/**
 * The organization's registry on the kit's DataGrid, the way Specs draws its
 * list (#1076): the search over names, descriptions and paths, the state, type
 * and project filters, header sort, pages, the list's empty state, and the
 * "needs a decision" chip in the grid's toolbar. A click on a row opens it
 * under the list (the grid has no row of its own for it): why it looks like a
 * gear, where it is declared, and the decisions it allows; a second click, or
 * Close, folds it.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Button,
  DataGridActionsPlugin,
  DataGridRowClickPlugin,
  filterTagGroup,
  type DataGridFilterEntity,
  type DataGridTableColumn,
} from '@gears-frontx/ui-kit';
import {
  GridClearFilters,
  GridEmpty,
  ListGrid,
  createGridCells,
  tagGroupChoice,
  useLocalGridLoad,
} from '@constructor-studio/mfe-shared/grid';
import type { RegistryEntry } from '../../api/types';
import { ROW_STATES, nameOf, type ComponentRow } from '../../model/catalogue';
import {
  STATE_LABEL,
  STATE_TONE,
  consumersLabel,
  isDuplicated,
  isOrphaned,
  projectsOf,
  publishStatus,
  registryProjects,
} from '../../model/registry';
import { useScope, type Text } from './common';
import { EntryDetail, type Person } from './RegistryEntry';
import { StatusChip, toneOf } from './parts';
import styles from './ComponentsScreen.module.css';

/** A row of the grid: a registry entry, a published node, or both. */
export interface RegistryRow extends ComponentRow {
  id: string;
}

/** The filter keys the grid hands `load`. */
export const REGISTRY_FILTERS = {
  state: 'state',
  kind: 'kind',
  project: 'project',
} as const;

/** Whether `row` passes the grid's state, type and project filters. */
export function keepsRegistryRow(row: RegistryRow, filters: Record<string, unknown>): boolean {
  const chosen = (key: string) => tagGroupChoice(filters[key] as { value?: unknown } | undefined);
  const state = chosen(REGISTRY_FILTERS.state);
  if (state && row.state !== state) return false;
  const kind = chosen(REGISTRY_FILTERS.kind);
  if (kind && row.kind !== kind) return false;
  const project = chosen(REGISTRY_FILTERS.project);
  return !project || (row.entry?.occurrences ?? []).some((o) => o.project_id === project);
}

const releaseOf = (row: RegistryRow): string => String(row.node?.value.max_stable_version ?? row.node?.value.newest_version ?? '');
const downloadsOf = (row: RegistryRow): number | null =>
  row.node?.value.downloads != null ? Number(row.node.value.downloads) : null;
const stateRank = (row: RegistryRow): number => {
  const i = ROW_STATES.indexOf(row.state);
  return i < 0 ? ROW_STATES.length : i;
};

const REGISTRY_OPTIONS = {
  // A row matches by its name, description or a path it is declared at (`rowMatches`).
  search: (row: RegistryRow) => [row.name, row.description, ...(row.entry?.occurrences ?? []).map((o) => o.path)],
  filter: keepsRegistryRow,
  compare: {
    component: (a: RegistryRow, b: RegistryRow) => a.name.localeCompare(b.name),
    // What needs a decision first, as the state filter lists them.
    state: (a: RegistryRow, b: RegistryRow) => stateRank(a) - stateRank(b),
    release: (a: RegistryRow, b: RegistryRow) => releaseOf(a).localeCompare(releaseOf(b), undefined, { numeric: true }),
    // Unknown downloads sort below every known count, in both directions.
    downloads: (a: RegistryRow, b: RegistryRow) => (downloadsOf(a) ?? -Infinity) - (downloadsOf(b) ?? -Infinity),
  },
};

/** What a cell and the toolbar need beyond their row. */
interface RegistryCells {
  t: Text;
  /** The key of the row open under the list. */
  open: string | null;
  /** Candidates waiting for a decision, and the orphans among the entries. */
  candidates: number;
  orphaned: number;
  onCandidates: (on: boolean) => void;
}

const [RegistryCellsProvider, useRegistryCells] = createGridCells<RegistryCells>('Registry');

const Dash: React.FC = () => <span className={styles.muted}>—</span>;

