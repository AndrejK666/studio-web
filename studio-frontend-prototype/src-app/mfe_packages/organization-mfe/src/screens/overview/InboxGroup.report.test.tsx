import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STUDIO_ACTION_INBOX_COUNT } from '@constructor-studio/mfe-shared';

/**
 * #1077: the Inbox and the Overview read the Inbox and tell the top bar what
 * they counted, so the bar does not read it a second time.
 */

const { inbox, bridge } = vi.hoisted(() => ({
  inbox: vi.fn(),
  bridge: { executeActionsChain: vi.fn() },
}));
const service = { inbox: (q: unknown) => ({ fetch: () => inbox(q) }), mark: { fetch: vi.fn() } };

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  apiRegistry: { getService: () => service },
  useMfeBridge: () => bridge,
  useSharedProperty: () => null,
}));

import { InboxGroup } from './InboxGroup';

const t = Object.assign((key: string) => key, { count: (key: string, count: number) => `${key} ${count}` });

const reported = () =>
  bridge.executeActionsChain.mock.calls
    .map(([chain]) => (chain as { action: { type: string; payload: { total: number | null } } }).action)
    .filter((action) => action.type === STUDIO_ACTION_INBOX_COUNT)
    .map((action) => action.payload.total);

describe('InboxGroup tells the top bar its count', () => {
  beforeEach(() => {
    inbox.mockReset();
    bridge.executeActionsChain.mockReset();
  });

  it('reports the total of the open view it read', async () => {
    inbox.mockResolvedValue({ items: [], total: 3, other: 0, unread: [] });
    render(<InboxGroup organizationId="o1" workspaces={1} t={t as never} />);
    await waitFor(() => expect(reported()).toEqual([3]));
  });

  it('reports a read that failed as unknown, not zero', async () => {
    inbox.mockRejectedValue(new Error('HTTP 503'));
    render(<InboxGroup organizationId="o1" workspaces={1} t={t as never} />);
    await waitFor(() => expect(reported()).toEqual([null]));
  });
});
