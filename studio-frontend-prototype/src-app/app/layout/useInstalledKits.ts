/**
 * The kits installed where the person is — the organization in scope, or the
 * open project (its own kits, its organization's and the base kits) — as a set
 * of slugs — or
 * `null` while it is unknown (no organization yet, the read in flight, or a
 * backend without the installer). Unknown never hides anything: a screen is
 * hidden only once the gear has said its kit is not installed.
 */

import { apiRegistry, useApiQuery, useAppSelector } from '@gears-frontx/react';
import { InstalledKitsApiService } from '@/app/api/InstalledKitsApiService';
import { APP_CONTEXT_SLICE_KEY, type AppContextState } from '@/app/slices/appContextSlice';
import type { StudioScreenExtension } from '@/app/mfe/screenLevels';

export function useInstalledKits(): ReadonlySet<string> | null {
  const orgId = useAppSelector(
    (state) => (state[APP_CONTEXT_SLICE_KEY] as AppContextState | undefined)?.org?.id ?? null
  );
  const projectId = useAppSelector(
    (state) => (state[APP_CONTEXT_SLICE_KEY] as AppContextState | undefined)?.project?.id ?? null
  );
  const scope = projectId ? { projectId } : { organizationId: orgId ?? '' };
  const read = useApiQuery(apiRegistry.getService(InstalledKitsApiService).installed(scope), {
    enabled: !!orgId || !!projectId,
  });
  if (!read.data) return null;
  // An answer for another scope (the read before a switch) is not this one's.
  if (projectId ? read.data.project_id !== projectId : read.data.organization_id !== orgId) return null;
  return new Set(read.data.effective.map((k) => k.kit_slug));
}

/** Whether a screen shows: the shell's own always, a kit's where its kit is installed. */
export function screenShows(screen: StudioScreenExtension, installed: ReadonlySet<string> | null): boolean {
  const kit = screen.presentation.kit;
  return !kit || installed === null || installed.has(kit);
}
