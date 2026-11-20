/**
 * What the Spec graph kit calls: studio-spec-graph, the gear in front of the
 * spec-graph service. Every route takes `?project_id=`.
 */

import { BaseApiService, RestEndpointProtocol, RestProtocol } from '@gears-frontx/react';
import type {
  Decision,
  GraphNode,
  Neighbors,
  SearchHit,
  OpenPullRequest,
  Review,
  Run,
  SpecGraphCheck,
  SpecGraphFindingList,
  SpecGraphProject,
} from './types';

const q = (params: Record<string, string>) => new URLSearchParams(params).toString();
const BASE = '/studio-spec-graph/v1';

export class SpecGraphApiService extends BaseApiService {
  constructor() {
    // A check reads the repository and runs every rule: seconds, not minutes.
    const restProtocol = new RestProtocol({ timeout: 60000 });
    const restEndpoints = new RestEndpointProtocol(restProtocol);
    super({ baseURL: '/cf' }, restProtocol, restEndpoints);
  }

  readonly project = this.protocol(RestEndpointProtocol).queryWith<SpecGraphProject, { projectId: string }>(
    ({ projectId }) => `${BASE}/project?${q({ project_id: projectId })}`
  );

  readonly findings = this.protocol(RestEndpointProtocol).queryWith<SpecGraphFindingList, { projectId: string }>(
    ({ projectId }) => `${BASE}/findings?${q({ project_id: projectId })}`
  );

  /** Every deterministic finding now, at the project's branch. */
  check(projectId: string) {
    return this.protocol(RestEndpointProtocol).mutation<SpecGraphCheck, Record<string, never>>(
      'POST',
      `${BASE}/checks?${q({ project_id: projectId })}`
    );
  }

  /** Which documents to read: the project's first Git source, at its branch. */
  setup(projectId: string) {
    return this.protocol(RestEndpointProtocol).mutation<SpecGraphProject, { scope: string }>(
      'PUT',
      `${BASE}/project?${q({ project_id: projectId })}`
    );
  }

  /** Recorded in Project model's decision table; a dismissal also leaves checks and reviews. */
  decide(projectId: string, fingerprint: string) {
    return this.protocol(RestEndpointProtocol).mutation<
      unknown,
      { decision: Decision; rule: string; note?: string }
    >('POST', `${BASE}/findings/${encodeURIComponent(fingerprint)}/decision?${q({ project_id: projectId })}`);
  }

  /** The project's open pull requests (Studio's sync of its repositories). */
  readonly openPullRequests = this.protocol(RestEndpointProtocol).queryWith<
    { items: OpenPullRequest[]; total: number },
    { projectId: string }
  >(({ projectId }) => `/studio-artifact-ingest/v1/open-pull-requests?${q({ project_id: projectId, limit: '200' })}`);

  /** A pull request's findings and threads; with the model, a run whose result holds them. */
  review(projectId: string) {
    return this.protocol(RestEndpointProtocol).mutation<
      { review: Review | null; run: Run | null },
      { base: string; head: string; model: boolean }
    >('POST', `${BASE}/reviews?${q({ project_id: projectId })}`);
  }

  readonly run = this.protocol(RestEndpointProtocol).queryWith<{ run: Run }, { projectId: string; runId: string }>(
    ({ projectId, runId }) => `${BASE}/runs/${encodeURIComponent(runId)}?${q({ project_id: projectId, wait: '25' })}`
  );

  /** Search the project's graph (full text and vectors). */
  search(projectId: string) {
    return this.protocol(RestEndpointProtocol).mutation<
      { answer: SearchHit[] | { hits?: SearchHit[] } },
      { query: string; limit?: number }
    >('POST', `${BASE}/graph/search?${q({ project_id: projectId })}`);
  }

  readonly node = this.protocol(RestEndpointProtocol).queryWith<{ answer: GraphNode }, { projectId: string; key: string }>(
    ({ projectId, key }) => `${BASE}/graph/node?${q({ project_id: projectId, key })}`
  );

  readonly neighbors = this.protocol(RestEndpointProtocol).queryWith<
    { answer: Neighbors },
    { projectId: string; key: string }
  >(({ projectId, key }) => `${BASE}/graph/neighbors?${q({ project_id: projectId, key })}`);
}
