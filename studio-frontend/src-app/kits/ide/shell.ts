/**
 * The ide kit's part in the shell (`app/ports/shellPorts.ts`):
 *
 * - `editor.connect`: the editor's frame channel (ADR-0080 §4). An IDE that
 *   hears its frame (`frame_channel`, Theia) is talked to over `postMessage`,
 *   in whichever protocol version it answers; one that does not (VS Code) is
 *   reached through the backend's control channel.
 * - `desktop.openFile`: a command for a desktop the member holds open, sent
 *   through studio-theia and out on studio-events (ADR-0027 §5–6). The
 *   desktops themselves are studio-session's, the core's
 *   (`app/api/DesktopApiService.ts`).
 */

import { apiRegistry } from '@gears-frontx/react';
import type { KitShell } from '@/app/ports/shellPorts';
import { editorCan } from '@/app/ports/editorPort';
import { controlChannel } from './controlChannel';
import { frameChannel } from './frameBridge';
import { IdeControlApiService } from './ideControlApi';

export { IdeControlApiService } from './ideControlApi';

const ide: KitShell = ({ fill }) => {
  apiRegistry.register(IdeControlApiService);
  fill('ide', 'editor.connect', (connection) =>
    editorCan(connection.runtime, 'frame_channel') ? frameChannel(connection) : controlChannel(connection)
  );
  fill('ide', 'desktop.openFile', async (desktopSessionId, relativePath) => {
    await apiRegistry
      .getService(IdeControlApiService)
      .command(desktopSessionId)
      .fetch({ command: 'open_in_editor', params: { relativePath } });
  });
};

export default ide;
