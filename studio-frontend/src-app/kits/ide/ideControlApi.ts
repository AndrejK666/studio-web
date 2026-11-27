/**
 * The ide kit's REST client: its gear (studio-theia, the IDE bridge of
 * ADR-0022) under `/cf/studio-theia/v1`. Commands for a desktop the member
 * holds open (ADR-0027 §5–6), and opens through the backend's control channel
 * for an IDE that does not hear its frame (ADR-0080 §4).
 */

import { BaseApiService, RestEndpointProtocol, RestProtocol } from '@gears-frontx/react';
import { CONTROL_API_BASE_URL } from './protocol';

export class IdeControlApiService extends BaseApiService {
  constructor() {
    const restProtocol = new RestProtocol({ timeout: 30000 });
    super({ baseURL: CONTROL_API_BASE_URL }, restProtocol, new RestEndpointProtocol(restProtocol));
  }

  /** A command for a desktop the member holds open: it goes out on studio-events. 404 for an ended one. */
  command(desktopSessionId: string) {
    return this.protocol(RestEndpointProtocol).mutation<
      { command_id: string; desktop_session_id: string; command: string },
      { command: 'open_in_editor'; params: { relativePath: string } }
    >('POST', `/desktop-sessions/${encodeURIComponent(desktopSessionId)}/commands`);
  }

  /** Open a file of the workspace in its running IDE, by its path from the workspace root. */
  openFile(workspaceId: string) {
    return this.protocol(RestEndpointProtocol).mutation<
      { opened: boolean; resolvedRelativePath?: string | null },
      { relativePath: string; preview: boolean }
    >('POST', `/workspaces/${encodeURIComponent(workspaceId)}/open`);
  }

  /** Open a portal document in the workspace's running IDE. */
  openDocument(workspaceId: string) {
    return this.protocol(RestEndpointProtocol).mutation<
      { opened: boolean },
      { workspace_id: string; document_id: string; title?: string; content?: string }
    >('POST', `/workspaces/${encodeURIComponent(workspaceId)}/documents/open`);
  }
}
