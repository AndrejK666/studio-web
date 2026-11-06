/** Connect source's own events. */

import '@gears-frontx/react';
import type { RepositoryPick } from '../model/projectDraft';

declare module '@gears-frontx/react' {
  interface EventPayloadMap {
    'mfe/projects/sources-connect-requested': { projectId: string; picks: RepositoryPick[] };
    'mfe/projects/sources-connected': { projectId: string };
  }
}
