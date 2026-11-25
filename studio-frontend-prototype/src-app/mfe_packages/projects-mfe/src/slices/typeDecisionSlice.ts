/**
 * The Specs list's type decisions still being sent, by binding id (#690), and
 * the project's proposed types a person may confirm in bulk.
 */

import { createSlice, type ReducerPayload } from '@gears-frontx/react';
import type { ConfirmTarget } from '../model/specsConfirm';
import { closeProject, openProject } from './navSlice';

export interface TypeDecisionState {
  pending: string[];
  /**
   * Every row of the project with a proposed type, whatever the filters show,
   * written after every load; `null` until the first.
   */
  proposed: ConfirmTarget[] | null;
}

const SLICE_KEY = 'projects/typeDecision' as const;

const initialState: TypeDecisionState = { pending: [], proposed: null };

const { slice, decisionStarted, decisionSettled, proposedTypes } = createSlice({
  name: SLICE_KEY,
  initialState,
  reducers: {
    decisionStarted: (state: TypeDecisionState, action: ReducerPayload<string>) => {
      if (!state.pending.includes(action.payload)) state.pending.push(action.payload);
    },
    decisionSettled: (state: TypeDecisionState, action: ReducerPayload<string>) => {
      state.pending = state.pending.filter((id) => id !== action.payload);
    },
    proposedTypes: (state: TypeDecisionState, action: ReducerPayload<ConfirmTarget[] | null>) => {
      state.proposed = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder.addCase(openProject, () => initialState).addCase(closeProject, () => initialState);
  },
});

export const typeDecisionSlice = slice;
export { decisionStarted, decisionSettled, proposedTypes };
export const TYPE_DECISION_SLICE_KEY = SLICE_KEY;

declare module '@gears-frontx/react' {
  interface RootState {
    'projects/typeDecision': TypeDecisionState;
  }
}

export default slice.reducer;
