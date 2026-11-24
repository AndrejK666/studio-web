import { describe, expect, it, vi } from 'vitest';
import { MatcherError, createMatcherClient } from './gearsMatcherClient';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('the matcher client', () => {
  it('submits a run with its idempotency key, through the dev proxy path', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json({ id: 'r1', state: 'queued', usage: {} }, 202));
    const client = createMatcherClient(fetchMock);
    const body = { product: 'p', documents: [], options: {} };
    await expect(client.submit(body, 'key-1')).resolves.toMatchObject({
      id: 'r1',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/gears-matcher/v1/runs');
    expect(init.method).toBe('POST');
    expect(init.headers['Idempotency-Key']).toBe('key-1');
    expect(JSON.parse(init.body)).toEqual(body);
  });

  it('reads a run and its report by id', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(json({ id: 'r 1' })));
    const client = createMatcherClient(fetchMock);
    await client.run('r 1');
    await client.report('r 1');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/gears-matcher/v1/runs/r%201',
      '/gears-matcher/v1/runs/r%201/report',
    ]);
  });

  it('turns a refusal into its code and one line', async () => {
    const problem = {
      code: 'provider_unavailable',
      detail: 'this service has no key for openai',
    };
    const client = createMatcherClient(vi.fn().mockResolvedValue(json(problem, 422)));
    const error = await client.run('r1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MatcherError);
    expect(error).toMatchObject({ code: 'provider_unavailable', status: 422 });
    expect((error as Error).message).toBe('this service has no key for openai');
  });

  it('says the matcher is not reachable when nothing answers, or a proxy answers with a page', async () => {
    const down = createMatcherClient(vi.fn().mockRejectedValue(new TypeError('failed')));
    await expect(down.run('r1')).rejects.toMatchObject({ code: 'unreachable' });
    const page = createMatcherClient(
      vi.fn().mockResolvedValue(new Response('<html>', { status: 502 }))
    );
    await expect(page.run('r1')).rejects.toMatchObject({
      code: 'unavailable',
      status: 502,
    });
  });
});
