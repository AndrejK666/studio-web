/**
 * The organization's registry on the kit's DataGrid, the way Kits draws its
 * library (#1081): each row with its type's glyph, a Type column, the search
 * over names, descriptions and paths, the state, type (with counts) and
 * project filters, header sort, pages, the list's empty state, the "needs a
 * decision" chip in the grid's toolbar, and a tiles view beside the table.
 * A click on a row opens the component's page (`ComponentView`).
 */

import React, { useCallback, useMemo } from 'react';
import {
  Badge,
  DataGridActionsPlugin,
  DataGridRowClickPlugin,
  filterTagGroup,
  type DataGridFilterEntity,
  type DataGridTableColumn,
} from '@gears-frontx/ui-kit';
import { ComponentTypeIcon, type ComponentType } from '@constructor-studio/mfe-shared';
import {
  GridClearFilters,
  GridEmpty,
  ListGrid,
  createGridCells,
  tagGroupChoice,
  useLocalGridLoad,
} from '@constructor-studio/mfe-shared/grid';
import type { RegistryEntry } from '../../api/types';
import { ROW_STATES, type ComponentRow } from '../../model/catalogue';
import { hostsOf, projectsUsing, rowType, typeCounts } from '../../model/component-page';
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
import { ComponentTile, TypeBadge, ViewFromPreference, tilesPlugin, typeLabel, useVisibleRows } from './ComponentCards';
import { StatusChip, toneOf } from './parts';
import styles from './ComponentsScreen.module.css';
import cards from './ComponentView.module.css';

/** A row of the grid: a registry entry, a published node, or both, with its type. */
export interface RegistryRow extends ComponentRow {
  id: string;
  type: ComponentType;
}

/** The filter keys the grid hands `load`. */
export const REGISTRY_FILTERS = {
  state: 'state',
  type: 'type',
  project: 'project',
} as const;

/** Whether `row` passes the grid's state, type and project filters. */
export function keepsRegistryRow(row: RegistryRow, filters: Record<string, unknown>): boolean {
  const chosen = (key: string) => tagGroupChoice(filters[key] as { value?: unknown } | undefined);
  const state = chosen(REGISTRY_FILTERS.state);
  if (state && row.state !== state) return false;
  const type = chosen(REGISTRY_FILTERS.type);
  if (type && row.type !== type) return false;
  const project = chosen(REGISTRY_FILTERS.project);
  return !project || (row.entry?.occurrences ?? []).some((o) => o.project_id === project);
}

/** The list's rows with their types. */
export function registryRows(rows: readonly ComponentRow[]): RegistryRow[] {
  return rows.map((r) => ({ ...r, id: r.key, type: rowType(r) }));
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
    type: (a: RegistryRow, b: RegistryRow) => a.type.localeCompare(b.type),
    // What needs a decision first, as the state filter lists them.
    state: (a: RegistryRow, b: RegistryRow) => stateRank(a) - stateRank(b),
    release: (a: RegistryRow, b: RegistryRow) => releaseOf(a).localeCompare(releaseOf(b), undefined, { numeric: true }),
    // Unknown downloads sort below every known count, in both directions.
    downloads: (a: RegistryRow, b: RegistryRow) => (downloadsOf(a) ?? -Infinity) - (downloadsOf(b) ?? -Infinity),
  },
};

/** What a cell, a tile and the toolbar need beyond their row. */
interface RegistryCells {
  t: Text;
  /** Candidates waiting for a decision, and the orphans among the entries. */
  candidates: number;
  orphaned: number;
  onCandidates: (on: boolean) => void;
  onOpen: (row: RegistryRow) => void;
}

const [RegistryCellsProvider, useRegistryCells] = createGridCells<RegistryCells>('Registry');

const Dash: React.FC = () => <span className={styles.muted}>—</span>;

const NameCell: React.FC<{ item: RegistryRow }> = ({ item }) => {
  const { t } = useRegistryCells();
  return (
    <div className={cards.nameCell} data-registry-row={item.name}>
      <ComponentTypeIcon type={item.type} className={cards.nameIcon} size={18} />
      <div className={cards.nameStack}>
        <div>
          <span className={styles.name}>{item.name}</span>
          {item.entry && isDuplicated(item.entry) && (
            <>
              {' '}
              <Badge variant="warning" title={t('declared_many_title')}>
                ×{new Set(item.entry.occurrences.map((o) => o.repo)).size} {t('repos')}
              </Badge>
            </>
          )}
          {item.entry && isOrphaned(item.entry) && (
            <>
              {' '}
              <Badge variant="secondary" title={t('orphaned_title')}>
                {t('orphaned')}
              </Badge>
            </>
          )}
        </div>
        {item.description && <div className={styles.purpose}>{item.description}</div>}
      </div>
    </div>
  );
};

