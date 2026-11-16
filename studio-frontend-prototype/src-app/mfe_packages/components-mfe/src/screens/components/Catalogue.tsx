/**
 * Platform › Components and Organization › Components (the prototype's
 * `ComponentsCatalog`, ADR-0041/0042): one header, then the platform's
 * catalogue as a grid, or the organization's registry beside its catalogue;
 * a component's page opens over either.
 */

import { useMemo, useRef, useState } from 'react';
import { Button, Skeleton } from '@gears-frontx/ui-kit';
import { catalogueComponentType, openScreen } from '@constructor-studio/mfe-shared';
import { GridFailed } from '@constructor-studio/mfe-shared/grid';
import type { CatalogNode } from '../../api/types';
import { nameOf, schemaFor } from '../../model/catalogue';
import { syncedSources } from '../../model/component-kinds';
import { inTierTab, shadowedNote, tierCounts } from '../../model/component-tiers';
import { useScope } from './common';
import { CatalogueGrid } from './CatalogueGrid';
import { ComponentPage } from './ComponentPage';
import { ComponentView } from './ComponentView';
import { PageHeader, StatusChip } from './parts';
import { Registry, type RegistrySummary } from './Registry';
import { SourcesDialog, useCatalogueSync } from './Sources';
import { useBaselines, useCatalogue } from './useCatalogue';
import styles from './ComponentsScreen.module.css';

