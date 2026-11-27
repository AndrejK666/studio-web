import { describe, expect, it } from 'vitest';
import type { StudioRun } from '@constructor-studio/mfe-shared';
import {
  lastSyncRuns,
  sourceSyncRun,
  syncRunView,
  syncStatusOf,
  syncTook,
  withoutRepo,
  type SyncLine,
} from './sourceSyncRun';

/** A source's last sync as the "Last sync" cell says it. */

function run(overrides: Partial<StudioRun> = {}): StudioRun {
  return {
    id: 'r-1',
    tenant_id: 'org-1',
    task_type: 'artifact.ingest',
    state: 'succeeded',
    payload: { project_id: 'p-1', repo_full_path: 'acme/api' },
    partition_key: null,
    attempts: 1,
    progress: null,
    summary: null,
    result: null,
    last_error: null,
    cancel_requested: false,
    requested_by: 'u-1',
    created_at: '2026-11-26T07:00:00Z',
    updated_at: '2026-11-26T07:13:00Z',
    started_at: '2026-11-26T07:00:05Z',
    finished_at: '2026-11-26T07:13:00Z',
    ...overrides,
  };
}

function line(overrides: Partial<SyncLine> = {}): SyncLine {
  return { repo: 'acme/api', runId: 'r-1', status: 'running', ...overrides };
}

describe('syncStatusOf', () => {
  it('reads a run waiting for the ingest slot as queued, and any other running one as running', () => {
    expect(syncStatusOf('running', 1, 'waiting for another repository to finish', null)).toBe('queued');
    expect(syncStatusOf('running', 1, 'linking merge requests to files: 7495 of 10269 linked', null)).toBe(
      'running'
    );
  });

  it('reads a queued run that tried before as partial when the attempt ran out of time with work left', () => {
    expect(
      syncStatusOf(
        'queued',
        1,
        null,
        'acme/api: partial -- linked 7495 of 10269 merge requests to their files, 2774 left before the attempt\'s time ran out; the next attempt continues from there'
      )
    ).toBe('partial');
  });

  it('reads a queued run that tried before and failed as retrying, and a fresh one as queued', () => {
    expect(syncStatusOf('queued', 1, null, 'the provider answered 502')).toBe('retrying');
    expect(syncStatusOf('queued', 0, null, null)).toBe('queued');
    expect(syncStatusOf('queued', 1, null, null)).toBe('queued');
  });

  it('keeps the states that ended', () => {
    expect(syncStatusOf('succeeded', 1, null, null)).toBe('succeeded');
    expect(syncStatusOf('failed', 3, null, 'x')).toBe('failed');
    expect(syncStatusOf('cancelled', 1, null, null)).toBe('cancelled');
  });
});

describe('withoutRepo', () => {
  it("takes the repository's own name off what the run said: the row already names it", () => {
    expect(withoutRepo('acme/api: 10269 pull requests, 9187 files', 'acme/api')).toBe(
      '10269 pull requests, 9187 files'
    );
    expect(withoutRepo('Acme/API: done', 'acme/api')).toBe('done');
    expect(withoutRepo('attempt 1 never reported back', 'acme/api')).toBe('attempt 1 never reported back');
    expect(withoutRepo('  ', 'acme/api')).toBeNull();
    expect(withoutRepo(null, 'acme/api')).toBeNull();
  });
});

describe('lastSyncRuns', () => {
  it('keeps the newest run of each repository, a running one over a queued one behind it', () => {
    const runs = [
      run({ id: 'r-queued', state: 'queued', payload: { repo_full_path: 'acme/api' } }),
      run({ id: 'r-running', state: 'running', payload: { repo_full_path: 'acme/api' } }),
      run({ id: 'r-old', state: 'failed', payload: { repo_full_path: 'acme/api' } }),
      run({ id: 'r-web', state: 'succeeded', payload: { repo_full_path: 'Acme/Web' } }),
      run({ id: 'r-none', payload: { something: 'else' } }),
    ];
    const last = lastSyncRuns(runs);
    expect(last.get('acme/api')?.id).toBe('r-running');
    expect(last.get('acme/web')?.id).toBe('r-web');
    expect(last.size).toBe(2);
  });
});