const NameCell: React.FC<{ item: RegistryRow }> = ({ item }) => {
  const { t, open } = useRegistryCells();
  return (
    <div data-registry-row={item.name} data-open={open === item.key || undefined}>
      <span className={styles.name}>{item.name}</span> <span className={styles.sub}>{item.kind}</span>
      {item.entry && isDuplicated(item.entry) && (
        <Badge variant="warning" title={t('declared_many_title')}>
          ×{new Set(item.entry.occurrences.map((o) => o.repo)).size} {t('repos')}
        </Badge>
      )}
      {item.entry && isOrphaned(item.entry) && (
        <Badge variant="secondary" title={t('orphaned_title')}>
          {t('orphaned')}
        </Badge>
      )}
      {item.description && <div className={styles.purpose}>{item.description}</div>}
    </div>
  );
};

const StateCell: React.FC<{ item: RegistryRow }> = ({ item }) => {
  const published = item.entry ? publishStatus(item.entry) : null;
  return (
    <span className={styles.chips}>
      <StatusChip
        tone={STATE_TONE[item.state] !== undefined ? toneOf(STATE_TONE[item.state]) : item.state === 'published' ? 'ok' : 'neutral'}
      >
        {STATE_LABEL[item.state] ?? item.state}
      </StatusChip>
      {published && (
        <StatusChip tone={published.kind === 'published' ? 'ok' : 'info'} data-registry-publish-status>
          {published.label}
        </StatusChip>
      )}
    </span>
  );
};

const ProjectsCell: React.FC<{ item: RegistryRow }> = ({ item }) => {
  if (!item.entry) return <Dash />;
  const used = consumersLabel(item.entry);
  return (
    <>
      {projectsOf(item.entry).join(', ') || '—'}
      {used && (
        <div className={styles.sub} data-registry-used-by>
          {used}
        </div>
      )}
    </>
  );
};

