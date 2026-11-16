/**
 * The top bar's Inbox count, told by a screen that has just read the Inbox
 * (#1077). The shell reads `GET /me/inbox` for its count; a screen that lists
 * the Inbox (the Inbox, an organization's Overview) reads the same route. The
 * server reads every source to answer either, so where the screen reads, the
 * shell asks the screen instead of the server: one read of the Inbox a visit,
 * not two at once.
 *
 * Declare the action in the entry's `mfe.json` `domainActions`.
 */

import { FRONTX_SCREEN_DOMAIN, type ChildMfeBridge } from '@gears-frontx/react';
import { sendToHost } from './hostActions';

/** Screen domain: `{total}` items wait on the person, as the screen's last read of the open view said; `null` when it failed. */
export const STUDIO_ACTION_INBOX_COUNT = 'gts.frontx.mfes.comm.action.v1~constructor_studio.shell.inbox.count.v1~';

/** Tells the shell what the screen's read of the open Inbox counted. */
export function reportInboxCount(bridge: ChildMfeBridge | null | undefined, total: number | null): void {
  sendToHost(bridge ?? null, { type: STUDIO_ACTION_INBOX_COUNT, target: FRONTX_SCREEN_DOMAIN, payload: { total } });
}