describe('sourceSyncRun', () => {
  it('says nothing without a run', () => {
    expect(sourceSyncRun('acme/api', undefined, undefined)).toBeNull();
    expect(sourceSyncRun('acme/api', undefined, line({ runId: null, status: 'unsyncable' }))).toBeNull();
  });

  it('shows a listed run that succeeded with its summary, tries and times', () => {
    expect(
      sourceSyncRun(
        'acme/api',
        run({ summary: 'acme/api: 0 issues, 10269 pull requests, 9187 files, 3261 comments, 5000 commits' }),
        undefined
      )
    ).toEqual({
      runId: 'r-1',
      status: 'succeeded',
      detail: '0 issues, 10269 pull requests, 9187 files, 3261 comments, 5000 commits',
      attempts: 1,
      createdAt: '2026-11-26T07:00:00Z',
      startedAt: '2026-11-26T07:00:05Z',
      finishedAt: '2026-11-26T07:13:00Z',
    });
  });

  it('shows a failed run with its error', () => {
    const shown = sourceSyncRun(
      'acme/api',
      run({
        state: 'failed',
        attempts: 3,
        last_error: "attempt 1 never reported back (its lease ran out and the queue took it back)",
      }),
      undefined
    );
    expect(shown).toMatchObject({
      status: 'failed',
      detail: 'attempt 1 never reported back (its lease ran out and the queue took it back)',
      attempts: 3,
    });
  });

  it('shows a running run with its phase', () => {
    expect(
      sourceSyncRun(
        'acme/api',
        run({ state: 'running', attempts: 2, progress: 'linking merge requests to files: 7495 of 10269 linked', finished_at: null }),
        undefined
      )
    ).toMatchObject({ status: 'running', detail: 'linking merge requests to files: 7495 of 10269 linked', attempts: 2, finishedAt: null });
  });

  it("takes the live line over the listing, and the listing's tries and times for the same run", () => {
    const listed = run({ state: 'running', attempts: 2, progress: 'reading', finished_at: null });
    expect(
      sourceSyncRun('acme/api', listed, line({ status: 'succeeded', summary: 'acme/api: 5 files' }))
    ).toMatchObject({
      runId: 'r-1',
      status: 'succeeded',
      detail: '5 files',
      attempts: 2,
      startedAt: '2026-11-26T07:00:05Z',
      // The listing was read while it ran: its end is not this one.
      finishedAt: null,
    });
  });

  it('knows no tries for a live line the listing has not caught up with', () => {
    expect(
      sourceSyncRun('acme/api', run({ id: 'r-old' }), line({ runId: 'r-new', status: 'queued' }))
    ).toMatchObject({ runId: 'r-new', status: 'queued', attempts: null, startedAt: null });
  });

  it('reads a live line queued again after a partial attempt as partial, with what is left', () => {
    expect(
      sourceSyncRun(
        'acme/api',
        undefined,
        line({ status: 'queued', lastError: 'acme/api: partial -- linked 7 of 10 pull requests, 3 left' })
      )
    ).toMatchObject({ status: 'partial', detail: 'partial -- linked 7 of 10 pull requests, 3 left' });
  });

  it("gives a live failure the portal's own reason when the gear said nothing", () => {
    expect(
      sourceSyncRun('acme/api', undefined, line({ status: 'failed', reasonText: 'the run is gone' }))
    ).toMatchObject({ status: 'failed', detail: 'the run is gone' });
    expect(sourceSyncRun('acme/api', undefined, line({ status: 'lost' }))).toMatchObject({
      status: 'lost',
      detail: null,
    });
  });
});

describe('syncTook', () => {
  const now = Date.parse('2026-11-26T10:00:00Z');

  it('counts from the start to the end, or to now while it runs', () => {
    expect(syncTook({ startedAt: '2026-11-26T09:59:15Z', finishedAt: '2026-11-26T10:00:00Z' }, now)).toBe('45 s');
    expect(syncTook({ startedAt: '2026-11-26T09:48:00Z', finishedAt: null }, now)).toBe('12 min');
    expect(syncTook({ startedAt: '2026-11-26T07:55:00Z', finishedAt: null }, now)).toBe('2 h 5 min');
    expect(syncTook({ startedAt: '2026-11-26T08:00:00Z', finishedAt: null }, now)).toBe('2 h');
  });

  it('says nothing before the run started', () => {
    expect(syncTook({ startedAt: null, finishedAt: null }, now)).toBeNull();
  });
});

describe('syncRunView', () => {
  it("names the run in the Background work screen's view", () => {
    expect(syncRunView('0D9C1F2A-1111-4222-8333-444455556666')).toBe('run-0d9c1f2a-1111-4222-8333-444455556666');
    expect(syncRunView('r/1')).toBeNull();
  });
});
