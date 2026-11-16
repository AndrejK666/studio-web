/**
 * Releases' two lists of builds on the kit's DataGrid, the way Specs draws its
 * list (#1076): the CI runs of the workflow Build in CI chose, and the
 * product's builds. Search, header sort, pages, the list's empty state and the
 * portal theme come from the shared grid; what a row says is what the tables
 * said. A product build opens on a click, under the list (Builds.tsx).
 */

import React, { useMemo } from 'react';
import { Badge, DataGridRowClickPlugin, type DataGridTableColumn } from '@gears-frontx/ui-kit';
import {
  GridClearFilters,
  GridEmpty,
  ListGrid,
  NoData,
  createGridCells,
  useLocalGridLoad,
} from '@constructor-studio/mfe-shared/grid';
import {
  BUILD_STAGES,
  buildDuration,
  buildStages,
  ideBuildDuration,
  isLost,
  statusTone,
  type BuildRun,
  type BuildStage,
  type BuildStatus,
  type IdeBuild,
  type StageState,
} from '../../model/builds';
import { TONE_BADGE, When, useReleases, type Text, type Tone } from './parts';
import styles from './ReleasesScreen.module.css';

/** A build's status as a chip's tone: statusTone, with a running build drawn as running. */
export function buildTone(status: BuildStatus): Tone {
  return status === 'running' ? 'running' : (statusTone(status) as Tone);
}

const STAGE_TONE: Record<StageState, Tone> = { done: 'ok', running: 'running', failed: 'danger', waiting: 'neutral' };
export const STAGE_MARK: Record<StageState, string> = { done: '✓', running: '…', failed: '✕', waiting: '' };

const byText = <T,>(pick: (row: T) => string | null | undefined) => (a: T, b: T) =>
  (pick(a) ?? '').localeCompare(pick(b) ?? '', undefined, { sensitivity: 'base', numeric: true });

/* ── The CI runs ── */

/** What a run's cell needs beyond its row. */
interface RunCells {
  t: Text;
  language: string;
  /** When Releases last read: what "took" is measured against. */
  now: number;
  /** The chart version a run published, by its build id (`ci-run-<external id>`). */
  published: ReadonlyMap<string, string | null>;
}

const [RunCellsProvider, useRunCells] = createGridCells<RunCells>('CiRuns');

const RunDash: React.FC = () => <NoData label={useRunCells().t('no_data')} />;

const RunStatusCell: React.FC<{ item: BuildRun }> = ({ item: r }) => {
  const { t, published } = useRunCells();
  const chart = r.externalId ? published.get(`ci-run-${r.externalId}`) : undefined;
  return (
    <span data-build-status={r.status}>
      <Badge variant={TONE_BADGE[buildTone(r.status)]}>{r.status}</Badge>
      {chart ? (
        <span className={styles.muted} data-run-published>
          {' '}
          · {t('published')} <code>{chart}</code>
        </span>
      ) : null}
    </span>
  );
};

const RunCommitCell: React.FC<{ item: BuildRun }> = ({ item: r }) => {
  const { t } = useRunCells();
  return (
    <span>
      <code>{r.shortSha}</code>{' '}
      {r.url ? (
        <a href={r.url} target="_blank" rel="noreferrer">
          {r.title || t('run_number', { number: r.number ?? '' })}
        </a>
      ) : (
        r.title
      )}
      {r.attempt && r.attempt > 1 ? <span className={styles.muted}> · {t('attempt', { attempt: r.attempt })}</span> : null}
    </span>
  );
};

const RunBranchCell: React.FC<{ item: BuildRun }> = ({ item: r }) => (r.branch ? <span>{r.branch}</span> : <RunDash />);

const RunAuthorCell: React.FC<{ item: BuildRun }> = ({ item: r }) =>
  r.author || r.event ? (
    <span>
      {r.author ?? '—'}
      {r.event ? <span className={styles.muted}> · {r.event}</span> : null}
    </span>
  ) : (
    <RunDash />
  );

const RunWhenCell: React.FC<{ item: BuildRun }> = ({ item: r }) => {
  const { language } = useRunCells();
  return r.createdAt ? <span>{new Date(r.createdAt).toLocaleString(language)}</span> : <RunDash />;
};

const RunTookCell: React.FC<{ item: BuildRun }> = ({ item: r }) => {
  const { now } = useRunCells();
  const took = buildDuration(r, now);
  return took ? <span>{took}</span> : <RunDash />;
};

