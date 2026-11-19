/**
 * How many items wait on the person (`GET /studio-user/v1/me/inbox/count`),
 * for the top bar's Inbox button: `total` is what the open view of
 * `/me/inbox` (ADR-0068 §6) reports as its total, without the items. The
 * server keeps the person's Inbox for a short while, so the count is a cheap
 * read. The list itself is the Inbox screen's (organization-mfe), which reads
 * `/me/inbox`.
 */

import { BaseApiService, RestEndpointProtocol, RestProtocol } from '@gears-frontx/react';

/** The answer of `/me/inbox/count`. */
export interface InboxTotal {
  /** Items in the open view: the count the button shows. */
  total: number;
  /** How many items the hidden view holds. */
  other?: number;
  /** The sources that could not be read, each with why. */
  unread: string[];
  members_known?: boolean;
  workspaces?: number;
}

export interface InboxCountQuery {
  /** The organization the count is about; the caller's home tenant when absent. */
  organizationId: string | null;
}

export class InboxCountApiService extends BaseApiService {
  constructor() {
    // A cold Inbox still has every source to read before it answers.
    const restProtocol = new RestProtocol({ timeout: 60000 });
    super({ baseURL: '/cf/studio-user/v1' }, restProtocol, new RestEndpointProtocol(restProtocol));
  }

  /**
   * The count in the organization on screen. Without one the server reads the
   * caller's home tenant, which is not where a person who joined by invitation
   * works: their token still names the tenant they signed up in.
   */
  readonly count = this.protocol(RestEndpointProtocol).queryWith<InboxTotal, InboxCountQuery>(
    ({ organizationId }) =>
      organizationId
        ? `/me/inbox/count?${new URLSearchParams({ organization_id: organizationId })}`
        : '/me/inbox/count'
  );
}
