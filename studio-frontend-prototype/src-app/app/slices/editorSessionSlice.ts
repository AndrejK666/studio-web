// @cpt-state:cpt-studiofrontend-state-editor-session:p1
// @cpt-dod:cpt-studiofrontend-dod-editor-session-address:p1
/**
 * Editor Session Slice — what the editor's session is doing, for the status
 * over the editor's slot.
 */

import { createSlice, type FrontXApp, type ReducerPayload } from '@gears-frontx/react';

export type EditorSessionPhase = 'idle' | 'launching' | 'ready' | 'failed';

export type EditorSessionFailure =
  /** The project's sources or the organization's connections could not be read; nothing was launched. */
  | { kind: 'sources' }
  /** The launch was refused; a 503's `detail` says whether sessions are off or there is no capacity. */
  | { kind: 'refused'; detail: string | null }
  /** 404: the member no longer reaches the project. */
  | { kind: 'unavailable' }
  /** The readiness run failed or was cancelled. */
  | { kind: 'run'; error: string | null }
  | { kind: 'stopped' }
  /** The person stopped it from the editor's bar; Try again starts a new one. */
  | { kind: 'ended' }
  /** No run, and the record did not say running within one probe attempt. */
  | { kind: 'timeout' }
  /** The run or the record could not be read several times in a row (401, 403, 5xx); the console has the first. */
  | { kind: 'read' }
  /** The session is up, but the IDE in the frame said nothing for two minutes; a late answer still opens it. */
  | { kind: 'unanswered' }
  /** The portal itself threw while launching; the console has the error. */
  | { kind: 'unexpected' };

/**
 * A project source whose last clone or fetch failed (as the kit filling the shell's `editor.cloneProblems` port reports it, #1071): the IDE opens
 * without it, or not at all, so the status over the editor says which and why while it waits.
 */
export interface EditorCloneProblem {
  /** `owner/repo`. */
  repository: string;
  /** `branch_not_found`, `provider_refused`, …; the backend's sentence when the portal has no words for it. */
  cause: string | null;
  causeText: string | null;
  action: string | null;
  actionText: string | null;
  /** The branch, for `branch_not_found`; the host's answer otherwise. */
  detail: string | null;
}

export interface EditorSessionState {
  phase: EditorSessionPhase;
  failure: EditorSessionFailure | null;
  shown: boolean;
  /** The project's sources that could not be cloned, as last read. */
  clones: EditorCloneProblem[];
}

const SLICE_KEY = 'app/editor-session' as const;

const initialState: EditorSessionState = { phase: 'idle', failure: null, shown: false, clones: [] };

const {
  slice,
  editorSessionReset,
  editorSessionLaunching,
  editorSessionReady,
  editorSessionFailed,
  editorSessionShown,
  editorSessionClones,
} = createSlice({
  name: SLICE_KEY,
  initialState,
  reducers: {
    editorSessionReset: (state: EditorSessionState) => {
      state.phase = 'idle';
      state.failure = null;
      state.clones = [];
    },
    editorSessionClones: (state: EditorSessionState, action: ReducerPayload<EditorCloneProblem[]>) => {
      state.clones = action.payload;
    },
    editorSessionLaunching: (state: EditorSessionState) => {
      state.phase = 'launching';
      state.failure = null;
    },
    editorSessionReady: (state: EditorSessionState) => {
      state.phase = 'ready';
      state.failure = null;
    },
    editorSessionFailed: (state: EditorSessionState, action: ReducerPayload<EditorSessionFailure>) => {
      state.phase = 'failed';
      state.failure = action.payload;
    },
    editorSessionShown: (state: EditorSessionState, action: ReducerPayload<boolean>) => {
      state.shown = action.payload;
    },
  },
});

export function readEditorSession(app: Pick<FrontXApp, 'store'>): EditorSessionState {
  return (
    ((app.store.getState() as Record<string, unknown>)[SLICE_KEY] as EditorSessionState | undefined) ??
    initialState
  );
}

export const editorSessionSlice = slice;
export {
  editorSessionReset,
  editorSessionLaunching,
  editorSessionReady,
  editorSessionFailed,
  editorSessionShown,
  editorSessionClones,
};
export const EDITOR_SESSION_SLICE_KEY = SLICE_KEY;

export default slice.reducer;
