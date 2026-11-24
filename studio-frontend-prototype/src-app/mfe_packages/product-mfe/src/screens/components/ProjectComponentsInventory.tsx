/**
 * Project › Components (the prototype's `project-components-view.tsx`): what
 * the project is made of (project-inventory.ts) — taken from the platform and
 * the organization, its own, its code that could become a gear, the services
 * that are not gears, and the gears its documents ask for that nobody has
 * written — with a gear scaffolded from the specs for the last.
 *
 * The same screen is the Product page's Parts section, which hands it
 * `onOpenProduct` (its Backend); on the Components tab "Put it into the
 * product" opens the Product tab.
 *
 * The joins below (plan × product × code × services × registry) are a backend
 * candidate: one route that answers "what is this project made of?".
 *
 * The services are what the backend computed when the project's
 * repositories were last synced (a derived view): read in milliseconds, with
 * the commit and time they were computed at and ↻ to compute them again. The
 * code's conformance (capabilities → conformance, seconds) no longer holds
 * the list back: the rows show first and its column fills in when it comes.
 */

import { useEffect, useMemo, useState } from 'react';
import { Skeleton } from '@gears-frontx/ui-kit';
import {
  DerivedViewStrip,
  openScreen,
  useDerivedViewPoll,
  violationOfType,
  type DerivedViewState,
} from '@constructor-studio/mfe-shared';
import { ProjectPage } from '@constructor-studio/mfe-shared/page';
import { GridFailed } from '@constructor-studio/mfe-shared/grid';
import { productApi } from '../../api/client';
import type { Conformance, PlanRow } from '../../api/types';
import { capabilityEntities, keptSentences, suggestedCategory } from '../../model/capability-entities';
import { layerOf } from '../../model/domain-layers';
import { entityGears, gearRefs } from '../../model/entity-gears';
import { gearDeployState, runningNow, type ProductAt, type Running } from '../../model/gear-deploys-model';
import type { ProjectComponent } from '../../model/project-checks';
import { inventory, ownGearsOf, type InventoryRow, type OwnGear } from '../../model/project-inventory';
import { gearProblem, rowCoverage } from '../../model/spec-coverage';
import { entitiesOf, type Entity, type GlossaryEntry } from '../../model/spec-model';
import { useComponentsTranslations } from '../../i18n';
import { useGearCatalogue } from '../product/catalogue';
import { errText, openTab, useScope } from '../common';
import { InventoryGrid, type InventoryCells } from './InventoryGrid';
import { ProjectCandidate } from './ProjectCandidate';
import { ScaffoldDialog } from './ScaffoldDialog';
import styles from './ProjectComponentsInventory.module.css';

export { inventoryType } from './InventoryGrid';

/** The organization's Components tab (components-mfe): where a catalogue component is. */
const ORGANIZATION_COMPONENTS_ROUTE = '/components';

interface Read {
  plan: PlanRow[];
  picks: string[];
  /** The product's last commit and change, which its deploys are read against. */
  productAt: ProductAt;
  services: ProjectComponent[];
  /** What the services were computed from and when; null when not said. */
  servicesView: DerivedViewState | null;
  /** The gears the project's own code declares, from the registry. */
  own: OwnGear[];
  /** What could not be read, each as its sentence's key; the rest still shows. */
  partial: string[];
}

/** What each environment the project deploys to runs now (the prototype's
 *  `useRunning`): null while read, or when this Studio keeps no deployments. */
