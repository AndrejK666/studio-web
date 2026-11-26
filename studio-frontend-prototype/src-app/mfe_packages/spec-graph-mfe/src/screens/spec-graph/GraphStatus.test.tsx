import { describe, expect, it } from 'vitest';
import type { Run } from '../../api/types';
import { runLine } from './GraphStatus';

const t = ((key: string) => key) as unknown as Parameters<typeof runLine>[1];
const run = (progress: Run['progress']): Run => ({ id: 'r', job: 'review', state: 'running', error: null, result: null, progress });

describe('runLine', () => {
  it('names the stage and its count, or that the cache had it all', () => {
    expect(runLine(run({ stage: 'judging', done: 3, total: 10 }), t)).toBe('stage_judging 3/10');
    expect(runLine(run({ stage: 'embeddings', done: 0, total: 0 }), t)).toBe('stage_embeddings stage_cached');
    expect(runLine(run({ stage: 'embeddings_cache' }), t)).toBe('stage_embeddings_cache');
    expect(runLine(run(null), t)).toBe('state_running');
  });
});
