/**
 * The top bar's way into the Inbox (the prototype's `InboxButton`,
 * `inbox-view.tsx`): the Inbox screen (organization-mfe, route `/inbox`) and
 * how many items wait on the person. The count is read when the button
 * appears, every two minutes, and when a review moves (studio-events,
 * `review_request`), as the prototype did — and when the person moves to
 * another screen, so a mark made on the Inbox shows here at once; `null` while
 * unknown or unreadable, so a failed read never shows as "nothing waits".
 */

import { useCallback, useEffect, useState } from 'react';
import { apiRegistry, eventBus, useAppSelector, useDomainExtensions, FRONTX_SCREEN_DOMAIN } from '@gears-frontx/react';
import { APP_CONTEXT_SLICE_KEY, type AppContextState } from '@/app/slices/appContextSlice';
import type { StudioEvent } from '@constructor-studio/mfe-shared';
import { InboxCountApiService } from '@/app/api/InboxCountApiService';
import type { StudioScreenExtension } from '@/app/mfe/screenLevels';
import { useStudioEvents } from '@/app/live/useLiveChannel';

/** The route the Inbox screen answers to. */
export const INBOX_ROUTE = '/inbox';

/** How often the count is read again without an event. */
export const INBOX_REREAD_MS = 120_000;

/** Whether an event may change what waits on the person. */
export function movesInbox(event: StudioEvent): boolean {
  return event.subject_type === 'review_request';
}

export interface InboxEntry {
  /** The Inbox screen, when one is registered. */
  screen: StudioScreenExtension | undefined;
  /** How many items wait, or `null` while unknown. */
  count: number | null;
  open: () => void;
}

export function useInboxEntry(): InboxEntry {
  const screens = useDomainExtensions(FRONTX_SCREEN_DOMAIN) as StudioScreenExtension[];
  const screen = screens.find((s) => s.presentation?.route === INBOX_ROUTE);
  const screenId = screen?.id ?? null;
  const [count, setCount] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const section = useAppSelector(
    (state) => (state[APP_CONTEXT_SLICE_KEY] as AppContextState | undefined)?.section ?? null
  );
  const again = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!screenId) return;
    let live = true;
    apiRegistry
      .getService(InboxCountApiService)
      .count.fetch({ staleTime: 0 })
      .then((answer) => live && setCount(typeof answer?.total === 'number' ? answer.total : null))
      .catch(() => live && setCount(null));
    return () => {
      live = false;
    };
  }, [screenId, tick, section]);

  useEffect(() => {
    if (!screenId) return;
    const timer = setInterval(again, INBOX_REREAD_MS);
    return () => clearInterval(timer);
  }, [screenId, again]);

  useStudioEvents(
    useCallback(
      (event: StudioEvent) => {
        if (movesInbox(event)) again();
      },
      [again]
    )
  );

  const open = useCallback(() => {
    if (screenId) eventBus.emit('app/context/screen/requested', { extensionId: screenId });
  }, [screenId]);

  return { screen, count, open };
}
