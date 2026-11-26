/**
 * A source's last sync as a run of `studio-tasks`: what the Sources tab's
 * "Last sync" cell says beside the date, and what its details open.
 *
 * Two places know about a sync. The runs the project's syncs left
 * (`GET /studio-tasks/v1/runs?project_id=`), newest first, say how each
 * repository's last sync ended even after a reload; the store's import lines
 * follow the syncs this tab watches, live. A line with a run is the newer
 * word; the listed run adds what a line does not carry (tries, times).
 */

import type { StudioRun, StudioRunState } from '@constructor-studio/mfe-shared';
import type { RepoImportStatus } from './repoImport';
import { pathKey } from './syncRequest';

/** The phase an ingest reports while it waits for the one ingest slot (`ingest_task.rs`). */
const WAITING_FOR_SLOT = 'waiting for another repository';

/** How the ingest says an attempt ran out of time with work left (`ingest_task.rs`). */
const PARTIAL = /: partial -- /;

export type SyncRunStatus =
  /** On the queue, never started, or waiting for the ingest slot. */
  | 'queued'
  | 'running'
  /** Stopped with work left and back on the queue: the next attempt continues. */
  | 'partial'
  /** An attempt failed and the run is back on the queue for another. */
  | 'retrying'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  /** The portal lost the run: it is gone from the gear. */
  | 'lost';

export interface SourceSyncRun {
  runId: string;
  status: SyncRunStatus;
  /**
   * One line for a person: the phase while it runs, what it did once it
   * succeeded, why it stopped — the repository's own name taken off.
   */
  detail: string | null;
  /** Attempts started so far; `null` when only the live line is known. */
  attempts: number | null;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** What the store follows of one sync (`RepoImport`'s fields this needs). */
export interface SyncLine {
  repo: string;
  runId: string | null;
  status: RepoImportStatus;
  phase?: string | null;
  summary?: string | null;
  /** The run's last error, kept while it is queued for another attempt too. */
  lastError?: string | null;
  reasonText?: string | null;
}

const SETTLED: ReadonlySet<SyncRunStatus> = new Set(['succeeded', 'failed', 'cancelled', 'lost']);

export function syncSettled(status: SyncRunStatus): boolean {
  return SETTLED.has(status);
}

/** The run's state in the cell's words: a queued run that has tried before is retrying, or continuing. */
export function syncStatusOf(
  state: StudioRunState,
  attempts: number,
  phase: string | null | undefined,
  lastError: string | null | undefined
): SyncRunStatus {
  if (state === 'running') return phase?.startsWith(WAITING_FOR_SLOT) ? 'queued' : 'running';
  if (state === 'queued') {
    if (attempts > 0 && lastError) return PARTIAL.test(lastError) ? 'partial' : 'retrying';
    return 'queued';
  }
  return state;
}

/** `acme/api: 12 issues, …` → `12 issues, …`: the row already names the repository. */
export function withoutRepo(text: string | null | undefined, repo: string): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  const prefix = `${repo}: `;
  const shown = trimmed.toLowerCase().startsWith(prefix.toLowerCase())
    ? trimmed.slice(prefix.length)
    : trimmed;
  return shown || null;
}

function detailOf(
  status: SyncRunStatus,
  repo: string,
  said: { phase?: string | null; summary?: string | null; error?: string | null }
): string | null {
  switch (status) {
    case 'running':
    case 'queued':
      return withoutRepo(said.phase, repo);
    case 'partial':
    case 'retrying':
    case 'failed':
    case 'cancelled':
      return withoutRepo(said.error, repo);
    case 'succeeded':
      return withoutRepo(said.summary, repo);
    case 'lost':
      return null;
  }
}

/** The repository a run syncs, from its payload; `null` for a run of no repository. */
function repoOfRun(run: StudioRun): string | null {
  const payload = run.payload as { repo_full_path?: unknown } | null;
  return typeof payload?.repo_full_path === 'string' ? payload.repo_full_path : null;
}

/**
 * Each repository's last sync among the listed runs (newest first): the
 * first listed, except that a running run wins over a queued one waiting
 * behind it.
 */
export function lastSyncRuns(runs: readonly StudioRun[]): Map<string, StudioRun> {
  const byRepo = new Map<string, StudioRun>();
  for (const run of runs) {
    const repo = repoOfRun(run);
    if (repo === null) continue;
    const key = pathKey(repo);
    const kept = byRepo.get(key);
    if (!kept || (kept.state === 'queued' && run.state === 'running')) byRepo.set(key, run);
  }
  return byRepo;
}

function fromRun(run: StudioRun, repo: string): SourceSyncRun {
  const status = syncStatusOf(run.state, run.attempts, run.progress, run.last_error);
  return {
    runId: run.id,
    status,
    detail: detailOf(status, repo, {
      phase: run.progress,
      summary: run.summary,
      error: run.last_error,
    }),
    attempts: run.attempts,
    createdAt: run.created_at,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
  };
}

function lineStatus(line: SyncLine, attempts: number): SyncRunStatus | null {
  switch (line.status) {
    case 'queued':
      // A line queued again after an attempt says so through its error.
      return line.lastError ? syncStatusOf('queued', Math.max(attempts, 1), null, line.lastError) : 'queued';
    case 'running':
    case 'succeeded':
    case 'failed':
    case 'cancelled':
    case 'lost':
      return line.status;
    case 'unsyncable':
      return null;
  }
}

/**
 * A source's last sync: the store's line when it follows a run (live), with
 * what the listing knows of that same run; else the listed run; `null` when
 * neither knows of one.
 */
export function sourceSyncRun(
  repo: string,
  listed: StudioRun | undefined,
  line: SyncLine | undefined
): SourceSyncRun | null {
  if (line?.runId) {
    const same = listed?.id === line.runId ? listed : undefined;
    const status = lineStatus(line, same?.attempts ?? 0);
    if (status !== null) {
      return {
        runId: line.runId,
        status,
        detail: detailOf(status, repo, {
          phase: line.phase ?? same?.progress,
          summary: line.summary ?? same?.summary,
          error: line.lastError ?? line.reasonText ?? same?.last_error,
        }),
        attempts: same?.attempts ?? null,
        createdAt: same?.created_at ?? null,
        startedAt: same?.started_at ?? null,
        // A line that settled after the listing was read: the listing's end is not this one.
        finishedAt: same && syncSettled(status) ? same.finished_at : null,
      };
    }
  }
  return listed ? fromRun(listed, repo) : null;
}

/** How long a run took, or has taken so far: `45 s`, `12 min`, `2 h 5 min`. `null` before it started. */
export function syncTook(run: Pick<SourceSyncRun, 'startedAt' | 'finishedAt'>, now: number): string | null {
  if (!run.startedAt) return null;
  const start = Date.parse(run.startedAt);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** The view of the Background work screen that opens one run: `run-<id>` (`screenOpenAction.ts` takes `[a-z][a-z0-9-]*`). */
export function syncRunView(runId: string): string | null {
  const view = `run-${runId.toLowerCase()}`;
  return /^[a-z][a-z0-9-]*$/.test(view) ? view : null;
}
