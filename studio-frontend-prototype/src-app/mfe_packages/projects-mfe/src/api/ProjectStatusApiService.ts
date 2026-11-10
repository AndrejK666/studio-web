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

/** A move a project's phase may make. */
export interface PhaseMove {
  transition: string;
  to: string;
}

/**
 * A project's phase (`GET /studio-kits/v1/project-phase?project_id=`): the
 * built-in Project lifecycle kit's field on the project, and its lifecycle.
 * `installed` is false where the kit does not apply — the screen then shows
 * no phase at all.
 */
export interface ProjectPhase {
  project_id: string;
  installed: boolean;
  phase: string | null;
  phase_owner: string | null;
  phase_since: string | null;
  states: string[];
  next: PhaseMove[];
}

/** The organization's projects with a phase (`GET /studio-kits/v1/project-phases`). */
export interface ProjectPhaseList {
  installed: boolean;
  items: { project_id: string; phase: string; phase_owner: string | null; phase_since: string | null }[];
  total: number;
}

/** Project lifecycle's function, over the studio-kits gear (ADR-0068 §7). */
export class ProjectPhaseApiService extends BaseApiService {
  constructor() {
    const restProtocol = new RestProtocol({ timeout: 30000 });
    const restEndpoints = new RestEndpointProtocol(restProtocol);
    super({ baseURL: '/cf/studio-kits/v1' }, restProtocol, restEndpoints);
  }

  readonly phase = this.protocol(RestEndpointProtocol).queryWith<ProjectPhase, { projectId: string }>(
    ({ projectId }) => `/project-phase?${new URLSearchParams({ project_id: projectId })}`
  );

  readonly phases = this.protocol(RestEndpointProtocol).queryWith<ProjectPhaseList, { organizationId: string }>(
    ({ organizationId }) => `/project-phases?${new URLSearchParams({ organization_id: organizationId, limit: '200' })}`
  );

  setPhase(projectId: string) {
    return this.protocol(RestEndpointProtocol).mutation<ProjectPhase, { phase: string; owner?: string }>(
      'PUT',
      `/project-phase?${new URLSearchParams({ project_id: projectId })}`
    );
  }
}

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
