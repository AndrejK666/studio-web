import { describe, expect, it } from 'vitest';
import { InboxCountApiService } from './InboxCountApiService';

/**
 * The descriptor, and nothing else: the bar's suite replaces this service with
 * a mock, so a wrong path here would pass every other test.
 */
describe('InboxCountApiService', () => {
  it('reads the count route, not the Inbox itself, and names no organization', () => {
    expect(new InboxCountApiService().count.key).toEqual(['/cf/studio-user/v1', 'GET', '/me/inbox/count']);
  });
});
