/**
 * What the Tests kit reads (ported from the prototype's Tests tab, ADR-0069):
 * the CI runs the sync kept (`/runs`: its jobs, `latest_completed` and the
 * revision and branch matching are derived there), the project's repositories (for their paths and
 * what could not be read), its open pull requests, the document checks on
 * them, and spec ↔ code. Each gear keeps its own base URL; the kit holds one
 * service so the screen asks one place.
 */

import { BaseApiService, RestEndpointProtocol, RestProtocol } from '@gears-frontx/react';
import { fetchProjectArtifacts } from '@constructor-studio/mfe-shared';
import type {
  ArtifactNodePage,
  Capability,
  CiRunList,
  Conformance,
  DeclaredCapability,
  OpenPullRequest,
  PullRequestChecks,
} from './types';

const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

export class TestsApiService extends BaseApiService {
  constructor() {
    const restProtocol = new RestProtocol({ timeout: 60000 });
    const restEndpoints = new RestEndpointProtocol(restProtocol);
    // The gateway prefix: every path below names its gear.
    super({ baseURL: '/cf' }, restProtocol, restEndpoints);
  }

  readonly ciRuns = this.protocol(RestEndpointProtocol).queryWith<CiRunList, { projectId: string }>(
    ({ projectId }) => `/studio-artifact-ingest/v1/runs?${q({ project_id: projectId })}`
  );

  /**
   * The project's repositories: through `POST /studio-domain-model/v1/query`
   * where the organization's artifacts are answered from the model, else
   * `GET /studio-artifact-ingest/v1/nodes` (`fetchProjectArtifacts`).
   */
  readonly repositories = ({ projectId, orgId }: { projectId: string; orgId: string | null }) => ({
    fetch: (_options?: { staleTime?: number }): Promise<ArtifactNodePage> =>
      fetchProjectArtifacts(orgId, projectId, 'repo', { limit: 200 }),
  });

  readonly openPullRequests = this.protocol(RestEndpointProtocol).queryWith<
    { items: OpenPullRequest[]; total: number },
    { projectId: string }
  >(({ projectId }) => `/studio-artifact-ingest/v1/open-pull-requests?${q({ project_id: projectId, limit: '200' })}`);

  /** A preview (`publish: false`): reads what the checks say, sets nothing on the host. */
  readonly pullRequestChecks = this.protocol(RestEndpointProtocol).mutation<
    PullRequestChecks,
    { project_id: string; publish: boolean }
  >('POST', '/studio-documents/v1/pull-request-checks');

  readonly declaredCapabilities = this.protocol(RestEndpointProtocol).queryWith<
    { items: DeclaredCapability[]; total: number },
    { projectId: string }
  >(({ projectId }) => `/studio-spec-mapping/v1/capabilities?${q({ project_id: projectId })}`);

  readonly capabilities = this.protocol(RestEndpointProtocol).queryWith<
    { items: Capability[] },
    { workspaceId: string }
  >(({ workspaceId }) => `/studio-documents/v1/workspaces/${encodeURIComponent(workspaceId)}/capabilities`);

  readonly conformance = this.protocol(RestEndpointProtocol).mutation<
    Conformance,
    {
      project_id: string;
      capabilities: string[];
      terms: Record<string, string[]>;
      contracts: Record<string, string[]>;
    }
  >('POST', '/studio-spec-mapping/v1/conformance');
}
