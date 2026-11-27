/**
 * What the path's nested menus read and do (ContextChain): the children of an
 * organization or a workspace, read only when their submenu opens, and the
 * move to a place picked there, on the same tab where the place has it.
 *
 * The lists are the shared query cache's (`useApiQuery`): the switchers, the
 * Workspaces screen and the projects list read the same entries, and the
 * organization or workspace in scope answers from the slice without a request.
 */

import {
  apiRegistry,
  eventBus,
  useApiQuery,
  useAppSelector,
  useDomainExtensions,
  FRONTX_SCREEN_DOMAIN,
} from '@gears-frontx/react';
import { AccountsApiService, errorMessage } from '@constructor-studio/mfe-shared';
import { InstalledKitsApiService } from '@/app/api/InstalledKitsApiService';
import { useMountedExtensions } from '@/app/mfe/domainOccupancy';
import type { StudioScreenExtension } from '@/app/mfe/screenLevels';
import { APP_CONTEXT_SLICE_KEY, type AppContextState, type ContextEntity } from '@/app/slices/appContextSlice';
import { itemOnScreen } from './KitAbsentScreen';

export interface ChildList {
  items: ContextEntity[];
  loading: boolean;
  failed: boolean;
}

const selectContext = (state: Record<string, unknown>) => state[APP_CONTEXT_SLICE_KEY] as AppContextState | undefined;

const toEntity = (tenant: { id: string; name: string; child_count?: number }): ContextEntity => ({
  id: tenant.id,
  name: tenant.name,
  ...(tenant.child_count !== undefined && { count: tenant.child_count }),
});

/** An organization's workspaces; the one in scope answers from the slice. */
export function useWorkspacesOf(orgId: string): ChildList {
  const context = useAppSelector(selectContext);
  const own = context?.org?.id === orgId && context.workspacesStatus !== 'pending' && context.workspacesStatus !== 'failed';
  const read = useApiQuery(apiRegistry.getService(AccountsApiService).getWorkspaces({ organizationId: orgId }), {
    enabled: !own,
  });
  if (own) return { items: context.workspaces, loading: false, failed: false };
  return { items: (read.data?.items ?? []).map(toEntity), loading: read.isLoading, failed: read.isError };
}

/** A workspace's projects; the one in scope answers from the slice once it holds them. */
export function useProjectsOf(workspaceId: string): ChildList {
  const context = useAppSelector(selectContext);
  const own = context?.workspace?.id === workspaceId && (context.projects.length > 0 || context.projectsStatus === 'ready');
  const read = useApiQuery(apiRegistry.getService(AccountsApiService).getProjects({ parentId: workspaceId }), {
    enabled: !own,
  });
  if (own) return { items: context.projects, loading: false, failed: false };
  return { items: (read.data?.items ?? []).map(toEntity), loading: read.isLoading, failed: read.isError };
}

/** The tab on screen, as far as a move needs it: the kit that brings it, if a kit does. */
export interface TabOnScreen {
  kit?: string;
}

export function useTabOnScreen(): TabOnScreen | undefined {
  const registered = useDomainExtensions(FRONTX_SCREEN_DOMAIN) as StudioScreenExtension[];
  const mounted = useMountedExtensions(FRONTX_SCREEN_DOMAIN)[0] as StudioScreenExtension | undefined;
  const section = useAppSelector((state) => selectContext(state)?.section ?? null);
  const item = itemOnScreen(registered, mounted, section);
  return item ? { kit: item.presentation.kit } : undefined;
}

export interface Place {
  organizationId: string;
  workspaceId?: string;
  projectId?: string;
}

/**
 * Whether `kit` is installed where `place` is. `true` when nobody can say —
 * no installer, or the read failed: unknown hides nothing, as for the tabs.
 */
async function kitAt(place: Place, kit: string): Promise<boolean> {
  if (!apiRegistry.has(InstalledKitsApiService)) return true;
  const scope = place.projectId ? { projectId: place.projectId } : { organizationId: place.organizationId };
  try {
    const summary = await apiRegistry.getService(InstalledKitsApiService).installed(scope).fetch();
    if (!summary) return true;
    // A retired slug (ADR-0071 §8) is in `effective` wherever everything it resolves to applies.
    return summary.effective.some((k) => k.kit_slug === kit);
  } catch (error) {
    console.warn('[chain] could not read the kits of the place picked:', errorMessage(error));
    return true;
  }
}

/**
 * Goes to `place`. `keep` (the level picked is the level on screen) asks the
 * shell to stay on the tab on screen; a tab whose kit the place does not have
 * is not kept, and the place opens on its own first tab. A section the place
 * does not answer falls back the same way when the address is applied.
 */
export async function openPlace(place: Place, keep: boolean, tab: TabOnScreen | undefined): Promise<void> {
  const kept = keep && (!tab?.kit || (await kitAt(place, tab.kit)));
  eventBus.emit('app/context/place/requested', kept ? { ...place, keep: true } : place);
}
