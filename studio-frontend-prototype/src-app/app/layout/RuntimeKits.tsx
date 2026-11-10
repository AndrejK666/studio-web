/**
 * Runtime kits (ADR-0068 phase 5): once the shell knows the kits installed
 * where the person is, it asks `studio-kits` for their micro-frontends and
 * registers them beside the built-in screens (`mfe/runtimeKits.ts`). Installing
 * a kit shows its tab, uninstalling hides it (`screenShows`), and the portal
 * is not rebuilt for either.
 *
 * The read follows the installed-kits answer the tabs use, keyed by its
 * effective kits and versions, so installing on the Kits tab — which refreshes
 * that answer — loads the new kit's screens too.
 *
 * What did not come up is a tile above the screen, one per package, which the
 * person can dismiss; nothing else of the shell is held back by it.
 */

import React, { useEffect, useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import { apiRegistry, useApiQuery, useAppSelector, useFrontX } from '@gears-frontx/react';
import { InstalledKitsApiService } from '@/app/api/InstalledKitsApiService';
import { APP_CONTEXT_SLICE_KEY, type AppContextState } from '@/app/slices/appContextSlice';
import { MFE_BOOTSTRAP_SLICE_KEY, setMfeBootstrapStatus, type MfeBootstrapState } from '@/app/slices/mfeBootstrapSlice';
import { runtimeKitsOf, type RuntimeKits as RuntimeKitsStore } from '@/app/mfe/runtimeKits';
import { useShellText } from '@/app/i18n/shellTranslations';

const selectContext = (state: Record<string, unknown>) => state[APP_CONTEXT_SLICE_KEY] as AppContextState | undefined;

/** Loads the effective kits' micro-frontends into the registry. Renders nothing. */
export function useRuntimeKitLoader(): RuntimeKitsStore | null {
  const app = useFrontX();
  const registry = app.mfeRegistry ?? null;
  const orgId = useAppSelector((state) => selectContext(state)?.org?.id ?? null);
  const projectId = useAppSelector((state) => selectContext(state)?.project?.id ?? null);
  const ready = useAppSelector(
    (state) => (state[MFE_BOOTSTRAP_SLICE_KEY] as MfeBootstrapState | undefined)?.status === 'ready'
  );
  const scope = projectId ? { projectId } : { organizationId: orgId ?? '' };
  // The same read as the tabs' (`useInstalledKits`): one cache entry.
  const installed = useApiQuery(apiRegistry.getService(InstalledKitsApiService).installed(scope), {
    enabled: !!orgId || !!projectId,
  });
  const forScope = installed.data
    ? projectId
      ? installed.data.project_id === projectId
      : installed.data.organization_id === orgId
    : false;
  // What to load changes exactly when a kit or its version does.
  const signature = forScope
    ? (installed.data?.effective ?? [])
        .map((kit) => `${kit.kit_slug}@${kit.version ?? ''}`)
        .sort()
        .join(',')
    : null;

  useEffect(() => {
    if (!registry || !ready || signature === null) return;
    let live = true;
    const kits = runtimeKitsOf(registry);
    const at = projectId ? { projectId } : { organizationId: orgId ?? '' };
    void (async () => {
      let items;
      try {
        items = (await apiRegistry.getService(InstalledKitsApiService).mfeManifests(at).fetch({ staleTime: 0 }))
          ?.items;
      } catch (error) {
        // A backend without the route answers nothing to load: no kit screens, no tile.
        console.warn('[Runtime kits] the kits’ micro-frontends could not be listed:', error);
        return;
      }
      if (!live || !items || items.length === 0) return;
      await kits.sync(items, window.location.origin);
      // Registration is invisible to the store; one dispatch wakes the tabs
      // (`useDomainExtensions` re-reads the registry on any store change).
      if (live) app.store.dispatch(setMfeBootstrapStatus('ready'));
    })();
    return () => {
      live = false;
    };
  }, [app, registry, ready, signature, orgId, projectId]);

  return registry ? runtimeKitsOf(registry) : null;
}

const NO_FAILURES: never[] = [];

/** The loader, and a tile for each kit package that did not come up. */
export const RuntimeKits: React.FC = () => {
  const t = useShellText();
  const kits = useRuntimeKitLoader();
  const failures = useSyncExternalStore(
    (listener) => kits?.subscribe(listener) ?? (() => undefined),
    () => kits?.failures() ?? NO_FAILURES
  );
  if (failures.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 px-4 pt-3" data-runtime-kit-errors>
      {failures.map((failure) => (
        <div
          key={failure.key}
          role="alert"
          data-runtime-kit-error={failure.key}
          className="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-label"
        >
          <div className="min-w-0 flex-1">
            <div className="font-medium text-foreground">
              {failure.label
                ? t('runtime_kit_screen_failed', { screen: failure.label, kit: failure.kit })
                : t('runtime_kit_failed', { kit: failure.kit, version: failure.version })}
            </div>
            <div className="truncate text-muted-foreground" title={failure.reason}>
              {failure.reason}
            </div>
          </div>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            aria-label={t('runtime_kit_dismiss')}
            onClick={() => kits?.dismiss(failure.key)}
          >
            <X className="size-4" />
          </button>
        </div>
      ))}
    </div>
  );
};

RuntimeKits.displayName = 'RuntimeKits';
