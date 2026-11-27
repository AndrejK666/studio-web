/**
 * What the shell reads for a level's tabs besides the manifests (ADR-0066):
 * the `shows` relations of the level's type in the organization's Studio
 * domain model, and the names the level's own settings document hides.
 *
 * The model is read again when the live channel says it changed (Admin ›
 * Studio domain model added or removed a tab), so a new tab shows without a
 * reload. Neither read hides anything when it fails: a model that will not
 * answer leaves the manifests' tabs, a settings document that will not answer
 * hides nothing.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiRegistry, useAppSelector, useQueryCache } from '@gears-frontx/react';
import {
  AccountsApiService,
  invalidateDomainTypes,
  isTabLevel,
  useDomainTypes,
  levelSettingsType,
  modelOf,
  modelTabs,
  parseHiddenTabs,
  withHiddenTabs,
  type DomainModel,
  type ModelTab,
  type TabLevel,
} from '@constructor-studio/mfe-shared';
import type { ScreenLevel } from '@/app/mfe/screenLevels';
import { APP_CONTEXT_SLICE_KEY, type AppContextState } from '@/app/slices/appContextSlice';
import { useStudioEvents } from '@/app/live/useLiveChannel';

const NO_TABS: ModelTab[] = [];

const selectContext = (state: Record<string, unknown>) => state[APP_CONTEXT_SLICE_KEY] as AppContextState | undefined;

/** The organization's model, re-read on `domain.model_changed`; null until (and unless) it answers. */
export function useOrganizationModel(orgId: string | null): DomainModel | null {
  // The one cached read of the model every reader shares (mfe-shared `useDomainTypes`).
  const read = useDomainTypes(orgId);
  return useMemo(() => (read.data && !read.isError ? modelOf(read.data) : null), [read.data, read.isError]);
}

/**
 * The shell's one listener for `domain.model_changed`: it marks the
 * organization's model stale in the shared cache, so every reader on screen —
 * the shell's tabs and kits, and every MFE — reads it again once.
 */
export function useDomainModelInvalidation(): void {
  const orgId = useAppSelector((state) => selectContext(state)?.org?.id ?? null);
  const cache = useQueryCache();
  useStudioEvents((event) => {
    if (event.kind === 'domain.model_changed' && orgId) invalidateDomainTypes(cache, orgId);
  });
}

/** The `shows` relations of `level`'s type, in the model's order; none above or beside the three levels. */
export function useLevelModelTabs(level: ScreenLevel): ModelTab[] {
  const orgId = useAppSelector((state) => selectContext(state)?.org?.id ?? null);
  const model = useOrganizationModel(isTabLevel(level) ? orgId : null);
  return useMemo(() => (model && isTabLevel(level) ? modelTabs(model, level) : NO_TABS), [model, level]);
}

/** The tenant whose settings document holds `level`'s hidden tabs. */
export function useLevelTenant(level: ScreenLevel): string | null {
  return useAppSelector((state) => {
    const context = selectContext(state);
    if (level === 'organization') return context?.org?.id ?? null;
    if (level === 'workspace') return context?.workspace?.id ?? null;
    if (level === 'project') return context?.project?.id ?? null;
    return null;
  });
}

export interface HiddenTabs {
  /** What the level's document hides, as saved. */
  hidden: string[];
  /** Saves `next` as the level's hidden tabs, every other field of the document kept. */
  save: ((next: string[]) => Promise<void>) | null;
}

const NOTHING_HIDDEN: string[] = [];

// A save heard by every reader of the same level and tenant: the top bar's
// row, the sidebar's list and the bar over the screen read the document each
// on its own, and one saving must not leave the others showing the old list.
type SavedListener = (key: string, hidden: string[]) => void;
const savedListeners = new Set<SavedListener>();

/** The names `tenantId`'s settings document hides from `level`'s tabs, and how to change them. */
export function useHiddenTabs(level: ScreenLevel, tenantId: string | null): HiddenTabs {
  const [read, setRead] = useState<{ key: string; hidden: string[] } | null>(null);
  const tabLevel: TabLevel | null = isTabLevel(level) ? level : null;
  const key = tabLevel && tenantId ? `${tabLevel}\u0000${tenantId}` : null;

  useEffect(() => {
    if (!tabLevel || !tenantId || !key) return undefined;
    let live = true;
    apiRegistry
      .getService(AccountsApiService)
      .getTenantMetadata<unknown>({ tenantId, metadataType: levelSettingsType(tabLevel) })
      .fetch({ staleTime: 0 })
      .then(
        (entry) => live && setRead({ key, hidden: parseHiddenTabs(entry?.value) }),
        // Not readable here: every tab shows — hiding is never the fallback.
        () => live && setRead({ key, hidden: NOTHING_HIDDEN })
      );
    return () => {
      live = false;
    };
  }, [tabLevel, tenantId, key]);

  useEffect(() => {
    if (!key) return undefined;
    const heard: SavedListener = (savedKey, hidden) => {
      if (savedKey === key) setRead({ key, hidden });
    };
    savedListeners.add(heard);
    return () => {
      savedListeners.delete(heard);
    };
  }, [key]);

  const save = useCallback(
    async (next: string[]) => {
      if (!tabLevel || !tenantId || !key) return;
      const accounts = apiRegistry.getService(AccountsApiService);
      const type = levelSettingsType(tabLevel);
      // Read, changed, written back whole, as every other writer of the
      // document does, so its other fields (icon, sources, stages…) stay.
      const current = await accounts.getTenantMetadata<unknown>({ tenantId, metadataType: type }).fetch({ staleTime: 0 });
      await accounts.putTenantMetadata<Record<string, unknown>>(tenantId, type).fetch(withHiddenTabs(current?.value, next));
      setRead({ key, hidden: next });
      for (const listener of [...savedListeners]) listener(key, next);
    },
    [tabLevel, tenantId, key]
  );

  return {
    hidden: read && read.key === key ? read.hidden : NOTHING_HIDDEN,
    save: key ? save : null,
  };
}
