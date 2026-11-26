/**
 * What the Spec graph kit calls: studio-spec-graph, the gear in front of the
 * spec-graph service. Every route takes `?project_id=`.
 */

import { BaseApiService, RestEndpointProtocol, RestProtocol } from '@gears-frontx/react';
import type {
  Decision,
  GraphNode,
  Neighbors,
  Ontology,
  Picture,
  SearchHit,
  OpenPullRequest,
  Review,
  ReviewRecord,
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

  /** A run; waits up to 5 s for it to end, so a page following it shows its progress as it goes. */
  readonly run = this.protocol(RestEndpointProtocol).queryWith<{ run: Run }, { projectId: string; runId: string }>(
    ({ projectId, runId }) => `${BASE}/runs/${encodeURIComponent(runId)}?${q({ project_id: projectId, wait: '5' })}`
  );

  /** The project's runs, newest first; a running one with its progress. */
  readonly runs = this.protocol(RestEndpointProtocol).queryWith<{ items: Run[]; total: number }, { projectId: string; job: string }>(
    ({ projectId, job }) => `${BASE}/runs?${q({ project_id: projectId, job, limit: '5' })}`
  );

  /** Start a long job: `index` (params.facts) or `prepare`. */
  startRun(projectId: string) {
    return this.protocol(RestEndpointProtocol).mutation<
      { run: Run },
      { job: 'index' | 'prepare'; params?: Record<string, unknown> }
    >('POST', `${BASE}/runs?${q({ project_id: projectId })}`);
  }

  /** The latest review of each pull request branch, to show again after a reload. */
  readonly reviews = this.protocol(RestEndpointProtocol).queryWith<{ items: ReviewRecord[]; total: number }, { projectId: string }>(
    ({ projectId }) => `${BASE}/reviews?${q({ project_id: projectId })}`
  );

  /** The project's Git sources (the first is the one the graph reads by default). */
  readonly sources = this.protocol(RestEndpointProtocol).queryWith<
    { items: { name: string }[] },
    { projectId: string }
  >(({ projectId }) => `/studio-git/v1/sources?${q({ project_id: projectId })}`);

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

  /** The graph around one node, `depth` hops out; `types` keeps only those nodes on the way. */
  readonly subgraph = this.protocol(RestEndpointProtocol).queryWith<
    { answer: Picture },
    { projectId: string; key: string; depth: number; types: string }
  >(({ projectId, key, depth, types }) =>
    `${BASE}/graph/subgraph?${q({ project_id: projectId, key, depth: String(depth), ...(types ? { types } : {}) })}`
  );

  /** The whole graph, or the nodes of `types` (comma-separated) and the edges between them. */
  readonly overview = this.protocol(RestEndpointProtocol).queryWith<{ answer: Picture }, { projectId: string; types: string }>(
    ({ projectId, types }) => `${BASE}/graph/overview?${q({ project_id: projectId, ...(types ? { types } : {}) })}`
  );

  /** The node and edge types, with the project's count of each node type. */
  readonly ontology = this.protocol(RestEndpointProtocol).queryWith<{ answer: Ontology }, { projectId: string }>(
    ({ projectId }) => `${BASE}/graph/ontology?${q({ project_id: projectId })}`
  );
}
