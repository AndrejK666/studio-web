/**
 * What the Inbox rows need beyond the server's answer: which kind a row is,
 * when a snooze ends, and the prototype's tones as ui-kit Badge variants.
 * The list itself — which items, in which order, what the marks hide — is the
 * server's (`user_profile/inbox.rs`), not computed here.
 */

import type { OpenPullRequest } from './api';
import type { InboxItem, ReviewRecord } from './types';

/** A review row's record, or null for any other source. */
export function reviewOf(item: InboxItem): ReviewRecord | null {
  return item.source === 'review-requests' ? (item.record as ReviewRecord) : null;
}

/** A pull request row's record, or null for any other source. */
export function pullOf(item: InboxItem): OpenPullRequest | null {
  if (item.source !== 'pull-requests') return null;
  const pull = item.record as Partial<OpenPullRequest>;
  return typeof pull.waiting === 'string' ? (pull as OpenPullRequest) : null;
}

/** When a snooze of `days` from `now` ends, as the API takes it (`waiting-on-me.ts`, unchanged). */
export function snoozeUntil(now: Date, days: number): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString();
}

export type BadgeVariant = 'danger' | 'warning' | 'success' | 'info' | 'secondary';

/** A waiting state's tone (`WAITING_TONE`, a `.badge` class in the prototype) as a Badge variant. */
export function badgeVariant(tone: string): BadgeVariant {
  if (tone === 'danger' || tone === 'bad') return 'danger';
  if (tone === 'warn') return 'warning';
  if (tone === 'ok') return 'success';
  if (tone === 'info') return 'info';
  return 'secondary';
}
