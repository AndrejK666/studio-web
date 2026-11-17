import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubResizeObserver } from '@frontx-test-utils/stubResizeObserver';
import type { TaskRun } from '../../background/types';

// The kit's DataGrid measures its header.
stubResizeObserver();

const { service, calls, live } = vi.hoisted(() => ({
  service: {} as Record<string, unknown>,
  calls: [] as string[],
  live: { value: null as unknown },
}));

vi.mock('../../i18n', () => ({
  useBackgroundTranslations: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
    loading: false,
  }),
}));
vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  apiRegistry: { getService: () => service },
  // The shell's live channel relays its last event under its own property; every other read here is the language.
  useSharedProperty: (id: string) => (id.includes('live.studio_events') ? live.value : 'en'),
}));

vi.mock('@constructor-studio/mfe-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@constructor-studio/mfe-shared')>()),
  useOrganization: () => ({ org: { id: 'o1', name: 'Org' } }),
}));

import { BackgroundScreen } from './BackgroundScreen';

const run = (id: string, state: string, task_type = 'catalog.sync'): TaskRun =>
  ({
    id: `${id}-0000-0000`,
    tenant_id: 't',
    task_type,
    state,
    payload: {},
    attempts: 1,
    cancel_requested: false,
    requested_by: 'someone',
    created_at: '2026-11-04T10:00:00Z',
    updated_at: '2026-11-04T10:00:00Z',
    last_error: state === 'failed' ? 'the token was refused' : null,
  }) as TaskRun;

