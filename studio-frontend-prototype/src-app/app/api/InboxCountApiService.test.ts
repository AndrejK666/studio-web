import { describe, expect, it } from 'vitest';
import { InboxCountApiService } from './InboxCountApiService';

/**
 * The descriptor, and nothing else: the bar's suite replaces this service with
 * a mock, so a wrong path here would pass every other test.
 */
describe('InboxCountApiService', () => {
  it('reads the count route, not the Inbox itself, in the organization on screen', () => {
    const service = new InboxCountApiService();
    expect(service.count({ organizationId: 'org-1' }).key.slice(0, 3)).toEqual([
      '/cf/studio-user/v1',
      'GET',
      '/me/inbox/count?organization_id=org-1',
    ]);
    expect(service.count({ organizationId: null }).key.slice(0, 3)).toEqual([
      '/cf/studio-user/v1',
      'GET',
      '/me/inbox/count',
    ]);
  });
});
