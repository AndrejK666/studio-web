import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInboxCountHandler,
  inboxTotalOf,
  lastInboxCountReport,
  onInboxCountReport,
  resetInboxCountReports,
} from './inboxCountActions';

afterEach(resetInboxCountReports);

describe('the Inbox count a screen reports (#1077)', () => {
  it('takes a count or null, and refuses anything else', () => {
    expect(inboxTotalOf({ total: 3 })).toBe(3);
    expect(inboxTotalOf({ total: 0 })).toBe(0);
    expect(inboxTotalOf({ total: null })).toBeNull();
    expect(inboxTotalOf({ total: -1 })).toBeUndefined();
    expect(inboxTotalOf({ total: 1.5 })).toBeUndefined();
    expect(inboxTotalOf({ total: '3' })).toBeUndefined();
    expect(inboxTotalOf(undefined)).toBeUndefined();
  });

  it('hands a report to the top bar, and keeps the last one', async () => {
    const heard = vi.fn();
    onInboxCountReport(heard);
    const handler = createInboxCountHandler();
    await handler.handleAction('action', { total: 5 });
    expect(heard).toHaveBeenCalledWith(expect.objectContaining({ total: 5 }));
    expect(lastInboxCountReport()?.total).toBe(5);
  });

  it('ignores a payload that is not a count', async () => {
    const heard = vi.fn();
    onInboxCountReport(heard);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await createInboxCountHandler().handleAction('action', { total: 'many' });
    expect(heard).not.toHaveBeenCalled();
    expect(lastInboxCountReport()).toBeNull();
  });
});
