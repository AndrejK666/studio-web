import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { service } = vi.hoisted(() => ({ service: {} as Record<string, unknown> }));
vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  apiRegistry: { getService: () => service },
}));

import type { Run } from '../../api/types';
import { GraphStatus, runLine } from './GraphStatus';

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

describe('GraphStatus', () => {
  it('cancels a run going on', async () => {
    const cancel = vi.fn((..._a: unknown[]) => Promise.resolve({ run: { id: 'r1', state: 'cancelled' } }));
    const running = { id: 'r1', job: 'index', state: 'running', error: null, result: null, progress: { stage: 'facts', done: 3, total: 9 } };
    Object.assign(service, {
      runs: ({ job }: { job: string }) => ({ fetch: () => Promise.resolve({ items: job === 'index' ? [running] : [], total: 0 }) }),
      cancelRun: (_p: string, id: string) => ({ fetch: () => cancel(id) }),
    });
    render(<GraphStatus projectId="p1" nodes={10} onChanged={() => undefined} t={t} />);
    fireEvent.click(await screen.findByText('run_cancel'));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith('r1'));
  });
});

