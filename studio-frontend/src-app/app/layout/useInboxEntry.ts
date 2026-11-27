/**
 * The top bar's way into the Inbox (the prototype's `InboxButton`,
 * `inbox-view.tsx`): the Inbox screen (organization-mfe, route `/inbox`) and
 * how many items wait on the person (`GET /me/inbox/count`). The count is
 * read when the button appears, every two minutes while the tab is shown (at
 * once when it is shown again, nothing while it is hidden), when a review
 * moves (studio-events, `review_request`), as the prototype did — and when the person moves to
 * another screen, so a mark made on the Inbox shows here at once (leaving the
 * Inbox or an Overview, or with a count older than {@link INBOX_FRESH_MS}; a
 * click between two other tabs asks nothing); `null` while
 * unknown or unreadable, so a failed read never shows as "nothing waits".
 *
 * Where the screen reads the Inbox itself (the Inbox, an organization's
 * Overview), the bar does not read it too (#1077): the screen reports what it
 * read (`reportInboxCount`, mfe-shared) and the bar shows that. The server
 * reads every source to answer, and the two reads used to go out together on
 * every visit. A screen that says nothing within {@link INBOX_FRESH_MS} gets
 * the bar's own read after all.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRegistry, eventBus, useAppSelector, useDomainExtensions, FRONTX_SCREEN_DOMAIN } from '@gears-frontx/react';
import { APP_CONTEXT_SLICE_KEY, type AppContextState } from '@/app/slices/appContextSlice';
import { usePollWhileVisible, type StudioEvent } from '@constructor-studio/mfe-shared';
import { InboxCountApiService } from '@/app/api/InboxCountApiService';
import { lastInboxCountReport, onInboxCountReport } from '@/app/mfe/inboxCountActions';
import type { StudioScreenExtension } from '@/app/mfe/screenLevels';
import { useStudioEvents } from '@/app/live/useLiveChannel';

/** The route the Inbox screen answers to. */
export const INBOX_ROUTE = '/inbox';

/** How often the count is read again without an event. */
export const INBOX_REREAD_MS = 120_000;

/** How old a count may be before a move to another screen reads it again. */
export const INBOX_FRESH_MS = 15_000;

/** The sections where the person marks Inbox items: leaving one reads the count again at once. */
export const MARKS_INBOX: ReadonlySet<string> = new Set(['inbox', 'overview']);

/**
 * Whether the screen on `section` reads the Inbox itself and reports its
 * count: the Inbox and the organization's Overview, not a project's.
 */
export function screenReadsInbox(section: string | null, projectId: string | null): boolean {
  return section !== null && MARKS_INBOX.has(section) && projectId === null;
}

/**
 * The section and project the address names (`?screen=…;section=…;project=…`),
 * for the first read: on a cold load the bar's read is due before the routing
 * has put the section in the store.
 */
export function placeInAddress(search: string): { section: string | null; projectId: string | null } {
  const params = new Map(
    search
      .replace(/^\?/, '')
      .split(/[;&]/)
      .map((part) => part.split('=') as [string, string | undefined])
  );
  return { section: params.get('section') ?? null, projectId: params.get('project') ?? null };
}

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
  const projectId = useAppSelector(
    (state) => (state[APP_CONTEXT_SLICE_KEY] as AppContextState | undefined)?.project?.id ?? null
  );
  // The count is the organization's on screen, as the Inbox screen's list is.
  const organizationId = useAppSelector(
    (state) => (state[APP_CONTEXT_SLICE_KEY] as AppContextState | undefined)?.org?.id ?? null
  );
  // Read when a read is due, not a dependency of it: a move alone reads nothing.
  const screenReads = useRef(false);
  // Declared before the read below, so a read in the same commit sees the screen it is on.
  // Until the routing has published a section, the address says where the person is.
  useEffect(() => {
    const place = section === null ? placeInAddress(window.location.search) : { section, projectId };
    screenReads.current = screenReadsInbox(place.section, place.projectId);
  }, [section, projectId]);
  const again = useCallback(() => setTick((n) => n + 1), []);

  // When the count was last asked for, and the section the person was on.
  const readAt = useRef(0);
  const previousSection = useRef(section);

  useEffect(() => {
    if (!screenId) return;
    let live = true;
    const now = Date.now();
    readAt.current = now;
    const read = () => {
      apiRegistry
        .getService(InboxCountApiService)
        .count({ organizationId })
        .fetch({ staleTime: 0 })
        .then((answer) => live && setCount(typeof answer?.total === 'number' ? answer.total : null))
        .catch(() => live && setCount(null));
    };
    const reported = () => {
      const last = lastInboxCountReport();
      return last !== null && Date.now() - last.at < INBOX_FRESH_MS;
    };
    let wait: ReturnType<typeof setTimeout> | undefined;
    if (!screenReads.current) read();
    else if (!reported()) wait = setTimeout(() => !reported() && read(), INBOX_FRESH_MS);
    return () => {
      live = false;
      clearTimeout(wait);
    };
  }, [screenId, tick, organizationId]);

  // What a screen that read the Inbox counted: the same answer the bar would get.
  useEffect(
    () =>
      onInboxCountReport((report) => {
        readAt.current = report.at;
        setCount(report.total);
      }),
    []
  );

  // A move to another screen reads again only when it can have changed the
  // count: leaving a screen where items are marked, or a count old enough to
  // be worth asking about. The server reads every source to answer, and every
  // tab click used to cost one.
  useEffect(() => {
    const left = previousSection.current;
    previousSection.current = section;
    if (left === section) return;
    // A screen that reports its count reports every mark too: a fresh report is the count after them.
    const last = lastInboxCountReport();
    const reportedFresh = last !== null && Date.now() - last.at < INBOX_FRESH_MS;
    const marked = left !== null && MARKS_INBOX.has(left) && !reportedFresh;
    if (marked || Date.now() - readAt.current >= INBOX_FRESH_MS) again();
  }, [section, again]);

  // Every two minutes while the tab is shown; nothing while it is hidden. Shown
  // again, it reads at once unless a count was read or reported a moment ago.
  usePollWhileVisible(again, INBOX_REREAD_MS, screenId !== null, () => {
    if (Date.now() - readAt.current >= INBOX_FRESH_MS) again();
  });

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
