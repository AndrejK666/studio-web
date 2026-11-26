import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  queries: [] as unknown[],
  nodes: [] as string[],
  answer: (_body: { type: string }): Promise<unknown> => Promise.resolve({ items: [], total: 0 }),
}));

vi.mock('../data/domain', () => ({
  domainQuerySend: () => ({
    fetch: (body: { type: string }) => {
      calls.queries.push(body);
      return calls.answer(body);
    },
  }),
}));

vi.mock('../data/gateway', () => ({
  withQuery: (path: string, params: Record<string, unknown>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
    return `${path}?${q}`;
  },
  gateway: () => ({
    get: (path: string) => ({
      fetch: () => {
        calls.nodes.push(path);
        return Promise.resolve({ nodes: [{ type_id: 't', instance_id: 'from-nodes', value: {} }], total: 1 });
      },
    }),
  }),
}));

import {
  artifactNodeOf,
  fetchProjectArtifacts,
  forgetArtifactsInModel,
  movedByMarker,
  projectArtifactsQuery,
} from './projectArtifacts';

const row = (id: string, value: Record<string, unknown>) => ({ id, entity: 'x', value });

beforeEach(() => {
  calls.queries = [];
  calls.nodes = [];
  forgetArtifactsInModel();
});

describe('projectArtifactsQuery', () => {
  it('lists the kind in the project, newest first when asked', () => {
    expect(projectArtifactsQuery('workflow_run', 'p1', { limit: 500, sort: 'updated' })).toEqual({
      type: 'ci-run',
      project_id: 'p1',
      limit: 200,
      order_by: [{ field: 'updated_at', direction: 'desc' }],
    });
    expect(projectArtifactsQuery('repo', 'p1')).toEqual({ type: 'repository', project_id: 'p1', limit: 50 });
  });
});

describe('artifactNodeOf', () => {
  it('is the node /nodes returns: the artifact id and its payload', () => {
    expect(artifactNodeOf('build', row('art-b1', { status: 'ok' }))).toEqual({
      type_id: 'gts.cf.studio.artifact.build.v1~',
      instance_id: 'b1',
      value: { status: 'ok' },
    });
  });
});

describe('movedByMarker', () => {
  it('is moved only while the marker is there and not returned', () => {
    expect(movedByMarker([])).toBe(false);
    expect(movedByMarker([row('art-store-moved-v1', { status: 'done' })])).toBe(true);
    expect(movedByMarker([row('art-store-moved-v1', { status: 'returned' })])).toBe(false);
  });
});

describe('fetchProjectArtifacts', () => {
  it('reads through the query where the organization has moved', async () => {
    calls.answer = (body) =>
      Promise.resolve(
        body.type === 'sync-state'
          ? { items: [row('art-store-moved-v1', { status: 'done' })], total: 1 }
          : { items: [row('art-r1', { full_path: 'acme/one' })], total: 1 }
      );
    const page = await fetchProjectArtifacts('org', 'p1', 'repo', { limit: 200 });
    expect(page.nodes.map((n) => n.instance_id)).toEqual(['r1']);
    expect(calls.nodes).toEqual([]);
    // The marker is asked once per organization for a while.
    await fetchProjectArtifacts('org', 'p1', 'build');
    expect(calls.queries.filter((q) => (q as { type: string }).type === 'sync-state')).toHaveLength(1);
  });

  it('falls back to /nodes before the move, so the screen is not blank', async () => {
    calls.answer = () => Promise.resolve({ items: [], total: 0 });
    const page = await fetchProjectArtifacts('org', 'p1', 'workflow_run', { sort: 'updated' });
    expect(page.nodes.map((n) => n.instance_id)).toEqual(['from-nodes']);
    expect(calls.nodes).toEqual(['/studio-artifact-ingest/v1/nodes?type=workflow_run&scope=p1&sort=updated&limit=50']);
  });

  it('falls back to /nodes when the marker cannot be read', async () => {
    calls.answer = () => Promise.reject(new Error('403'));
    const page = await fetchProjectArtifacts('org', 'p1', 'repo');
    expect(page.total).toBe(1);
    expect(calls.nodes).toHaveLength(1);
  });

  it('reads /nodes while the organization is not known', async () => {
    await fetchProjectArtifacts(null, 'p1', 'repo');
    expect(calls.queries).toEqual([]);
    expect(calls.nodes).toHaveLength(1);
  });
});
