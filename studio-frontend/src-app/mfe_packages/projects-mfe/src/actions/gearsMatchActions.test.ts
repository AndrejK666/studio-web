import { describe, expect, it, vi } from 'vitest';
import { MatcherError, type MatcherClient, type MatcherRun } from '../api/gearsMatcherClient';
import { startGearsMatch } from './gearsMatchActions';

const run = (state: MatcherRun['state'], more: Partial<MatcherRun> = {}): MatcherRun => ({
  id: 'r1',
  state,
  usage: { calls: 0, cache_hits: 0 },
  ...more,
});
const report = { requirements: [], recommended_gears: [] };
const job = {
  projectId: 'p1',
  projectName: 'Constructor Studio',
  spec: { name: 'PRD.md', content: '# PRD' },
  choice: { provider: 'litellm' as const },
};
const noPause = () => Promise.resolve();
const last = (actions: { payload?: unknown }[]) => actions[actions.length - 1]?.payload;

function setup(client: Partial<MatcherClient>) {
  const dispatched: { type: string; payload?: unknown }[] = [];
  const dispatch = ((action: { type: string; payload?: unknown }) =>
    dispatched.push(action)) as never;
  return { dispatched, dispatch, client: client as MatcherClient };
}

describe('startGearsMatch', () => {
  it('submits the chosen connection, follows the run, and reads its report', async () => {
    const submit = vi.fn().mockResolvedValue(run('queued'));
    const poll = vi
      .fn()
      .mockResolvedValueOnce(
        run('running', {
          progress: { requirements_total: 8, requirements_done: 3 },
          usage: { calls: 4, cache_hits: 0 },
        })
      )
      .mockResolvedValueOnce(run('succeeded', { usage: { calls: 7, cache_hits: 1 } }));
    const { dispatched, dispatch, client } = setup({
      submit,
      run: poll,
      report: vi.fn().mockResolvedValue(report),
    });
    await startGearsMatch(dispatch, job, client, noPause);
    const [body, key] = submit.mock.calls[0];
    expect(body.product).toBe('constructor-studio');
    expect(body.options).toMatchObject({ provider: 'litellm' });
    expect(body.options).not.toHaveProperty('model');
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(dispatched.map((a) => a.type.split('/').pop())).toEqual([
      'runStarted',
      'runProgressed',
      'runProgressed',
      'runFinished',
    ]);
    expect(dispatched[2].payload).toMatchObject({
      done: 3,
      total: 8,
      calls: 4,
    });
    expect(dispatched[3].payload).toMatchObject({
      state: 'succeeded',
      calls: 7,
      report,
    });
  });

  it('keeps the report of a partial run, and says why a failed one failed', async () => {
    const partial = setup({
      submit: vi.fn().mockResolvedValue(run('partial')),
      report: vi.fn().mockResolvedValue(report),
    });
    await startGearsMatch(partial.dispatch, job, partial.client, noPause);
    expect(last(partial.dispatched)).toMatchObject({
      state: 'partial',
    });

    const failed = setup({
      submit: vi.fn().mockResolvedValue(
        run('failed', {
          error: { kind: 'input', message: 'not_a_template: x' },
        })
      ),
    });
    await startGearsMatch(failed.dispatch, job, failed.client, noPause);
    expect(last(failed.dispatched)).toMatchObject({
      message: 'not_a_template: x',
    });
  });

  it('shows a refusal or an unreachable matcher as one line, and never throws', async () => {
    const refused = setup({
      submit: vi
        .fn()
        .mockRejectedValue(
          new MatcherError('this service has no key for openai', 'provider_unavailable', 422)
        ),
    });
    await expect(
      startGearsMatch(refused.dispatch, job, refused.client, noPause)
    ).resolves.toBeUndefined();
    expect(last(refused.dispatched)).toMatchObject({
      message: 'this service has no key for openai',
    });

    const odd = setup({
      submit: vi.fn().mockRejectedValue(new Error('boom: secret detail')),
    });
    await startGearsMatch(odd.dispatch, job, odd.client, noPause);
    expect(last(odd.dispatched)).toMatchObject({
      message: 'the match could not be completed',
    });
  });
});
