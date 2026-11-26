import { describe, expect, it } from 'vitest';
import type { Run } from '../api/types';
import { elapsed, ended, lastSucceeded, progressOf } from './runs';

const run = (state: Run['state'], extra: Partial<Run> = {}): Run => ({ id: state, job: 'review', state, error: null, result: null, ...extra });

describe('runs on the page', () => {
  it('reads a running step\'s progress', () => {
    expect(progressOf(run('running', { progress: { stage: 'facts', done: 40, total: 85 } }))).toEqual({ stage: 'facts', done: 40, total: 85 });
    expect(progressOf(run('running'))).toBeNull();
  });

  it('tells ended runs and the last success', () => {
    expect(ended(run('failed'))).toBe(true);
    expect(ended(run('running'))).toBe(false);
    expect(lastSucceeded([run('running'), run('succeeded'), run('failed')])?.id).toBe('succeeded');
  });

  it('says the time gone', () => {
    expect(elapsed('2026-11-26T11:00:00Z', Date.parse('2026-11-26T11:03:07Z'))).toBe('3:07');
    expect(elapsed(null)).toBeNull();
  });
});
