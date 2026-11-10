/**
 * Where a project stands (`GET /studio-organizations/v1/project-status`,
 * studio-backend `organizations/status.rs`): one verdict, the signals behind
 * it, and the path from a repository to a passing build. The prototype
 * computed this in the browser from nine reads (`project-overview-model.ts`,
 * `project-path.ts`); the server now makes the same reads as the caller.
 */

import { BaseApiService, RestEndpointProtocol, RestProtocol } from '@gears-frontx/react';
import type { ProjectStatus } from '../model/projectStatus';

export const STUDIO_ORGANIZATIONS_API_BASE_URL = '/cf/studio-organizations/v1';

export class ProjectStatusApiService extends BaseApiService {
  constructor() {
    // The server reads every gear behind the status before it answers.
    const restProtocol = new RestProtocol({ timeout: 60000 });
    const restEndpoints = new RestEndpointProtocol(restProtocol);
    super({ baseURL: STUDIO_ORGANIZATIONS_API_BASE_URL }, restProtocol, restEndpoints);
  }

  readonly status = this.protocol(RestEndpointProtocol).queryWith<ProjectStatus, { projectId: string }>(
    ({ projectId }) => `/project-status?${new URLSearchParams({ project_id: projectId })}`
  );
}
