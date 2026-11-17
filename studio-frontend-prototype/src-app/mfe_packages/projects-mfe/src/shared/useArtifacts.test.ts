import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodesParams } from '../api/ArtifactIngestApiService';
import { ARTIFACT_NODE_TYPES } from '../api/artifactTypes';
import type { DocumentDto } from '../api/documentTypes';

/**
 * The header's repository total is its own read: the grid's page carries the
 * search and the type, the header must not (DoD `...-counters`).
 */

interface Answer {
  data?: { nodes: never[]; total: number };
  isLoading: boolean;
  isError: boolean;
}

const { answer, invalidate, imported, fetched } = vi.hoisted(() => ({
  answer: vi.fn<(params: NodesParams) => Answer>(),
  invalidate: vi.fn(),
  imported: vi.fn(),
  fetched: [] as NodesParams[],
}));

vi.mock('@gears-frontx/react', () => ({
  apiRegistry: {
    getService: () => ({
      nodes: (params: NodesParams) => ({
        params,
        fetch: () => {
          fetched.push(params);
          return Promise.resolve({ nodes: [], total: 40 });
        },
      }),
    }),
  },
  useApiQuery: (descriptor: { params: NodesParams }) => answer(descriptor.params),
  useQueryCache: () => ({ invalidate }),
}));
vi.mock('../api/ArtifactIngestApiService', () => ({ ArtifactIngestApiService: class {} }));
vi.mock('./useProjectConfig', () => ({
  useProjectConfig: () => ({ config: { sources: [] }, loading: false, failed: false }),
}));
vi.mock('./useArtifactImport', () => ({ useProjectImport: () => imported() }));
vi.mock('./useProjectDocuments', () => ({
  useProjectDocuments: () => ({ documents: [], own: [], loading: false, failed: false }),
}));

import { readArtifactsPage, useArtifacts } from './useArtifacts';

const ok = (total: number): Answer => ({ data: { nodes: [], total }, isLoading: false, isError: false });
const isRepositoryTotal = (params: NodesParams) =>
  params.limit === 1 && params.repo !== undefined;
const noop = () => {};

beforeEach(() => {
  invalidate.mockClear();
  fetched.length = 0;
  imported.mockReturnValue({ phase: 'idle', repos: [] });
  answer.mockReset();
  // Every limit=1 read with a repo answers 96; the project count 1286.
  answer.mockImplementation((params) => {
    if (isRepositoryTotal(params)) return ok(96);
    if (params.limit === 1) return ok(1286);
    return ok(96);
  });
});

