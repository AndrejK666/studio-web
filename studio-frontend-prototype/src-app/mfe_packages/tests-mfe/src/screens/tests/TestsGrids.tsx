/**
 * Tests' two lists on the kit's DataGrid, the way Specs draws its list
 * (#1076): the CI runs of the last two weeks and the open pull requests. The
 * grid's search, header sort, pages, the list's empty state and the portal
 * theme come from the shared part; what a row says is what the tables said. A
 * run with jobs opens on a click, its jobs under the list (the kit's grid has
 * no detail row).
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Badge, DataGridRowClickPlugin, type DataGridTableColumn } from '@gears-frontx/ui-kit';
import {
  GridClearFilters,
  GridEmpty,
  ListGrid,
  NoData,
  createGridCells,
  useLocalGridLoad,
} from '@constructor-studio/mfe-shared/grid';
import type { CiRun, OpenPullRequest, PullRequestChecks } from '../../api/types';
import { durationLabel, failedJobLabel, failedJobs, runSeconds, runStatus, type BuildStatus } from '../../model/tests';
import type { useTestsTranslations } from '../../i18n';
import styles from './TestsScreen.module.css';

/** The screen's translator. */
export type GridText = ReturnType<typeof useTestsTranslations>['t'];

/** A build status as a Badge's variant. */
export function tone(s: BuildStatus): 'success' | 'danger' | 'info' | 'secondary' {
  return s === 'passed'
    ? 'success'
    : s === 'failed'
      ? 'danger'
      : s === 'running' || s === 'queued'
        ? 'info'
        : 'secondary';
}

/** "3 h ago", in the screen's language. */
export function relTime(iso: string | null, language: string, now: number): string {
  const at = Date.parse(iso ?? '');
  if (Number.isNaN(at)) return '—';
  const seconds = Math.round((at - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(seconds, 'second');
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), 'hour');
  return rtf.format(Math.round(seconds / 86_400), 'day');
}

const STATUS_ORDER: BuildStatus[] = ['failed', 'running', 'queued', 'passed', 'cancelled', 'skipped', 'unknown'];
const byStatus = (a: BuildStatus | null, b: BuildStatus | null) =>
  (a ? STATUS_ORDER.indexOf(a) : STATUS_ORDER.length) - (b ? STATUS_ORDER.indexOf(b) : STATUS_ORDER.length);
const byText = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? '').localeCompare(b ?? '', undefined, { sensitivity: 'base', numeric: true });

/* ── The CI runs ── */

interface RunCells {
  t: GridText;
  language: string;
  /** When the screen read: what "3 h ago" counts from. */
  now: number;
  open: string | null;
}

const [RunCellsProvider, useRunCells] = createGridCells<RunCells>('TestsRuns');

const RunDash: React.FC = () => <NoData label={useRunCells().t('no_data')} />;

const RunStatusCell: React.FC<{ item: CiRun }> = ({ item }) => {
  const { t } = useRunCells();
  const s = runStatus(item);
  return (
    <span data-tests-run={s} data-tests-run-id={item.id}>
      <Badge variant={tone(s)}>{t(`status_${s}`)}</Badge>
    </span>
  );
};

const RunWorkflowCell: React.FC<{ item: CiRun }> = ({ item }) => {
  const { t, open } = useRunCells();
  const jobs = item.jobs ?? [];
  return (
    <span className={styles.nowrap}>
      {item.url ? (
        <a href={item.url} target="_blank" rel="noreferrer" data-grid-row-ignore-click>
          {item.workflow}
        </a>
      ) : (
        item.workflow
      )}
      {jobs.length > 0 && (
        <span className={styles.muted}>
          {' '}
          · {open === item.id ? '▾' : '▸'} {t('jobs', { count: jobs.length })}
        </span>
      )}
    </span>
  );
};

const RunBranchCell: React.FC<{ item: CiRun }> = ({ item }) =>
  item.branch ? (
    // A long branch name ends in an ellipsis inside its column instead of running over the commit.
    <span className={styles.branch} title={item.branch}>
      <Badge variant="secondary" className={styles.branchBadge}>
        {item.branch}
      </Badge>
    </span>
  ) : (
    <RunDash />
  );

const RunCommitCell: React.FC<{ item: CiRun }> = ({ item }) => (
  <span className={styles.commit} title={item.title ?? undefined}>
    <code>{item.sha.slice(0, 7)}</code> {item.title}
  </span>
);

const RunFailedCell: React.FC<{ item: CiRun }> = ({ item }) => {
  const failed = failedJobs(item);
  return failed.length ? <span>{failed.map(failedJobLabel).join(', ')}</span> : <RunDash />;
};

const RunWhenCell: React.FC<{ item: CiRun }> = ({ item }) => {
  const { language, now } = useRunCells();
  return <span className={styles.nowrap}>{relTime(item.created_at, language, now)}</span>;
};

