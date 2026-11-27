/**
 * The kits installed where the person is — the organization in scope, or the
 * open project (its own kits, its organization's and the base kits) — as a set
 * of slugs — or
 * `null` while it is unknown (no organization yet, the read in flight, or a
 * backend without the installer). Unknown never hides anything: a screen is
 * hidden only once the gear has said its kit is not installed. A kit the
 * deployment does not run (ADR-0079 §5, `available_in_deployment: false`)
 * counts as not installed: its screens show nowhere here.
 *
 * And the domain types installed for the organization (ADR-0070 §2): a
 * section that shows another kit's type declares it in `presentation.needs`
 * by its GTS id (`gts.cf.studio.domain.milestone.v1~`, ADR-0071 §5), and
 * shows only where every type it needs is installed. The same rule: unknown
 * hides nothing.
 */

import { useMemo } from 'react';
import { apiRegistry, useApiQuery, useAppSelector } from '@gears-frontx/react';
import { useDomainTypes } from '@constructor-studio/mfe-shared';
import { InstalledKitsApiService, kitsOffInDeployment, runningKits } from '@/app/api/InstalledKitsApiService';
import type { ModelTypesSummary } from '@/app/api/ModelTypesApiService';
import { APP_CONTEXT_SLICE_KEY, type AppContextState } from '@/app/slices/appContextSlice';
import type { ScreenLevel, StudioScreenExtension } from '@/app/mfe/screenLevels';

/**
 * `level`, when given, names whose kits are asked about: a level above the
 * project reads the organization's even while a project is open (the
 * sidebar lists the organization's tabs beside the project's). Absent: the
 * scope on screen, as before.
 */
export function useInstalledKits(level?: ScreenLevel): ReadonlySet<string> | null {
  const orgId = useAppSelector(
    (state) => (state[APP_CONTEXT_SLICE_KEY] as AppContextState | undefined)?.org?.id ?? null
  );
  const openProject = useAppSelector(
    (state) => (state[APP_CONTEXT_SLICE_KEY] as AppContextState | undefined)?.project?.id ?? null
  );
  const projectId = level === undefined || level === 'project' ? openProject : null;
  const scope = projectId ? { projectId } : { organizationId: orgId ?? '' };
  const read = useApiQuery(apiRegistry.getService(InstalledKitsApiService).installed(scope), {
    enabled: !!orgId || !!projectId,
  });
  if (!read.data) return null;
  // An answer for another scope (the read before a switch) is not this one's.
  if (projectId ? read.data.project_id !== projectId : read.data.organization_id !== orgId) return null;
  return new Set(runningKits(read.data));
}

/**
 * The kits installed where the person is that the deployment does not run
 * (ADR-0079 §5), as a set of slugs; empty while unknown. Reads the same cache
 * entry as `useInstalledKits`, so a screen of such a kit can say why it is
 * not there.
 */
export function useKitsOffInDeployment(): ReadonlySet<string> {
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
  const data = read.data;
  return useMemo(() => new Set(data ? kitsOffInDeployment(data) : []), [data]);
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

function gtsList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((n): n is string => typeof n === 'string' && n !== '') : [];
}

/** The domain types (GTS ids) a screen needs to show (`presentation.needs`); empty for most. */
export function typesNeeded(screen: StudioScreenExtension): readonly string[] {
  return gtsList(screen.presentation.needs);
}

/** The domain types (GTS ids) a section inside the screen needs (`presentation.sectionNeeds`). */
export function sectionTypesNeeded(screen: StudioScreenExtension): readonly string[] {
  return gtsList(screen.presentation.sectionNeeds);
}

/**
 * The GTS id a domain type is named by in `needs`: the one the model records
 * (`meta.gts`), else `gts.cf.studio.domain.<id>.v1~` with `-`, `.` and
 * spaces as `_`, as the backend derives it.
 */
export function typeGtsId(entity: { id?: string; meta?: { gts?: unknown } | null }): string | null {
  const own = entity.meta?.gts;
  if (typeof own === 'string' && own !== '') return own;
  if (typeof entity.id !== 'string' || entity.id === '') return null;
  return `gts.cf.studio.domain.${entity.id.replace(/[-. ]/g, '_')}.v1~`;
}

/**
 * The organization's installed domain types, by GTS id, or `null` while unknown.
 * Read only when `wanted` (some screen on the level needs a type), so a level
 * without such a screen costs no request.
 */
export function useInstalledTypes(wanted: boolean): ReadonlySet<string> | null {
  const orgId = useAppSelector(
    (state) => (state[APP_CONTEXT_SLICE_KEY] as AppContextState | undefined)?.org?.id ?? null
  );
  const read = useDomainTypes<ModelTypesSummary>(orgId, { enabled: wanted });
  const entities = read.data?.ontology?.entities;
  return useMemo(
    () =>
      entities
        ? new Set(entities.map(typeGtsId).filter((id): id is string => id !== null))
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
  // A kit named by a retired slug (ADR-0071 §8) is in `installed` wherever
  // everything it resolves to is: the installer lists it in `effective`.
  if (kit && installed !== null && !installed.has(kit)) return false;
  return types === null || typesNeeded(screen).every((t) => types.has(t));
}
