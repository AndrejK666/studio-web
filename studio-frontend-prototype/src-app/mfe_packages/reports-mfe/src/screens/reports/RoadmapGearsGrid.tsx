/**
 * The roadmap report's row per planned gear on the kit's DataGrid, the way
 * Specs draws its list (#1076): search by gear, component, demand and
 * assignee, quick filters for stage, plan and milestone, header sort, pages,
 * the portal theme. Every value is the server's, as the table had it.
 */

import React, { useMemo } from 'react';
import { filterTagGroup, type DataGridFilterEntity, type DataGridTableColumn } from '@gears-frontx/ui-kit';
import {
  GridClearFilters,
  GridEmpty,
  ListGrid,
  NoData,
  createGridCells,
  listChoices,
  useLocalGridLoad,
} from '@constructor-studio/mfe-shared/grid';
import { demandText, type RoadmapRow } from '../../model/roadmap-report';
import { StatusChip, type Text, type Tone } from './parts';
import styles from './ReportsScreen.module.css';

/** A gear's row, with the id the grid keys it by. */
export interface GearRow extends RoadmapRow {
  id: string;
}

/** The filter keys the grid hands `load`. */
export const GEAR_FILTERS = { stage: 'stage', plan: 'plan', milestone: 'milestone' } as const;

/** A plan lamp as a chip tone. */
const LAMP: Record<string, Tone> = { good: 'ok', watch: 'warn', bad: 'danger' };

export const gearRows = (items: readonly RoadmapRow[]): GearRow[] =>
  items.map((row) => ({ ...row, id: `${row.number ?? ''}:${row.title}` }));

/** Whether `row` passes the grid's filters: within a filter any choice, across filters every one. */
export function keepsGear(row: GearRow, filters: Record<string, unknown>): boolean {
  const chosen = (key: string) => listChoices(filters[key] as { value?: unknown } | undefined);
  const stages = chosen(GEAR_FILTERS.stage);
  if (stages.length > 0 && !stages.includes(row.readiness.stage ?? '')) return false;
  const plans = chosen(GEAR_FILTERS.plan);
  if (plans.length > 0 && !plans.includes(row.readiness.plan ?? '')) return false;
  const milestones = chosen(GEAR_FILTERS.milestone);
  return milestones.length === 0 || milestones.includes(row.readiness.milestone ?? '');
}

const byText = (pick: (row: GearRow) => string | null | undefined) => (a: GearRow, b: GearRow) =>
  (pick(a) ?? '').localeCompare(pick(b) ?? '', undefined, { sensitivity: 'base', numeric: true });

/** Unknown numbers sort below every known one, in both directions. */
const byNumber = (pick: (row: GearRow) => number | null) => (a: GearRow, b: GearRow) =>
  (pick(a) ?? -Infinity) - (pick(b) ?? -Infinity);

const GEAR_OPTIONS = {
  search: (row: GearRow) => [
    row.title,
    row.name,
    row.group,
    row.assignees,
    demandText(row.readiness.demand),
    ...row.components,
  ],
  filter: keepsGear,
  compare: {
    gear: byText((row) => row.title),
    stage: byNumber((row) => row.readiness.stage_at),
    milestone: byText((row) => row.readiness.due ?? row.readiness.milestone),
    plan: byText((row) => row.readiness.plan),
    assignees: byText((row) => row.assignees),
    effort: byNumber((row) => row.effort_md),
    grade: byText((row) => row.readiness.grade),
  },
};

const [GearCellsProvider, useGearCells] = createGridCells<{ t: Text }>('RoadmapGears');

const Dash: React.FC = () => <NoData label={useGearCells().t('no_data')} />;

const GearCell: React.FC<{ item: GearRow }> = ({ item: row }) => {
  const { t } = useGearCells();
  const link = row.readiness.roadmap_item;
  return (
    <span data-roadmap-row={row.title}>
      {link ? (
        <a href={link} target="_blank" rel="noreferrer" title={row.roadmap_title ?? ''}>
          {row.title}
        </a>
      ) : (
        row.title
      )}
      <span className={`${styles.sub} ${styles.line}`}>
        {row.components.length ? row.components.join(', ') : t('not_in_code')}
      </span>
    </span>
  );
};

const StageCell: React.FC<{ item: GearRow }> = ({ item: row }) =>
  row.readiness.stage ? <span>{row.readiness.stage}</span> : <Dash />;

const MilestoneCell: React.FC<{ item: GearRow }> = ({ item: row }) => {
  const { t } = useGearCells();
  const r = row.readiness;
  if (!r.milestone && !r.due && !r.committed) return <Dash />;
  return (
    <span className={styles.date}>
      {r.milestone ?? ''}
      {r.due && <span className={styles.mutedInline}> · {r.due}</span>}
      {r.committed && ` · ${t('committed')}`}
    </span>
  );
};