const TypeCell: React.FC<{ item: RegistryRow }> = ({ item }) => {
  const { t } = useRegistryCells();
  const reason = item.node?.value.component_type_reason;
  return <TypeBadge type={item.type} t={t} reason={typeof reason === 'string' ? reason : undefined} hosts={hostsOf(item.node)} />;
};

/** The row's state as chips: the registry's, and how far its publication went. */
function StateChips({ row }: { row: RegistryRow }) {
  const published = row.entry ? publishStatus(row.entry) : null;
  return (
    <span className={styles.chips}>
      <StatusChip
        tone={STATE_TONE[row.state] !== undefined ? toneOf(STATE_TONE[row.state]) : row.state === 'published' ? 'ok' : 'neutral'}
      >
        {STATE_LABEL[row.state] ?? row.state}
      </StatusChip>
      {published && (
        <StatusChip tone={published.kind === 'published' ? 'ok' : 'info'} data-registry-publish-status>
          {published.label}
        </StatusChip>
      )}
    </span>
  );
}

const StateCell: React.FC<{ item: RegistryRow }> = ({ item }) => <StateChips row={item} />;

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

/** The tiles view: one card per visible row. */
const RegistryTiles: React.FC = () => {
  const { t, onOpen } = useRegistryCells();
  const rows = useVisibleRows<RegistryRow>();
  return (
    <ul className={cards.tiles} data-component-tiles>
      {rows.map((row) => (
        <ComponentTile
          key={row.id}
          t={t}
          onOpen={() => onOpen(row)}
          tile={{
            key: row.id,
            name: row.name,
            type: row.type,
            state: <StateChips row={row} />,
            purpose: row.description,
            projects: projectsUsing(row.entry),
          }}
        />
      ))}
    </ul>
  );
};

const RegistryTilesPlugin = tilesPlugin('registryTiles', RegistryTiles);

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
  candidates,
  orphaned,
  onCandidates,
  onOpen,
}: {
  rows: ComponentRow[];
  entries: RegistryEntry[];
  withCatalogue: boolean;
  candidates: number;
  orphaned: number;
  onCandidates: (on: boolean) => void;
  /** Open a row's page. */
  onOpen: (row: RegistryRow) => void;
}) {
  const { t, bridge } = useScope();
  const rows = useMemo(() => registryRows(componentRows), [componentRows]);
  const { load, reloadBridge } = useLocalGridLoad(rows, REGISTRY_OPTIONS);

  const columns = useMemo<DataGridTableColumn<RegistryRow>[]>(() => {
    const out: DataGridTableColumn<RegistryRow>[] = [
      { id: 'component', label: t('col_component'), component: NameCell, minWidth: 240 },
      { id: 'type', label: t('col_type'), component: TypeCell, width: 150 },
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
  const types = typeCounts(rows.map((r) => r.type))
    .map((c) => `${c.type}\t${typeLabel(c.type, t)} ${c.count}`)
    .join('\n');
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
    add(REGISTRY_FILTERS.type, t('col_type'), types);
    add(REGISTRY_FILTERS.state, t('col_state'), states);
    add(REGISTRY_FILTERS.project, t('filter_project'), projects);
    return entities;
  }, [t, states, types, projects]);

  const cells = useMemo<RegistryCells>(
    () => ({ t, candidates, orphaned, onCandidates, onOpen }),
    [t, candidates, orphaned, onCandidates, onOpen]
  );
  const click = useCallback((row: RegistryRow) => onOpen(row), [onOpen]);

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
        minWidth="68rem"
      >
        <DataGridRowClickPlugin<RegistryRow> click={click} />
        <DataGridActionsPlugin component={DecideChip} />
        <RegistryTilesPlugin />
        <ViewFromPreference bridge={bridge} />
        {reloadBridge}
      </ListGrid>
    </RegistryCellsProvider>
  );
}
