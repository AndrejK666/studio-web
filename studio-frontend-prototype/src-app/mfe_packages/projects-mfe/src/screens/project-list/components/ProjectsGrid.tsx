/**
 * The workspace's projects on the kit's DataGrid, the way Specs draws its list
 * (#1076): the mockup's Projects Portfolio columns (Project, Phase, Status,
 * Issues, 7-day movement, Owner, Updated), search by name, a filter by phase,
 * header sort (most recently updated first), pages, the list's empty state,
 * the portal theme. A click on a row (or Enter on it) asks the shell to open
 * the project.
 *
 * The phase (Project lifecycle) comes with the rollup the list already reads
 * (`/rollups?workspace_id=`, its `phase`): read-only here, moved on the
 * project's Overview, where its lifecycle's moves are offered.
 */

import React, { useCallback, useMemo } from 'react';
import { FileSpreadsheet, Folder } from 'lucide-react';
import {
  Badge,
  DataGridRowClickPlugin,
  filterTagGroup,
  type DataGridFilterEntity,
  type DataGridTableColumn,
} from '@gears-frontx/ui-kit';
import { useFormatters, useMfeBridge } from '@gears-frontx/react';
import type { Tenant } from '@constructor-studio/mfe-shared';
import {
  GridClearFilters,
  GridEmpty,
  GridFooter,
  ListGrid,
  createGridCells,
  listChoices,
  useLocalGridLoad,
} from '@constructor-studio/mfe-shared/grid';
import { requestOpenProject } from '../../../actions/projectsActions';
import { useWorkspaceProjects } from '../../../shared/workspaceProjects';
import { useProjectConfig } from '../../../shared/useProjectConfig';
import { useProjectListText } from '../../../i18n';
import { OwnerInline } from './OwnerInline';
import { ProjectStatusInline } from './StatusInline';
import type { ProjectRollup } from '../../../api/ProjectStatusApiService';
import { PROJECT_PHASES, phaseLabel, phaseRank, phaseVariant } from '../../../shared/projectPhase';
import styles from '../ProjectListScreen.module.css';

/** A project of the list: its tenant, and the phase its rollup row says (`null` for none). */
export type ProjectRow = Tenant & { phase: string | null };

/** The phase filter's key in the grid's filters, and its choice for a project with no phase. */
export const PHASE_FILTER_KEY = 'phase';
export const NO_PHASE = 'none';

/** Whether a project passes the phase filter: any chosen phase, or every project with none chosen. */
export function keepsProject(row: ProjectRow, filters: Record<string, unknown>): boolean {
  const chosen = listChoices(filters[PHASE_FILTER_KEY] as { value?: unknown } | undefined);
  return chosen.length === 0 || chosen.includes(row.phase ?? NO_PHASE);
}

/** How the grid searches, filters and sorts the projects in memory. */
export const PROJECT_GRID_OPTIONS = {
  search: (row: ProjectRow) => row.name,
  filter: keepsProject,
  compare: {
    project: (a: ProjectRow, b: ProjectRow) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    // The lifecycle's order, a project with no phase last.
    phase: (a: ProjectRow, b: ProjectRow) => phaseRank(a.phase) - phaseRank(b.phase),
    updated: (a: ProjectRow, b: ProjectRow) => a.updated_at.localeCompare(b.updated_at),
  },
};

/** What a cell needs beyond its row. */
interface ProjectCells {
  t: ReturnType<typeof useProjectListText>;
  formatRelative: (value: string) => string;
  /** Each project's portfolio rollup (`/rollups?workspace_id=`), by id: its Issues and 7-day movement. */
  rollups: Record<string, ProjectRollup>;
  /** Which "nothing here yet" the list says: no organization, no workspace, or no project. */
  emptyNote: string;
}

const [ProjectCellsProvider, useProjectCells] = createGridCells<ProjectCells>('Projects');

/**
 * Every row is a project: the list is rooted at a workspace, and the tenant
 * type registry puts nothing else under one, so there are no container rows.
 */
const ProjectCell: React.FC<{ item: ProjectRow }> = ({ item }) => (
  <span className={styles.nameCell} data-project-row={item.id}>
    <span className={styles.rowGlyph} aria-hidden>
      <FileSpreadsheet size={16} strokeWidth={1.3} />
    </span>
    <span className={styles.name}>{item.name}</span>
  </span>
);

/** The project's phase as a badge in the lifecycle's colour; a dash where it has none. */
const PhaseCell: React.FC<{ item: ProjectRow }> = ({ item }) => {
  const { t } = useProjectCells();
  return item.phase ? (
    <Badge variant={phaseVariant(item.phase)} className={styles.phase} data-project-phase={item.phase}>
      {phaseLabel(item.phase, t)}
    </Badge>
  ) : (
    <span className={styles.noPhase} data-project-phase="none" title={t('phase_none')}>
      —
    </span>
  );
};

/** One metadata read per project, deduped by React Query between the Status and Owner cells. */
const StatusCell: React.FC<{ item: ProjectRow }> = ({ item }) => {
  const state = useProjectConfig(item.id);
  return <ProjectStatusInline tenant={item} state={state} />;
};

const OwnerCell: React.FC<{ item: ProjectRow }> = ({ item }) => {
  const state = useProjectConfig(item.id);
  return <OwnerInline state={state} />;
};

/** The open detector findings the rollup counts; null is "not asked", not zero. */
const IssuesCell: React.FC<{ item: ProjectRow }> = ({ item }) => {
  const { t, rollups } = useProjectCells();
  const rollup = rollups[item.id];
  return rollup?.open_findings == null ? (
    <span>{t('data_unavailable')}</span>
  ) : (
    <span data-project-issues>{t.count('issues_open', rollup.open_findings)}</span>
  );
};

