/**
 * Organization › Gears matcher, its usage part (docs/design/product-gear-match.md
 * §9): over the period on screen (7, 30 or 90 days, kept in the address), the
 * organization's sums as tiles — how its projects' products are assembled,
 * the runs by how they ended, the model calls and tokens, the members'
 * decisions, the questions still open — and a project per row on the kit's
 * DataGrid (search, header sort, pages, the list's empty state; kept in the
 * address as the other lists keep theirs). A row opens that project's Gear
 * match tab.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { Badge, DataGridRowClickPlugin, type DataGridTableColumn } from '@gears-frontx/ui-kit';
import type { ChildMfeBridge } from '@gears-frontx/react';
import { openPlace, readListState, writeListState } from '@constructor-studio/mfe-shared';
import {
  GridAddress,
  GridClearFilters,
  GridEmpty,
  ListGrid,
  NoData,
  createGridCells,
  useLocalGridLoad,
  writeGridAddress,
} from '@constructor-studio/mfe-shared/grid';
import {
  PERIODS,
  USAGE_OPTIONS,
  compact,
  countOf,
  duration,
  periodOf,
  usageRows,
  type GearMatchUsage,
  type Period,
  type UsageRow,
} from '../../model/gear-match-usage';
import { Segmented, StatusChip, type Tone } from '../common';
import page from '../product.module.css';
import styles from './matcher.module.css';

type T = (key: string, params?: Record<string, string>) => string;

/** The address prefix of the period, and of the projects grid. */
export const PERIOD_PREFIX = 'gmu.';
export const GRID_PREFIX = 'gmug.';
const GRID_ADDRESS: readonly string[] = [];