describe('BackgroundScreen', () => {
  beforeEach(() => {
    calls.length = 0;
    live.value = null;
    Object.assign(service, {
      taskTypes: { fetch: () => Promise.resolve({ items: ['catalog.sync'] }) },
      schedules: {
        fetch: () =>
          Promise.resolve({
            items: [
              // Another organization's schedule: not this one's to see or run.
              { id: 's2', name: 'Elsewhere', task_type: 'catalog.sync', payload: { organization_id: 'o2' }, expression_kind: 'cron', expression: '0 3 * * *', timezone: 'UTC', concurrency: 'forbid', missed_policy: 'skip', max_catch_up_runs: 0, enabled: true, next_run_at: null, created_at: '' },
              {
                id: 's1',
                name: 'Nightly catalogue',
                task_type: 'catalog.sync',
                payload: { organization_id: 'o1' },
                expression_kind: 'cron',
                expression: '0 3 * * *',
                timezone: 'UTC',
                concurrency: 'forbid',
                missed_policy: 'skip',
                max_catch_up_runs: 0,
                enabled: true,
                next_run_at: '2026-11-05T03:00:00Z',
                created_at: '',
              },
            ],
          }),
      },
      runs: ({ state, organizationId, limit }: { state?: string; organizationId?: string; limit?: number }) => ({
        fetch: () => {
          if (organizationId !== 'o1') throw new Error('runs read outside the organization in view');
          // The header's counts read one run per state; the list reads a page.
          if (limit !== 1) calls.push(state ?? 'every');
          if (state === 'failed') return Promise.resolve({ items: [run('f1', 'failed')], total: 1 });
          if (state === 'running') return Promise.resolve({ items: [run('r1', 'running', 'notify.deliver')], total: 1 });
          if (state === undefined)
            return Promise.resolve({ items: [run('f1', 'failed'), run('s1', 'succeeded', 'docs.index')], total: 2 });
          return Promise.resolve({ items: [], total: 0 });
        },
      }),
      retry: (id: string) => ({ fetch: () => (calls.push(`retry:${id}`), Promise.resolve({})) }),
      cancel: () => ({ fetch: () => Promise.resolve({}) }),
      runNow: (id: string) => ({ fetch: () => (calls.push(`run-now:${id}`), Promise.resolve({ run_id: 'r' })) }),
    });
  });

  it('opens on what failed and what is running, and retries a failed run', async () => {
    render(<BackgroundScreen />);
    expect(await screen.findByText('the token was refused')).toBeTruthy();
    expect(calls).toEqual(expect.arrayContaining(['failed', 'running']));
    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    await waitFor(() => expect(calls).toContain('retry:f1-0000-0000'));
  });

  it('runs a schedule now', async () => {
    render(<BackgroundScreen />);
    expect(await screen.findByText('Nightly catalogue')).toBeTruthy();
    expect(screen.queryByText('Elsewhere')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'run_now' }));
    await waitFor(() => expect(calls).toContain('run-now:s1'));
  });

  it('reads the runs again when the shell relays a run transition', async () => {
    const view = render(<BackgroundScreen />);
    expect(await screen.findByText('the token was refused')).toBeTruthy();
    const before = calls.filter((c) => c === 'failed').length;
    live.value = { seq: 7, at_ms: 1, kind: 'task.succeeded', subject_type: 'task_run', subject_id: 'r', source: 'studio-tasks', payload: {} };
    view.rerender(<BackgroundScreen />);
    await waitFor(() => expect(calls.filter((c) => c === 'failed').length).toBeGreaterThan(before));
  });

  it('does not read again for an event about something else', async () => {
    const view = render(<BackgroundScreen />);
    expect(await screen.findByText('the token was refused')).toBeTruthy();
    const before = calls.length;
    live.value = { seq: 8, at_ms: 1, kind: 'workspace.created', subject_type: 'workspace', subject_id: 'w', source: 'x', payload: {} };
    view.rerender(<BackgroundScreen />);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(calls.length).toBe(before);
  });

  it('lists the runs through the grid: the search narrows them and says when nothing matched', async () => {
    render(<BackgroundScreen />);
    expect(await screen.findByText('the token was refused')).toBeTruthy();
    const runs = document.querySelector('[data-list-grid="background-runs"]') as HTMLElement;
    expect(runs.querySelector('[data-run-id="r1-0000-0000"]')).toBeTruthy();
    fireEvent.change(within(runs).getByPlaceholderText('search_runs'), { target: { value: 'notify' } });
    await waitFor(() => expect(runs.querySelector('[data-run-id="f1-0000-0000"]')).toBeNull());
    expect(runs.querySelector('[data-run-id="r1-0000-0000"]')).toBeTruthy();
    fireEvent.change(within(runs).getByPlaceholderText('search_runs'), { target: { value: 'nothing like it' } });
    expect(await within(runs).findByText('runs_no_matches')).toBeTruthy();
    fireEvent.click(within(runs).getByText('clear_search'));
    await waitFor(() => expect(runs.querySelector('[data-run-id="f1-0000-0000"]')).toBeTruthy());
  });

  it('asks the server for the state the grid filter chose', async () => {
    render(<BackgroundScreen />);
    expect(await screen.findByText('the token was refused')).toBeTruthy();
    const runs = document.querySelector('[data-list-grid="background-runs"]') as HTMLElement;
    const filter = within(runs)
      .getAllByRole('button', { name: /col_state/ })
      .find((b) => !b.closest('thead')) as HTMLElement;
    fireEvent.click(filter);
    fireEvent.click(await screen.findByRole('radio', { name: 'filter_every' }));
    await waitFor(() => expect(calls).toContain('every'));
    expect(await screen.findByText('docs.index')).toBeTruthy();
  });

  it('opens a run under the list', async () => {
    render(<BackgroundScreen />);
    await screen.findByText('the token was refused');
    // The runs are read again once the schedules arrive (a recurring task folds), and the grid redraws its
    // rows: click the row on screen until the click lands on a row still there.
    await waitFor(() => {
      if (!document.querySelector('[data-run-details]')) fireEvent.click(screen.getByText('the token was refused'));
      expect(document.querySelector('[data-run-details="f1-0000-0000"]')).toBeTruthy();
    });
  });

  it('says so when nothing failed and nothing is running, and when no schedule matched', async () => {
    Object.assign(service, {
      runs: () => ({ fetch: () => Promise.resolve({ items: [], total: 0 }) }),
    });
    render(<BackgroundScreen />);
    expect(await screen.findByText('runs_empty')).toBeTruthy();
    const schedules = await waitFor(() => {
      const found = document.querySelector('[data-list-grid="background-schedules"]');
      if (!found) throw new Error('no schedules grid');
      return found as HTMLElement;
    });
    await within(schedules).findByText('Nightly catalogue');
    fireEvent.change(within(schedules).getByPlaceholderText('search_schedules'), { target: { value: 'weekly' } });
    expect(await within(schedules).findByText('schedules_no_matches')).toBeTruthy();
  });

  it('offers a retry when the runs could not be read', async () => {
    let fail = true;
    Object.assign(service, {
      runs: ({ state, limit }: { state?: string; limit?: number }) => ({
        fetch: () => {
          if (limit === 1) return Promise.resolve({ items: [], total: 0 });
          return fail
            ? Promise.reject(new Error('boom'))
            : Promise.resolve(state === 'failed' ? { items: [run('f1', 'failed')], total: 1 } : { items: [], total: 0 });
        },
      }),
    });
    render(<BackgroundScreen />);
    const retry = await screen.findByRole('button', { name: 'try_again' });
    fail = false;
    fireEvent.click(retry);
    expect(await screen.findByText('the token was refused')).toBeTruthy();
  });
});
