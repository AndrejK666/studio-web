/**
 * The Gears section's choice of connection, model and spec, shared by the section and the header's
 * Match button, and each project's latest match run while it is shown.
 */

import { createSlice, type ReducerPayload } from '@gears-frontx/react';
import type { CoverageReport, RunState } from '../api/gearsMatcherClient';
import {
  DEFAULT_MATCH_CHOICE,
  chooseProvider,
  modelsLabel,
  type MatchChoice,
  type MatchSpec,
} from '../model/gearsMatch';

export type GearsRunPhase = 'running' | 'done' | 'failed';

export interface GearsRun {
  provider: string;
  /** The models it runs on, as a person reads them. */
  models: string;
  phase: GearsRunPhase;
  /** The spec's name, for the note. */
  spec: string;
  /** What the service last said: how far it is and what it has cost so far. */
  done: number;
  total: number;
  calls: number;
  /** `partial` when some requirements could not be assessed. */
  state: RunState | null;
  report: CoverageReport | null;
  /** One line for a person, when `phase` is `failed`. */
  error: string | null;
}

export interface GearsMatchState {
  choice: MatchChoice;
  spec: MatchSpec | null;
  /** By project id. */
  runs: Record<string, GearsRun>;
}

const SLICE_KEY = 'projects/gearsMatch' as const;

const initialState: GearsMatchState = {
  choice: DEFAULT_MATCH_CHOICE,
  spec: null,
  runs: {},
};

interface Progress {
  projectId: string;
  done: number;
  total: number;
  calls: number;
}

const {
  slice,
  providerPicked,
  specPicked,
  specCleared,
  runStarted,
  runProgressed,
  runFinished,
  runFailed,
} = createSlice({
  name: SLICE_KEY,
  initialState,
  reducers: {
    providerPicked: (state: GearsMatchState, action: ReducerPayload<string>) => {
      state.choice = chooseProvider(action.payload);
    },
    specPicked: (state: GearsMatchState, action: ReducerPayload<MatchSpec>) => {
      state.spec = action.payload;
    },
    specCleared: (state: GearsMatchState) => {
      state.spec = null;
    },
    /** The run takes the choice and the spec as they are now; a later change does not rewrite it. */
    runStarted: (state: GearsMatchState, action: ReducerPayload<string>) => {
      state.runs[action.payload] = {
        provider: state.choice.provider,
        models: modelsLabel(state.choice.provider),
        phase: 'running',
        spec: state.spec?.name ?? '',
        done: 0,
        total: 0,
        calls: 0,
        state: null,
        report: null,
        error: null,
      };
    },
    runProgressed: (state: GearsMatchState, action: ReducerPayload<Progress>) => {
      const run = state.runs[action.payload.projectId];
      if (!run || run.phase !== 'running') return;
      run.done = action.payload.done;
      run.total = action.payload.total;
      run.calls = action.payload.calls;
    },
    runFinished: (
      state: GearsMatchState,
      action: ReducerPayload<{
        projectId: string;
        state: RunState;
        calls: number;
        report: CoverageReport;
      }>
    ) => {
      const run = state.runs[action.payload.projectId];
      if (!run) return;
      run.phase = 'done';
      run.state = action.payload.state;
      run.calls = action.payload.calls;
      run.report = action.payload.report;
    },
    runFailed: (
      state: GearsMatchState,
      action: ReducerPayload<{ projectId: string; message: string }>
    ) => {
      const run = state.runs[action.payload.projectId];
      if (!run) return;
      run.phase = 'failed';
      run.error = action.payload.message;
    },
  },
});

/** Whether the project's latest match is still running. */
export function matchRunning(state: GearsMatchState, projectId: string): boolean {
  return state.runs[projectId]?.phase === 'running';
}

export const gearsMatchSlice = slice;
export {
  providerPicked,
  specPicked,
  specCleared,
  runStarted,
  runProgressed,
  runFinished,
  runFailed,
};
export const GEARS_MATCH_SLICE_KEY = SLICE_KEY;

declare module '@gears-frontx/react' {
  interface RootState {
    'projects/gearsMatch': GearsMatchState;
  }
}

export default slice.reducer;