function replaceSearch(search: string): void {
  if (search === window.location.search) return;
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${search}${window.location.hash}`);
}

/** The period the address names, and a setter that writes it back (taken out again when the screen goes). */
export function useAddressPeriod(): [Period, (p: Period) => void] {
  const [period, setPeriod] = useState<Period>(() =>
    typeof window === 'undefined' ? periodOf(undefined) : periodOf(readListState(window.location.search, PERIOD_PREFIX).filters.period)
  );
  const choose = useCallback((p: Period) => {
    setPeriod(p);
    const state = readListState(window.location.search, PERIOD_PREFIX);
    replaceSearch(writeListState(window.location.search, { ...state, filters: { ...state.filters, period: String(p) } }, PERIOD_PREFIX));
  }, []);
  useEffect(
    () => () => replaceSearch(writeListState(window.location.search, readListState('', PERIOD_PREFIX), PERIOD_PREFIX)),
    []
  );
  return [period, choose];
}

interface UsageCells {
  t: T;
  language: string;
}

const [UsageCellsProvider, useUsageCells] = createGridCells<UsageCells>('GearMatchUsage');

const Dash: React.FC = () => {
  const { t } = useUsageCells();
  return <NoData label={t('no_data')} />;
};

const runTone = (state: string): Tone =>
  state === 'succeeded'
    ? 'ok'
    : state === 'partial'
      ? 'warn'
      : state === 'failed'
        ? 'danger'
        : state === 'cancelled'
          ? 'neutral'
          : 'running';

const ProjectCell: React.FC<{ item: UsageRow }> = ({ item }) => (
  <span className={styles.cell} data-gear-match-usage-project={item.project_id}>
    <span className={styles.name}>{item.project_name}</span>
    <span className={styles.meta}>{item.workspace_name}</span>
  </span>
);

const StrategyCell: React.FC<{ item: UsageRow }> = ({ item }) => {
  const { t } = useUsageCells();
  return (
    <span className={styles.cell} data-gear-match-usage-strategy={item.strategy}>
      <span>{t(`strategy_${item.strategy}`)}</span>
      <span className={styles.meta}>
        {t(`source_short_${item.source}`)}
        {item.fallback && (
          <>
            {' · '}
            <Badge variant="warning" title={item.fallback.reason} data-gear-match-usage-fallback={item.fallback.code}>
              {t('fallback_badge')}
            </Badge>
          </>
        )}
      </span>
    </span>
  );
};

const LastRunCell: React.FC<{ item: UsageRow }> = ({ item }) => {
  const { t, language } = useUsageCells();
  const run = item.last_run;
  if (!run) return <span className={styles.meta}>{t('no_run')}</span>;
  return (
    <span className={styles.cell}>
      <StatusChip tone={runTone(run.state)} data-gear-match-usage-last={run.state}>
        {t(`run_state_${run.state}`)}
      </StatusChip>
      <span className={styles.meta}>{new Date(run.created_at).toLocaleString(language)}</span>
    </span>
  );
};

const CoverageCell: React.FC<{ item: UsageRow }> = ({ item }) => {
  const { t } = useUsageCells();
  const totals = item.last_run?.totals;
  if (!totals) return <Dash />;
  const params = {
    covered: String(totals.covered),
    partial: String(totals.partial),
    gap: String(totals.gap),
    clarify: String(totals.clarification_needed),
    not_assessed: String(totals.not_assessed),
  };
  return (
    <span className={`${styles.count}`} title={t('coverage_line', params)} data-gear-match-usage-coverage>
      {t('coverage_short', params)}
    </span>
  );
};

const RunsCell: React.FC<{ item: UsageRow }> = ({ item }) => {
  const { t } = useUsageCells();
  if (item.runs.total === 0) return <Dash />;
  return (
    <span className={styles.cell}>
      <span className={styles.count}>{item.runs.total}</span>
      {item.runs.failed > 0 && <span className={styles.meta}>{t('runs_failed', { count: String(item.runs.failed) })}</span>}
    </span>
  );
};

const TokensCell: React.FC<{ item: UsageRow }> = ({ item }) => {
  const { t } = useUsageCells();
  const tokens = item.usage.input_tokens + item.usage.output_tokens;
  if (tokens === 0 && item.usage.calls === 0) return <Dash />;
  return (
    <span className={styles.cell}>
      <span className={styles.count}>{compact(tokens)}</span>
      <span className={styles.meta}>{t('calls', { count: String(item.usage.calls) })}</span>
    </span>
  );
};

const DecisionsCell: React.FC<{ item: UsageRow }> = ({ item }) =>
  item.accepted + item.rejected === 0 ? (
    <Dash />
  ) : (
    <span className={styles.count}>
      {item.accepted} / {item.rejected}
    </span>
  );

const QuestionsCell: React.FC<{ item: UsageRow }> = ({ item }) =>
  item.questions_open === 0 ? (
    <Dash />
  ) : (
    <StatusChip tone="warn" data-gear-match-usage-questions={String(item.questions_open)}>
      {String(item.questions_open)}
    </StatusChip>
  );

const UsageEmpty: React.FC = () => {
  const { t } = useUsageCells();
  return (
    <GridEmpty
      icon={<BarChart3 />}
      title={t('grid_empty_title')}
      note={t('grid_empty_note')}
      noMatches={t('grid_no_matches')}
      noMatchesActions={<GridClearFilters label={t('grid_clear')} />}
    />
  );
};

function Tile({ label, value, note, children, data }: { label: string; value: string; note?: string; children?: React.ReactNode; data: string }) {
  return (
    <div className={styles.tile} data-gear-match-usage-tile={data}>
      <span className={styles.tileLabel}>{label}</span>
      <span className={styles.tileValue}>{value}</span>
      {children}
      {note && <span className={styles.tileNote}>{note}</span>}
    </div>
  );
}

/** The organization's sums, one tile each. */
export function UsageTiles({ usage, t }: { usage: GearMatchUsage; t: T }) {
  const s = usage.summary;
  const matcher = countOf(s.strategies, 'gears_matcher');
  const spec = countOf(s.strategies, 'spec_mapping');
  const manual = countOf(s.strategies, 'manual');
  const all = Math.max(1, matcher + spec + manual);
  const fallbacks = s.fallbacks.reduce((n, f) => n + f.projects, 0);
  const pct = (n: number) => `${(n / all) * 100}%`;
  return (
    <div className={styles.tiles}>
      <Tile
        data="strategies"
        label={t('tile_strategies')}
        value={`${matcher} / ${s.projects}`}
        note={[
          t('tile_strategies_note', { matcher: String(matcher), spec: String(spec), manual: String(manual) }),
          fallbacks ? t('tile_fallbacks', { count: String(fallbacks) }) : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      >
        <div className={styles.split} aria-hidden>
          <span className={styles.splitMatcher} style={{ width: pct(matcher) }} />
          <span className={styles.splitSpec} style={{ width: pct(spec) }} />
          <span className={styles.splitManual} style={{ width: pct(manual) }} />
        </div>
      </Tile>
      <Tile
        data="runs"
        label={t('tile_runs')}
        value={String(s.runs.total)}
        note={[
          t('tile_runs_note', {
            succeeded: String(s.runs.succeeded),
            partial: String(s.runs.partial),
            failed: String(s.runs.failed),
            cancelled: String(s.runs.cancelled),
            running: String(s.runs.running),
          }),
          s.median_run_ms != null ? t('tile_median', { duration: duration(s.median_run_ms) }) : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      />
      <Tile
        data="tokens"
        label={t('tile_tokens')}
        value={compact(s.usage.input_tokens + s.usage.output_tokens)}
        note={t('tile_tokens_note', {
          calls: String(s.usage.calls),
          cache: String(s.usage.cache_hits),
          input: compact(s.usage.input_tokens),
          output: compact(s.usage.output_tokens),
        })}
      />
      <Tile
        data="decisions"
        label={t('tile_decisions')}
        value={String(s.accepted + s.rejected)}
        note={t('tile_decisions_note', { accepted: String(s.accepted), rejected: String(s.rejected) })}
      />
      <Tile
        data="questions"
        label={t('tile_questions')}
        value={String(s.questions_open)}
        note={[
          t('tile_questions_note', { answered: String(s.questions_answered) }),
          t('tile_projects', { matched: String(s.projects_matched), projects: String(s.projects) }),
        ].join(' · ')}
      />
    </div>
  );
}

/** The projects, one per row; a row opens that project's Gear match. */
export function UsageGrid({
  usage,
  t,
  language,
  bridge,
  organizationId,
}: {
  usage: GearMatchUsage;
  t: T;
  language: string;
  bridge: ChildMfeBridge | null;
  organizationId: string;
}) {
  const rows = useMemo(() => usageRows(usage.items), [usage]);
  const { load, reloadBridge } = useLocalGridLoad(rows, USAGE_OPTIONS);
  const columns = useMemo<DataGridTableColumn<UsageRow>[]>(
    () => [
      { id: 'project', label: t('col_project'), component: ProjectCell },
      { id: 'strategy', label: t('col_strategy'), component: StrategyCell, width: 168 },
      { id: 'last_run', label: t('col_last_run'), component: LastRunCell, width: 184 },
      { id: 'coverage', label: t('col_coverage'), component: CoverageCell, width: 120 },
      { id: 'runs', label: t('col_runs'), component: RunsCell, width: 96 },
      { id: 'tokens', label: t('col_tokens'), component: TokensCell, width: 112 },
      { id: 'decisions', label: t('col_decisions'), component: DecisionsCell, width: 128 },
      { id: 'questions', label: t('col_questions'), component: QuestionsCell, width: 120 },
    ],
    [t]
  );
  const open = useCallback(
    (row: UsageRow) =>
      openPlace(bridge, {
        organizationId,
        workspaceId: row.workspace_id,
        projectId: row.project_id,
        route: '/gear-match',
      }),
    [bridge, organizationId]
  );
  const cells = useMemo(() => ({ t, language }), [t, language]);
  const wrappedLoad = useCallback(
    (context: Parameters<typeof load>[0]) => {
      // The search and the order into the address, as the other lists keep theirs.
      writeGridAddress(context, GRID_PREFIX, GRID_ADDRESS);
      return load(context);
    },
    [load]
  );
  return (
    <UsageCellsProvider value={cells}>
      <ListGrid<UsageRow>
        name="gear-match-usage"
        label={t('usage_title')}
        columns={columns}
        load={wrappedLoad}
        search={t('search_projects')}
        empty={UsageEmpty}
        defaultOrder={{ id: 'last_run', direction: 'desc' }}
        minWidth="64rem"
      >
        <GridAddress prefix={GRID_PREFIX} filterKeys={GRID_ADDRESS} />
        <DataGridRowClickPlugin<UsageRow> click={open} />
        {reloadBridge}
      </ListGrid>
    </UsageCellsProvider>
  );
}

/** The period switch. */
export function PeriodSwitch({ period, onChange, t }: { period: Period; onChange: (p: Period) => void; t: T }) {
  return (
    <span className={page.row}>
      <span className={`${page.small} ${page.muted}`}>{t('usage_period')}</span>
      <Segmented
        label={t('usage_period')}
        value={String(period) as `${Period}`}
        onChange={(v) => onChange(Number(v) as Period)}
        dataAttr="data-gear-match-usage-period"
        items={PERIODS.map((p) => ({ id: String(p) as `${Period}`, label: t('usage_period_days', { days: String(p) }) }))}
      />
    </span>
  );
}
