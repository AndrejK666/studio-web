/**
 * The workspace's projects on the kit's DataGrid, the way Specs draws its list
 * (#1076): the mockup's Projects Portfolio columns (Project, Status, Issues,
 * 7-day movement, Owner, Updated), search by name, header sort (most recently
 * updated first), pages, the list's empty state, the portal theme. A click on
 * a row (or Enter on it) asks the shell to open the project.
 */

import React, { useCallback, useMemo } from 'react';
import { FileSpreadsheet, Folder } from 'lucide-react';
import { Badge, DataGridRowClickPlugin, type DataGridTableColumn } from '@gears-frontx/ui-kit';
import { useFormatters, useMfeBridge } from '@gears-frontx/react';
import type { Tenant } from '@constructor-studio/mfe-shared';
import {
  GridClearFilters,
  GridEmpty,
  GridFooter,
  ListGrid,
  NoData,
  createGridCells,
  useLocalGridLoad,
} from '@constructor-studio/mfe-shared/grid';
import { requestOpenProject } from '../../../actions/projectsActions';
import { useWorkspaceProjects } from '../../../shared/workspaceProjects';
import { useProjectConfig } from '../../../shared/useProjectConfig';
import { useProjectListText } from '../../../i18n';
import { OwnerInline } from './OwnerInline';
import { ProjectStatusInline } from './StatusInline';
import type { ProjectRollup } from '../../../api/ProjectStatusApiService';
import styles from '../ProjectListScreen.module.css';

/** How the grid searches and sorts the projects in memory. */
export const PROJECT_GRID_OPTIONS = {
  search: (row: Tenant) => row.name,
  compare: {
    project: (a: Tenant, b: Tenant) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    updated: (a: Tenant, b: Tenant) => a.updated_at.localeCompare(b.updated_at),
  },
};

/** What a cell needs beyond its row. */
interface ProjectCells {
  t: ReturnType<typeof useProjectListText>;
  formatRelative: (value: string) => string;
  /** Each project's phase (Project lifecycle), by id; empty where the kit does not apply. */
  phases: Record<string, string>;
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
const ProjectCell: React.FC<{ item: Tenant }> = ({ item }) => {
  const { t, phases } = useProjectCells();
  const phase = phases[item.id];
  return (
    <span className={styles.nameCell} data-project-row={item.id}>
      <span className={styles.rowGlyph} aria-hidden>
        <FileSpreadsheet size={16} strokeWidth={1.3} />
      </span>
      <span className={styles.name}>{item.name}</span>
      {phase && (
        <Badge variant="info" className={styles.phase} data-project-phase={phase}>
          {t(`phase_${phase}`)}
        </Badge>
      )}
    </span>
  );
};

/** One metadata read per project, deduped by React Query between the Status and Owner cells. */
const StatusCell: React.FC<{ item: Tenant }> = ({ item }) => {
  const state = useProjectConfig(item.id);
  return <ProjectStatusInline tenant={item} state={state} />;
};

const OwnerCell: React.FC<{ item: Tenant }> = ({ item }) => {
  const state = useProjectConfig(item.id);
  return <OwnerInline state={state} />;
};

/** The open detector findings the rollup counts; null is "not asked", not zero. */
const IssuesCell: React.FC<{ item: Tenant }> = ({ item }) => {
  const { t, rollups } = useProjectCells();
  const rollup = rollups[item.id];
  return rollup?.open_findings == null ? (
    <NoData label={t('no_data')} />
  ) : (
    <span data-project-issues>{t.count('issues_open', rollup.open_findings)}</span>
  );
};

/** The pull requests merged and open over the rollup's window; a count it could not read stays a dash. */
const MovementCell: React.FC<{ item: Tenant }> = ({ item }) => {
  const { t, rollups } = useProjectCells();
  const rollup = rollups[item.id];
  return rollup?.pulls_merged == null && rollup?.pulls_open == null ? (
    <NoData label={t('no_data')} />
  ) : (
    <span data-project-movement>
      {t('movement_pulls', { merged: rollup.pulls_merged ?? '—', open: rollup.pulls_open ?? '—' })}
    </span>
  );
};

const UpdatedCell: React.FC<{ item: Tenant }> = ({ item }) => {
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
  /** Each project's phase (Project lifecycle), by id; empty where the kit does not apply. */
  phases?: Record<string, string>;
  /** Each project's portfolio rollup (`/rollups?workspace_id=`), by id; empty while unread or refused. */
  rollups?: Record<string, ProjectRollup>;
}

const NO_PHASES: Record<string, string> = {};
const NO_ROLLUPS: Record<string, ProjectRollup> = {};

/** The workspace in scope's projects, read from `WorkspaceProjectsProvider`. */
export const ProjectsGrid: React.FC<ProjectsGridProps> = ({ phases = NO_PHASES, rollups = NO_ROLLUPS }) => {
  const t = useProjectListText();
  const { formatRelative } = useFormatters();
  const bridge = useMfeBridge();
  const { org, workspace, projects } = useWorkspaceProjects();
  const { load, shown, reloadBridge } = useLocalGridLoad(projects, PROJECT_GRID_OPTIONS);

  const open = useCallback(
    (project: Tenant) => {
      if (!workspace) return;
      const siblings = projects.map((sibling) => ({ id: sibling.id, name: sibling.name }));
      requestOpenProject({ id: project.id, name: project.name }, siblings, bridge, workspace.id);
    },
    [bridge, projects, workspace]
  );

  const columns = useMemo<DataGridTableColumn<Tenant>[]>(
    () => [
      { id: 'project', label: t('col_project'), component: ProjectCell },
      { id: 'status', label: t('col_status'), component: StatusCell, width: '15%' },
      { id: 'issues', label: t('col_issues'), component: IssuesCell, width: '11%' },
      { id: 'movement', label: t('col_movement'), component: MovementCell, width: '15%' },
      { id: 'owner', label: t('col_owner'), component: OwnerCell, width: '15%', cellOverflow: 'nowrap' },
      { id: 'updated', label: t('col_updated'), component: UpdatedCell, width: '12%', cellOverflow: 'nowrap' },
    ],
    [t]
  );

  const emptyNote = !org ? t('empty_no_org') : !workspace ? t('empty_no_workspace') : t('empty_hint');
  const cells = useMemo<ProjectCells>(
    () => ({ t, formatRelative, phases, rollups, emptyNote }),
    [t, formatRelative, phases, rollups, emptyNote]
  );

  return (
    <ProjectCellsProvider value={cells}>
      <ListGrid<Tenant>
        name="projects"
        label={t('title')}
        columns={columns}
        load={load}
        search={t('search_placeholder')}
        empty={ProjectsEmpty}
        unsortable={['status', 'issues', 'movement', 'owner']}
        defaultOrder={{ id: 'updated', direction: 'desc' }}
        minWidth="56rem"
      >
        <DataGridRowClickPlugin<Tenant> click={open} />
        {reloadBridge}
      </ListGrid>
      {shown && shown.length > 0 && workspace && <GridFooter parts={[`${t('in_workspace')} ${workspace.name}`]} />}
    </ProjectCellsProvider>
  );
};

ProjectsGrid.displayName = 'ProjectsGrid';
