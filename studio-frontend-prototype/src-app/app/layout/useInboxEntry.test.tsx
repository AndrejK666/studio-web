import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { StudioEvent } from '@constructor-studio/mfe-shared';

/**
 * The top bar's Inbox entry: the screen it opens, and the server's count, read
 * again on a review event and every two minutes; unknown on a failed read.
 */

const { mockEventBus, screens, channel, fetchCount } = vi.hoisted(() => ({
  mockEventBus: { emit: vi.fn() },
  screens: [] as Array<{ id: string; presentation: { label: string; route: string } }>,
  channel: { listeners: new Set<(event: unknown) => void>() },
  fetchCount: vi.fn(),
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  eventBus: mockEventBus,
  useDomainExtensions: () => screens,
  useAppSelector: () => null,
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

import { INBOX_REREAD_MS, INBOX_ROUTE, movesInbox, useInboxEntry } from './useInboxEntry';

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
