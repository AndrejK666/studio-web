/**
 * What runs where, projects by environments, on the kit's DataGrid, the way
 * Specs draws its list (#1076): a row per project, a column per environment of
 * the ladder; search by project, header sort by project, pages, the list's
 * empty state ("nothing runs yet" / "nothing matched" with Clear search), the
 * portal theme. Per cell what runs and, beside it, the newest deploy when that
 * is not what runs.
 */

import React, { useMemo } from 'react';
import { Badge, type DataGridTableColumn } from '@gears-frontx/ui-kit';
import {
  GridClearFilters,
  GridEmpty,
  ListGrid,
  createGridCells,
  useLocalGridLoad,
} from '@constructor-studio/mfe-shared/grid';
import type { DeployEnvironment } from '../../api/types';
import { STATE_LABELS, stateTone } from '../../model/environments';
import { versionOf, type ProjectRuns } from '../../model/releases';
import { STATE_BADGE, relTime, useInfra } from './parts';
import styles from './InfrastructureScreen.module.css';

/** A row of the grid: a project's runs, by its id. */
export type RunsGridRow = ProjectRuns & { id: string };

interface RunsCells {
  /** The ladder, in the columns' order: column `env_<i>` is `ladder[i]`. */
  ladder: DeployEnvironment[];
}

const [RunsCellsProvider, useRunsCells] = createGridCells<RunsCells>('RunsWhere');

/** A column id for an environment: snake_case, as the kit asks; environment ids need not be. */
const columnOf = (index: number) => `env_${index}`;

const ProjectCell: React.FC<{ item: RunsGridRow }> = ({ item }) => (
  <b data-runs-row={item.projectName}>{item.projectName}</b>
);

const EnvironmentCell: React.FC<{ item: RunsGridRow; column: DataGridTableColumn<RunsGridRow> }> = ({
  item,
  column,
}) => {
  const { t, language } = useInfra();
  const { ladder } = useRunsCells();
  const env = ladder[Number(column.id.slice('env_'.length))];
  const cell = env ? item.cells.get(env.id) : undefined;
  if (!env || !cell) return <span className={styles.muted}>—</span>;
  const runs = cell.runs ? versionOf(cell.runs) : null;
  const asked = versionOf(cell.latest);
  // What runs, as a chip; the newest deploy beside it when it is not what
  // runs: waiting, deploying, failed, taken out.
  return (
    <div
      className={styles.chipRow}
      data-runs-cell={`${item.projectName}/${env.name}`}
      title={t('newest_deploy', { when: relTime(cell.latest.requested_at, language) })}
    >
      {runs ? <Badge variant="success">{runs}</Badge> : <span className={styles.muted}>{t('nothing_runs_cell')}</span>}
      {cell.latest.id !== cell.runs?.id && (
        <Badge variant={STATE_BADGE[stateTone(cell.latest.state)]} data-deployment-state={cell.latest.state}>
          {asked ? `${asked} · ` : ''}
          {STATE_LABELS[cell.latest.state] ?? cell.latest.state}
        </Badge>
      )}
    </div>
  );
};

const RunsEmpty: React.FC = () => {
  const { t } = useInfra();
  return (
    <GridEmpty
      title={t('nothing_runs')}
      noMatches={t('no_matches')}
      noMatchesActions={<GridClearFilters label={t('clear_search')} />}
    />
  );
};

const LOCAL_OPTIONS = {
  search: (r: RunsGridRow) => r.projectName,
  compare: { project: (a: RunsGridRow, b: RunsGridRow) => a.projectName.localeCompare(b.projectName) },
};

export const RunsWhereGrid: React.FC<{ rows: ProjectRuns[]; ladder: DeployEnvironment[] }> = ({ rows, ladder }) => {
  const { t } = useInfra();
  const gridRows = useMemo<RunsGridRow[]>(() => rows.map((r) => ({ ...r, id: r.projectId })), [rows]);
  const { load, reloadBridge } = useLocalGridLoad(gridRows, LOCAL_OPTIONS);
  const columns = useMemo<DataGridTableColumn<RunsGridRow>[]>(
    () => [
      { id: 'project', label: t('col_project'), component: ProjectCell, width: 200 },
      ...ladder.map((e, i) => ({ id: columnOf(i), label: e.name, component: EnvironmentCell })),
    ],
    [t, ladder]
  );
  const cells = useMemo<RunsCells>(() => ({ ladder }), [ladder]);
  return (
    <RunsCellsProvider value={cells}>
      <ListGrid<RunsGridRow>
        name="runs-where"
        label={t('tab_where')}
        columns={columns}
        load={load}
        search={t('search_projects')}
        empty={RunsEmpty}
        unsortable={ladder.map((_, i) => columnOf(i))}
        minWidth={`${12 + ladder.length * 12}rem`}
      >
        {reloadBridge}
      </ListGrid>
    </RunsCellsProvider>
  );
};

RunsWhereGrid.displayName = 'RunsWhereGrid';