const RUN_OPTIONS = {
  search: (r: BuildRun) => [r.title, r.shortSha, r.sha, r.branch, r.author, r.event, r.status],
  compare: {
    status: byText<BuildRun>((r) => r.status),
    branch: byText<BuildRun>((r) => r.branch),
    started_by: byText<BuildRun>((r) => r.author),
    when: byText<BuildRun>((r) => r.createdAt),
  },
};

const RunsEmpty: React.FC = () => {
  const { t } = useRunCells();
  return (
    <GridEmpty
      title={t('ci_none')}
      noMatches={t('no_runs_match')}
      noMatchesActions={<GridClearFilters label={t('clear_search')} />}
    />
  );
};

/** The runs of the chosen workflow on the chosen branch, newest first as the sync keeps them. */
export const CiRunsGrid: React.FC<{
  runs: readonly BuildRun[];
  now: number;
  published: ReadonlyMap<string, string | null>;
}> = ({ runs, now, published }) => {
  const { t, language } = useReleases();
  const { load, reloadBridge } = useLocalGridLoad(runs, RUN_OPTIONS);
  const columns = useMemo<DataGridTableColumn<BuildRun>[]>(
    () => [
      { id: 'status', label: t('col_status'), component: RunStatusCell, width: 200 },
      { id: 'commit', label: t('col_commit'), component: RunCommitCell },
      { id: 'branch', label: t('branch'), component: RunBranchCell, width: 160 },
      { id: 'started_by', label: t('col_started_by'), component: RunAuthorCell, width: 180 },
      { id: 'when', label: t('col_when'), component: RunWhenCell, width: 180 },
      { id: 'took', label: t('col_took'), component: RunTookCell, width: 100 },
    ],
    [t]
  );
  const cells = useMemo<RunCells>(() => ({ t, language, now, published }), [t, language, now, published]);
  return (
    <RunCellsProvider value={cells}>
      <div data-builds-table>
        <ListGrid<BuildRun>
          name="ci-runs"
          label={t('build_in_ci_title')}
          columns={columns}
          load={load}
          search={t('search_runs')}
          empty={RunsEmpty}
          unsortable={['commit', 'took']}
          minWidth="56rem"
        >
          {reloadBridge}
        </ListGrid>
      </div>
    </RunCellsProvider>
  );
};

CiRunsGrid.displayName = 'CiRunsGrid';

/* ── The product's builds ── */

/** prepare → images → publish, each as a badge in its state. A run of the
 *  product has no stages, nor has a CI run that left no manifest (its page
 *  has its jobs); a lost build's are not known past what it said. */
export function StageLane({ build: b, lost }: { build: IdeBuild; lost: boolean }) {
  if (b.action === 'run' || (b.where === 'ci' && b.status !== 'passed' && !b.failureStep && !b.step))
    return <span className={styles.muted}>—</span>;
  const stages: Record<BuildStage, StageState> = buildStages(b);
  return (
    <span className={styles.stages} data-build-stages>
      {BUILD_STAGES.map((stage, i) => {
        const state: StageState =
          lost && (stages[stage] === 'running' || stages[stage] === 'failed') ? 'waiting' : stages[stage];
        return (
          <span key={stage} className={styles.stages}>
            {i > 0 && <span className={styles.muted}>→</span>}
            <Badge variant={TONE_BADGE[STAGE_TONE[state]]} data-stage={stage} data-stage-state={state}>
              {STAGE_MARK[state]} {stage}
            </Badge>
          </span>
        );
      })}
    </span>
  );
}

/** What a product build's cell needs beyond its row. */
interface BuildCells {
  t: Text;
  /** When Releases last read: what "lost" and "took" are measured against. */
  now: number;
  /** The build open under the list, if any. */
  open: string | null;
}

const [BuildCellsProvider, useBuildCells] = createGridCells<BuildCells>('ProductBuilds');

const BuildDash: React.FC = () => <NoData label={useBuildCells().t('no_data')} />;

const BuildStatusCell: React.FC<{ item: IdeBuild }> = ({ item: b }) => {
  const { t, now } = useBuildCells();
  const lost = isLost(b, now);
  return (
    <span data-ide-build-status={lost ? 'lost' : b.status}>
      {lost ? (
        <Badge variant="warning" data-build-lost-badge>
          {t('lost')}
        </Badge>
      ) : (
        <Badge variant={TONE_BADGE[buildTone(b.status)]}>{b.status}</Badge>
      )}
    </span>
  );
};

