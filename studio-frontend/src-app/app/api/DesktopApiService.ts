/**
 * The desktops a project is open on (studio-session), for the editor's desktop
 * hand-off (ADR-0027 §5–6). The command sent to one is the ide kit's
 * (`desktop.openFile`, `src-app/kits/ide/shell.ts`).
 */

import { BaseApiService, RestEndpointProtocol, RestProtocol } from '@gears-frontx/react';
import type { DesktopSession } from '@/app/desktop/desktopLink';

export class DesktopApiService extends BaseApiService {
  constructor() {
    const restProtocol = new RestProtocol({ timeout: 30000 });
    super({ baseURL: '/cf' }, restProtocol, new RestEndpointProtocol(restProtocol));
  }

  /** Every desktop the project is open on, any member's. Read with `staleTime: 0`. */
  readonly sessions = this.protocol(RestEndpointProtocol).queryWith<
    { items: DesktopSession[]; total: number },
    { projectId: string }
  >(({ projectId }) => `/studio-session/v1/desktop-sessions?project_id=${encodeURIComponent(projectId)}&limit=200`);
}