const RunTookCell: React.FC<{ item: CiRun }> = ({ item }) => {
  const took = durationLabel(runSeconds(item.jobs ?? []));
  return took ? <span className={styles.nowrap}>{took}</span> : <RunDash />;
};

const RUN_OPTIONS = {
  search: (r: CiRun) => [r.workflow, r.branch, r.sha, r.title, ...failedJobs(r).map(failedJobLabel)],
  compare: {
    status: (a: CiRun, b: CiRun) => byStatus(runStatus(a), runStatus(b)),
    workflow: (a: CiRun, b: CiRun) => byText(a.workflow, b.workflow),
    branch: (a: CiRun, b: CiRun) => byText(a.branch, b.branch),
    when: (a: CiRun, b: CiRun) => byText(a.created_at, b.created_at),
    took: (a: CiRun, b: CiRun) => (runSeconds(a.jobs ?? []) ?? 0) - (runSeconds(b.jobs ?? []) ?? 0),
  },
};

const RunsEmpty: React.FC = () => {
  const { t } = useRunCells();
  return (
    <GridEmpty
      note={t('runs_empty')}
      noMatches={t('no_runs_match')}
      noMatchesActions={<GridClearFilters label={t('clear_search')} />}
    />
  );
};

/** A run's jobs, opened under the list. */
const RunJobs: React.FC<{ run: CiRun; t: GridText }> = ({ run, t }) => (
  <div className={styles.jobs} data-tests-jobs={run.id}>
    <h4 className={styles.jobsTitle}>
      {run.workflow} · <code>{run.sha.slice(0, 7)}</code>
    </h4>
    <ul className={styles.jobList}>
      {(run.jobs ?? []).map((j) => {
        const js = runStatus(j);
        return (
          <li key={j.name} className={styles.job} data-tests-job={js}>
            <Badge variant={tone(js)}>{t(`status_${js}`)}</Badge>{' '}
            {j.url ? (
              <a href={j.url} target="_blank" rel="noreferrer">
                {j.name}
              </a>
            ) : (
              j.name
            )}
            {j.failed_step && <span className={styles.muted}> · {j.failed_step}</span>}
            {durationLabel(j.duration_seconds) && (
              <span className={styles.muted}> · {durationLabel(j.duration_seconds)}</span>
            )}
          </li>
        );
      })}
    </ul>
  </div>
);

export const RunsGrid: React.FC<{ runs: CiRun[]; t: GridText; language: string; now: number }> = ({
  runs,
  t,
  language,
  now,
}) => {
  const [open, setOpen] = useState<string | null>(null);
  const { load, reloadBridge } = useLocalGridLoad(runs, RUN_OPTIONS);
  const columns = useMemo<DataGridTableColumn<CiRun>[]>(
    () => [
      { id: 'status', label: t('col_status'), component: RunStatusCell, width: 120 },
      { id: 'workflow', label: t('col_workflow'), component: RunWorkflowCell, width: 200 },
      { id: 'branch', label: t('col_branch'), component: RunBranchCell, width: 160 },
      { id: 'commit', label: t('col_commit'), component: RunCommitCell },
      { id: 'failed', label: t('col_failed'), component: RunFailedCell, width: 200 },
      { id: 'when', label: t('col_when'), component: RunWhenCell, width: 120 },
      { id: 'took', label: t('col_took'), component: RunTookCell, width: 100 },
    ],
    [t]
  );
  const toggle = useCallback(
    (run: CiRun) => {
      if (!run.jobs?.length) return;
      setOpen((was) => (was === run.id ? null : run.id));
    },
    []
  );
  const cells = useMemo<RunCells>(() => ({ t, language, now, open }), [t, language, now, open]);
  const opened = open ? runs.find((r) => r.id === open) : undefined;
  return (
    <RunCellsProvider value={cells}>
      <div data-tests-runs-table>
        <ListGrid<CiRun>
          name="tests-runs"
          label={t('runs_title')}
          columns={columns}
          load={load}
          search={t('search_runs')}
          empty={RunsEmpty}
          unsortable={['commit', 'failed']}
          minWidth="60rem"
        >
          <DataGridRowClickPlugin<CiRun> click={toggle} />
          {reloadBridge}
        </ListGrid>
      </div>
      {opened && <RunJobs run={opened} t={t} />}
    </RunCellsProvider>
  );
};

RunsGrid.displayName = 'RunsGrid';

/* ── The open pull requests ── */

type DocCheck = PullRequestChecks['items'][number];

/** A pull request, with the run on its branch and its documents' check. */
export type PullGridRow = OpenPullRequest & {
  run: CiRun | null;
  status: BuildStatus | null;
  doc: DocCheck | undefined;
};

