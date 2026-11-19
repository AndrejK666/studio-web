import { describe, expect, it } from 'vitest';
import { CREATE_SLICE_KEY, createWizardSlice, editDraft, resetWizard, submitFailed, submitProgress, submitStarted } from './createSlice';

const reducer = createWizardSlice.reducer;

describe(`${CREATE_SLICE_KEY}: the draft`, () => {
  it('takes the name, the type, the goal and the owner, and drops a refusal on an edit', () => {
    let state = reducer(undefined, { type: '@@init' });
    state = reducer(state, submitFailed({ kind: 'i18n', key: 'error_create' }));
    state = reducer(state, editDraft({ name: 'Shop', typeKit: 'gears-project', goal: 'Tea', ownerId: 'u1' }));
    expect(state.draft).toEqual({ name: 'Shop', typeKit: 'gears-project', goal: 'Tea', ownerId: 'u1' });
    expect(state.error).toBeNull();
  });

  it('is empty again when the wizard opens', () => {
    let state = reducer(undefined, { type: '@@init' });
    state = reducer(state, editDraft({ name: 'Shop', typeKit: 'gears-project' }));
    state = reducer(state, resetWizard());
    expect(state.draft).toEqual({ name: '', goal: '', ownerId: null });
  });
});

describe(`${CREATE_SLICE_KEY}: the server's run`, () => {
  const run = { runId: 'r1', state: 'failed', steps: [{ key: 'tenant', state: 'done' }, { key: 'config', state: 'failed', detail: 'down' }] };

  it('keeps the run as last read after a failure, so the dialog says which step stopped', () => {
    let state = reducer(undefined, { type: '@@init' });
    state = reducer(state, submitStarted());
    state = reducer(state, submitProgress(run));
    state = reducer(state, submitFailed({ kind: 'provider', text: 'down' }));
    expect(state.progress).toEqual(run);
    expect(state.submitting).toBe(false);
  });

  it('starts again from no run when the member creates again', () => {
    let state = reducer(undefined, { type: '@@init' });
    state = reducer(state, submitProgress(run));
    state = reducer(state, submitStarted());
    expect(state.progress).toBeNull();
    expect(state.submitting).toBe(true);
  });
});
