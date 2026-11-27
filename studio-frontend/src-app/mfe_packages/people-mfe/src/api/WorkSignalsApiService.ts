/**
 * Where somebody works, as other kits' gears know it: the open pull requests
 * and the activity of a project's repositories (the artifact graph, which the
 * project-git kit brings) and Insight's per-person figures. Each is optional:
 * People is a core screen and draws without any of them (ADR-0079 §1), so
 * `useOrgActivity` asks only where the kit is there and reads an absent one
 * (`kitAbsent`) as nothing to show, not a failure. Out of mfe-shared, so no
 * core package names these gears.
 */

import { BaseApiService, RestEndpointProtocol, RestProtocol } from '@gears-frontx/react';
import type { ActivityEvent, InsightQueryResult, OpenPullRequest } from '@constructor-studio/mfe-shared';

const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

/** The kit whose gear holds the open pull requests and the activity feed. */
export const GIT_KIT = 'project-git';
/** The kit name Insight's figures come with, for the absent state. */
export const INSIGHT_KIT = 'insight';

export class WorkSignalsApiService extends BaseApiService {
  constructor() {
    const restProtocol = new RestProtocol({ timeout: 30000 });
    super({ baseURL: '/cf' }, restProtocol, new RestEndpointProtocol(restProtocol));
  }

  readonly openPullRequests = this.protocol(RestEndpointProtocol).queryWith<
    { items: OpenPullRequest[]; total?: number },
    { projectId: string }
  >(({ projectId }) => `/studio-artifact-ingest/v1/open-pull-requests?${q({ project_id: projectId })}`);

  readonly activityFeed = this.protocol(RestEndpointProtocol).queryWith<
    { items: ActivityEvent[]; total?: number },
    { projectId: string }
  >(({ projectId }) => `/studio-artifact-ingest/v1/activity?${q({ project_id: projectId })}`);

  readonly insightQuery = this.protocol(RestEndpointProtocol).mutation<InsightQueryResult, { sql: string }>(
    'POST',
    '/studio-insight/v1/query'
  );
}
