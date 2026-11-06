/**
 * The kits installed for the organization in scope, as a set of slugs — or
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
  const read = useApiQuery(
    apiRegistry.getService(InstalledKitsApiService).installed({ organizationId: orgId ?? '' }),
    { enabled: !!orgId }
  );
  if (!orgId || !read.data || read.data.organization_id !== orgId) return null;
  return new Set(read.data.effective.map((k) => k.kit_slug));
}

/** Whether a screen shows: the shell's own always, a kit's where its kit is installed. */
export function screenShows(screen: StudioScreenExtension, installed: ReadonlySet<string> | null): boolean {
  const kit = screen.presentation.kit;
  return !kit || installed === null || installed.has(kit);
}
