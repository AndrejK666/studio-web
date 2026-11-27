/**
 * The organization's component registry (ADR-0041), the prototype's
 * `ComponentRegistry`: every component its projects declare — a `gear.toml`
 * or `gear.gdl` directory, a `#[toolkit::gear]` attribute, a FrontX package,
 * a kit manifest — laid beside what its catalogue holds, one row each, on the
 * kit's DataGrid (`RegistryGrid`). A row opens the component's page
 * (`ComponentView`), whose Lifecycle block carries the registry's panel: why
 * it looks like a gear, who owns it, where it is declared, what was
 * contributed or extracted, and the decisions it allows (an organization
 * administrator's; anyone else is told so by the 403).
 * "Needs a decision" lists the candidates, strongest first.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Checkbox, Empty, EmptyHeader, EmptyTitle, Skeleton } from '@gears-frontx/ui-kit';
import { GridFailed } from '@constructor-studio/mfe-shared/grid';
import type { CatalogNode, RegistryEntry, RegistryProjectWalk } from '../../api/types';
import { componentRows, type ComponentRow } from '../../model/catalogue';
import {
  candidateWhere,
  candidatesOf,
  evidenceLines,
  isDuplicated,
  isOrphaned,
  registryProjects,
  stateCounts,
  walkLine,
} from '../../model/registry';
import { api, errText, statusOf, useScope, waitForSync } from './common';
import { ComponentView } from './ComponentView';
import { EntryDetail, RegistryDecisions, DeclareCandidate, type Person } from './RegistryEntry';
import { RegistryGrid, registryRows } from './RegistryGrid';
import { StatusChip } from './parts';
import styles from './ComponentsScreen.module.css';

/** What the registry tells the screen's header. */
export interface RegistrySummary {
  /** Components on the list; null while it is read. */
  total: number | null;
  /** Candidates waiting for a decision. */
  decide: number;
  orphaned: number;
  /** A read now in flight, or how the last one ended. */
  reading: string;
  failed: boolean;
}

interface Loaded {
  entries: RegistryEntry[];
  excluded: string[];
  walks: RegistryProjectWalk[];
}

