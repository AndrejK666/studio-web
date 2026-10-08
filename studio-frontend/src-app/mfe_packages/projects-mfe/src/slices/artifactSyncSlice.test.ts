import { describe, expect, it } from 'vitest';
import type { RunUpdate } from '@constructor-studio/mfe-shared';
import reducer, {
  importStarted,
  projectImport,
  repoCancelling,
  repoControlRefused,
  repoEnqueued,
  repoProgressed,
  repoRetried,
  repoUpdated,
  type ArtifactSyncState,
} from './artifactSyncSlice';

const PROJECT = 'p-1';

function started(...repos: string[]): ArtifactSyncState {
  return repos.reduce(
    (state, repo, i) => reducer(state, repoEnqueued({ projectId: PROJECT, repo, runId: `r-${i + 1}` })),
    reducer(undefined, importStarted({ projectId: PROJECT, repos, unsyncable: [] }))
  );
}

const updated = (state: ArtifactSyncState, repo: string, update: Omit<RunUpdate, 'runId'>) =>
  reducer(state, repoUpdated({ projectId: PROJECT, repo, update: { runId: 'r', ...update } }));

const lost = (state: ArtifactSyncState, repo: string) =>
  reducer(state, repoProgressed({ projectId: PROJECT, repo, status: 'lost', reason: null }));

const imported = (state: ArtifactSyncState) => projectImport(state, PROJECT);

describe('the import as its syncs end', () => {
  it('settles when one sync succeeded and the rest were cancelled or lost', () => {
    let state = started('acme/api', 'acme/web', 'acme/docs');
    state = updated(state, 'acme/api', { state: 'succeeded' });
    state = updated(state, 'acme/web', { state: 'cancelled' });
    state = lost(state, 'acme/docs');

    expect(imported(state).phase).toBe('settled');
  });

  it('fails when every sync was cancelled or lost', () => {
    let state = started('acme/api', 'acme/web');
    state = updated(state, 'acme/api', { state: 'cancelled' });
    state = lost(state, 'acme/web');

    expect(imported(state).phase).toBe('failed');
  });

  it('runs again when a sync is retried after the import settled', () => {
    let state = started('acme/api', 'acme/web');
    state = updated(state, 'acme/api', { state: 'succeeded' });
    state = updated(state, 'acme/web', { state: 'failed', error: 'rate limited' });
    expect(imported(state).phase).toBe('settled');

    state = reducer(state, repoRetried({ projectId: PROJECT, repo: 'acme/web' }));

    expect(imported(state).phase).toBe('running');
    expect(imported(state).repos[1]).toMatchObject({ status: 'queued', reason: null });
  });
});

describe('a sync as its run reports', () => {
  it('keeps its phase when a running event says none', () => {
    let state = started('acme/api');
    state = updated(state, 'acme/api', { state: 'running', phase: 'pulling issues…' });
    state = updated(state, 'acme/api', { state: 'running' });

    expect(imported(state).repos[0]).toMatchObject({ status: 'running', phase: 'pulling issues…' });
  });

  it.each([
    ['cancelling', repoCancelling({ projectId: PROJECT, repo: 'acme/api' })],
    [
      'a refusal',
      repoControlRefused({
        projectId: PROJECT,
        repo: 'acme/api',
        refusal: { kind: 'i18n', key: 'artifacts_reason_cancel_refused' },
      }),
    ],
  ])('forgets what it said last time, %s included, when it is retried', (_what, control) => {
    let state = started('acme/api');
    state = updated(state, 'acme/api', { state: 'running', phase: 'pulling issues…', result: { stored: 40 } });
    state = updated(state, 'acme/api', { state: 'succeeded', summary: 'acme/api: done' });
    state = updated(state, 'acme/api', { state: 'failed', error: 'rate limited' });
    state = reducer(state, control);

    state = reducer(state, repoRetried({ projectId: PROJECT, repo: 'acme/api' }));

    expect(imported(state).repos[0]).toMatchObject({
      status: 'queued',
      phase: null,
      summary: null,
      reason: null,
      stored: 0,
      cancelling: false,
      refusal: null,
    });
  });
});
