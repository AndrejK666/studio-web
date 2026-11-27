/**
 * The Inbox count a screen reports after reading the Inbox itself (#1077): the
 * top bar takes it instead of reading `GET /me/inbox` again while that screen
 * is open. See `useInboxEntry`.
 */

import { ActionHandler } from '@gears-frontx/react';

/** What a screen last reported: the count, or `null` for a read that failed, and when. */
export interface InboxCountReport {
  total: number | null;
  at: number;
}

type Listener = (report: InboxCountReport) => void;

const listeners = new Set<Listener>();
let last: InboxCountReport | null = null;

/** The last report, or `null` before any. */
export function lastInboxCountReport(): InboxCountReport | null {
  return last;
}

/** Calls `listener` with every report from now on; returns the unsubscribe. */
export function onInboxCountReport(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The total a payload carries: a count, `null` for a failed read, `undefined` when it is not a report. */
export function inboxTotalOf(payload: Record<string, unknown> | undefined): number | null | undefined {
  const total = payload?.total;
  if (total === null) return null;
  if (typeof total === 'number' && Number.isInteger(total) && total >= 0) return total;
  return undefined;
}

export function reportInboxCountToShell(total: number | null, now: number = Date.now()): void {
  last = { total, at: now };
  for (const listener of listeners) listener(last);
}

export function createInboxCountHandler(): ActionHandler {
  return ActionHandler.fromFunction(async (_actionTypeId, payload) => {
    const total = inboxTotalOf(payload);
    if (total === undefined) {
      console.warn('[shell] inbox count: payload refused', payload);
      return;
    }
    reportInboxCountToShell(total);
  });
}

/** Test only: forget every report and listener. */
export function resetInboxCountReports(): void {
  last = null;
  listeners.clear();
}