describe('the repository total in the header', () => {
  it('is the repository read', () => {
    const { result } = renderHook(() => useArtifacts('p1', 'w1', 'r-1', noop));
    expect(result.current.repositoryTotal).toBe(96);
    expect(answer).toHaveBeenCalledWith({ scope: 'p1', repo: 'r-1', limit: 1 });
  });

  it('is absent with no repository chosen, and its read is the project count', () => {
    const { result } = renderHook(() => useArtifacts('p1', 'w1', null, noop));
    expect(result.current.repositoryTotal).toBeNull();
    expect(result.current.projectTotal).toBe(1286);
    expect(answer.mock.calls.some(([params]) => isRepositoryTotal(params))).toBe(false);
  });

  it('fails on its own, without taking the tab down', () => {
    answer.mockImplementation((params) =>
      isRepositoryTotal(params) ? { isLoading: false, isError: true } : ok(96)
    );
    const { result } = renderHook(() => useArtifacts('p1', 'w1', 'r-1', noop));
    expect(result.current.repositoryTotal).toBeNull();
    expect(result.current.repositoryTotalFailed).toBe(true);
    expect(result.current.failed).toBe(false);
  });

  it('is asked again by refetch, and so is the list', () => {
    const onRefresh = vi.fn();
    const { result } = renderHook(() => useArtifacts('p1', 'w1', 'r-1', onRefresh));
    result.current.refetch();
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ params: { scope: 'p1', repo: 'r-1', limit: 1 } }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

describe("the grid's page", () => {
  const NAMES = new Map<string, string>();
  const doc = (id: string, title: string) => ({ id, title, updated_at: '2026-01-01T00:00:00Z' }) as DocumentDto;

  it('sends the chosen kind as its full GTS id, the repository and the search', async () => {
    await readArtifactsPage('p1', [], NAMES, { repo: 'r-1', kind: 'issue', search: ' broken ' }, 0, 25);
    expect(fetched[0]).toMatchObject({
      scope: 'p1',
      sort: 'updated',
      repo: 'r-1',
      type: ARTIFACT_NODE_TYPES.issue,
      q: 'broken',
      limit: 25,
    });
  });

  it('sends no type for all types — the gear answers its default kinds', async () => {
    await readArtifactsPage('p1', [], NAMES, { repo: null, kind: null, search: '' }, 0, 25);
    expect(fetched[0]).not.toHaveProperty('type', expect.anything());
  });

  it("puts the project's own documents first, and counts them in the total", async () => {
    const page = await readArtifactsPage('p1', [doc('d1', 'Plan')], NAMES, { repo: null, kind: null, search: '' }, 0, 25);
    expect(page.rows.map((r) => r.id)).toEqual(['d1']);
    expect(page.total).toBe(41);
    expect(fetched[0]).toMatchObject({ limit: 24, offset: 0 });
  });

  it('hides the documents under a repository or a type filter', async () => {
    const page = await readArtifactsPage('p1', [doc('d1', 'Plan')], NAMES, { repo: 'r-1', kind: null, search: '' }, 0, 25);
    expect(page.rows).toEqual([]);
    expect(page.total).toBe(40);
  });
});

describe('the re-read while an import runs', () => {
  /** One refetch invalidates the repositories, the project count and the repository total, and re-reads the page. */
  const READS_PER_REFETCH = 3;
  const importing = (...repos: [status: string, stored: number][]) => ({
    phase: 'running',
    repos: repos.map(([status, stored], i) => ({ repo: `acme/r-${i}`, status, stored })),
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('happens at once when a sync starts or settles, and not again for the same statuses', () => {
    const onRefresh = vi.fn();
    imported.mockReturnValue(importing(['queued', 0], ['queued', 0]));
    const { rerender } = renderHook(() => useArtifacts('p1', 'w1', null, onRefresh));
    invalidate.mockClear();
    onRefresh.mockClear();

    imported.mockReturnValue(importing(['running', 0], ['queued', 0]));
    rerender();
    expect(invalidate).toHaveBeenCalledTimes(READS_PER_REFETCH);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    rerender();
    expect(invalidate).toHaveBeenCalledTimes(READS_PER_REFETCH);
  });

  it('happens once in two seconds however often the stored count grows', () => {
    imported.mockReturnValue(importing(['running', 0]));
    const { rerender } = renderHook(() => useArtifacts('p1', 'w1', null, noop));
    invalidate.mockClear();

    for (const stored of [1_000, 2_000, 3_000]) {
      imported.mockReturnValue(importing(['running', stored]));
      rerender();
    }
    expect(invalidate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_000);
    expect(invalidate).toHaveBeenCalledTimes(READS_PER_REFETCH);
  });

  it('keeps happening every two seconds while the stored count keeps growing', () => {
    imported.mockReturnValue(importing(['running', 0]));
    const { rerender } = renderHook(() => useArtifacts('p1', 'w1', null, noop));
    invalidate.mockClear();

    for (let second = 1; second <= 5; second += 1) {
      imported.mockReturnValue(importing(['running', second * 1_000]));
      rerender();
      vi.advanceTimersByTime(1_000);
      if (second === 2) expect(invalidate).toHaveBeenCalledTimes(READS_PER_REFETCH);
    }

    expect(invalidate).toHaveBeenCalledTimes(2 * READS_PER_REFETCH);
  });

  it('drops the pending one when a status change re-reads at once', () => {
    imported.mockReturnValue(importing(['running', 0], ['queued', 0]));
    const { rerender } = renderHook(() => useArtifacts('p1', 'w1', null, noop));
    invalidate.mockClear();

    imported.mockReturnValue(importing(['running', 1_000], ['queued', 0]));
    rerender();
    imported.mockReturnValue(importing(['running', 1_000], ['running', 0]));
    rerender();
    vi.advanceTimersByTime(2_000);

    expect(invalidate).toHaveBeenCalledTimes(READS_PER_REFETCH);
  });

  it('does not happen once the hook is gone', () => {
    imported.mockReturnValue(importing(['running', 0]));
    const { rerender, unmount } = renderHook(() => useArtifacts('p1', 'w1', null, noop));
    invalidate.mockClear();

    imported.mockReturnValue(importing(['running', 1_000]));
    rerender();
    unmount();
    vi.advanceTimersByTime(2_000);

    expect(invalidate).not.toHaveBeenCalled();
  });
});
