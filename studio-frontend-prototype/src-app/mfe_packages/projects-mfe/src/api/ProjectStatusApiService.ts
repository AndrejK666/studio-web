/**
 * studio-organizations' project routes:
 *
 * - Where a project stands (`GET /studio-organizations/v1/project-status`,
 *   studio-backend `organizations/status.rs`): one verdict, the signals behind
 *   it, and the path from a repository to a passing build. The prototype
 *   computed this in the browser from nine reads (`project-overview-model.ts`,
 *   `project-path.ts`); the server now makes the same reads as the caller.
 * - A project's creation as one background run (`POST /project-creations`,
 *   `GET /project-creations/{run_id}`, `organizations/project_create.rs`): the
 *   portal used to make each step a request of its own (the tenant, its
 *   configuration, its sources, ...); the server checks them as the caller and
 *   carries them out as one resumable run.
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

  setPhase(projectId: string) {
    return this.protocol(RestEndpointProtocol).mutation<ProjectPhase, { phase: string; owner?: string }>(
      'PUT',
      `/project-phase?${new URLSearchParams({ project_id: projectId })}`
    );
  }
}

/** One step of a project's creation. */
export interface ProjectCreationStep {
  /** `tenant`, `config`, `repository`, `sources`, `scaffold`, `prd`, `kits` or `model`. */
  key: string;
  state: 'pending' | 'done' | 'failed';
  detail?: string | null;
}

/** A project's creation and where it stands. */
export interface ProjectCreation {
  run_id: string;
  project_id: string;
  organization_id: string;
  workspace_id: string;
  name: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  steps: ProjectCreationStep[];
  error?: string | null;
}

/** What the New project dialog asks for. */
export interface CreateProjectBody {
  workspace_id: string;
  name: string;
  mode?: string;
  brief?: string;
  owner_id?: string;
  project_type_kit?: string;
  sources?: { connection_id: string; full_path: string; clone_url: string; default_branch?: string }[];
  idempotency_key?: string;
}

/** What the person does next once a project of a type exists (the type kit's manifest). */
export interface ProjectNextStep {
  /** Unique within the type; a dismissed step is kept by it in `project.config` `next_steps_dismissed`. */
  id: string;
  label: string;
  description: string;
  /** The shell route of the screen where it is done. */
  route: string;
  /**
   * What makes this step done: a project path step (`ProjectStatus.path[].step`)
   * being done, or `field:<name>` — the project's object in the domain model
   * (type `project`) having `<name>` set. Without it the step stays until dismissed.
   */
  done_when?: string | null;
}

/**
 * A project type (`GET project-creation-types`): a kit's subtype of the core
 * Project type (ADR-0073). Older servers answer `slug`, `name` and
 * `description` only.
 */
export interface ProjectTypeKit {
  /** The kit, sent back as `project_type_kit`. */
  slug: string;
  /** The type's GTS id, derived from Project's. */
  type_id?: string;
  name: string;
  description: string;
  kit_name?: string;
  mode?: string;
  /** The optional creation steps it takes: `repository`, `sources`, `scaffold`, `prd`. */
  steps?: string[];
  next_steps?: ProjectNextStep[];
  /** `builtin`, or `organization`: one the organization installed from its own shelf. */
  shelf?: string;
  /** The kit's version a project of this type gets; absent for a built-in kit. */
  version?: string | null;
}

/** One row of `GET /rollups` (`RollupDto`): the counts the projects list reads. Null means not asked, not zero. */
export interface ProjectRollup {
  id: string;
  name: string;
  /** `workspace` or `project`. */
  kind: string;
  open_findings?: number | null;
  findings?: number | null;
  pulls_open?: number | null;
  pulls_merged?: number | null;
  activity_days?: number | null;
  /** The phase Project lifecycle has the project in (`idea`, `discovery`, `build`, `run`); null for none. */
  phase?: string | null;
}

export class ProjectStatusApiService extends BaseApiService {
  constructor() {
    // The server reads every gear behind the status before it answers.
    const restProtocol = new RestProtocol({ timeout: 60000 });
    const restEndpoints = new RestEndpointProtocol(restProtocol);
    super({ baseURL: STUDIO_ORGANIZATIONS_API_BASE_URL }, restProtocol, restEndpoints);
  }

  /** A workspace and its projects as the portfolio rollup counts them; every count may be null (not asked). */
  readonly rollups = this.protocol(RestEndpointProtocol).queryWith<{ items: ProjectRollup[]; total: number }, { workspaceId: string }>(
    ({ workspaceId }) => `/rollups?${new URLSearchParams({ workspace_id: workspaceId })}`
  );

  readonly status = this.protocol(RestEndpointProtocol).queryWith<ProjectStatus, { projectId: string }>(
    ({ projectId }) => `/project-status?${new URLSearchParams({ project_id: projectId })}`
  );

  /**
   * The project types an organization offers: the built-in ones, then the kits
   * it installed whose model derives a subtype of Project (ADR-0073 Amendment 2).
   * Without an organization, the built-in ones only.
   */
  readonly projectTypeKits = this.protocol(RestEndpointProtocol).queryWith<
    { items: ProjectTypeKit[] },
    { organizationId: string | null }
  >(({ organizationId }) =>
    organizationId
      ? `/project-creation-types?${new URLSearchParams({ organization_id: organizationId })}`
      : '/project-creation-types'
  );

  /** Check a project's creation as the caller and queue it as one run (202). */
  readonly createProject = this.protocol(RestEndpointProtocol).mutation<ProjectCreation, CreateProjectBody>(
    'POST',
    '/project-creations'
  );

  /** Where a creation stands. */
  readonly creation = this.protocol(RestEndpointProtocol).queryWith<
    ProjectCreation,
    { runId: string; organizationId: string }
  >(
    ({ runId, organizationId }) =>
      `/project-creations/${encodeURIComponent(runId)}?${new URLSearchParams({ organization_id: organizationId })}`
  );
}
