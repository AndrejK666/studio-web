/**
 * One gear match's report on the kit's DataGrid, the way Specs and Workspaces
 * draw their lists (#1076): search, a filter, header sort, pages and the
 * list's empty state, in two views of the same report —
 *
 * - **By requirement**: a row per requirement (its id, verdict, best gear,
 *   confidence, where the spec says it, what to do), opening through the
 *   grid's tree into the passage and its candidate gears, each with the
 *   matcher's evidence and Add / Reject;
 * - **By gear**: a row per gear the run named, with how many requirements it
 *   covers fully or partly, its best confidence, whether the product has it
 *   and whether it has code, opening into the requirements it answers; Add to
 *   product / Reject on the gear. Sorted by coverage, so the gears that carry
 *   the product come first and the missing ones show.
 *
 * The view, the search, the filter and the order are kept in the address,
 * as the other lists keep theirs.
 */

import React, { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { FileSearch } from 'lucide-react';
import {
  Badge,
  Button,
  DataGridTableTreePlugin,
  filterTagGroup,
  type DataGridLoadContext,
  type DataGridLoadResult,
  type DataGridTableColumn,
} from '@gears-frontx/ui-kit';
import {
  GridAddress,
  GridClearFilters,
  GridEmpty,
  GridTreeReplace,
  ListGrid,
  NoData,
  createGridCells,
  pageOfRows,
  shownRows,
  tagGroupChoice,
  useLocalGridReload,
  writeGridAddress,
  type LocalGridOptions,
} from '@constructor-studio/mfe-shared/grid';
import { actionLabel, addability, coverageTone, shortId, type GearMatch, type GearMatchCandidate, type GearMatchRequirement } from '../../../model/gear-match';
import {
  GEAR_FILTER,
  GEAR_FILTERS,
  VERDICTS,
  VERDICT_FILTER,
  coverageScore,
  gearChildren,
  gearRows,
  gearStanding,
  keepsGear,
  proposedAnswers,
  requirementChildren,
  requirementConfidence,
  requirementRows,
  type GearFilter,
  type GearRow,
  type RequirementRow,
} from '../../../model/gear-match-grid';
import { StatusChip } from '../../common';
import styles from './match.module.css';

type T = (key: string, params?: Record<string, string>) => string;

/** A decision to record: the matcher's (requirement, gear) pair. */
export interface MatchDecision {
  requirement_id: string;
  gear_id: string;
}

/** What the cells need beyond their row: the product, the catalogue and the actions. */
export interface MatchCells {
  t: T;
  /** The product's picks under every spelling the catalogue has. */
  picks: string[];
  catalogue: Set<string> | null;
  planGears: Set<string>;
  /** The key of the action running, if any: one at a time. */
  busy: string | null;
  add: (key: string, pick: string, decisions: MatchDecision[]) => void;
  decide: (key: string, decisions: MatchDecision[], decision: 'rejected' | 'undecided') => void;
  createGear: (r: GearMatchRequirement) => void;
  answer: (r: GearMatchRequirement) => void;
}

const [MatchCellsProvider, useMatchCells] = createGridCells<MatchCells>('GearMatch');

/** The address prefixes: the requirement grid, the gear grid. */
export const REQUIREMENT_PREFIX = 'gm.';
export const GEAR_PREFIX = 'gmg.';
const REQUIREMENT_ADDRESS = [VERDICT_FILTER];
const GEAR_ADDRESS = [GEAR_FILTER];

const verdictRank = (v: string) => {
  const i = (VERDICTS as readonly string[]).indexOf(v);
  return i < 0 ? VERDICTS.length : i;
};
const byNumber = <R,>(pick: (row: R) => number | null | undefined) => (a: R, b: R) =>
  (pick(a) ?? -Infinity) - (pick(b) ?? -Infinity);

// ---------------------------------------------------------------- requirement view

const passageOf = (row: RequirementRow) => (row.kind === 'requirement' ? row.r.passage : null);

export const REQUIREMENT_OPTIONS: LocalGridOptions<RequirementRow> = {
  search: (row) => [
    row.r.requirement_id,
    row.r.reason,
    row.kind === 'requirement' ? (row.best?.name ?? row.best?.pick) : null,
    row.r.passage?.text,
    ...row.r.candidates.map((c) => c.gear_id),
  ],
  filter: (row, filters) => {
    const verdict = tagGroupChoice(filters[VERDICT_FILTER] as { value?: unknown } | undefined);
    return !verdict || verdict === 'all' || row.r.coverage === verdict;
  },
  compare: {
    requirement: (a, b) => a.r.requirement_id.localeCompare(b.r.requirement_id),
    verdict: (a, b) => verdictRank(a.r.coverage) - verdictRank(b.r.coverage),
    gear: (a, b) =>
      (a.kind === 'requirement' ? (a.best?.pick ?? '') : '').localeCompare(b.kind === 'requirement' ? (b.best?.pick ?? '') : ''),
    confidence: byNumber(requirementConfidence),
    passage: (a, b) =>
      (passageOf(a)?.path ?? '').localeCompare(passageOf(b)?.path ?? '') || (passageOf(a)?.line ?? 0) - (passageOf(b)?.line ?? 0),
  },
};

/** The requirement grid's `load`: the report's requirements, and a requirement's own children when the tree opens it. */
export function requirementGridLoad(
  rows: readonly RequirementRow[],
  context: DataGridLoadContext
): DataGridLoadResult<RequirementRow> {
  const parent = (context.tree as { parentId?: string | number | null } | undefined)?.parentId;
  if (parent !== undefined && parent !== null) {
    const owner = rows.find((row) => row.id === parent);
    const children = owner?.kind === 'requirement' ? requirementChildren(owner.r) : [];
    return { results: children, total: children.length };
  }
  return pageOfRows(shownRows(rows, context, REQUIREMENT_OPTIONS), context);
}

const Dash: React.FC = () => {
  const { t } = useMatchCells();
  return <NoData label={t('no_data')} />;
};

const Facts: React.FC<{ c: GearMatchCandidate }> = ({ c }) => {
  const { t } = useMatchCells();
  const facts = (['evidence', 'covers', 'missing', 'rationale'] as const).filter((k) => c[k]);
  if (facts.length === 0) return null;
  return (
    <dl className={styles.facts}>
      {facts.map((k) => (
        <React.Fragment key={k}>
          <dt>{t(k)}</dt>
          <dd>{c[k]}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
};

const RequirementCell: React.FC<{ item: RequirementRow }> = ({ item }) => {
  const { t } = useMatchCells();
  if (item.kind === 'passage') {
    const p = item.r.passage;
    return p ? (
      <pre className={styles.passage} data-gear-match-passage={item.r.requirement_id}>
        {p.text}
      </pre>
    ) : (
      <span className={styles.meta}>{t('no_passage')}</span>
    );
  }
  if (item.kind === 'candidate') {
    return (
      <span className={styles.cellStack} data-gear-match-candidate={item.c.gear_id}>
        <Facts c={item.c} />
      </span>
    );
  }
  return (
    <span className={styles.cellStack} data-gear-match-requirement={item.r.requirement_id} data-action={item.r.action}>
      <code className={styles.id} title={item.r.requirement_id}>
        {shortId(item.r.requirement_id)}
      </code>
      {item.r.reason && <span className={styles.meta}>{item.r.reason}</span>}
    </span>
  );
};

const VerdictCell: React.FC<{ item: RequirementRow }> = ({ item }) => {
  const { t } = useMatchCells();
  if (item.kind === 'passage') return null;
  if (item.kind === 'candidate') return <VerdictBadge verdict={item.c.verdict} />;
  return <StatusChip tone={coverageTone(item.r.coverage)}>{t(`coverage_${item.r.coverage}`)}</StatusChip>;
};

const VerdictBadge: React.FC<{ verdict: string }> = ({ verdict }) => (
  <Badge variant={verdict === 'covered' ? 'success' : verdict === 'partial' ? 'warning' : 'secondary'}>{verdict}</Badge>
);

const GearName: React.FC<{ c: GearMatchCandidate }> = ({ c }) => {
  const { t, planGears } = useMatchCells();
  return (
    <span className={styles.cellStack}>
      <span className={styles.name}>{c.name ?? c.pick}</span>
      <code className={styles.meta}>{c.gear_id}</code>
      <span className={styles.badges}>
        {c.in_code === false && <Badge variant="secondary">{t('future_part')}</Badge>}
        {planGears.has(c.pick) && <Badge variant="info">{t('in_spec_plan')}</Badge>}
        {c.decision === 'accepted' && <Badge variant="success">{t('accepted')}</Badge>}
        {c.decision === 'rejected' && <Badge variant="secondary">{t('rejected')}</Badge>}
      </span>
    </span>
  );
};

const BestGearCell: React.FC<{ item: RequirementRow }> = ({ item }) => {
  if (item.kind === 'passage') return null;
  if (item.kind === 'candidate') return <GearName c={item.c} />;
  return item.best ? <span className={styles.name}>{item.best.name ?? item.best.pick}</span> : <Dash />;
};

const Confidence: React.FC<{ value: number | null | undefined }> = ({ value }) =>
  value == null ? <Dash /> : <span className={styles.count}>{value.toFixed(2)}</span>;

const ConfidenceCell: React.FC<{ item: RequirementRow }> = ({ item }) =>
  item.kind === 'passage' ? null : <Confidence value={requirementConfidence(item)} />;

const PassageCell: React.FC<{ item: RequirementRow }> = ({ item }) => {
  if (item.kind !== 'requirement') return null;
  const p = item.r.passage;
  return p ? (
    <code className={styles.meta} title={p.path}>
      {p.path}:{p.line}
    </code>
  ) : (
    <Dash />
  );
};

/** Add / Reject / Undo for one candidate, or for one gear across its proposals. */
const Decide: React.FC<{ id: string; c: GearMatchCandidate; decisions: MatchDecision[]; standing: string }> = ({
  id,
  c,
  decisions,
  standing,
}) => {
  const { t, busy, add, decide } = useMatchCells();
  if (decisions.length === 0) return null;
  return (
    <span className={styles.actions} data-grid-row-ignore-click>
      {standing === 'in' ? (
        <span className={styles.meta}>{t('in_product')}</span>
      ) : standing === 'add' ? (
        <Button type="button" size="sm" onClick={() => add(id, c.pick, decisions)} disabled={busy !== null} data-gear-match-add={id}>
          {busy === `add:${id}` ? t('adding') : t('add')}
        </Button>
      ) : (
        <span className={styles.meta}>{standing === 'future' ? t('future_part') : t('not_in_catalogue')}</span>
      )}
      {c.decision ? (
        <Button type="button" size="sm" variant="ghost" onClick={() => decide(id, decisions, 'undecided')} disabled={busy !== null}>
          {t('undo')}
        </Button>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => decide(id, decisions, 'rejected')}
          disabled={busy !== null}
          data-gear-match-reject={id}
        >
          {t('reject')}
        </Button>
      )}
    </span>
  );
};

const RequirementActionCell: React.FC<{ item: RequirementRow }> = ({ item }) => {
  const { t, picks, catalogue, createGear, answer, busy } = useMatchCells();
  if (item.kind === 'passage') return null;
  if (item.kind === 'candidate') {
    if (!item.c.proposed) return null;
    return (
      <Decide
        id={item.id}
        c={item.c}
        decisions={[{ requirement_id: item.r.requirement_id, gear_id: item.c.gear_id }]}
        standing={addability(item.c, picks, catalogue)}
      />
    );
  }
  const r = item.r;
  if (r.action === 'create_gear')
    return (
      <Button type="button" size="sm" variant="outline" onClick={() => createGear(r)} data-gear-match-create={r.requirement_id} data-grid-row-ignore-click>
        {t('create_gear')}
      </Button>
    );
  if (r.action === 'answer')
    return (
      <Button type="button" size="sm" variant="outline" onClick={() => answer(r)} disabled={busy !== null} data-gear-match-answer-open={r.requirement_id} data-grid-row-ignore-click>
        {t('answer_open')}
      </Button>
    );
  if (r.action === 'none') return <Dash />;
  return <span className={styles.meta}>{t(`action_${actionLabel(r, picks, catalogue)}`)}</span>;
};

const RequirementEmpty: React.FC = () => {
  const { t } = useMatchCells();
  return (
    <GridEmpty
      icon={<FileSearch />}
      title={t('grid_empty_title')}
      note={t('grid_empty_note')}
      noMatches={t('grid_no_matches')}
      noMatchesActions={<GridClearFilters label={t('grid_clear')} />}
    />
  );
};

// ---------------------------------------------------------------- gear view



const nameOfGear = (row: GearRow) => (row.kind === 'gear' ? row.name : row.r.requirement_id);

/** The gear view's local options; the filter needs the product's picks, so it is made per render. */
export function gearOptions(picks: readonly string[], catalogue: ReadonlySet<string> | null): LocalGridOptions<GearRow> {
  return {
    search: (row) => (row.kind === 'gear' ? [row.name, row.gear_id, ...row.answers.map((a) => a.r.requirement_id)] : [row.r.requirement_id]),
    filter: (row, filters) => {
      if (row.kind !== 'gear') return true;
      const chosen = tagGroupChoice(filters[GEAR_FILTER] as { value?: unknown } | undefined);
      return keepsGear(gearStanding(row, picks, catalogue), chosen && chosen !== 'all' ? (chosen as GearFilter) : null);
    },
    compare: {
      gear: (a, b) => nameOfGear(a).localeCompare(nameOfGear(b)),
      coverage: (a, b) => (a.kind === 'gear' && b.kind === 'gear' ? coverageScore(a) - coverageScore(b) : 0),
      confidence: byNumber((row: GearRow) => (row.kind === 'gear' ? row.confidence : row.c.confidence)),
    },
  };
}

export function gearGridLoad(
  rows: readonly GearRow[],
  context: DataGridLoadContext,
  options: LocalGridOptions<GearRow>
): DataGridLoadResult<GearRow> {
  const parent = (context.tree as { parentId?: string | number | null } | undefined)?.parentId;
  if (parent !== undefined && parent !== null) {
    const owner = rows.find((row) => row.id === parent);
    const children = owner?.kind === 'gear' ? gearChildren(owner) : [];
    return { results: children, total: children.length };
  }
  return pageOfRows(shownRows(rows, context, options), context);
}

const GearCell: React.FC<{ item: GearRow }> = ({ item }) => {
  const { t, planGears } = useMatchCells();
  if (item.kind === 'answer') {
    return (
      <span className={styles.cellStack} data-gear-match-answer-row={item.r.requirement_id}>
        <code className={styles.id} title={item.r.requirement_id}>
          {shortId(item.r.requirement_id)}
        </code>
        <Facts c={item.c} />
      </span>
    );
  }
  return (
    <span className={styles.cellStack} data-gear-match-gear={item.gear_id}>
      <span className={styles.name}>{item.name}</span>
      <code className={styles.meta}>{item.repo ? `${item.repo} · ${item.pick}` : item.pick}</code>
      {planGears.has(item.pick) && (
        <span className={styles.badges}>
          <Badge variant="info">{t('in_spec_plan')}</Badge>
        </span>
      )}
    </span>
  );
};

const CoverageCell: React.FC<{ item: GearRow }> = ({ item }) => {
  const { t } = useMatchCells();
  if (item.kind === 'answer') return <VerdictBadge verdict={item.c.verdict} />;
  if (item.covered + item.partial === 0) return <span className={styles.meta}>{t('gear_covers_none')}</span>;
  return (
    <span className={styles.count} data-gear-match-coverage={`${item.covered}/${item.partial}`}>
      {t('gear_covers', { covered: String(item.covered), partial: String(item.partial) })}
    </span>
  );
};

const GearConfidenceCell: React.FC<{ item: GearRow }> = ({ item }) => (
  <Confidence value={item.kind === 'gear' ? item.confidence : item.c.confidence} />
);

const InProductCell: React.FC<{ item: GearRow }> = ({ item }) => {
  const { t, picks, catalogue } = useMatchCells();
  if (item.kind === 'answer') return <StatusChip tone={coverageTone(item.r.coverage)}>{t(`coverage_${item.r.coverage}`)}</StatusChip>;
  const standing = gearStanding(item, picks, catalogue);
  return (
    <StatusChip tone={standing === 'in' ? 'ok' : standing === 'add' ? 'warn' : 'neutral'} data-gear-match-standing={standing}>
      {t(`standing_${standing}`)}
    </StatusChip>
  );
};

const CodeCell: React.FC<{ item: GearRow }> = ({ item }) => {
  const { t } = useMatchCells();
  if (item.kind === 'answer') return null;
  return <span className={styles.meta}>{item.in_code ? t('has_code') : t('future_part')}</span>;
};

const GearActionCell: React.FC<{ item: GearRow }> = ({ item }) => {
  const { picks, catalogue } = useMatchCells();
  if (item.kind === 'answer') return null;
  const proposed = proposedAnswers(item);
  if (proposed.length === 0) return null;
  // The gear row stands for every proposal of it: its decision is theirs while they agree.
  const decided = proposed.every((a) => a.c.decision) ? proposed[0].c : { ...proposed[0].c, decision: null };
  return (
    <Decide
      id={item.id}
      c={decided}
      decisions={proposed.map((a) => ({ requirement_id: a.r.requirement_id, gear_id: a.c.gear_id }))}
      standing={gearStanding(item, picks, catalogue)}
    />
  );
};

const GearEmpty: React.FC = () => {
  const { t } = useMatchCells();
  return (
    <GridEmpty
      icon={<FileSearch />}
      title={t('gear_empty_title')}
      note={t('gear_empty_note')}
      noMatches={t('grid_no_matches')}
      noMatchesActions={<GridClearFilters label={t('grid_clear')} />}
    />
  );
};

// ---------------------------------------------------------------- the grids

/** A requirement opens into its passage and candidates; a gear into the requirements it answers. */
const opensRequirement = (row: RequirementRow) => row.kind === 'requirement';
const opensGear = (row: GearRow) => row.kind === 'gear' && row.answers.length > 0;

export interface MatchReportGridProps {
  match: GearMatch;
  cells: MatchCells;
}

export const RequirementGrid: React.FC<MatchReportGridProps> = ({ match, cells }) => {
  const { t } = cells;
  const rows = useMemo(() => requirementRows(match), [match]);
  const current = useRef(rows);
  useLayoutEffect(() => {
    current.current = rows;
  });
  const load = useCallback(async (context: DataGridLoadContext) => {
    writeGridAddress(context, REQUIREMENT_PREFIX, REQUIREMENT_ADDRESS);
    const page = requirementGridLoad(current.current, context);
    context.signal?.throwIfAborted();
    return page;
  }, []);
  const reloadBridge = useLocalGridReload(rows);
  const columns = useMemo<DataGridTableColumn<RequirementRow>[]>(
    () => [
      { id: 'requirement', label: t('col_requirement'), component: RequirementCell },
      { id: 'verdict', label: t('col_verdict'), component: VerdictCell, width: 132 },
      { id: 'gear', label: t('col_best_gear'), component: BestGearCell, width: 200 },
      { id: 'confidence', label: t('col_confidence'), component: ConfidenceCell, width: 112 },
      { id: 'passage', label: t('col_passage'), component: PassageCell, width: 220 },
      { id: 'action', label: t('col_action'), component: RequirementActionCell, width: 220 },
    ],
    [t]
  );
  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const r of match.requirements) out[r.coverage] = (out[r.coverage] ?? 0) + 1;
    return out;
  }, [match]);
  const filters = useMemo(
    () => [
      filterTagGroup({
        id: VERDICT_FILTER,
        label: t('filter_label'),
        mode: 'radio',
        options: [
          { value: 'all', label: t('filter_all') },
          ...VERDICTS.map((v) => ({ value: v, label: `${t(`coverage_${v}`)} ${counts[v] ?? 0}` })),
        ],
      }),
    ],
    [t, counts]
  );
  return (
    <MatchCellsProvider value={cells}>
      <ListGrid<RequirementRow>
        name="gear-match-requirements"
        label={t('view_requirement')}
        columns={columns}
        load={load}
        search={t('search_requirements')}
        filters={filters}
        empty={RequirementEmpty}
        unsortable={['action']}
        defaultOrder={{ id: 'verdict', direction: 'asc' }}
        minWidth="72rem"
      >
        <GridAddress prefix={REQUIREMENT_PREFIX} filterKeys={REQUIREMENT_ADDRESS} />
        {/* Before the tree: a new page size or new rows replace the list, not append to it. */}
        <GridTreeReplace />
        <DataGridTableTreePlugin<RequirementRow> expandable={opensRequirement} />
        {reloadBridge}
      </ListGrid>
    </MatchCellsProvider>
  );
};

RequirementGrid.displayName = 'RequirementGrid';

export const GearGrid: React.FC<MatchReportGridProps> = ({ match, cells }) => {
  const { t, picks, catalogue } = cells;
  const rows = useMemo(() => gearRows(match), [match]);
  const options = useMemo(() => gearOptions(picks, catalogue), [picks, catalogue]);
  const current = useRef({ rows, options });
  useLayoutEffect(() => {
    current.current = { rows, options };
  });
  const load = useCallback(async (context: DataGridLoadContext) => {
    writeGridAddress(context, GEAR_PREFIX, GEAR_ADDRESS);
    const page = gearGridLoad(current.current.rows, context, current.current.options);
    context.signal?.throwIfAborted();
    return page;
  }, []);
  // The filter reads the product's picks: a gear added moves between "addable" and "in the product".
  const reloadOn = useMemo(() => ({ rows, options }), [rows, options]);
  const reloadBridge = useLocalGridReload(reloadOn);
  const columns = useMemo<DataGridTableColumn<GearRow>[]>(
    () => [
      { id: 'gear', label: t('col_gear'), component: GearCell },
      { id: 'coverage', label: t('col_coverage'), component: CoverageCell, width: 180 },
      { id: 'confidence', label: t('col_confidence'), component: GearConfidenceCell, width: 112 },
      { id: 'product', label: t('col_product'), component: InProductCell, width: 168 },
      { id: 'code', label: t('col_code'), component: CodeCell, width: 112 },
      { id: 'action', label: t('col_action'), component: GearActionCell, width: 200 },
    ],
    [t]
  );
  const filters = useMemo(
    () => [
      filterTagGroup({
        id: GEAR_FILTER,
        label: t('gear_filter_label'),
        mode: 'radio',
        options: [{ value: 'all', label: t('filter_all') }, ...GEAR_FILTERS.map((f) => ({ value: f, label: t(`gear_filter_${f}`) }))],
      }),
    ],
    [t]
  );
  return (
    <MatchCellsProvider value={cells}>
      <ListGrid<GearRow>
        name="gear-match-gears"
        label={t('view_gear')}
        columns={columns}
        load={load}
        search={t('search_gears')}
        filters={filters}
        empty={GearEmpty}
        unsortable={['product', 'code', 'action']}
        defaultOrder={{ id: 'coverage', direction: 'desc' }}
        minWidth="64rem"
      >
        <GridAddress prefix={GEAR_PREFIX} filterKeys={GEAR_ADDRESS} />
        <GridTreeReplace />
        <DataGridTableTreePlugin<GearRow> expandable={opensGear} />
        {reloadBridge}
      </ListGrid>
    </MatchCellsProvider>
  );
};

GearGrid.displayName = 'GearGrid';
