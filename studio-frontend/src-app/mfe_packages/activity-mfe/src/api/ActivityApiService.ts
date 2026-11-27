/**
 * What the Activity kit reads and writes:
 *
 * - Activity: the project's feed of checks and comments, ordered and named by
 *   the gear that owns the nodes (`studio-artifact-ingest`,
 *   `artifact_ingest/activity.rs`).
 * - Open pull requests, for the project's overview card.
 *
 * Timeline reads the Studio domain model through mfe-shared's data layer
 * (`useDomainTypes`, `useDomainQuery`, `domainMutate`), not through here.
 */

import { BaseApiService, RestEndpointProtocol, RestProtocol } from '@gears-frontx/react';
import type { OpenPullRequest } from '@constructor-studio/mfe-shared';
import type { ActivityFeed } from './types';

const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

export class ActivityApiService extends BaseApiService {
  constructor() {
    const restProtocol = new RestProtocol({ timeout: 60000 });
    const restEndpoints = new RestEndpointProtocol(restProtocol);
    // The gateway prefix: every path below names its gear.
    super({ baseURL: '/cf' }, restProtocol, restEndpoints);
  }

  readonly activity = this.protocol(RestEndpointProtocol).queryWith<ActivityFeed, { projectId: string }>(
    ({ projectId }) => `/studio-artifact-ingest/v1/activity?${q({ project_id: projectId })}`
  );

  readonly openPulls = this.protocol(RestEndpointProtocol).queryWith<
    { items: OpenPullRequest[]; total: number; members_known?: boolean },
    { projectId: string; offset: number }
  >(({ projectId, offset }) => `/studio-artifact-ingest/v1/open-pull-requests?${q({
    project_id: projectId, limit: '200', offset: String(offset),
  })}`);
}