function useRunning(projectId: string): Running[] | null {
  const [running, setRunning] = useState<Running[] | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all([
      productApi.deployments({ project: projectId }),
      // Without the targets every run still shows; only `protected` is lost.
      productApi.projectTargets(projectId).catch(() => null),
    ])
      .then(([d, t]) => {
        if (live) setRunning(runningNow(d.items, t?.environments.map((e) => e.environment) ?? []));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [projectId]);
  return running;
}

/** The code's conformance to the declared capabilities: two reads one after
 *  the other, seconds, so read beside the list rather than before it. */
function readCode(projectId: string, workspaceId: string | null, refresh = false): Promise<Conformance> {
  return Promise.all([
    productApi.declaredCapabilities(projectId),
    workspaceId ? productApi.capabilities(workspaceId) : Promise.resolve({ items: [] }),
  ]).then(([declared, vocab]) =>
    productApi.conformance(
      projectId,
      declared.items.map((c) => c.key),
      vocab.items ?? [],
      refresh
    )
  );
}

/** The code's comparison as a derived view: which commits of the server's clones, and when. */
function codeView(code: Conformance | null | undefined): DerivedViewState | null {
  if (!code?.computed_at) return null;
  return {
    status: 'ready',
    computed_at: code.computed_at,
    inputs: (code.code_commits ?? []).map((c) => ({ source: c.repo, commit: c.commit })),
  };
}

/** Plan × product × services × registry: what the inventory is drawn from.
 *  What could not be read is said in `partial` (as keys); only the plan is required. */
async function readInventory(projectId: string): Promise<Read> {
  const partial: string[] = [];
  const [plan, product, services, registry] = await Promise.all([
    // The plan is the Spec mapping kit's (ADR-0074): without it the plan's
    // part of the list is left out and said so, and the rest still shows.
    productApi.projectPlan(projectId).catch((e: unknown) => {
      if (!violationOfType(e, 'KIT_NOT_INSTALLED')) throw e;
      partial.push('partial_plan_kit');
      return { items: [] as PlanRow[] };
    }),
    productApi.projectProduct(projectId).catch(() => {
      partial.push('partial_product');
      return null;
    }),
    productApi.projectComponents(projectId).catch(() => {
      partial.push('partial_services');
      return null;
    }),
    // Every gear the project's code declares, whether a capability offers
    // it or not; the plan only names the ones its documents ask for.
    productApi.componentRegistry({ project_id: projectId }).catch(() => {
      partial.push('partial_own');
      return null;
    }),
  ]);
  return {
    plan: plan.items,
    picks: product?.gears ?? [],
    productAt: { commit: product?.written?.commit_sha, updatedAt: product?.updated_at },
    services: services?.items ?? [],
    servicesView: services?.view ?? null,
    own: ownGearsOf(registry?.items ?? [], projectId),
    partial,
  };
}

/** `framed`: the Components tab's own page, its lead behind the title's "?"; bare inside Product. */
export function ProjectComponentsInventory({
  onOpenProduct,
  framed = false,
}: {
  onOpenProduct?: () => void;
  framed?: boolean;
}) {
  const { projectId, workspaceId, bridge, container } = useScope();
  const { t } = useComponentsTranslations();
  const [read, setRead] = useState<Read | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The code's conformance: undefined while read, null when it could not be. */
  const [code, setCode] = useState<Conformance | null | undefined>(undefined);
  const [scaffold, setScaffold] = useState<PlanRow | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  /** The project domain model's entities, read when a gear is first asked for: what
   *  the new gear keeps. Null while unread; empty when it cannot be read. */
  const [entities, setEntities] = useState<Entity[] | null>(null);
  /** Bumped to read again. */
  const [round, setRound] = useState(0);
  /** Bumped to compare the code again (↻ on its line). */
  const [codeRound, setCodeRound] = useState(0);
  const openProduct = onOpenProduct ?? (() => openTab(bridge, 'product'));

  useEffect(() => {
    if (!scaffold || entities) return;
    let live = true;
    Promise.all([
      productApi.specModel(projectId),
      // A backend from before the glossary answers 404: the model still reads.
      productApi.glossary(projectId).catch(() => ({ items: [] as GlossaryEntry[], total: 0 })),
    ])
      .then(([model, glossary]) => live && setEntities(entitiesOf(model.facts, glossary.items)))
      // No model yet: the gear is asked for from the capability alone.
      .catch(() => live && setEntities([]));
    return () => {
      live = false;
    };
  }, [scaffold, entities, projectId]);

  // The catalogue says which subsystem the new gear most likely joins, and
  // gives the product's gears their maturity, read against where they run.
  const catalogue = useGearCatalogue(!!scaffold || (read?.picks.length ?? 0) > 0, projectId);
  const running = useRunning(projectId);
  const index = catalogue && 'index' in catalogue ? catalogue.index : null;
  const draft = useMemo(() => {
    if (!scaffold || !entities || !catalogue) return null;
    const kept = capabilityEntities(scaffold, entities);
    const domain = entities.filter((e) => layerOf(e) === 'domain');
    const keepers = index ? entityGears(domain, gearRefs(index)).byEntity : new Map();
    const suggested = suggestedCategory(scaffold, kept.entities, entities, index, (keys) =>
      keys.map((k) => keepers.get(k)?.gear.id ?? null)
    );
    const categories = [
      ...new Set((index?.gears ?? []).map((g) => g.category?.trim() ?? '').filter((c) => c && c !== 'example')),
    ].sort();
    return { kept, suggested, categories };
  }, [scaffold, entities, catalogue, index]);
  const kept = draft?.kept ?? null;

  useEffect(() => {
    let live = true;
    readInventory(projectId).then(
      (r) => live && setRead(r),
      (e: unknown) => live && setError(errText(e))
    );
    return () => {
      live = false;
    };
  }, [projectId, round]);

  // Beside the list, not before it: the rows show without the code's column.
  useEffect(() => {
    let live = true;
    // A read again keeps the last answer until the new one comes.
    readCode(projectId, workspaceId, codeRound > 0).then(
      (c) => live && setCode(c),
      () => live && setCode(null)
    );
    return () => {
      live = false;
    };
  }, [projectId, workspaceId, round, codeRound]);

  /** Read the services again (a computation running, or asked for). */
  const rereadServices = () => {
    productApi
      .projectComponents(projectId)
      .then((s) =>
        setRead((r) => (r ? { ...r, services: s.items, servicesView: s.view ?? null } : r))
      )
      .catch(() => undefined);
  };
  useDerivedViewPoll(read?.servicesView, rereadServices);
  /** ↻: compute the services again from what the syncs stored. */
  const recompute = () => {
    setRead((r) =>
      r && r.servicesView ? { ...r, servicesView: { ...r.servicesView, status: 'computing' } } : r
    );
    productApi
      .refreshProjectComponents(projectId)
      .then(rereadServices)
      .catch(rereadServices);
  };
  /** Read it all again: Retry, and a scaffold dialog closed. */
  const reload = () => {
    setError(null);
    setRound((r) => r + 1);
  };

  const rows = useMemo(() => {
    if (!read) return null;
    const needsGear = (row: PlanRow) =>
      !row.nonfunctional &&
      !!(
        row.gap ||
        row.unbuilt ||
        (rowCoverage(row, read.picks).cover === 'open' && !row.candidates.some((c) => c.built === 'built'))
      );
    return inventory(read.plan, code ?? null, read.picks, read.services, needsGear, read.own);
  }, [read, code]);
  const partial = read ? [...read.partial, ...(code === null ? ['partial_code'] : [])] : [];

  const stateOf = (r: InventoryRow): string =>
    r.service
      ? r.service.readiness === 'ready'
        ? t('state_ready')
        : r.service.readiness === 'caution'
          ? t('state_caution')
          : t('state_not_ready')
      : r.role === 'create'
        ? r.need?.gap
          ? t('state_gap')
          : t('state_unbuilt')
        : r.candidate?.built === 'docs-only'
          ? t('state_docs_only')
          : (r.candidate?.registry_state ?? t('state_built'));

  const runsOf = (r: InventoryRow) => {
    // Only what the product carries is deployed with it.
    const s =
      r.inProduct && read
        ? gearDeployState({ name: r.name, maturity: index?.find(r.name)?.maturity }, running, read.productAt)
        : null;
    if (!s) return <span className={styles.muted}>—</span>;
    return (
      <span className={styles.muted} data-runs={s.runs.length > 0 ? 'yes' : 'no'} title={s.hint ?? s.line}>
        {s.hint && <span className={styles.error}>⚠ </span>}
        {s.runs.length > 0 ? s.runs.map((x) => x.environment).join(', ') : t('not_deployed')}
      </span>
    );
  };

  const explain = (r: InventoryRow) =>
    r.service ? (
      <div>
        {r.service.reasons.join(' · ') || t('nothing_in_the_way')}
        {r.service.owners.length > 0 && <div>{t('owners', { owners: r.service.owners.join(', ') })}</div>}
      </div>
    ) : r.need ? (
      <div>{gearProblem(r.need)}</div>
    ) : r.answers.length ? (
      <div>{t('answers_by', { answers: r.answers.join(', ') })}</div>
    ) : (
      <div>{r.inProduct ? t('taken_by_product') : t('taken_by_code')}</div>
    );

  const cells: InventoryCells = {
    t,
    expanded,
    opened,
    stateOf,
    runsOf,
    scaffold,
    drafted: !!kept,
    onCreate: setScaffold,
    onOpenCatalogue: () => openScreen(bridge, ORGANIZATION_COMPONENTS_ROUTE),
    onToggleCandidate: (key) => setOpened((was) => (was === key ? null : key)),
    onOpenProduct: openProduct,
  };
  const toggle = (row: InventoryRow) => setExpanded((was) => (was === row.key ? null : row.key));
  const explained = expanded ? rows?.find((r) => r.key === expanded) : undefined;
  const candidate = opened ? rows?.find((r) => r.key === opened && r.role === 'could') : undefined;

  const lead = (
    <p className={framed ? undefined : styles.lead}>
      <b>{t('lead_title')}</b> {t('lead_body')}
    </p>
  );
  const body = (
    <section className={styles.inventory} data-project-components>
      {!framed && lead}
      {read?.servicesView && (
        <p className={styles.muted} data-inventory-services-view>
          <DerivedViewStrip
            view={read.servicesView}
            onRefresh={recompute}
            labels={{
              byCommit: (commits) => t('services_by_commit', { commits }),
              computed: (ago) => t('services_computed', { ago }),
              computing: t('services_computing'),
              failed: (why) => t('services_failed', { why }),
              never: t('services_never'),
              refresh: t('services_refresh'),
            }}
          />
        </p>
      )}
      {codeView(code) && (
        <p className={styles.muted} data-inventory-code-view>
          <DerivedViewStrip
            view={codeView(code)}
            onRefresh={() => setCodeRound((r) => r + 1)}
            labels={{
              byCommit: (commits) => t('code_by_commit', { commits }),
              computed: (ago) => t('services_computed', { ago }),
              computing: t('services_computing'),
              failed: (why) => t('services_failed', { why }),
              never: t('services_never'),
              refresh: t('code_refresh'),
            }}
          />
        </p>
      )}
      {partial.length > 0 && (
        <p className={styles.muted} data-inventory-partial>
          {t('partial', { what: partial.map((k) => t(k)).join('; ') })}
        </p>
      )}
      {error ? (
        <GridFailed message={error} retry={t('retry')} onRetry={reload} />
      ) : !rows ? (
        <Skeleton className={styles.skeleton} />
      ) : (
        <InventoryGrid rows={rows} cells={cells} onToggle={toggle} />
      )}
      {/* Why a row is there, and a code candidate made a gear, open under the list: the kit's grid has no detail row. */}
      {explained && (
        <div className={`${styles.detail} ${styles.muted}`} data-inventory-detail={explained.key}>
          <b>{explained.name}</b>
          {explain(explained)}
        </div>
      )}
      {candidate && (
        <div className={styles.detail} data-inventory-candidate={candidate.key}>
          <ProjectCandidate name={candidate.name} projectId={projectId} />
        </div>
      )}
      {/* Opened once the project domain model is read, so the draft it starts with is the whole one. */}
      {scaffold && draft && kept && (
        <ScaffoldDialog
          capability={scaffold.capability}
          projectId={projectId}
          container={container}
          problem={[gearProblem(scaffold), keptSentences(kept)].filter(Boolean).join(' ')}
          declares={[scaffold.capability]}
          category={draft.suggested?.category}
          categories={draft.categories}
          lead={[
            kept.entities.length
              ? kept.requirements.length
                ? t('lead_kept_answers', {
                    entities: kept.entities.map((e) => e.name).join(', '),
                    count: String(kept.requirements.length),
                  })
                : t('lead_kept', { entities: kept.entities.map((e) => e.name).join(', ') })
              : t('lead_no_entity'),
            draft.suggested ? t('lead_subsystem', { why: draft.suggested.why }) : '',
          ]
            .filter(Boolean)
            .join(' ')}
          onClose={() => {
            setScaffold(null);
            reload();
          }}
        />
      )}
    </section>
  );
  if (!framed) return body;
  return (
    <ProjectPage title={t('title')} help={lead} helpLabel={t('help_label')}>
      {body}
    </ProjectPage>
  );
}
