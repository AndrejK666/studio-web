import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Inbox, InboxItem } from '../../inbox/types';

const { inbox, mark, requestWorkspace, service } = vi.hoisted(() => {
  const inbox = vi.fn();
  const mark = vi.fn();
  // One instance, as the registry gives: a new one per render would read again on every render.
  const service = {
    inbox: (q: unknown) => ({ fetch: () => inbox(q) }),
    mark: { fetch: (body: unknown) => mark(body) },
  };
  return { inbox, mark, requestWorkspace: vi.fn(), service };
});

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  apiRegistry: { getService: () => service },
  useMfeBridge: () => null,
  useSharedProperty: () => null,
}));
vi.mock('../../actions/workspaceActions', () => ({ requestWorkspace }));

import { InboxGroup } from './InboxGroup';

const t = Object.assign(
  (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
  { count: (key: string, count: number) => `${key} ${count}` }
);

const review: InboxItem = {
  key: 'review:r1',
  source: 'review-requests',
  workspace_id: 'w1',
  workspace_name: 'Main',
  title: 'Billing spec',
  url: null,
  due_at: '2026-11-01T00:00:00Z',
  overdue: true,
  record: { id: 'r1', title: 'Billing spec', requested_by_name: 'Ann' },
};

const pull: InboxItem = {
  key: 'pr:p1@2026-11-09',
  source: 'pull-requests',
  workspace_id: 'w1',
  workspace_name: 'Main',
  title: 'Fix login',
  url: 'https://example.test/acme/web/pull/42',
  due_at: null,
  overdue: false,
  record: {
    id: 'p1',
    repo: 'acme/web',
    number: 42,
    title: 'Fix login',
    waiting: 'review',
    days_open: 3,
    days_since_update: 9,
  },
};

const page = (items: InboxItem[], extra: Partial<Inbox> = {}): Inbox => ({
  items,
  total: items.length,
  other: 0,
  unread: [],
  ...extra,
});

const status = (code: number) => Object.assign(new Error(`HTTP ${code}`), { response: { status: code } });

const phaseWaiting: InboxItem = {
  key: 'kit:project-lifecycle/phase-waiting:obj-1@00ff',
  source: 'kit:project-lifecycle/phase-waiting',
  workspace_id: 'w1',
  workspace_name: 'Main',
  title: 'Atlas waits in its discovery phase',
  url: null,
  due_at: null,
  overdue: false,
  record: { id: 'obj-1', value: { name: 'Atlas', phase: 'discovery' } },
  kit: { slug: 'project-lifecycle', name: 'Project lifecycle', version: '0.1.0' },
};

describe('InboxGroup', () => {
  beforeEach(() => {
    inbox.mockReset();
    mark.mockReset();
    requestWorkspace.mockReset();
    mark.mockResolvedValue({});
  });

  it("shows a kit's item with its title and the kit's name, and marks it like any other", async () => {
    inbox.mockResolvedValue(page([phaseWaiting]));
    render(<InboxGroup organizationId="o1" workspaces={1} t={t as never} />);
    expect(await screen.findByText('Atlas waits in its discovery phase')).toBeTruthy();
    const badge = document.querySelector('[data-inbox-kit="project-lifecycle"]');
    expect(badge?.textContent).toBe('Project lifecycle');
    fireEvent.click(screen.getByRole('button', { name: 'inbox_done' }));
    await waitFor(() =>
      expect(mark).toHaveBeenCalledWith(expect.objectContaining({ item_key: phaseWaiting.key, state: 'done' }))
    );
  });

  it('draws what the server says waits, and counts it', async () => {
    inbox.mockResolvedValue(page([review, pull]));
    const onCount = vi.fn();
    render(<InboxGroup organizationId="o1" workspaces={1} t={t} onCount={onCount} />);
    expect(screen.getByText('inbox_reading')).toBeTruthy();
    expect(await screen.findByText('Billing spec')).toBeTruthy();
    expect(inbox).toHaveBeenCalledWith({ view: 'open', offset: 0, limit: 200 });
    expect(onCount).toHaveBeenLastCalledWith(2);
    expect(screen.getByText('inbox_overdue')).toBeTruthy();
    // The pull request in the prototype's words for it.
    expect(screen.getByText('your review')).toBeTruthy();
    expect(screen.getByText(/acme\/web#42, Main · open 3 days · quiet for 9 days/)).toBeTruthy();
    expect(screen.getByText('inbox_quiet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'inbox_open_pull' }).getAttribute('href')).toBe(pull.url);
    // A review opens its workspace.
    fireEvent.click(screen.getByRole('button', { name: 'inbox_open_project' }));
    expect(requestWorkspace).toHaveBeenCalledWith(null, { id: 'w1', name: 'Main' }, 'o1');
  });

  it('marks an item done and hides it at once', async () => {
    inbox.mockResolvedValue(page([review, pull]));
    const onCount = vi.fn();
    render(<InboxGroup organizationId="o1" workspaces={1} t={t} onCount={onCount} />);
    await screen.findByText('Billing spec');
    fireEvent.click(screen.getAllByRole('button', { name: 'inbox_done' })[0]);
    expect(mark).toHaveBeenCalledWith({ item_key: 'review:r1', state: 'done', until: null });
    await waitFor(() => expect(screen.queryByText('Billing spec')).toBeNull());
    expect(onCount).toHaveBeenLastCalledWith(1);
    expect(screen.getByText(/inbox_hidden 1/)).toBeTruthy();
  });

  it('snoozes for a day', async () => {
    inbox.mockResolvedValue(page([review]));
    render(<InboxGroup organizationId="o1" workspaces={1} t={t} />);
    await screen.findByText('Billing spec');
    fireEvent.click(screen.getByRole('button', { name: 'inbox_snooze' }));
    const body = mark.mock.calls[0][0] as { state: string; until: string };
    expect(body.state).toBe('snoozed');
    expect(Date.parse(body.until) - Date.now()).toBeGreaterThan(23 * 3_600_000);
  });

  it('shows the hidden ones and unmarks them all', async () => {
    inbox.mockImplementation(({ view }: { view: string }) =>
      Promise.resolve(view === 'hidden' ? page([review], { other: 0 }) : page([], { other: 1 }))
    );
    render(<InboxGroup organizationId="o1" workspaces={1} t={t} />);
    expect(await screen.findByText('inbox_nothing_new 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'inbox_show_them' }));
    expect(await screen.findByText('Billing spec')).toBeTruthy();
    expect(inbox).toHaveBeenCalledWith({ view: 'hidden', offset: 0, limit: 200 });
    fireEvent.click(screen.getByRole('button', { name: 'inbox_unmark_all' }));
    await waitFor(() => expect(mark).toHaveBeenCalledWith({ item_key: 'review:r1', state: 'open', until: null }));
  });

  it('names the sources it could not read rather than saying nothing waits', async () => {
    inbox.mockResolvedValue(page([], { unread: ['pull-requests in Main: 502'] }));
    render(<InboxGroup organizationId="o1" workspaces={1} t={t} />);
    expect(await screen.findByText(/inbox_nothing_read .*pull-requests in Main: 502/)).toBeTruthy();
    expect(screen.queryByText('inbox_nothing')).toBeNull();
  });

  it('says plainly when nothing waits', async () => {
    inbox.mockResolvedValue(page([]));
    render(<InboxGroup organizationId="o1" workspaces={2} t={t} />);
    expect(await screen.findByText('inbox_nothing')).toBeTruthy();
    expect(screen.getByText(/confirm your GitHub account on your Profile/)).toBeTruthy();
  });

  it('shows a 503 as the Inbox being unavailable, not as an empty one', async () => {
    inbox.mockRejectedValue(status(503));
    render(<InboxGroup organizationId="o1" workspaces={1} t={t} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('inbox_unavailable');
    expect(screen.queryByText('inbox_nothing')).toBeNull();
  });
});
