import { describe, expect, it } from 'vitest';
import reducer, {
  matchRunning,
  modelPicked,
  providerPicked,
  runFailed,
  runFinished,
  runProgressed,
  runStarted,
  specCleared,
  specPicked,
} from './gearsMatchSlice';

const start = () => reducer(undefined, { type: '@@init' });
const report = { requirements: [], recommended_gears: [] };

describe('the Gears match slice', () => {
  it('starts on LiteLLM and its default model, with no spec', () => {
    expect(start().choice).toEqual({
      provider: 'litellm',
      model: 'glm-5.3-flash',
    });
    expect(start().spec).toBeNull();
  });

  it('switches connection and model, and picks and clears a spec', () => {
    let state = reducer(reducer(start(), providerPicked('openai')), modelPicked('gpt-5.5'));
    expect(state.choice).toEqual({ provider: 'openai', model: 'gpt-5.5' });
    state = reducer(state, specPicked({ name: 'PRD.md', content: '# PRD' }));
    expect(state.spec?.name).toBe('PRD.md');
    expect(reducer(state, specCleared()).spec).toBeNull();
  });

  it('records a run with the choice and spec it started on, and follows it to the report', () => {
    let state = reducer(start(), specPicked({ name: 'PRD.md', content: '# PRD' }));
    state = reducer(state, runStarted('p1'));
    expect(state.runs.p1).toMatchObject({
      provider: 'litellm',
      model: 'glm-5.3-flash',
      spec: 'PRD.md',
      phase: 'running',
    });
    expect(matchRunning(state, 'p1')).toBe(true);
    // A later change of choice does not rewrite the run that is already going.
    state = reducer(state, providerPicked('openai'));
    expect(state.runs.p1.provider).toBe('litellm');
    state = reducer(state, runProgressed({ projectId: 'p1', done: 3, total: 8, calls: 5 }));
    expect(state.runs.p1).toMatchObject({ done: 3, total: 8, calls: 5 });
    state = reducer(state, runFinished({ projectId: 'p1', state: 'partial', calls: 7, report }));
    expect(state.runs.p1).toMatchObject({
      phase: 'done',
      state: 'partial',
      calls: 7,
      report,
    });
    expect(matchRunning(state, 'p1')).toBe(false);
  });

  it('ends a failed run with a line for a person, and ignores progress after the end', () => {
    let state = reducer(
      reducer(start(), runStarted('p1')),
      runFailed({ projectId: 'p1', message: 'no key' })
    );
    expect(state.runs.p1).toMatchObject({ phase: 'failed', error: 'no key' });
    state = reducer(state, runProgressed({ projectId: 'p1', done: 9, total: 9, calls: 9 }));
    expect(state.runs.p1.done).toBe(0);
  });

  it('keeps each project its own run', () => {
    const state = reducer(reducer(start(), runStarted('p1')), runStarted('p2'));
    expect(Object.keys(state.runs)).toEqual(['p1', 'p2']);
  });
});
