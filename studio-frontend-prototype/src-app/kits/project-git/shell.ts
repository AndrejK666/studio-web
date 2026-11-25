/**
 * The project-git kit's part in the shell (`app/ports/shellPorts.ts`): whether
 * each of a project's sources could be cloned, and why not
 * (`studio-artifact-ingest`, #1071), for the editor's status, which says why
 * the IDE opens without a repository instead of only waiting.
 */

import { BaseApiService, RestEndpointProtocol, RestProtocol, apiRegistry } from '@gears-frontx/react';
import type { KitShell } from '@/app/ports/shellPorts';
import type { EditorCloneProblem } from '@/app/slices/editorSessionSlice';

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

/** The failed rows of a project's clone status, as the editor's status shows them. */
export function cloneProblems(items: readonly SourceCloneStatus[]): EditorCloneProblem[] {
  return items
    .filter((s) => s.state === 'failed')
    .map((s) => ({
      repository: s.full_path,
      cause: s.cause ?? null,
      causeText: s.cause_text ?? null,
      action: s.action ?? null,
      actionText: s.action_text ?? null,
      detail: s.detail ?? null,
    }));
}

const projectGit: KitShell = ({ fill }) => {
  apiRegistry.register(CloneStatusApiService);
  fill('project-git', 'editor.cloneProblems', async (projectId) => {
    const list = await apiRegistry.getService(CloneStatusApiService).cloneStatus({ projectId }).fetch({ staleTime: 0 });
    return cloneProblems(list.items);
  });
};

export default projectGit;