/** The pull requests merged and open over the rollup's window; a count it could not read stays a dash. */
const MovementCell: React.FC<{ item: ProjectRow }> = ({ item }) => {
  const { t, rollups } = useProjectCells();
  const rollup = rollups[item.id];
  return rollup?.pulls_merged == null && rollup?.pulls_open == null ? (
    <span>{t('data_unavailable')}</span>
  ) : (
    <span data-project-movement>
      {t('movement_pulls', { merged: rollup.pulls_merged ?? '—', open: rollup.pulls_open ?? '—' })}
    </span>
  );
};

const UpdatedCell: React.FC<{ item: ProjectRow }> = ({ item }) => {
  const { formatRelative } = useProjectCells();
  return <span className={styles.updated}>{formatRelative(item.updated_at)}</span>;
};

const ProjectsEmpty: React.FC = () => {
  const { t, emptyNote } = useProjectCells();
  return (
    <GridEmpty
      icon={<Folder />}
      title={t('empty_title')}
      note={emptyNote}
      noMatches={t('empty_no_match')}
      noMatchesActions={<GridClearFilters label={t('clear_search')} />}
    />
  );
};

export interface ProjectsGridProps {
  /** Each project's portfolio rollup (`/rollups?workspace_id=`), by id: its counts and its phase; empty while unread or refused. */
  rollups?: Record<string, ProjectRollup>;
}

const NO_ROLLUPS: Record<string, ProjectRollup> = {};

/** The workspace in scope's projects, read from `WorkspaceProjectsProvider`. */
export const ProjectsGrid: React.FC<ProjectsGridProps> = ({ rollups = NO_ROLLUPS }) => {
  const t = useProjectListText();
  const { formatRelative } = useFormatters();
  const bridge = useMfeBridge();
  const { org, workspace, projects } = useWorkspaceProjects();
  // The phase rides on the row, so the filter and the sort read it; the rollup arriving reloads the grid.
  const rows = useMemo<ProjectRow[]>(
    () => projects.map((project) => ({ ...project, phase: rollups[project.id]?.phase ?? null })),
    [projects, rollups]
  );
  const { load, shown, reloadBridge } = useLocalGridLoad(rows, PROJECT_GRID_OPTIONS);

  const open = useCallback(
    (project: ProjectRow) => {
      if (!workspace) return;
      const siblings = projects.map((sibling) => ({ id: sibling.id, name: sibling.name }));
      requestOpenProject({ id: project.id, name: project.name }, siblings, bridge, workspace.id);
    },
    [bridge, projects, workspace]
  );

  const columns = useMemo<DataGridTableColumn<ProjectRow>[]>(
    () => [
      { id: 'project', label: t('col_project'), component: ProjectCell },
      { id: 'phase', label: t('col_phase'), component: PhaseCell, width: '11%', cellOverflow: 'nowrap' },
      { id: 'status', label: t('col_status'), component: StatusCell, width: '15%' },
      { id: 'issues', label: t('col_issues'), component: IssuesCell, width: '11%' },
      { id: 'movement', label: t('col_movement'), component: MovementCell, width: '15%' },
      { id: 'owner', label: t('col_owner'), component: OwnerCell, width: '15%', cellOverflow: 'nowrap' },
      { id: 'updated', label: t('col_updated'), component: UpdatedCell, width: '12%', cellOverflow: 'nowrap' },
    ],
    [t]
  );

  // The phases the projects are in, in the lifecycle's order (one it does not list after), then "no
  // phase": the filter offers only those, and is not there while no project has a phase.
  const known = PROJECT_PHASES.filter((phase) => rows.some((row) => row.phase === phase));
  const other = [...new Set(rows.map((row) => row.phase))]
    .filter((phase): phase is string => !!phase && !(PROJECT_PHASES as readonly string[]).includes(phase))
    .sort();
  const choicesKey = [...known, ...other, ...(rows.some((row) => !row.phase) ? [NO_PHASE] : [])].join(',');
  const filters = useMemo<DataGridFilterEntity[] | undefined>(() => {
    const choices = choicesKey ? choicesKey.split(',') : [];
    if (!choices.some((choice) => choice !== NO_PHASE)) return undefined;
    return [
      filterTagGroup({
        id: PHASE_FILTER_KEY,
        label: t('col_phase'),
        options: choices.map((value) => ({
          value,
          label: value === NO_PHASE ? t('phase_none') : phaseLabel(value, t),
        })),
      }),
    ];
  }, [t, choicesKey]);

  const emptyNote = !org ? t('empty_no_org') : !workspace ? t('empty_no_workspace') : t('empty_hint');
  const cells = useMemo<ProjectCells>(
    () => ({ t, formatRelative, rollups, emptyNote }),
    [t, formatRelative, rollups, emptyNote]
  );

  return (
    <ProjectCellsProvider value={cells}>
      <ListGrid<ProjectRow>
        name="projects"
        label={t('title')}
        columns={columns}
        load={load}
        search={t('search_placeholder')}
        filters={filters}
        empty={ProjectsEmpty}
        unsortable={['status', 'issues', 'movement', 'owner']}
        defaultOrder={{ id: 'updated', direction: 'desc' }}
        minWidth="62rem"
      >
        <DataGridRowClickPlugin<ProjectRow> click={open} />
        {reloadBridge}
      </ListGrid>
      {shown && shown.length > 0 && workspace && <GridFooter parts={[`${t('in_workspace')} ${workspace.name}`]} />}
    </ProjectCellsProvider>
  );
};

ProjectsGrid.displayName = 'ProjectsGrid';