export function Registry({
  readRef,
  onSummary,
  candidates,
  onCandidates,
  profileFor,
  onPage,
  catalogue,
}: {
  /** Where the header's Read the projects now finds this registry's read. */
  readRef: React.MutableRefObject<(() => void) | null>;
  onSummary: (s: RegistrySummary) => void;
  /** The candidates view, held by the header's chip. */
  candidates: boolean;
  onCandidates: (on: boolean) => void;
  /** A published component's field profile, for its page's Profile tab. */
  profileFor: (row: ComponentRow) => React.ReactNode;
  /** Whether a component's page is open over the list. */
  onPage: (open: boolean) => void;
  /** What the organization's catalogue holds, laid beside what its projects declare. */
  catalogue: CatalogNode[];
}) {
  const { org, platformAdmin, t } = useScope();
  const orgId = org?.id ?? null;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [tick, setTick] = useState(0);
  const [sync, setSync] = useState('');
  const [busy, setBusy] = useState(false);
  const people = usePeople();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const names = useMemo(() => Object.fromEntries(people.map((p) => [p.id, p.name])), [people]);

  useEffect(() => {
    let live = true;
    const service = api();
    Promise.all([
      service.registry({ org: orgId }).fetch({ staleTime: 0 }),
      service
        .registryExcludedProjects({ org: orgId })
        .fetch({ staleTime: 0 })
        .catch(() => ({ project_ids: [] as string[] })),
      service
        .registryProjects({ org: orgId })
        .fetch({ staleTime: 0 })
        .catch(() => ({ items: [] as RegistryProjectWalk[], total: 0 })),
    ])
      .then(([list, ex, walked]) => {
        if (!live) return;
        setError(null);
        setLoaded({ entries: list.items, excluded: ex.project_ids, walks: walked.items });
      })
      .catch((cause: unknown) => {
        if (!live) return;
        // A backend from before the registry answers 404: say so plainly.
        if (statusOf(cause) === 404) setMissing(true);
        else setError(errText(cause));
      });
    return () => {
      live = false;
    };
  }, [orgId, tick]);
  const load = () => setTick((n) => n + 1);

  /** Read every project again now, rather than waiting for the schedule. */
  const readNow = async () => {
    setBusy(true);
    setSync('queued…');
    try {
      const { run_id } = await api().sync(orgId).fetch(undefined);
      const last = await waitForSync(run_id, orgId, (l) => setSync(l.done ? (l.ok ? '' : l.text) : l.text.split(' — ')[0] + '…'));
      if (last.ok) load();
    } catch (cause) {
      setSync(errText(cause));
    } finally {
      setBusy(false);
    }
  };

  // The header's button reads the projects through this.
  useEffect(() => {
    readRef.current = () => void readNow();
    return () => {
      readRef.current = null;
    };
  });

  const toggleProject = async (id: string) => {
    if (!loaded) return;
    const next = loaded.excluded.includes(id) ? loaded.excluded.filter((x) => x !== id) : [...loaded.excluded, id];
    setLoaded({ ...loaded, excluded: next });
    try {
      await api().saveExcludedProjects(orgId).fetch({ project_ids: next });
    } catch (cause) {
      setError(errText(cause));
    }
  };

  const entries = loaded?.entries ?? null;
  const rows = useMemo(() => componentRows(entries ?? [], catalogue), [entries, catalogue]);
  const counts = useMemo(() => stateCounts(entries ?? []), [entries]);
  const orphaned = (entries ?? []).filter(isOrphaned).length;
  // The open row, read again from the rows after every decision.
  const opened = useMemo(() => (openKey ? (registryRows(rows).find((r) => r.key === openKey) ?? null) : null), [openKey, rows]);
  const pageOpen = opened !== null;
  useEffect(() => {
    onPage(pageOpen);
  }, [pageOpen, onPage]);
  const duplicated = (entries ?? []).filter(isDuplicated).length;

  useEffect(() => {
    onSummary({
      total: entries === null ? null : rows.length,
      decide: counts.candidate ?? 0,
      orphaned,
      reading: busy ? sync || 'reading…' : sync,
      failed: !busy && !!sync,
    });
  }, [entries, rows.length, counts.candidate, orphaned, busy, sync, onSummary]);

  if (missing) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{t('no_registry')}</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }

  if (opened && loaded) {
    return (
      <ComponentView
        key={opened.key}
        name={opened.name}
        node={opened.node}
        entry={opened.entry}
        type={opened.type}
        onBack={() => setOpenKey(null)}
        profile={opened.node ? profileFor(opened) : undefined}
        lifecycle={
          opened.entry ? (
            <EntryDetail
              entry={opened.entry}
              entries={loaded.entries}
              people={people}
              names={names}
              onDecided={load}
              platformAdmin={platformAdmin}
            />
          ) : (
            <p className={styles.sub}>{t('published_no_project')}</p>
          )
        }
      />
    );
  }

  return (
    <section className={styles.stack} data-component-registry>
      {error && loaded !== null && <p className={styles.error}>{error}</p>}
      {loaded === null ? (
        error ? (
          <GridFailed message={error} retry={t('retry')} onRetry={load} />
        ) : (
          <Skeleton className={styles.skeleton} />
        )
      ) : (
        <>
          <p className={styles.sub}>
            <b>{t.count('n_components', rows.length)}</b>
            {rows.length > loaded.entries.length && ` · ${t('published_undeclared', { count: rows.length - loaded.entries.length })}`}
            {duplicated > 0 && ` · ${t('declared_many', { count: duplicated })}`}
            {orphaned > 0 && ` · ${t('orphaned_many', { count: orphaned })}`}
          </p>
          <Unreadable loaded={loaded} />
          {candidates ? (
            <>
              <div className={styles.toolbar}>
                <StatusChip tone="info" pressed onClick={() => onCandidates(false)} data-registry-candidates-tab>
                  ✓ {t('needs_decision_chip', { count: counts.candidate ?? 0 })}
                </StatusChip>
              </div>
              <CandidatesView entries={loaded.entries} people={people} names={names} onDecided={load} />
            </>
          ) : (
            <RegistryGrid
              rows={rows}
              entries={loaded.entries}
              withCatalogue={catalogue.length > 0}
              candidates={counts.candidate ?? 0}
              orphaned={orphaned}
              onCandidates={onCandidates}
              onOpen={(row) => setOpenKey(row.key)}
            />
          )}
          <ProjectsRead loaded={loaded} entries={loaded.entries} onToggle={(id) => void toggleProject(id)} />
        </>
      )}
    </section>
  );
}