const DeclaredAtCell: React.FC<{ item: RegistryRow }> = ({ item }) => {
  const { t } = useRegistryCells();
  const first = item.entry?.occurrences[0];
  if (!first) {
    return item.node?.value.repository ? (
      <span className={styles.sub}>{String(item.node.value.repository).replace(/^https?:\/\//, '')}</span>
    ) : (
      <Dash />
    );
  }
  const more = item.entry!.occurrences.length - 1;
  return (
    <span className={styles.sub}>
      <code>{first.path}</code> ({first.declared_in})
      {more > 0 && ` ${t('and_more', { count: more })}`}
    </span>
  );
};

const ReleaseCell: React.FC<{ item: RegistryRow }> = ({ item }) => {
  const release = releaseOf(item);
  return release ? <code className={styles.version}>{release}</code> : <Dash />;
};

const DownloadsCell: React.FC<{ item: RegistryRow }> = ({ item }) => {
  const downloads = downloadsOf(item);
  return <div className={styles.num}>{downloads === null ? <Dash /> : downloads.toLocaleString('en-US')}</div>;
};

/** "Needs a decision", in the grid's toolbar: opens the candidates. */
const DecideChip: React.FC = () => {
  const { t, candidates, orphaned, onCandidates } = useRegistryCells();
  if (candidates === 0) return null;
  return (
    <StatusChip
      tone="warn"
      onClick={() => onCandidates(true)}
      title={orphaned > 0 ? t('decide_title_orphaned', { candidates, orphaned }) : t('decide_title')}
      data-registry-candidates-tab
    >
      {t('needs_decision_chip', { count: candidates })}
    </StatusChip>
  );
};

const RegistryEmpty: React.FC = () => {
  const { t } = useRegistryCells();
  return (
    <GridEmpty
      title={t('nothing_read')}
      note={t('nothing_read_body')}
      noMatches={t('no_component_matches')}
      noMatchesActions={<GridClearFilters label={t('clear_filters')} />}
    />
  );
};

export function RegistryGrid({
  rows: componentRows,
  entries,
  withCatalogue,
  people,
  names,
  onDecided,
  onOpenComponent,
  platformAdmin,
  candidates,
  orphaned,
  onCandidates,
}: {
  rows: ComponentRow[];
  entries: RegistryEntry[];
  withCatalogue: boolean;
  people: Person[];
  names: Record<string, string>;
  onDecided: () => void;
  onOpenComponent: (name: string) => void;
  platformAdmin: boolean;
  candidates: number;
  orphaned: number;
  onCandidates: (on: boolean) => void;
}) {
  const { t } = useScope();
  const [open, setOpen] = useState<string | null>(null);
  const rows = useMemo<RegistryRow[]>(() => componentRows.map((r) => ({ ...r, id: r.key })), [componentRows]);
  const { load, reloadBridge } = useLocalGridLoad(rows, REGISTRY_OPTIONS);

  const columns = useMemo<DataGridTableColumn<RegistryRow>[]>(() => {
    const out: DataGridTableColumn<RegistryRow>[] = [
      { id: 'component', label: t('col_component'), component: NameCell, minWidth: 240 },
      { id: 'state', label: t('col_state'), component: StateCell, width: 200 },
      { id: 'projects', label: t('col_projects'), component: ProjectsCell, width: 200 },
      { id: 'declared_at', label: t('col_declared_at'), component: DeclaredAtCell, width: 240 },
    ];
    if (withCatalogue) {
      out.push(
        { id: 'release', label: t('col_release'), component: ReleaseCell, width: 110 },
        { id: 'downloads', label: t('col_downloads'), component: DownloadsCell, width: 120 }
      );
    }
    return out;
  }, [t, withCatalogue]);

  // The options a filter offers are the ones the rows have; a filter with one choice is none.
  const states = ROW_STATES.filter((st) => rows.some((r) => r.state === st))
    .map((st) => `${st}\t${STATE_LABEL[st] ?? st} ${rows.filter((r) => r.state === st).length}`)
    .join('\n');
  const kinds = [...new Set(rows.map((r) => r.kind).filter(Boolean))].sort().join('\n');
  const projects = useMemo(
    () => registryProjects(entries).map((p) => `${p.id}\t${p.name}`).join('\n'),
    [entries]
  );
  const filters = useMemo(() => {
    const options = (joined: string) =>
      (joined ? joined.split('\n') : []).map((line) => {
        const [value, label = value] = line.split('\t');
        return { value, label };
      });
    const entities: DataGridFilterEntity[] = [];
    const add = (id: string, label: string, joined: string) => {
      const choices = options(joined);
      if (choices.length > 1) entities.push(filterTagGroup({ id, label, mode: 'radio', options: choices }));
    };
    add(REGISTRY_FILTERS.state, t('col_state'), states);
    add(REGISTRY_FILTERS.kind, t('col_type'), kinds);
    add(REGISTRY_FILTERS.project, t('filter_project'), projects);
    return entities;
  }, [t, states, kinds, projects]);

  const cells = useMemo<RegistryCells>(
    () => ({ t, open, candidates, orphaned, onCandidates }),
    [t, open, candidates, orphaned, onCandidates]
  );
  const toggle = useCallback((row: RegistryRow) => setOpen((now) => (now === row.key ? null : row.key)), []);
  const opened = open ? rows.find((r) => r.key === open) ?? null : null;

  // The detail sits under the list: bring it into view when a row opens.
  const detail = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) detail.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [open]);

  return (
    <RegistryCellsProvider value={cells}>
      <ListGrid<RegistryRow>
        name="components_registry"
        label={t('organization_title')}
        columns={columns}
        load={load}
        search={t('search_registry')}
        filters={filters}
        empty={RegistryEmpty}
        unsortable={['projects', 'declared_at']}
        defaultOrder={{ id: 'component', direction: 'asc' }}
        minWidth="60rem"
      >
        <DataGridRowClickPlugin<RegistryRow> click={toggle} />
        <DataGridActionsPlugin component={DecideChip} />
        {reloadBridge}
      </ListGrid>
      {opened && (
        <section ref={detail} className={styles.panel} data-registry-expanded={opened.name}>
          <header className={styles.panelHead}>
            <h2 className={styles.panelTitle}>{opened.name}</h2>
            <span className={styles.sub}>{opened.kind}</span>
            <Button variant="ghost" size="sm" className={styles.pushEnd} onClick={() => setOpen(null)}>
              {t('close')}
            </Button>
          </header>
          {opened.entry ? (
            <EntryDetail
              entry={opened.entry}
              entries={entries}
              people={people}
              names={names}
              onDecided={onDecided}
              onOpenComponent={opened.node ? () => onOpenComponent(nameOf(opened.node!)) : undefined}
              platformAdmin={platformAdmin}
            />
          ) : (
            <div className={styles.sub}>
              {t('published_no_project')}{' '}
              {opened.node && (
                <Button variant="link" size="sm" onClick={() => onOpenComponent(nameOf(opened.node!))}>
                  {t('open_page')} →
                </Button>
              )}
            </div>
          )}
        </section>
      )}
    </RegistryCellsProvider>
  );
}
