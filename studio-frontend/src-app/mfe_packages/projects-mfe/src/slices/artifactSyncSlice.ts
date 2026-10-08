/** Where a project's import stands */

import { createSlice, type ReducerPayload } from '@gears-frontx/react';
import { runCount, type Refusal, type RunUpdate } from '@constructor-studio/mfe-shared';
import { repoStatusOf, type RepoImportStatus } from '../model/repoImport';

export type { RepoImportStatus } from '../model/repoImport';

export interface RepoImport {
  repo: string;
  runId: string | null;
  status: RepoImportStatus;
  /** The phase the gear last reported, while it runs. */
  phase: string | null;
  /** The gear's one line about what it did, once it succeeded. */
  summary: string | null;
  /** Why it stopped. */
  reason: Refusal | null;
  /** Nodes the sync has flushed so far. */
  stored: number;
  /** Cancel was asked for and the gear has not recorded it yet. */
  cancelling: boolean;
  /** The gear refused the last cancel or retry. */
  refusal: Refusal | null;
}

export type ImportPhase = 'idle' | 'running' | 'settled' | 'failed';

export interface ProjectImport {
  phase: ImportPhase;
  attempted: boolean;
  repos: RepoImport[];
}

export interface ArtifactSyncState {
  byProject: Record<string, ProjectImport>;
}

const SLICE_KEY = 'projects/artifact-sync' as const;

const initialState: ArtifactSyncState = { byProject: {} };

const EMPTY: ProjectImport = { phase: 'idle', attempted: false, repos: [] };

const UNSETTLED: readonly RepoImportStatus[] = ['queued', 'running'];

// @cpt-state:cpt-studiofrontend-state-project-artifacts-import:p2
function settle(repos: readonly RepoImport[]): ImportPhase {
  if (repos.length === 0) return 'settled';
  if (repos.some((r) => UNSETTLED.includes(r.status))) return 'running';
  return repos.some((r) => r.status === 'succeeded') ? 'settled' : 'failed';
}

function row(repo: string, status: RepoImportStatus, reason: Refusal | null): RepoImport {
  return {
    repo,
    runId: null,
    status,
    phase: null,
    summary: null,
    reason,
    stored: 0,
    cancelling: false,
    refusal: null,
  };
}

function repoOf(state: ArtifactSyncState, projectId: string, repo: string) {
  const entry = state.byProject[projectId];
  const found = entry?.repos.find((r) => r.repo === repo);
  return entry && found ? { entry, row: found } : null;
}

const {
  slice,
  importStarted,
  repoEnqueued,
  repoUpdated,
  repoProgressed,
  repoCancelling,
  repoRetried,
  repoControlRefused,
  importAbandoned,
} = createSlice({
  name: SLICE_KEY,
  initialState,
  reducers: {
    importStarted: (
      state: ArtifactSyncState,
      action: ReducerPayload<{
        projectId: string;
        repos: string[];
        unsyncable: { repo: string; reason: Refusal }[];
      }>
    ) => {
      const { projectId, repos, unsyncable } = action.payload;
      const rows: RepoImport[] = [
        ...repos.map((repo) => row(repo, 'queued', null)),
        ...unsyncable.map(({ repo, reason }) => row(repo, 'unsyncable', reason)),
      ];
      state.byProject[projectId] = { phase: settle(rows), attempted: true, repos: rows };
    },

    repoEnqueued: (
      state: ArtifactSyncState,
      action: ReducerPayload<{ projectId: string; repo: string; runId: string }>
    ) => {
      const found = repoOf(state, action.payload.projectId, action.payload.repo);
      if (found) found.row.runId = action.payload.runId;
    },

    repoUpdated: (
      state: ArtifactSyncState,
      action: ReducerPayload<{ projectId: string; repo: string; update: RunUpdate }>
    ) => {
      const { projectId, repo, update } = action.payload;
      const found = repoOf(state, projectId, repo);
      if (!found) return;
      const target = found.row;
      if (update.phase !== undefined) target.phase = update.phase;
      if (update.result) target.stored = runCount(update.result, 'stored');
      target.status = repoStatusOf(update.state, target.phase);
      if (target.status === 'succeeded') target.summary = update.summary ?? target.summary;
      // @cpt-begin:cpt-studiofrontend-algo-project-artifacts-sync:p2:inst-14
      // @cpt-begin:cpt-studiofrontend-algo-project-artifacts-sync:p2:inst-15
      if (target.status === 'failed' || target.status === 'cancelled') {
        const said = update.error ?? null;
        target.reason = said ? { kind: 'provider', text: said } : null;
      }
      // @cpt-end:cpt-studiofrontend-algo-project-artifacts-sync:p2:inst-14
      // @cpt-end:cpt-studiofrontend-algo-project-artifacts-sync:p2:inst-15
      if (!UNSETTLED.includes(target.status)) target.cancelling = false;
      found.entry.phase = settle(found.entry.repos);
    },

    /** The portal's own verdict: the request was refused, or the run is gone. */
    repoProgressed: (
      state: ArtifactSyncState,
      action: ReducerPayload<{
        projectId: string;
        repo: string;
        status: RepoImportStatus;
        reason: Refusal | null;
      }>
    ) => {
      const { projectId, repo, status, reason } = action.payload;
      const found = repoOf(state, projectId, repo);
      if (!found) return;
      found.row.status = status;
      found.row.reason = reason;
      found.row.cancelling = false;
      found.entry.phase = settle(found.entry.repos);
    },

    repoCancelling: (
      state: ArtifactSyncState,
      action: ReducerPayload<{ projectId: string; repo: string }>
    ) => {
      const found = repoOf(state, action.payload.projectId, action.payload.repo);
      if (!found) return;
      found.row.cancelling = true;
      found.row.refusal = null;
    },

    /** Back on the queue, the same run: what it said last time no longer stands. */
    repoRetried: (
      state: ArtifactSyncState,
      action: ReducerPayload<{ projectId: string; repo: string }>
    ) => {
      const found = repoOf(state, action.payload.projectId, action.payload.repo);
      if (!found) return;
      Object.assign(found.row, {
        status: 'queued',
        phase: null,
        summary: null,
        reason: null,
        stored: 0,
        cancelling: false,
        refusal: null,
      });
      found.entry.phase = settle(found.entry.repos);
    },

    repoControlRefused: (
      state: ArtifactSyncState,
      action: ReducerPayload<{ projectId: string; repo: string; refusal: Refusal }>
    ) => {
      const found = repoOf(state, action.payload.projectId, action.payload.repo);
      if (!found) return;
      found.row.cancelling = false;
      found.row.refusal = action.payload.refusal;
    },

    importAbandoned: (state: ArtifactSyncState, action: ReducerPayload<string>) => {
      const entry = state.byProject[action.payload];
      if (entry) state.byProject[action.payload] = { ...EMPTY, attempted: entry.attempted };
    },
  },
});

export const artifactSyncSlice = slice;
export {
  importStarted,
  repoEnqueued,
  repoUpdated,
  repoProgressed,
  repoCancelling,
  repoRetried,
  repoControlRefused,
  importAbandoned,
};
export const ARTIFACT_SYNC_SLICE_KEY = SLICE_KEY;

export function projectImport(state: ArtifactSyncState, projectId: string): ProjectImport {
  return state.byProject[projectId] ?? EMPTY;
}

declare module '@gears-frontx/react' {
  interface RootState {
    'projects/artifact-sync': ArtifactSyncState;
  }
}

export default slice.reducer;