/** The caller's colleagues and the caller: who a decision can name as owner, and who decided. */
function usePeople(): Person[] {
  const [people, setPeople] = useState<Person[]>([]);
  useEffect(() => {
    let live = true;
    const service = api();
    void Promise.all([
      service.colleagues().catch(() => []),
      service.myProfile.fetch({ staleTime: 0 }).catch(() => null),
    ]).then(([colleagues, me]) => {
      if (!live) return;
      const out = new Map<string, string>();
      if (me) out.set(me.id, me.display_name || me.email || me.id);
      for (const c of colleagues) if (!out.has(c.user_id)) out.set(c.user_id, c.display_name || c.user_id);
      setPeople([...out].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)));
    });
    return () => {
      live = false;
    };
  }, []);
  return people;
}

/** The projects of the last walk, with the ones excluded: which the registry reads. */
function projectsRead(loaded: Loaded, entries: RegistryEntry[]): { id: string; name: string }[] {
  const out = new Map<string, string>();
  for (const w of loaded.walks) out.set(w.project_id, w.project_name || w.project_id);
  const seen = new Map(registryProjects(entries).map((p) => [p.id, p.name]));
  for (const id of loaded.excluded) if (!out.has(id)) out.set(id, seen.get(id) ?? id);
  return [...out].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

function Unreadable({ loaded }: { loaded: Loaded }) {
  const { t } = useScope();
  const unreadable = loaded.walks.filter((w) => !loaded.excluded.includes(w.project_id) && walkLine(w).failed);
  if (unreadable.length === 0) return null;
  return (
    <div className={styles.errorBox} data-registry-unreadable>
      <b>{t.count('projects_unreadable', unreadable.length)}</b> — {unreadable.map((w) => w.project_name || w.project_id).join(', ')}.{' '}
      {walkLine(unreadable[0]).hint ?? t('see_projects_below')}
    </div>
  );
}

function ProjectsRead({ loaded, entries, onToggle }: { loaded: Loaded; entries: RegistryEntry[]; onToggle: (id: string) => void }) {
  const { t } = useScope();
  const projects = projectsRead(loaded, entries);
  const read = projects.filter((p) => !loaded.excluded.includes(p.id)).length;
  return (
    <details className={styles.details} data-registry-projects>
      <summary>{t('projects_read', { read, total: projects.length })}</summary>
      <p className={styles.sub}>{t('projects_read_hint')}</p>
      {projects.length === 0 ? (
        <p className={styles.sub}>{t('no_walk_yet')}</p>
      ) : (
        <ul className={styles.plainList}>
          {projects.map((p) => {
            const line = walkLine(loaded.walks.find((w) => w.project_id === p.id));
            const off = loaded.excluded.includes(p.id);
            return (
              <li key={p.id}>
                <label className={styles.row}>
                  <Checkbox checked={!off} onCheckedChange={() => onToggle(p.id)} aria-label={p.name} />
                  {p.name}
                  <span className={line.failed && !off ? styles.errorText : styles.sub}>{off ? t('excluded') : line.text}</span>
                </label>
                {line.hint && !off && <div className={styles.sub}>{line.hint}</div>}
              </li>
            );
          })}
        </ul>
      )}
    </details>
  );
}

/** Code that looks like a gear, strongest first, with why and what to do about it. */
function CandidatesView({
  entries,
  people,
  names,
  onDecided,
}: {
  entries: RegistryEntry[];
  people: Person[];
  names: Record<string, string>;
  onDecided: () => void;
}) {
  const { t } = useScope();
  const list = useMemo(() => candidatesOf(entries), [entries]);
  const [open, setOpen] = useState<string | null>(null);
  if (list.length === 0) {
    return (
      <p className={styles.sub} data-registry-candidates>
        {t('no_candidates')}
      </p>
    );
  }
  return (
    <div className={styles.stack} data-registry-candidates>
      <p className={styles.sub}>{t('candidates_hint')}</p>
      <ul className={styles.candidates}>
        {list.map((e) => (
          <li key={e.name} className={styles.candidate} data-registry-candidate={e.name}>
            <div className={styles.row}>
              <b>{e.name}</b>
              <Badge variant="info" title={t('score_title')}>
                {t('score', { score: e.score ?? 0 })}
              </Badge>
              <span className={styles.sub}>{candidateWhere(e)}</span>
            </div>
            {e.description && <div className={styles.sub}>{e.description}</div>}
            <ul className={styles.evidence}>
              {evidenceLines(e).map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
            {open === e.name ? (
              <div>
                <DeclareCandidate entry={e} onDeclared={onDecided} />
                <RegistryDecisions entry={e} entries={entries} people={people} names={names} onDecided={onDecided} platformAdmin={false} />
              </div>
            ) : (
              <Button variant="link" size="sm" onClick={() => setOpen(e.name)}>
                {t('declare_register_reject')}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
