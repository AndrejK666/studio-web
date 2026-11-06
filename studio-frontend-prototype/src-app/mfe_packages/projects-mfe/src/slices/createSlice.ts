/**
 * The New project wizard's state: which step, and the draft being filled.
 */

// @cpt-dod:cpt-studiofrontend-dod-project-create-reset:p1
// @cpt-dod:cpt-studiofrontend-dod-project-create-many-sources:p1
import { createSlice, type ReducerPayload } from '@gears-frontx/react';
import type { Refusal } from '@constructor-studio/mfe-shared';
import {
  EMPTY_DRAFT,
  MAX_SOURCES,
  type ProjectDraft,
  type RepositoryPick,
} from '../model/projectDraft';
import { FIRST_STEP_KEY, type WizardStepKey } from '../model/wizardSteps';
import { pickerReducers, toggled } from './pickerReducers';

export interface CreateState {
  stepKey: WizardStepKey;
  draft: ProjectDraft;
  providerId: string | null;
  connectionId: string | null;
  search: string;
  submitting: boolean;
  error: Refusal | null;
}

const SLICE_KEY = 'projects/create' as const;

const initialState: CreateState = {
  stepKey: FIRST_STEP_KEY,
  draft: EMPTY_DRAFT,
  providerId: null,
  connectionId: null,
  search: '',
  submitting: false,
  error: null,
};

const {
  slice,
  resetWizard,
  goToStep,
  editDraft,
  pickSource,
  chooseProvider,
  clearProvider,
  chooseConnection,
  searchRepos,
  submitStarted,
  submitFailed,
} = createSlice({
  name: SLICE_KEY,
  initialState,
  reducers: {
    // @cpt-begin:cpt-studiofrontend-dod-project-create-reset:p1:inst-1
    resetWizard: (state: CreateState) => {
      state.stepKey = FIRST_STEP_KEY;
      state.draft = EMPTY_DRAFT;
      state.providerId = null;
      state.connectionId = null;
      state.search = '';
      state.submitting = false;
      state.error = null;
    },
    // @cpt-end:cpt-studiofrontend-dod-project-create-reset:p1:inst-1
    goToStep: (state: CreateState, action: ReducerPayload<WizardStepKey>) => {
      state.stepKey = action.payload;
    },
    editDraft: (state: CreateState, action: ReducerPayload<Partial<ProjectDraft>>) => {
      state.draft = { ...state.draft, ...action.payload };
      state.error = null;
    },
    // @cpt-begin:cpt-studiofrontend-dod-project-create-many-sources:p1:inst-1
    pickSource: (state: CreateState, action: ReducerPayload<RepositoryPick>) => {
      const sources = toggled(state.draft.sources, action.payload, MAX_SOURCES);
      if (!sources) return;
      state.draft = { ...state.draft, sources };
      state.error = null;
    },
    // @cpt-end:cpt-studiofrontend-dod-project-create-many-sources:p1:inst-1
    ...pickerReducers<CreateState>(),
    submitStarted: (state: CreateState) => {
      state.submitting = true;
      state.error = null;
    },
    submitFailed: (state: CreateState, action: ReducerPayload<Refusal>) => {
      state.submitting = false;
      state.error = action.payload;
    },
  },
});

export const createWizardSlice = slice;
export {
  resetWizard,
  goToStep,
  editDraft,
  pickSource,
  chooseProvider,
  clearProvider,
  chooseConnection,
  searchRepos,
  submitStarted,
  submitFailed,
};
export const CREATE_SLICE_KEY = SLICE_KEY;

declare module '@gears-frontx/react' {
  interface RootState {
    'projects/create': CreateState;
  }
}

export default slice.reducer;
