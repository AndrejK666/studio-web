/**
 * The New project wizard's state: which step, and the draft being filled.
 */

// @cpt-dod:cpt-studiofrontend-dod-project-create-reset:p1
import { createSlice, type ReducerPayload } from '@gears-frontx/react';
import type { Refusal } from '@constructor-studio/mfe-shared';
import { EMPTY_DRAFT, type ProjectDraft } from '../model/projectDraft';
import { FIRST_STEP_KEY, type WizardStepKey } from '../model/wizardSteps';

/** The server's run creating the project, as last read. */
export interface CreateProgress {
  runId: string;
  state: string;
  steps: { key: string; state: string; detail?: string | null }[];
}

export interface CreateState {
  stepKey: WizardStepKey;
  draft: ProjectDraft;
  submitting: boolean;
  error: Refusal | null;
  /** The creation's run once the server took it; its steps show in the dialog. */
  progress: CreateProgress | null;
}

const SLICE_KEY = 'projects/create' as const;

const initialState: CreateState = {
  stepKey: FIRST_STEP_KEY,
  draft: EMPTY_DRAFT,
  submitting: false,
  error: null,
  progress: null,
};

const { slice, resetWizard, goToStep, editDraft, submitStarted, submitFailed, submitProgress } = createSlice({
  name: SLICE_KEY,
  initialState,
  reducers: {
    // @cpt-begin:cpt-studiofrontend-dod-project-create-reset:p1:inst-1
    resetWizard: (state: CreateState) => {
      state.stepKey = FIRST_STEP_KEY;
      state.draft = EMPTY_DRAFT;
      state.submitting = false;
      state.error = null;
      state.progress = null;
    },
    // @cpt-end:cpt-studiofrontend-dod-project-create-reset:p1:inst-1
    goToStep: (state: CreateState, action: ReducerPayload<WizardStepKey>) => {
      state.stepKey = action.payload;
    },
    editDraft: (state: CreateState, action: ReducerPayload<Partial<ProjectDraft>>) => {
      state.draft = { ...state.draft, ...action.payload };
      state.error = null;
    },
    submitStarted: (state: CreateState) => {
      state.submitting = true;
      state.error = null;
      state.progress = null;
    },
    submitFailed: (state: CreateState, action: ReducerPayload<Refusal>) => {
      state.submitting = false;
      state.error = action.payload;
    },
    /** The run as last read: kept after a failure, so the dialog says which step stopped. */
    submitProgress: (state: CreateState, action: ReducerPayload<CreateProgress>) => {
      state.progress = action.payload;
    },
  },
});

export const createWizardSlice = slice;
export { resetWizard, goToStep, editDraft, submitStarted, submitFailed, submitProgress };
export const CREATE_SLICE_KEY = SLICE_KEY;

declare module '@gears-frontx/react' {
  interface RootState {
    'projects/create': CreateState;
  }
}

export default slice.reducer;
