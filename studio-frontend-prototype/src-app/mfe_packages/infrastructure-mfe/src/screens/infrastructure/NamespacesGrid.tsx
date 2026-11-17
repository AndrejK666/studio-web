/**
 * The namespaces projects were given, on the kit's DataGrid, the way Specs
 * draws its list (#1076): search by project, environment and namespace, header
 * sort, pages, the list's empty state ("none assigned yet" / "nothing matched"
 * with Clear search), the portal theme. Change sits in the row's actions and
 * opens the assignment's form above the list, as Add does.
 */

import React, { useMemo } from 'react';
import { DataGridRowActionsPlugin, type DataGridTableColumn } from '@gears-frontx/ui-kit';
import {
  GridClearFilters,
  GridEmpty,
  ListGrid,
  createGridCells,
  useLocalGridLoad,
} from '@constructor-studio/mfe-shared/grid';
import type { AssignmentRow } from '../../model/namespace-assignments';
import { personLabel, relTime, useInfra, type PeopleNames } from './parts';
import styles from './InfrastructureScreen.module.css';

/** A row of the grid: an assignment, by its project and environment. */
export type AssignmentGridRow = AssignmentRow & { id: string };

interface AssignmentCells {
  people: PeopleNames;
  onChange: (row: AssignmentRow) => void;
}

const [AssignmentCellsProvider, useAssignmentCells] = createGridCells<AssignmentCells>('Namespaces');

const ProjectCell: React.FC<{ item: AssignmentGridRow }> = ({ item }) => (
  <b data-assignment={item.key}>{item.project}</b>
);

const EnvironmentCell: React.FC<{ item: AssignmentGridRow }> = ({ item }) => <span>{item.environment}</span>;

const NamespaceCell: React.FC<{ item: AssignmentGridRow }> = ({ item }) => <code>{item.namespace}</code>;

const BuildCell: React.FC<{ item: AssignmentGridRow }> = ({ item }) => {
  const { t } = useInfra();
  return item.build ? <code>{item.build}</code> : <span className={styles.muted}>{t('the_same')}</span>;
};

const AssignedCell: React.FC<{ item: AssignmentGridRow }> = ({ item }) => {
  const { t, language } = useInfra();
  const { people } = useAssignmentCells();
  const by = item.assignment.assigned_by;
  return (
    <span title={item.at ?? undefined}>
      {by === 'studio' ? t('assigned_by_run') : by ? personLabel(by, null, people, t) : '—'}
      {item.at ? <span className={styles.muted}> · {relTime(item.at, language)}</span> : null}
    </span>
  );
};

const RowActions: React.FC<{ item: AssignmentGridRow }> = ({ item }) => {
  const { t } = useInfra();
  const { onChange } = useAssignmentCells();
  return (
    <button type="button" className={styles.link} onClick={() => onChange(item)} data-assignment-change={item.key}>
      {t('change')}
    </button>
  );
};

const AssignmentsEmpty: React.FC = () => {
  const { t } = useInfra();
  return (
    <GridEmpty
      title={t('no_assignments')}
      noMatches={t('no_matches')}
      noMatchesActions={<GridClearFilters label={t('clear_search')} />}
    />
  );
};

const at = (row: AssignmentGridRow) => Date.parse(row.at ?? '') || 0;

const LOCAL_OPTIONS = {
  search: (r: AssignmentGridRow) => [r.project, r.environment, r.namespace, r.build],
  compare: {
    project: (a: AssignmentGridRow, b: AssignmentGridRow) => a.project.localeCompare(b.project),
    environment: (a: AssignmentGridRow, b: AssignmentGridRow) => a.environment.localeCompare(b.environment),
    namespace: (a: AssignmentGridRow, b: AssignmentGridRow) => a.namespace.localeCompare(b.namespace),
    assigned: (a: AssignmentGridRow, b: AssignmentGridRow) => at(a) - at(b),
  },
};

export const NamespacesGrid: React.FC<{
  rows: AssignmentRow[];
  people: PeopleNames;
  onChange: (row: AssignmentRow) => void;
}> = ({ rows, people, onChange }) => {
  const { t } = useInfra();
  const gridRows = useMemo<AssignmentGridRow[]>(() => rows.map((r) => ({ ...r, id: r.key })), [rows]);
  const { load, reloadBridge } = useLocalGridLoad(gridRows, LOCAL_OPTIONS);
  const columns = useMemo<DataGridTableColumn<AssignmentGridRow>[]>(
    () => [
      { id: 'project', label: t('col_project'), component: ProjectCell },
      { id: 'environment', label: t('col_environment'), component: EnvironmentCell, width: 160 },
      { id: 'namespace', label: t('col_namespace'), component: NamespaceCell },
      { id: 'builds_in', label: t('col_builds_in'), component: BuildCell },
      { id: 'assigned', label: t('col_assigned_by'), component: AssignedCell, width: 200 },
    ],
    [t]
  );
  const cells = useMemo<AssignmentCells>(() => ({ people, onChange }), [people, onChange]);
  return (
    <AssignmentCellsProvider value={cells}>
      <ListGrid<AssignmentGridRow>
        name="namespace-assignments"
        label={t('tab_namespaces')}
        columns={columns}
        load={load}
        search={t('search_assignments')}
        empty={AssignmentsEmpty}
        unsortable={['builds_in']}
        minWidth="52rem"
      >
        <DataGridRowActionsPlugin<AssignmentGridRow> component={RowActions} />
        {reloadBridge}
      </ListGrid>
    </AssignmentCellsProvider>
  );
};

NamespacesGrid.displayName = 'NamespacesGrid';