const BuildNameCell: React.FC<{ item: IdeBuild }> = ({ item: b }) => {
  const { t, open } = useBuildCells();
  const isOpen = open === b.id;
  return (
    <span data-product-build={b.buildId} data-product-build-open={isOpen || undefined}>
      <span className={styles.muted} aria-hidden="true">
        {isOpen ? '▾' : '▸'}{' '}
      </span>
      <b>
        {b.product ?? t('the_product')}
        {b.profile ? <span className={styles.muted}> · {b.profile}</span> : null}
      </b>
    </span>
  );
};

const BuildStagesCell: React.FC<{ item: IdeBuild }> = ({ item: b }) => {
  const { now } = useBuildCells();
  return <StageLane build={b} lost={isLost(b, now)} />;
};

const BuildWhereCell: React.FC<{ item: IdeBuild }> = ({ item: b }) => <span>{b.where}</span>;

const BuildCommitCell: React.FC<{ item: IdeBuild }> = ({ item: b }) => {
  const { t } = useBuildCells();
  if (!b.shortSha && !b.branch && b.descriptionRevision === null) return <BuildDash />;
  return (
    <span>
      {b.shortSha ? <code>{b.shortSha}</code> : (b.branch ?? '—')}
      {b.descriptionRevision !== null ? (
        <span className={styles.muted} title={t('revision_title')}>
          {' '}
          · {t('revision', { revision: b.descriptionRevision })}
        </span>
      ) : null}
    </span>
  );
};

const BuildWhenCell: React.FC<{ item: IdeBuild }> = ({ item: b }) => <When iso={b.startedAt} />;

const BuildTookCell: React.FC<{ item: IdeBuild }> = ({ item: b }) => {
  const { now } = useBuildCells();
  const took = isLost(b, now) ? null : ideBuildDuration(b, now);
  return took ? <span>{took}</span> : <BuildDash />;
};

const BUILD_OPTIONS = {
  search: (b: IdeBuild) => [b.product, b.profile, b.buildId, b.where, b.status, b.branch, b.shortSha, b.commit],
  compare: {
    status: byText<IdeBuild>((b) => b.status),
    build: byText<IdeBuild>((b) => b.product),
    where: byText<IdeBuild>((b) => b.where),
    when: byText<IdeBuild>((b) => b.startedAt),
  },
};

const BuildsEmpty: React.FC = () => {
  const { t } = useBuildCells();
  return (
    <GridEmpty
      title={t('builds_title')}
      noMatches={t('no_builds_match')}
      noMatchesActions={<GridClearFilters label={t('clear_search')} />}
    />
  );
};

/** The product's builds, newest first; a click on one opens it under the list, a second closes it. */
export const ProductBuildsGrid: React.FC<{
  builds: readonly IdeBuild[];
  now: number;
  open: string | null;
  onToggle: (build: IdeBuild) => void;
}> = ({ builds, now, open, onToggle }) => {
  const { t } = useReleases();
  const { load, reloadBridge } = useLocalGridLoad(builds, BUILD_OPTIONS);
  const columns = useMemo<DataGridTableColumn<IdeBuild>[]>(
    () => [
      { id: 'status', label: t('col_status'), component: BuildStatusCell, width: 120 },
      { id: 'build', label: t('col_build'), component: BuildNameCell },
      { id: 'stages', label: t('col_stages'), component: BuildStagesCell, width: 320 },
      { id: 'where', label: t('col_where'), component: BuildWhereCell, width: 100 },
      { id: 'commit', label: t('col_commit'), component: BuildCommitCell, width: 160 },
      { id: 'when', label: t('col_when'), component: BuildWhenCell, width: 120 },
      { id: 'took', label: t('col_took'), component: BuildTookCell, width: 100 },
    ],
    [t]
  );
  const cells = useMemo<BuildCells>(() => ({ t, now, open }), [t, now, open]);
  return (
    <BuildCellsProvider value={cells}>
      <ListGrid<IdeBuild>
        name="product-builds"
        label={t('builds_title')}
        columns={columns}
        load={load}
        search={t('search_builds')}
        empty={BuildsEmpty}
        unsortable={['stages', 'commit', 'took']}
        minWidth="64rem"
      >
        <DataGridRowClickPlugin<IdeBuild> click={onToggle} />
        {reloadBridge}
      </ListGrid>
    </BuildCellsProvider>
  );
};

ProductBuildsGrid.displayName = 'ProductBuildsGrid';
