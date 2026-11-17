/**
 * Background work's two lists on the kit's DataGrid, the way Specs draws its
 * list (#1076): search, header sort, pages, the list's own empty states, the
 * portal theme.
 *
 * Runs: the state and the task type are quick filters, but the server answers
 * them (it narrows by one state, and the default asks for failed and running
 * apart): the grid's choice goes back to the screen, which reads the runs
 * again, and the rows already in memory are narrowed the same way meanwhile.
 * No state chosen is the default, what failed and what is running. Retry and
 * Cancel sit in the row's actions; a click on a row opens its details under
 * the list. Schedules: search by name, task type and cadence; Run now in the
 * row's actions.
 */

import React, { useCallback, useMemo } from 'react';
import {
  Badge,
  Button,
  DataGridRowActionsPlugin,
  DataGridRowClickPlugin,
  filterTagGroup,
  type DataGridLoadContext,
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
import {
  ATTENTION_STATES,
  EVERY_STATE,
  STATES,
  duration,
  finished,
  headline,
  stateTone,
  type ShownRun,
  type Tone,
} from '../../background/model';
import type { TaskRun, TaskSchedule } from '../../background/types';
import type { useBackgroundTranslations } from '../../i18n';
import styles from './BackgroundScreen.module.css';

export type Text = ReturnType<typeof useBackgroundTranslations>['t'];

/** The filter keys the runs grid hands `load`. */
export const RUN_FILTERS = { state: 'state', taskType: 'task_type' } as const;

type Filters = NonNullable<DataGridLoadContext['filters']>;

const VARIANT: Record<Tone, 'success' | 'info' | 'danger' | 'warning' | 'secondary'> = {
  ok: 'success',
  running: 'info',
  danger: 'danger',
  warn: 'warning',
  neutral: 'secondary',
};

export function when(iso: string | null | undefined, language: string): string {
  if (!iso) return '—';
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString(language);
}

/** The server's question the grid's filters ask: a state (`null` for failed and running) and a task type (`''` for any). */
export interface RunQuery {
  state: string | null;
  taskType: string;
}

export function runQueryOf(filters: Filters | undefined): RunQuery {
  return {
    state: tagGroupChoice(filters?.[RUN_FILTERS.state]),
    taskType: tagGroupChoice(filters?.[RUN_FILTERS.taskType]) ?? '',
  };
}

/** Whether a run in memory answers the query, while the server is asked again. */
export function keepsRun(run: TaskRun, filters: Filters): boolean {
  const { state, taskType } = runQueryOf(filters);
  if (taskType && run.task_type !== taskType) return false;
  if (state === null) return (ATTENTION_STATES as readonly string[]).includes(run.state);
  return state === EVERY_STATE || run.state === state;
}

const RUN_ORDER: readonly string[] = STATES;

const RUN_OPTIONS = {
  search: (run: ShownRun) => [run.task_type, run.id, headline(run)],
  filter: keepsRun,
  compare: {
    task: (a: ShownRun, b: ShownRun) => a.task_type.localeCompare(b.task_type),
    state: (a: ShownRun, b: ShownRun) => RUN_ORDER.indexOf(a.state) - RUN_ORDER.indexOf(b.state),
    tries: (a: ShownRun, b: ShownRun) => a.attempts - b.attempts,
    started: (a: ShownRun, b: ShownRun) =>
      (a.started_at ?? a.created_at).localeCompare(b.started_at ?? b.created_at),
  },
};

interface RunCells {
  t: Text;
  language: string;
  /** The instant "took" counts to for a run still moving: when the page was read. */
  now: number;
  cadenceOf: (taskType: string) => string | undefined;
  onAct: (run: TaskRun, what: 'cancel' | 'retry') => void;
}

const [RunCellsProvider, useRunCells] = createGridCells<RunCells>('Runs');

const TaskCell: React.FC<{ item: ShownRun }> = ({ item }) => {
  const { t, cadenceOf } = useRunCells();
  return (
    <div data-run={item.state} data-run-id={item.id}>
      <b>{item.task_type}</b>
      <div className={styles.muted}>
        {item.folded !== undefined ? (
          <>
            {t('folded', { cadence: cadenceOf(item.task_type) ?? t('scheduled') })}
            {item.folded > 0 && ` · ${t('folded_more', { count: item.folded })}`}
          </>
        ) : (
          item.id.slice(0, 8)
        )}
      </div>
    </div>
  );
};

const StateCell: React.FC<{ item: ShownRun }> = ({ item }) => {
  const { t } = useRunCells();
  return (
    <div>
      <Badge variant={VARIANT[stateTone(item.state)]}>{t(`state_${item.state}`)}</Badge>
      {item.cancel_requested && !finished(item) && <div className={styles.muted}>{t('stop_requested')}</div>}
    </div>
  );
};

const WhatCell: React.FC<{ item: ShownRun }> = ({ item }) => <span className={styles.muted}>{headline(item)}</span>;

const TriesCell: React.FC<{ item: ShownRun }> = ({ item }) => <span>{item.attempts}</span>;

const TookCell: React.FC<{ item: ShownRun }> = ({ item }) => {
  const { now } = useRunCells();
  return <span className={styles.muted}>{duration(item, now)}</span>;
};

const StartedCell: React.FC<{ item: ShownRun }> = ({ item }) => {
  const { language } = useRunCells();
  return <span>{when(item.started_at ?? item.created_at, language)}</span>;
};

const RunActions: React.FC<{ item: ShownRun }> = ({ item }) => {
  const { t, onAct } = useRunCells();
  return (
    <span className={styles.actions} data-grid-row-ignore-click>
      {(item.state === 'failed' || item.state === 'cancelled') && (
        <Button variant="ghost" size="sm" onClick={() => onAct(item, 'retry')}>
          {t('retry')}
        </Button>
      )}
      {!finished(item) && (
        <Button variant="ghost" size="sm" disabled={item.cancel_requested} onClick={() => onAct(item, 'cancel')}>
          {t('cancel')}
        </Button>
      )}
    </span>
  );
};

const RunsEmpty: React.FC = () => {
  const { t } = useRunCells();
  return (
    <GridEmpty
      title={t('runs_empty')}
      noMatches={t('runs_no_matches')}
      noMatchesActions={<GridClearFilters label={t('clear_search')} />}
    />
  );
};

export interface RunsGridProps {
  rows: ShownRun[];
  t: Text;
  language: string;
  now: number;
  /** How many runs the server has in each state, for the state filter's labels. */
  counts: Partial<Record<string, number>>;
  types: string[];
  cadenceOf: (taskType: string) => string | undefined;
  onAct: (run: TaskRun, what: 'cancel' | 'retry') => void;
  /** The grid's state and type filters, for the screen to ask the server. */
  onQuery: (query: RunQuery) => void;
  onOpen: (run: ShownRun) => void;
}

export const RunsGrid: React.FC<RunsGridProps> = ({
  rows,
  t,
  language,
  now,
  counts,
  types,
  cadenceOf,
  onAct,
  onQuery,
  onOpen,
}) => {
  const { load: localLoad, reloadBridge } = useLocalGridLoad(rows, RUN_OPTIONS);
  const load = useCallback(
    (context: DataGridLoadContext) => {
      onQuery(runQueryOf(context.filters));
      return localLoad(context);
    },
    [localLoad, onQuery]
  );

  const columns = useMemo<DataGridTableColumn<ShownRun>[]>(
    () => [
      { id: 'task', label: t('col_task'), component: TaskCell },
      { id: 'state', label: t('col_state'), component: StateCell, width: 140 },
      { id: 'what', label: t('col_what'), component: WhatCell },
      { id: 'tries', label: t('col_tries'), component: TriesCell, width: 90 },
      { id: 'took', label: t('col_took'), component: TookCell, width: 110 },
      { id: 'started', label: t('col_started'), component: StartedCell, width: 190 },
    ],
    [t]
  );
  // One entity list per set of counts and types: the labels carry the counts.
  const stateLabels = STATES.map((st) => `${st}:${counts[st] ?? ''}`).join(',');
  const typeList = types.join(',');
  const filters = useMemo(() => {
    const states = stateLabels.split(',').map((entry) => entry.split(':') as [string, string]);
    const entities = [
      filterTagGroup({
        id: RUN_FILTERS.state,
        label: t('col_state'),
        mode: 'radio',
        options: [
          ...states.map(([st, count]) => ({
            value: st,
            label: count ? `${t(`state_${st}`)} (${count})` : t(`state_${st}`),
          })),
          { value: EVERY_STATE, label: t('filter_every') },
        ],
      }),
    ];
    if (typeList) {
      entities.push(
        filterTagGroup({
          id: RUN_FILTERS.taskType,
          label: t('filter_task_type'),
          mode: 'radio',
          options: typeList.split(',').map((ty) => ({ value: ty, label: ty })),
        })
      );
    }
    return entities;
  }, [t, stateLabels, typeList]);

  const cells = useMemo<RunCells>(() => ({ t, language, now, cadenceOf, onAct }), [t, language, now, cadenceOf, onAct]);

  return (
    <RunCellsProvider value={cells}>
      <ListGrid<ShownRun>
        name="background-runs"
        label={t('runs')}
        columns={columns}
        load={load}
        search={t('search_runs')}
        filters={filters}
        empty={RunsEmpty}
        unsortable={['what', 'took']}
        minWidth="56rem"
      >
        <DataGridRowClickPlugin<ShownRun> click={onOpen} />
        <DataGridRowActionsPlugin<ShownRun> component={RunActions} />
        {reloadBridge}
      </ListGrid>
    </RunCellsProvider>
  );
};

RunsGrid.displayName = 'RunsGrid';

/** A run's details, under the list. */
export const RunDetails: React.FC<{ run: ShownRun; t: Text; language: string }> = ({ run, t, language }) => (
  <dl className={styles.details} data-run-details={run.id}>
    <dt>{t('detail_id')}</dt>
    <dd>{run.id}</dd>
    <dt>{t('detail_by')}</dt>
    <dd>{run.requested_by}</dd>
    {run.partition_key && (
      <>
        <dt>{t('detail_partition')}</dt>
        <dd>{run.partition_key}</dd>
      </>
    )}
    <dt>{t('detail_created')}</dt>
    <dd>{when(run.created_at, language)}</dd>
    <dt>{t('detail_finished')}</dt>
    <dd>{when(run.finished_at, language)}</dd>
    {run.progress && (
      <>
        <dt>{t('detail_progress')}</dt>
        <dd>{run.progress}</dd>
      </>
    )}
    {run.last_error && (
      <>
        <dt>{t('detail_error')}</dt>
        <dd>{run.last_error}</dd>
      </>
    )}
    <dt>{t('detail_payload')}</dt>
    <dd>
      <pre className={styles.json}>{JSON.stringify(run.payload, null, 2)}</pre>
    </dd>
    {run.result && (
      <>
        <dt>{t('detail_result')}</dt>
        <dd>
          <pre className={styles.json}>{JSON.stringify(run.result, null, 2)}</pre>
        </dd>
      </>
    )}
  </dl>
);

RunDetails.displayName = 'RunDetails';

/** A schedule in the grid. */
type ScheduleRow = TaskSchedule;

const SCHEDULE_OPTIONS = {
  search: (sc: ScheduleRow) => [sc.name, sc.task_type, sc.expression],
  compare: {
    schedule: (a: ScheduleRow, b: ScheduleRow) => a.name.localeCompare(b.name),
    runs: (a: ScheduleRow, b: ScheduleRow) => a.task_type.localeCompare(b.task_type),
    next: (a: ScheduleRow, b: ScheduleRow) => (a.next_run_at ?? '').localeCompare(b.next_run_at ?? ''),
    last: (a: ScheduleRow, b: ScheduleRow) => (a.last_fired_at ?? '').localeCompare(b.last_fired_at ?? ''),
  },
};

interface ScheduleCells {
  t: Text;
  language: string;
  runNow: (sc: TaskSchedule) => void;
}

const [ScheduleCellsProvider, useScheduleCells] = createGridCells<ScheduleCells>('Schedules');

const ScheduleCell: React.FC<{ item: ScheduleRow }> = ({ item }) => {
  const { t } = useScheduleCells();
  return (
    <span data-schedule={item.id}>
      <b>{item.name}</b> {!item.enabled && <Badge variant="warning">{t('disabled')}</Badge>}
    </span>
  );
};

const ScheduleRunsCell: React.FC<{ item: ScheduleRow }> = ({ item }) => (
  <span className={styles.muted}>{item.task_type}</span>
);

const CadenceCell: React.FC<{ item: ScheduleRow }> = ({ item }) => (
  <div className={styles.muted}>
    {item.expression}
    <div>
      {item.expression_kind} · {item.timezone}
    </div>
  </div>
);

const PoliciesCell: React.FC<{ item: ScheduleRow }> = ({ item }) => (
  <span className={styles.muted}>
    {item.concurrency} · {item.missed_policy}
    {item.missed_policy === 'backfill' && ` (≤${item.max_catch_up_runs})`}
  </span>
);

const NextCell: React.FC<{ item: ScheduleRow }> = ({ item }) => {
  const { language } = useScheduleCells();
  return <span>{when(item.next_run_at, language)}</span>;
};

const LastCell: React.FC<{ item: ScheduleRow }> = ({ item }) => {
  const { language } = useScheduleCells();
  return <span>{when(item.last_fired_at, language)}</span>;
};

const ScheduleActions: React.FC<{ item: ScheduleRow }> = ({ item }) => {
  const { t, runNow } = useScheduleCells();
  return (
    <Button variant="ghost" size="sm" onClick={() => runNow(item)} data-schedule-run-now={item.id}>
      {t('run_now')}
    </Button>
  );
};

const SchedulesEmpty: React.FC = () => {
  const { t } = useScheduleCells();
  return (
    <GridEmpty
      title={t('schedules_empty')}
      noMatches={t('schedules_no_matches')}
      noMatchesActions={<GridClearFilters label={t('clear_search')} />}
    />
  );
};

export const SchedulesGrid: React.FC<{
  schedules: TaskSchedule[];
  t: Text;
  language: string;
  runNow: (sc: TaskSchedule) => void;
}> = ({ schedules, t, language, runNow }) => {
  const { load, reloadBridge } = useLocalGridLoad(schedules, SCHEDULE_OPTIONS);
  const columns = useMemo<DataGridTableColumn<ScheduleRow>[]>(
    () => [
      { id: 'schedule', label: t('col_schedule'), component: ScheduleCell },
      { id: 'runs', label: t('col_runs'), component: ScheduleRunsCell },
      { id: 'cadence', label: t('col_cadence'), component: CadenceCell },
      { id: 'policies', label: t('col_policies'), component: PoliciesCell },
      { id: 'next', label: t('col_next'), component: NextCell, width: 190 },
      { id: 'last', label: t('col_last'), component: LastCell, width: 190 },
    ],
    [t]
  );
  const cells = useMemo<ScheduleCells>(() => ({ t, language, runNow }), [t, language, runNow]);
  return (
    <ScheduleCellsProvider value={cells}>
      <ListGrid<ScheduleRow>
        name="background-schedules"
        label={t('schedules')}
        columns={columns}
        load={load}
        search={t('search_schedules')}
        empty={SchedulesEmpty}
        unsortable={['cadence', 'policies']}
        defaultOrder={{ id: 'schedule', direction: 'asc' }}
        minWidth="56rem"
      >
        <DataGridRowActionsPlugin<ScheduleRow> component={ScheduleActions} />
        {reloadBridge}
      </ListGrid>
    </ScheduleCellsProvider>
  );
};

SchedulesGrid.displayName = 'SchedulesGrid';
