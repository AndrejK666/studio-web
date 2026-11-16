import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { StudioEvent } from '@constructor-studio/mfe-shared';

/**
 * The top bar's Inbox entry: the screen it opens, and the server's count, read
 * again on a review event and every two minutes; unknown on a failed read.
 */

const { mockEventBus, screens, channel, fetchCount, store } = vi.hoisted(() => ({
  mockEventBus: { emit: vi.fn() },
  screens: [] as Array<{ id: string; presentation: { label: string; route: string } }>,
  channel: { listeners: new Set<(event: unknown) => void>() },
  fetchCount: vi.fn(),
  store: { state: {} as Record<string, unknown> },
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  eventBus: mockEventBus,
  useDomainExtensions: () => screens,
  useAppSelector: (select: (state: Record<string, unknown>) => unknown) => select(store.state),
  apiRegistry: { getService: () => ({ count: { fetch: fetchCount } }) },
}));
vi.mock('@/app/live/liveChannel', () => ({
  liveChannel: () => ({
    subscribe: (listener: (event: unknown) => void) => {
      channel.listeners.add(listener);
      return () => channel.listeners.delete(listener);
    },
  }),
}));

import { APP_CONTEXT_SLICE_KEY } from '@/app/slices/appContextSlice';
import { reportInboxCountToShell, resetInboxCountReports } from '@/app/mfe/inboxCountActions';
import {
  INBOX_FRESH_MS,
  INBOX_REREAD_MS,
  INBOX_ROUTE,
  movesInbox,
  placeInAddress,
  screenReadsInbox,
  useInboxEntry,
} from './useInboxEntry';

/** The person is on `section`, of a project or not. */
function onSection(section: string | null, project: string | null = null) {
  store.state = { [APP_CONTEXT_SLICE_KEY]: { section, project: project ? { id: project, name: project } : null } };
}

function hear(subject_type: string) {
  const event: StudioEvent = { seq: 1, at_ms: 1, kind: 'x', subject_type, subject_id: 's', source: 'x', payload: {} };
  act(() => {
    for (const listener of channel.listeners) listener(event);
  });
}

describe('useInboxEntry', () => {
  beforeEach(() => {
    screens.length = 0;
    screens.push({ id: 'ext.inbox', presentation: { label: 'Inbox', route: INBOX_ROUTE } });
    fetchCount.mockReset();
    fetchCount.mockResolvedValue({ total: 4, unread: [] });
    onSection(null);
    resetInboxCountReports();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    channel.listeners.clear();
  });

  it('counts what waits and opens the Inbox screen', async () => {
    const { result } = renderHook(() => useInboxEntry());
    await waitFor(() => expect(result.current.count).toBe(4));
    result.current.open();
    expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/screen/requested', { extensionId: 'ext.inbox' });
  });

  it('reads nothing where no Inbox screen is registered', () => {
    screens.length = 0;
    const { result } = renderHook(() => useInboxEntry());
    expect(result.current.screen).toBeUndefined();
    expect(result.current.count).toBeNull();
    expect(fetchCount).not.toHaveBeenCalled();
  });

  it('is unknown, not zero, when the server cannot answer', async () => {
    fetchCount.mockRejectedValue(new Error('503'));
    const { result } = renderHook(() => useInboxEntry());
    await waitFor(() => expect(fetchCount).toHaveBeenCalled());
    expect(result.current.count).toBeNull();
  });

  it('reads again when a review moves, and not for anything else', async () => {
    renderHook(() => useInboxEntry());
    await waitFor(() => expect(fetchCount).toHaveBeenCalledTimes(1));
    hear('task_run');
    hear('review_request');
    await waitFor(() => expect(fetchCount).toHaveBeenCalledTimes(2));
    expect(movesInbox({ subject_type: 'workspace' } as StudioEvent)).toBe(false);
  });

  it('reads again on leaving the Inbox, where items are marked', async () => {
    onSection('inbox');
    const { rerender } = renderHook(() => useInboxEntry());
    expect(fetchCount).not.toHaveBeenCalled();
    onSection('workspaces');
    rerender();
    await waitFor(() => expect(fetchCount).toHaveBeenCalledTimes(1));
  });

  // #1077: the Inbox and the organization's Overview read the Inbox themselves.
  it("takes the count a screen that read the Inbox reports, and reads nothing itself", async () => {
    onSection('overview');
    const { result } = renderHook(() => useInboxEntry());
    act(() => reportInboxCountToShell(7));
    expect(result.current.count).toBe(7);
    act(() => reportInboxCountToShell(null));
    expect(result.current.count).toBeNull();
    expect(fetchCount).not.toHaveBeenCalled();
  });

  it('reads nothing on leaving such a screen that has just reported, marks included', async () => {
    vi.useFakeTimers();
    onSection('inbox');
    const { rerender, result } = renderHook(() => useInboxEntry());
    act(() => reportInboxCountToShell(2));
    onSection('workspaces');
    rerender();
    await act(async () => {});
    expect(fetchCount).not.toHaveBeenCalled();
    expect(result.current.count).toBe(2);
  });

  it('reads itself when such a screen says nothing within INBOX_FRESH_MS', async () => {
    vi.useFakeTimers();
    onSection('inbox');
    renderHook(() => useInboxEntry());
    expect(fetchCount).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(INBOX_FRESH_MS);
    });
    expect(fetchCount).toHaveBeenCalledTimes(1);
  });

  it('on a cold load, goes by the address until the routing names the section', () => {
    window.history.replaceState({}, '', '/?screen=organization;org=o1;section=overview');
    try {
      renderHook(() => useInboxEntry());
      expect(fetchCount).not.toHaveBeenCalled();
    } finally {
      window.history.replaceState({}, '', '/');
    }
    expect(placeInAddress('?screen=projects;org=o1;workspace=w1;project=p1;section=overview')).toEqual({
      section: 'overview',
      projectId: 'p1',
    });
    expect(placeInAddress('?screen=people;org=o1')).toEqual({ section: null, projectId: null });
  });

  it("reads at once on a project's Overview, which does not read the Inbox", async () => {
    onSection('overview', 'p1');
    renderHook(() => useInboxEntry());
    await waitFor(() => expect(fetchCount).toHaveBeenCalledTimes(1));
    expect(screenReadsInbox('overview', 'p1')).toBe(false);
    expect(screenReadsInbox('overview', null)).toBe(true);
    expect(screenReadsInbox('people', null)).toBe(false);
  });

  it('asks nothing for a click between two other tabs while the count is fresh', async () => {
    vi.useFakeTimers();
    onSection('workspaces');
    const { rerender } = renderHook(() => useInboxEntry());
    expect(fetchCount).toHaveBeenCalledTimes(1);
    onSection('people');
    rerender();
    onSection('settings');
    rerender();
    await act(async () => {});
    expect(fetchCount).toHaveBeenCalledTimes(1);
  });

  it('reads again on a move once the count is older than INBOX_FRESH_MS', async () => {
    vi.useFakeTimers();
    onSection('workspaces');
    const { rerender } = renderHook(() => useInboxEntry());
    expect(fetchCount).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(INBOX_FRESH_MS);
    });
    onSection('people');
    rerender();
    await act(async () => {});
    expect(fetchCount).toHaveBeenCalledTimes(2);
  });

  it('reads again every two minutes', async () => {
    vi.useFakeTimers();
    renderHook(() => useInboxEntry());
    expect(fetchCount).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(INBOX_REREAD_MS);
    });
    expect(fetchCount).toHaveBeenCalledTimes(2);
  });
});