export function Catalogue({ tier }: { tier: 'platform' | 'organization' }) {
  const { org, platformAdmin, t, bridge, container } = useScope();
  const orgId = org?.id ?? null;
  const platformLevel = tier === 'platform';
  const { data, reload, setProfile } = useCatalogue(orgId);
  const { gears, profiles, resolved, schemas, componentTypes, truncated, shadowed, err } = data;
  const [selected, setSelected] = useState<string | null>(null);
  const [days, setDays] = useState(90);
  const baselines = useBaselines(orgId, days);
  const [registry, setRegistry] = useState<RegistrySummary | null>(null);
  const [decide, setDecide] = useState(false);
  const readNow = useRef<(() => void) | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const sync = useCatalogueSync(orgId, reload);

  const levelNodes = useMemo(() => (gears ?? []).filter((g) => inTierTab(g, tier)), [gears, tier]);
  // One array while nothing changed: the registry's grid reloads on a new one.
  const componentNodes = useMemo(
    () => levelNodes.filter((g) => componentTypes === null || componentTypes.has(g.type_id)),
    [levelNodes, componentTypes]
  );
  const tiers = useMemo(() => tierCounts(gears ?? []), [gears]);
  const filledFrom = useMemo(() => syncedSources(levelNodes, profiles).join(' + '), [levelNodes, profiles]);
  const selectedGear = useMemo(
    () => (selected ? (gears ?? []).find((g) => nameOf(g) === selected) ?? null : null),
    [selected, gears]
  );

  const [registryPage, setRegistryPage] = useState(false);

  /** A catalogue node's field profile: the Profile tab of its page. */
  const profileOf = (gear: CatalogNode) => (
    <ComponentPage
      gear={gear}
      profile={profiles[nameOf(gear)]}
      values={resolved[nameOf(gear)]?.values ?? {}}
      schema={schemaFor(schemas, gear.type_id)}
      baselines={baselines}
      days={days}
      onDays={setDays}
      onSaved={(p) => setProfile(nameOf(gear), p)}
    />
  );

  if (selectedGear) {
    return (
      <ComponentView
        key={selectedGear.instance_id}
        name={nameOf(selectedGear)}
        node={selectedGear}
        type={catalogueComponentType(selectedGear.value)}
        onBack={() => setSelected(null)}
        profile={profileOf(selectedGear)}
      />
    );
  }

  const registryView = (
    <Registry
      readRef={readNow}
      onSummary={setRegistry}
      candidates={decide}
      onCandidates={setDecide}
      profileFor={(row) => (row.node ? profileOf(row.node) : null)}
      onPage={setRegistryPage}
      catalogue={componentNodes}
    />
  );
  // A component's page open over the registry shows alone; the registry stays
  // mounted in the same place, so Back finds its filters and page as they were.
  const listChrome = platformLevel || !registryPage;

  const status = (
    <>
      {!platformLevel && registry ? (
        <span className={styles.count} data-components-count>
          {registry.total === null ? t('reading') : registry.total}
          {registry.decide > 0 && (
            <>
              {' · '}
              <StatusChip tone="warn" onClick={() => setDecide((d) => !d)} pressed={decide} data-components-decide>
                {t.count('needs_decision', registry.decide)}
              </StatusChip>
            </>
          )}
        </span>
      ) : (
        <span className={styles.count} data-components-count>
          {gears === null ? t('reading') : tiers[tier]} ·{' '}
          {filledFrom ? filledFrom.replace(/ \+ /g, ' · ') : t('not_synced')}
        </span>
      )}
      {sync.line && (
        <StatusChip
          tone={sync.busy ? 'running' : sync.ok ? 'ok' : 'danger'}
          title={sync.line}
          data-components-sync={sync.busy ? 'running' : sync.ok ? 'done' : 'failed'}
        >
          {sync.busy ? t('syncing_line', { line: sync.line.replace(/…$/, '') }) : sync.ok ? t('synced_line', { line: sync.line }) : t('sync_failed_line', { line: sync.line })}
        </StatusChip>
      )}
      {registry?.reading && (
        <StatusChip tone={registry.failed ? 'danger' : 'running'} data-registry-reading>
          {registry.failed ? t('read_failed', { line: registry.reading }) : registry.reading}
        </StatusChip>
      )}
    </>
  );

  const info = platformLevel ? (
    <p>{t('platform_info')}</p>
  ) : (
    <>
      <p>{t('organization_info')}</p>
      <p>{t('organization_info_members')}</p>
      {shadowedNote(shadowed) && <p data-shadowed>{shadowedNote(shadowed)}</p>}
      {filledFrom && <p>{t('filled_from', { sources: filledFrom })}</p>}
    </>
  );

  const actions = platformLevel ? (
    platformAdmin ? (
      <Button onClick={() => openScreen(bridge, '/platform/repositories')} title={t('repositories_sync_title')}>
        {t('repositories_sync')}
      </Button>
    ) : null
  ) : (
    <>
      <Button
        variant="outline"
        disabled={!!registry?.reading && !registry.failed}
        onClick={() => readNow.current?.()}
        data-registry-read
      >
        {t('read_projects_now')}
      </Button>
      <Button variant="outline" onClick={() => setSourcesOpen(true)} data-components-sources>
        {t('sources')}
      </Button>
      <Button disabled={sync.busy} onClick={() => void sync.run()} data-components-sync-btn>
        {sync.busy ? t('syncing') : t('sync')}
      </Button>
    </>
  );

  return (
    <>
      {listChrome && (
        <PageHeader
          title={platformLevel ? t('platform_title') : t('organization_title')}
          status={status}
          info={info}
          infoLabel={t('about', { title: platformLevel ? t('platform_title') : t('organization_title') })}
          actions={actions}
          container={container}
        />
      )}
      {sourcesOpen && <SourcesDialog sync={sync} onClose={() => setSourcesOpen(false)} />}
      {listChrome && truncated && <p className={styles.hint}>{t('truncated', { count: gears?.length ?? 0 })}</p>}
      {listChrome && err && gears !== null && <p className={styles.error}>{err}</p>}
      {platformLevel ? (
        gears === null ? (
          err ? (
            <GridFailed message={err} retry={t('retry')} onRetry={reload} />
          ) : (
            <Skeleton className={styles.skeleton} />
          )
        ) : (
          <CatalogueGrid
            levelNodes={levelNodes}
            componentTypes={componentTypes}
            resolved={resolved}
            schemas={schemas}
            baselines={baselines.byName}
            days={days}
            onDays={setDays}
            onOpen={setSelected}
            t={t}
          />
        )
      ) : (
        registryView
      )}
    </>
  );
}