interface PullCells {
  t: GridText;
  /** Whether the documents' checks are still being read. */
  checking: boolean;
}

const [PullCellsProvider, usePullCells] = createGridCells<PullCells>('TestsPulls');

const PullCell: React.FC<{ item: PullGridRow }> = ({ item: p }) => (
  <span className={styles.wide} data-tests-pull={p.status ?? 'none'}>
    {p.url ? (
      <a href={p.url} target="_blank" rel="noreferrer">
        #{p.number}
      </a>
    ) : (
      `#${p.number}`
    )}{' '}
    {p.title}
    {p.repo ? <span className={styles.muted}> · {p.repo}</span> : null}
  </span>
);

const PullCiCell: React.FC<{ item: PullGridRow }> = ({ item: p }) => {
  const { t } = usePullCells();
  if (!p.run || !p.status) {
    return <span className={styles.muted}>{p.source_branch ? t('no_run_on_branch') : t('branch_unknown')}</span>;
  }
  return (
    <span>
      <Badge variant={tone(p.status)}>{t(`status_${p.status}`)}</Badge>
      {failedJobs(p.run).map((j) => (
        <span key={j.name} className={`${styles.muted} ${styles.block}`}>
          ✗ {failedJobLabel(j)}
        </span>
      ))}
    </span>
  );
};

const PullDocumentsCell: React.FC<{ item: PullGridRow }> = ({ item: p }) => {
  const { t, checking } = usePullCells();
  if (checking) return <span className={styles.muted}>…</span>;
  if (!p.doc) return <span className={styles.muted}>{t('no_document')}</span>;
  return (
    <span>
      <Badge variant={p.doc.state === 'success' ? 'success' : 'warning'}>
        {p.doc.state === 'success' ? t('doc_pass') : t('doc_fail')}
      </Badge>
      {p.doc.files
        .filter((f) => !f.conforms)
        .map((f) => (
          <span key={f.path} className={`${styles.muted} ${styles.block}`}>
            {f.path}: {f.issues.join('; ')}
          </span>
        ))}
    </span>
  );
};

const PullWaitingCell: React.FC<{ item: PullGridRow }> = ({ item: p }) => {
  const { t } = usePullCells();
  return (
    <span>
      {p.days_open != null ? t('days_open', { days: p.days_open }) : '—'}
      {p.waiting_on.length > 0 && (
        <span className={`${styles.muted} ${styles.block}`}>
          {t('waiting_on', { who: p.waiting_on.map((w) => w.display_name ?? w.login).join(', ') })}
        </span>
      )}
    </span>
  );
};

const PULL_OPTIONS = {
  search: (p: PullGridRow) => [
    `#${p.number}`,
    p.title,
    p.repo,
    p.source_branch,
    ...p.waiting_on.map((w) => w.display_name ?? w.login),
  ],
  compare: {
    pull: (a: PullGridRow, b: PullGridRow) => byText(a.repo, b.repo) || a.number - b.number,
    ci: (a: PullGridRow, b: PullGridRow) => byStatus(a.status, b.status),
    waiting: (a: PullGridRow, b: PullGridRow) => (a.days_open ?? -1) - (b.days_open ?? -1),
  },
};

const PullsEmpty: React.FC = () => {
  const { t } = usePullCells();
  return (
    <GridEmpty
      title={t('none_open')}
      noMatches={t('no_pulls_match')}
      noMatchesActions={<GridClearFilters label={t('clear_search')} />}
    />
  );
};

export const PullsGrid: React.FC<{ rows: PullGridRow[]; checking: boolean; t: GridText }> = ({
  rows,
  checking,
  t,
}) => {
  const { load, reloadBridge } = useLocalGridLoad(rows, PULL_OPTIONS);
  const columns = useMemo<DataGridTableColumn<PullGridRow>[]>(
    () => [
      { id: 'pull', label: t('col_pull'), component: PullCell },
      { id: 'ci', label: t('col_ci'), component: PullCiCell, width: 200 },
      { id: 'documents', label: t('col_documents'), component: PullDocumentsCell, width: 220 },
      { id: 'waiting', label: t('col_waiting'), component: PullWaitingCell, width: 180 },
    ],
    [t]
  );
  const cells = useMemo<PullCells>(() => ({ t, checking }), [t, checking]);
  return (
    <PullCellsProvider value={cells}>
      <div data-tests-pulls-table>
        <ListGrid<PullGridRow>
          name="tests-pulls"
          label={t('pulls_title')}
          columns={columns}
          load={load}
          search={t('search_pulls')}
          empty={PullsEmpty}
          unsortable={['documents']}
          minWidth="52rem"
        >
          {reloadBridge}
        </ListGrid>
      </div>
    </PullCellsProvider>
  );
};

PullsGrid.displayName = 'PullsGrid';
