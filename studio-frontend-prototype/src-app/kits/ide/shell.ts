/**
 * The ide kit's part in the shell (`app/ports/shellPorts.ts`): a command for a
 * desktop the member holds open, sent through studio-theia and out on
 * studio-events (ADR-0027 §5–6). The desktops themselves are studio-session's,
 * the core's (`app/api/DesktopApiService.ts`).
 */

import { BaseApiService, RestEndpointProtocol, RestProtocol, apiRegistry } from '@gears-frontx/react';
import type { KitShell } from '@/app/ports/shellPorts';

export class DesktopCommandsApiService extends BaseApiService {
  constructor() {
    const restProtocol = new RestProtocol({ timeout: 30000 });
    super({ baseURL: '/cf/studio-theia/v1' }, restProtocol, new RestEndpointProtocol(restProtocol));
  }

  /** A command for a desktop the member holds open: it goes out on studio-events. 404 for an ended one. */
  command(desktopSessionId: string) {
    return this.protocol(RestEndpointProtocol).mutation<
      { command_id: string; desktop_session_id: string; command: string },
      { command: 'open_in_editor'; params: { relativePath: string } }
    >('POST', `/desktop-sessions/${encodeURIComponent(desktopSessionId)}/commands`);
  }
}

const ide: KitShell = ({ fill }) => {
  apiRegistry.register(DesktopCommandsApiService);
  fill('ide', 'desktop.openFile', async (desktopSessionId, relativePath) => {
    await apiRegistry
      .getService(DesktopCommandsApiService)
      .command(desktopSessionId)
      .fetch({ command: 'open_in_editor', params: { relativePath } });
  });
};

export default ide;
