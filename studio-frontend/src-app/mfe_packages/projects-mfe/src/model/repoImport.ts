import type { StudioRunState } from '@constructor-studio/mfe-shared';

export type RepoImportStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'lost'
  | 'unsyncable';

/**
 * The phase an ingest reports while it waits for the one ingest slot
 * (`studio-backend/src/artifact_ingest/ingest_task.rs`).
 */
const WAITING_FOR_SLOT = 'waiting for another repository';

/** A run's state as its repository's line says it. */
export function repoStatusOf(state: StudioRunState, phase: string | null): RepoImportStatus {
  return state === 'running' && phase?.startsWith(WAITING_FOR_SLOT) ? 'queued' : state;
}

interface RepoRun {
  runId: string | null;
  status: RepoImportStatus;
}

export function canCancel(row: RepoRun): boolean {
  return row.runId !== null && (row.status === 'queued' || row.status === 'running');
}

export function canRetry(row: RepoRun): boolean {
  return row.runId !== null && (row.status === 'failed' || row.status === 'cancelled');
}
