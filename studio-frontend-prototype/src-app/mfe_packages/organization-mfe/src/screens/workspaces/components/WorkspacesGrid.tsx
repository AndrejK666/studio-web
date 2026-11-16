/**
 * The organization's workspaces on the kit's DataGrid, the way Specs draws its
 * list (#1076): search by name, the managed filter, header sort, pages, the
 * list's empty state, the portal theme. A workspace the overview has projects
 * for opens into them through the grid's tree, with the overview's numbers per
 * project, as the table's folded rows had them. A click on a workspace row
 * opens it; Rename and Delete sit in its actions.
 */

import React, { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { Building2, Folder, FolderGit2 } from 'lucide-react';
import {
  Button,
  DataGridRowActionsPlugin,
  DataGridRowClickPlugin,
  DataGridTableTreePlugin,
  filterTagGroup,
  type DataGridLoadContext,
  type DataGridLoadResult,
  type DataGridTableColumn,
} from '@gears-frontx/ui-kit';
import { useFormatters } from '@gears-frontx/react';
import type { Tenant } from '@constructor-studio/mfe-shared';
import {
  GridClearFilters,
  GridEmpty,
  ListGrid,
  NoData,
  createGridCells,
  listChoices,
  pageOfRows,
  shownRows,
  useLocalGridReload,
} from '@constructor-studio/mfe-shared/grid';
import { useWorkspacesText } from '../../../i18n';
import { growthText, quietText, reasonLine } from '../../../overview/model';
import type { OrgProjectHealth, OrgWorkspace } from '../../../overview/types';
import { matchesManaged, workspaceSummary, type ManagedFilter } from '../model';
import styles from '../WorkspacesScreen.module.css';

/** A row of the grid: a workspace, or one of its projects under it. */
export type WorkspaceGridRow =
  | { id: string; kind: 'workspace'; tenant: Tenant; health: OrgWorkspace | undefined }
  | { id: string; kind: 'project'; project: OrgProjectHealth; workspaceId: string };

/** The managed filter's key in the grid's filters. */
export const MANAGED_FILTER_KEY = 'managed';

const workspaceRow = (tenant: Tenant, health: OrgWorkspace | undefined): WorkspaceGridRow => ({
  id: tenant.id,
  kind: 'workspace',
  tenant,
  health,
});

/** Whether a workspace row passes the managed filter: any chosen side, or every row with none chosen. */
export function keepsWorkspace(row: WorkspaceGridRow, filters: Record<string, unknown>): boolean {
  if (row.kind !== 'workspace') return true;
  const chosen = listChoices(filters[MANAGED_FILTER_KEY] as { value?: unknown } | undefined) as ManagedFilter[];
  return chosen.length === 0 || chosen.some((side) => matchesManaged(row.tenant, side));
}

const spendOf = (row: WorkspaceGridRow) => (row.kind === 'workspace' ? row.health?.spend : row.project.spend) ?? null;
const failingOf = (row: WorkspaceGridRow) =>
  (row.kind === 'workspace' ? row.health?.specs_failing : row.project.specs_failing) ?? 0;
const stuckOf = (row: WorkspaceGridRow) => (row.kind === 'workspace' ? row.health?.stuck : row.project.stuck) ?? 0;
const quietOf = (row: WorkspaceGridRow) =>
  (row.kind === 'workspace' ? row.health?.quiet_days : row.project.quiet_days) ?? null;
const nameOf = (row: WorkspaceGridRow) => (row.kind === 'workspace' ? row.tenant.name : row.project.name);

/** Unknown numbers sort below every known one, in both directions. */
const byNumber = (pick: (row: WorkspaceGridRow) => number | null | undefined) => (a: WorkspaceGridRow, b: WorkspaceGridRow) =>
  (pick(a) ?? -Infinity) - (pick(b) ?? -Infinity);

export const WORKSPACE_GRID_OPTIONS = {
  search: (row: WorkspaceGridRow) => nameOf(row),
  filter: keepsWorkspace,
  compare: {
    workspace: (a: WorkspaceGridRow, b: WorkspaceGridRow) => nameOf(a).localeCompare(nameOf(b)),
    projects: byNumber((row) => (row.kind === 'workspace' ? row.tenant.child_count : null)),
    spend: byNumber(spendOf),
    failing: byNumber(failingOf),
    stuck: byNumber(stuckOf),
    quiet: byNumber(quietOf),
    updated: (a: WorkspaceGridRow, b: WorkspaceGridRow) =>
      (a.kind === 'workspace' ? (a.tenant.updated_at ?? '') : '').localeCompare(
        b.kind === 'workspace' ? (b.tenant.updated_at ?? '') : ''
      ),
  },
};

/**
 * The grid's `load` over the rows in memory. A workspace's own load (the tree
 * opening it, `tree.parentId`) answers its projects from the overview, worst
 * first as the overview ranks them, whatever the search, filters and page say.
 */
export function workspaceGridLoad(
  rows: readonly WorkspaceGridRow[],
  context: DataGridLoadContext
): DataGridLoadResult<WorkspaceGridRow> {
  const parent = (context.tree as { parentId?: string | number | null } | undefined)?.parentId;
  if (parent !== undefined && parent !== null) {
    const owner = rows.find((row) => row.id === parent);
    const projects = owner?.kind === 'workspace' ? (owner.health?.projects ?? []) : [];
    const children: WorkspaceGridRow[] = projects.map((project) => ({
      id: `${String(parent)}/${project.id}`,
      kind: 'project',
      project,
      workspaceId: String(parent),
    }));
    return { results: children, total: children.length };
  }
  return pageOfRows(shownRows(rows, context, WORKSPACE_GRID_OPTIONS), context);
}

const opensProjects = (row: WorkspaceGridRow): boolean =>
  row.kind === 'workspace' && (row.health?.projects.length ?? 0) > 0;

/** What a cell needs beyond its row. */
interface WorkspaceCells {
  t: ReturnType<typeof useWorkspacesText>;
  formatRelative: (value: string) => string;
  stuckDays: number;
  cash: (value: number) => string;
  onOpen: (row: Tenant) => void;
  onRename: (row: Tenant) => void;
  onDelete: (row: Tenant) => void;
}

const [WorkspaceCellsProvider, useWorkspaceCells] = createGridCells<WorkspaceCells>('Workspaces');

const Dash: React.FC = () => {
  const { t } = useWorkspaceCells();
  return <NoData label={t('no_data')} />;
};

const NameCell: React.FC<{ item: WorkspaceGridRow }> = ({ item }) => {
  const { t, stuckDays } = useWorkspaceCells();
  if (item.kind === 'project') {
    const reasons = item.project.reasons;
    return (
      <span className={styles.nameCell} data-workspace-project={item.project.id}>
        <span className={styles.rowGlyph} aria-hidden>
          <FolderGit2 size={16} strokeWidth={1.3} />
        </span>
        <span className={styles.nameStack}>
          <span className={styles.name}>{item.project.name}</span>
          <span className={styles.summary}>
            {reasons.length > 0 ? reasonLine(reasons, stuckDays) : t('project_fine')}
          </span>
        </span>
      </span>
    );
  }
  const summary = workspaceSummary(item.tenant, item.health, stuckDays);
  return (
    <span className={styles.nameCell} data-workspace-row={item.id}>
      <span className={styles.rowGlyph} aria-hidden>
        <Building2 size={16} strokeWidth={1.3} />
      </span>
      <span className={styles.nameStack}>
        <span className={styles.name}>{item.tenant.name}</span>
        {summary && (
          <span className={styles.summary} data-workspace-description>
            {summary}
          </span>
        )}
      </span>
    </span>
  );
};

const Count: React.FC<{ value: React.ReactNode }> = ({ value }) => <span className={styles.count}>{value}</span>;

const ProjectsCell: React.FC<{ item: WorkspaceGridRow }> = ({ item }) =>
  item.kind === 'workspace' && item.tenant.child_count !== undefined ? (
    <Count value={item.tenant.child_count} />
  ) : (
    <Dash />
  );

const SpendCell: React.FC<{ item: WorkspaceGridRow }> = ({ item }) => {
  const { cash } = useWorkspaceCells();
  const spend = spendOf(item);
  return spend === null ? <Dash /> : <Count value={cash(spend)} />;
};

const DeltaCell: React.FC<{ item: WorkspaceGridRow }> = ({ item }) => {
  const spend = spendOf(item);
  const previous = (item.kind === 'workspace' ? item.health?.previous : item.project.previous) ?? null;
  return spend === null || previous === null ? <Dash /> : <Count value={growthText(spend, previous)} />;
};

const FailingCell: React.FC<{ item: WorkspaceGridRow }> = ({ item }) => {
  const failing = failingOf(item);
  return failing ? <Count value={failing} /> : <Dash />;
};

const StuckCell: React.FC<{ item: WorkspaceGridRow }> = ({ item }) => {
  const stuck = stuckOf(item);
  return stuck ? <Count value={stuck} /> : <Dash />;
};

const QuietCell: React.FC<{ item: WorkspaceGridRow }> = ({ item }) => {
  const days = quietOf(item);
  return days === null ? <Dash /> : <Count value={quietText(days)} />;
};

const UpdatedCell: React.FC<{ item: WorkspaceGridRow }> = ({ item }) => {
  const { formatRelative } = useWorkspaceCells();
  return item.kind === 'workspace' && item.tenant.updated_at ? (
    <span className={styles.updated}>{formatRelative(item.tenant.updated_at)}</span>
  ) : (
    <Dash />
  );
};

const RowActions: React.FC<{ item: WorkspaceGridRow }> = ({ item }) => {
  const { t, onOpen, onRename, onDelete } = useWorkspaceCells();
  if (item.kind !== 'workspace') return null;
  return (
    <span className={styles.rowActions}>
      <Button size="sm" variant="ghost" onClick={() => onOpen(item.tenant)}>
        {t('open')}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => onRename(item.tenant)} data-workspace-rename={item.id}>
        {t('rename')}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => onDelete(item.tenant)} data-workspace-delete={item.id}>
        {t('delete')}
      </Button>
    </span>
  );
};

