import { FRONTX_SCREEN_DOMAIN, type ChildMfeBridge } from '@gears-frontx/react';
import { STUDIO_ACTION_ARTIFACT_OPEN, sendAndForget } from '@constructor-studio/mfe-shared';
import type { ArtifactRow } from '../model/artifact';

// @cpt-dod:cpt-studiofrontend-dod-project-artifacts-open-request:p1
export function requestOpenArtifact(
  bridge: ChildMfeBridge | null,
  projectId: string,
  row: ArtifactRow
): void {
  if (row.kind === null) return;
  sendAndForget(
    bridge,
    {
      type: STUDIO_ACTION_ARTIFACT_OPEN,
      target: FRONTX_SCREEN_DOMAIN,
      payload: {
        projectId,
        artifactId: row.id,
        repository: row.repository,
        path: row.path,
        kind: row.kind,
      },
    },
    'projects'
  );
}
