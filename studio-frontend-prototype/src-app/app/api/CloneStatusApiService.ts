/**
 * Whether each of a project's sources could be cloned, and why not
 * (`studio-artifact-ingest`, #1071): read by the editor's status, which says
 * why the IDE opens without a repository instead of only waiting.
 */

import { BaseApiService, RestEndpointProtocol, RestProtocol } from '@gears-frontx/react';

export const CLONE_STATUS_API_BASE_URL = '/cf/studio-artifact-ingest/v1';

/** `SourceCloneStatusDto`: the fields the editor's status reads. */
export interface SourceCloneStatus {
  clone_url: string;
  full_path: string;
  state: 'cloned' | 'failed' | 'never';
  /** `desktop`, `ide_session` or `sync`. */
  by?: string | null;
  cause?: string | null;
  cause_text?: string | null;
  action?: string | null;
  action_text?: string | null;
  detail?: string | null;
}

export interface SourceCloneStatusList {
  items: SourceCloneStatus[];
  total: number;
}

export class CloneStatusApiService extends BaseApiService {
  constructor() {
    const restProtocol = new RestProtocol({ timeout: 30000 });
    const restEndpoints = new RestEndpointProtocol(restProtocol);

    super({ baseURL: CLONE_STATUS_API_BASE_URL }, restProtocol, restEndpoints);
  }

  /** The project's sources, each with its last clone or fetch. Read with `staleTime: 0`. */
  readonly cloneStatus = this.protocol(RestEndpointProtocol).queryWith<SourceCloneStatusList, { projectId: string }>(
    ({ projectId }) => `/sources/clone-status?${new URLSearchParams({ project_id: projectId })}`
  );
}