const PlanCell: React.FC<{ item: GearRow }> = ({ item: row }) => {
  const r = row.readiness;
  if (!r.plan && r.plan_reasons.length === 0) return <Dash />;
  return (
    <span title={r.plan_reasons.join('\n')}>
      {r.plan && <StatusChip tone={LAMP[r.plan_lamp ?? ''] ?? 'neutral'}>{r.plan}</StatusChip>}
      {r.plan_reasons.length > 0 && (
        <span className={`${styles.mutedInline} ${styles.line}`}>
          {r.plan_reasons.join('; ')}
        </span>
      )}
    </span>
  );
};

const DemandCell: React.FC<{ item: GearRow }> = ({ item: row }) => {
  const text = demandText(row.readiness.demand);
  return text ? <span>{text}</span> : <Dash />;
};

const AssigneesCell: React.FC<{ item: GearRow }> = ({ item: row }) =>
  row.assignees ? <span>{row.assignees}</span> : <Dash />;

const EffortCell: React.FC<{ item: GearRow }> = ({ item: row }) => {
  const { t } = useGearCells();
  if (row.effort_md === null && row.remaining_md === null) return <Dash />;
  return (
    <span className={`${styles.num} ${styles.line}`}>
      {row.effort_md === null ? '' : t('days', { n: row.effort_md })}
      {row.remaining_md !== null && row.remaining_md !== row.effort_md && (
        <span className={`${styles.sub} ${styles.line}`}>
          {t('days_left', { n: Math.round(row.remaining_md) })}
        </span>
      )}
    </span>
  );
};

const GradeCell: React.FC<{ item: GearRow }> = ({ item: row }) =>
  row.readiness.grade ? <span>{row.readiness.grade}</span> : <Dash />;

const GearsEmpty: React.FC = () => {
  const { t } = useGearCells();
  return (
    <GridEmpty
      title={t('no_gears_title')}
      note={t('no_gears_body')}
      noMatches={t('no_gears_match')}
      noMatchesActions={<GridClearFilters label={t('clear_search')} />}
    />
  );
};

const distinct = (values: (string | null)[]) =>
  [...new Set(values.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

/** A tag group offering the values `joined` holds, one per line; none without any. */
function tagGroup(id: string, label: string, joined: string): DataGridFilterEntity[] {
  if (!joined) return [];
  return [filterTagGroup({ id, label, options: joined.split('\n').map((value) => ({ value, label: value })) })];
}

/** The report's gears, in the server's order until a header sorts them. */
export const RoadmapGearsGrid: React.FC<{ rows: readonly GearRow[]; t: Text }> = ({ rows, t }) => {
  const { load, reloadBridge } = useLocalGridLoad(rows, GEAR_OPTIONS);
  const columns = useMemo<DataGridTableColumn<GearRow>[]>(
    () => [
      { id: 'gear', label: t('col_gear'), component: GearCell },
      { id: 'stage', label: t('col_stage'), component: StageCell, width: 120 },
      { id: 'milestone', label: t('col_milestone'), component: MilestoneCell, width: 180 },
      { id: 'plan', label: t('col_plan'), component: PlanCell, width: 200 },
      { id: 'demand', label: t('col_demand'), component: DemandCell, width: 160 },
      { id: 'assignees', label: t('col_assignees'), component: AssigneesCell, width: 160 },
      { id: 'effort', label: t('col_effort'), component: EffortCell, width: 110 },
      { id: 'grade', label: t('col_grade'), component: GradeCell, width: 90 },
    ],
    [t]
  );
  // The options a filter offers are the ones the rows have: one entity list per set of them.
  const stages = distinct(rows.map((row) => row.readiness.stage)).join('\n');
  const plans = distinct(rows.map((row) => row.readiness.plan)).join('\n');
  const milestones = distinct(rows.map((row) => row.readiness.milestone)).join('\n');
  const filters = useMemo(
    () => [
      ...tagGroup(GEAR_FILTERS.stage, t('col_stage'), stages),
      ...tagGroup(GEAR_FILTERS.plan, t('col_plan'), plans),
      ...tagGroup(GEAR_FILTERS.milestone, t('col_milestone'), milestones),
    ],
    [t, stages, plans, milestones]
  );
  const cells = useMemo(() => ({ t }), [t]);
  return (
    <GearCellsProvider value={cells}>
      <ListGrid<GearRow>
        name="roadmap-gears"
        label={t('col_gears')}
        columns={columns}
        load={load}
        search={t('search_gears')}
        filters={filters}
        empty={GearsEmpty}
        unsortable={['demand']}
        minWidth="64rem"
      >
        {reloadBridge}
      </ListGrid>
    </GearCellsProvider>
  );
};

RoadmapGearsGrid.displayName = 'RoadmapGearsGrid';
