/**
 * The kits installed where the person is — the organization in scope, or the
 * open project (its own kits, its organization's and the base kits) — as a set
 * of slugs — or
 * `null` while it is unknown (no organization yet, the read in flight, or a
 * backend without the installer). Unknown never hides anything: a screen is
 * hidden only once the gear has said its kit is not installed.
 *
 * And the domain types installed for the organization (ADR-0070 §2): a
 * section that shows another kit's type declares it in `presentation.needs`
 * (project-activity's Timeline needs project-lifecycle's `milestone`), and
 * shows only where every type it needs is installed. The same rule: unknown
 * hides nothing.
 */

import { useMemo } from 'react';
import { apiRegistry, useApiQuery, useAppSelector } from '@gears-frontx/react';
import { InstalledKitsApiService } from '@/app/api/InstalledKitsApiService';
import { ModelTypesApiService } from '@/app/api/ModelTypesApiService';
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

/** A kit's icon as the installer lists it: a lucide name, or the URL of an SVG in its bundle. */
export interface KitIconRef {
  icon: string | null;
  url: string | null;
}

/**
 * The icons of the kits installed where the person is, by slug (#1081); empty
 * while unknown. Reads the same cache entry as `useInstalledKits`.
 */
export function useKitIcons(): ReadonlyMap<string, KitIconRef> {
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
  const effective = read.data?.effective;
  return useMemo(
    () =>
      new Map(
        (effective ?? []).map((k) => [k.kit_slug, { icon: k.icon ?? null, url: k.icon_url ?? null }] as const)
      ),
    [effective]
  );
}

/**
 * What a screen's tab shows as its icon: the screen's own (`presentation.icon`)
 * when it names one, else its kit's, a lucide name or a bundled SVG's URL.
 */
export function screenIcon(
  screen: StudioScreenExtension,
  kits: ReadonlyMap<string, KitIconRef>
): { declared: string | undefined; url: string | undefined } {
  const own = screen.presentation.icon;
  if (own) return { declared: own, url: undefined };
  const kit = screen.presentation.kit ? kits.get(screen.presentation.kit) : undefined;
  return { declared: kit?.icon ?? undefined, url: kit?.url ?? undefined };
}

/** The domain types a screen needs to show (`presentation.needs`); empty for most. */
export function typesNeeded(screen: StudioScreenExtension): readonly string[] {
  const needs = screen.presentation.needs;
  return Array.isArray(needs) ? needs.filter((n): n is string => typeof n === 'string' && n !== '') : [];
}

/**
 * The organization's installed domain types, by id, or `null` while unknown.
 * Read only when `wanted` (some screen on the level needs a type), so a level
 * without such a screen costs no request.
 */
export function useInstalledTypes(wanted: boolean): ReadonlySet<string> | null {
  const orgId = useAppSelector(
    (state) => (state[APP_CONTEXT_SLICE_KEY] as AppContextState | undefined)?.org?.id ?? null
  );
  const read = useApiQuery(apiRegistry.getService(ModelTypesApiService).types({ organizationId: orgId ?? '' }), {
    enabled: wanted && !!orgId,
  });
  const entities = read.data?.ontology?.entities;
  return useMemo(
    () =>
      entities
        ? new Set(entities.map((e) => e.id).filter((id): id is string => typeof id === 'string'))
        : null,
    [entities]
  );
}

/**
 * Whether a screen shows: the shell's own always, a kit's where its kit is
 * installed, and one that needs domain types where all of them are.
 */
export function screenShows(
  screen: StudioScreenExtension,
  installed: ReadonlySet<string> | null,
  types: ReadonlySet<string> | null = null
): boolean {
  const kit = screen.presentation.kit;
  if (kit && installed !== null && !installed.has(kit)) return false;
  return types === null || typesNeeded(screen).every((t) => types.has(t));
}