const WorkspacesEmpty: React.FC = () => {
  const { t } = useWorkspaceCells();
  return (
    <GridEmpty
      icon={<Folder />}
      title={t('empty_title')}
      note={t('empty_hint')}
      noMatches={t('empty_search')}
      noMatchesActions={<GridClearFilters label={t('clear_search')} />}
    />
  );
};

export interface WorkspacesGridProps {
  workspaces: readonly Tenant[];
  /** A workspace's health in the organization overview; none while it is unread or refused. */
  health: (row: Tenant) => OrgWorkspace | undefined;
  /** The overview's threshold for a stuck pull request, in days. */
  stuckDays: number;
  cash: (value: number) => string;
  onOpen: (row: Tenant) => void;
  onRename: (row: Tenant) => void;
  onDelete: (row: Tenant) => void;
}

export const WorkspacesGrid: React.FC<WorkspacesGridProps> = ({
  workspaces,
  health,
  stuckDays,
  cash,
  onOpen,
  onRename,
  onDelete,
}) => {
  const t = useWorkspacesText();
  const { formatRelative } = useFormatters();
  const rows = useMemo(() => workspaces.map((tenant) => workspaceRow(tenant, health(tenant))), [workspaces, health]);
  const current = useRef(rows);
  useLayoutEffect(() => {
    current.current = rows;
  });
  const load = useCallback(async (context: DataGridLoadContext) => {
    const page = workspaceGridLoad(current.current, context);
    context.signal?.throwIfAborted();
    return page;
  }, []);
  const reloadBridge = useLocalGridReload(rows);

  const columns = useMemo<DataGridTableColumn<WorkspaceGridRow>[]>(
    () => [
      { id: 'workspace', label: t('col_workspace'), component: NameCell },
      { id: 'projects', label: t('col_projects'), component: ProjectsCell, width: 96 },
      { id: 'spend', label: t('col_spend'), component: SpendCell, width: 112 },
      { id: 'delta', label: t('col_delta'), component: DeltaCell, width: 72 },
      { id: 'failing', label: t('col_failing'), component: FailingCell, width: 112 },
      { id: 'stuck', label: t('col_stuck', { days: stuckDays }), component: StuckCell, width: 96 },
      { id: 'quiet', label: t('col_quiet'), component: QuietCell, width: 88 },
      { id: 'updated', label: t('col_updated'), component: UpdatedCell, width: 120 },
    ],
    [t, stuckDays]
  );
  const filters = useMemo(
    () => [
      filterTagGroup({
        id: MANAGED_FILTER_KEY,
        label: t('filter_label'),
        options: [
          { value: 'self', label: t('filter_self') },
          { value: 'org', label: t('filter_org') },
        ],
      }),
    ],
    [t]
  );
  const open = useCallback((row: WorkspaceGridRow) => row.kind === 'workspace' && onOpen(row.tenant), [onOpen]);
  const cells = useMemo<WorkspaceCells>(
    () => ({ t, formatRelative, stuckDays, cash, onOpen, onRename, onDelete }),
    [t, formatRelative, stuckDays, cash, onOpen, onRename, onDelete]
  );

  return (
    <WorkspaceCellsProvider value={cells}>
      <ListGrid<WorkspaceGridRow>
        name="workspaces"
        label={t('table_label')}
        columns={columns}
        load={load}
        search={t('search_placeholder')}
        filters={filters}
        empty={WorkspacesEmpty}
        defaultOrder={{ id: 'workspace', direction: 'asc' }}
        minWidth="64rem"
      >
        <DataGridRowClickPlugin<WorkspaceGridRow> click={open} />
        <DataGridTableTreePlugin<WorkspaceGridRow> expandable={opensProjects} />
        <DataGridRowActionsPlugin<WorkspaceGridRow> component={RowActions} />
        {reloadBridge}
      </ListGrid>
    </WorkspaceCellsProvider>
  );
};

WorkspacesGrid.displayName = 'WorkspacesGrid';
