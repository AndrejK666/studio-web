/**
 * The workspace's projects as the portfolio rollup counts them
 * (`GET /studio-organizations/v1/rollups?workspace_id=`, one request for the
 * whole list): open findings and pull requests over the last days, by project
 * id. Empty while it is read or when it cannot be: the list then shows its
 * "no data" mark, never a zero it did not read.
 */

import { useEffect, useState } from 'react';
import { apiRegistry } from '@gears-frontx/react';
import { ProjectStatusApiService, type ProjectRollup } from '../api/ProjectStatusApiService';

export function useProjectRollups(workspaceId: string | null | undefined): Record<string, ProjectRollup> {
  const [result, setResult] = useState<{ workspaceId: string; rows: Record<string, ProjectRollup> } | null>(null);
  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    let read: Promise<{ items: ProjectRollup[] }>;
    try {
      read = apiRegistry.getService(ProjectStatusApiService).rollups({ workspaceId }).fetch({ staleTime: 0 });
    } catch {
      return;
    }
    read.then(
      (r) =>
        alive &&
        setResult({
          workspaceId,
          rows: Object.fromEntries(r.items.filter((i) => i.kind === 'project').map((i) => [i.id, i])),
        }),
      () => alive && setResult({ workspaceId, rows: {} })
    );
    return () => {
      alive = false;
    };
  }, [workspaceId]);
  return result && result.workspaceId === workspaceId ? result.rows : {};
}
