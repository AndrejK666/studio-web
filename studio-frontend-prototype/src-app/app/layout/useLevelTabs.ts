/**
 * One level's tabs as both layouts draw them: the top bar's row
 * (`LevelTabs`) and the sidebar's lists (`sidebar/ShellSidebar`). What a tab
 * is, which show and in what order is decided here once — the manifests'
 * tabs through `resolveLevelMenu` (a tab whose kit or needed type is not
 * installed left out), then those the Studio domain model adds, without what
 * the level's settings hide (`hidden_tabs`), in the order the person keeps.
 * The layouts only draw it, so a kit never knows which one is on.
 */

import { useCallback, useSyncExternalStore } from 'react';
import { useAppSelector, useDomainExtensions, eventBus, FRONTX_SCREEN_DOMAIN } from '@gears-frontx/react';
import { useMountedExtensions } from '@/app/mfe/domainOccupancy';
import { MFE_BOOTSTRAP_SLICE_KEY, type MfeBootstrapState } from '@/app/slices/mfeBootstrapSlice';
import { APP_CONTEXT_SLICE_KEY, type AppContextState } from '@/app/slices/appContextSlice';
import {
  offeredTo,
  parentSectionOf,
  resolveLevelMenu,
  sectionOf,
  type ScreenLevel,
  type StudioScreenExtension,
} from '@/app/mfe/screenLevels';
import { usePreference } from '@/app/preferences/uiPreferences';
import { orderLevelTabs, tabOrderKey, type OrderedTab } from '@/app/preferences/levelTabOrder';
import { isDefaultOrder, serializeOrder } from '@/app/preferences/tab-order';
import { pinFor, usePins } from '@/app/pins/usePins';
import { isPinned, type Pin } from '@/app/pins/pins';
import { screenShows, typesNeeded, useInstalledKits, useInstalledTypes, useKitIcons, type KitIconRef } from './useInstalledKits';
import { screenIdOf, visibleTabs, withModelTabs } from './modelTabs';
import { useHiddenTabs, useLevelModelTabs, useLevelTenant } from './useModelTabs';
import { useDecidesRequests } from './OrganizationRequests';

/** Whether `item` is the tab of what is mounted. */
export function isActiveItem(
  item: StudioScreenExtension,
  mounted: StudioScreenExtension | undefined,
  section: string | null
): boolean {
  const itemSection = sectionOf(item);
  // A hidden screen (the editor) names the section it belongs to.
  const parent = mounted && parentSectionOf(mounted);
  if (parent !== undefined) return itemSection === parent;
  if (itemSection !== undefined && mounted && item.entry === mounted.entry) {
    return itemSection === section;
  }
  return item.id === mounted?.id;
}

/** Asks for a tab's screen: a tab the model adds is its generic screen, under the tab's section. */
export function chooseTab(chosen: StudioScreenExtension): void {
  const screenId = screenIdOf(chosen);
  const section = sectionOf(chosen);
  eventBus.emit(
    'app/context/screen/requested',
    screenId !== chosen.id && section ? { extensionId: screenId, section } : { extensionId: chosen.id }
  );
}

// The Tabs editor's preview (names switched off, not yet saved), per level:
// shared, so the sidebar's list and the editor in the bar over the screen
// show the same thing while the switches move.
const previews = new Map<ScreenLevel, string[] | null>();
const previewListeners = new Set<() => void>();
let previewVersion = 0;

function setPreview(level: ScreenLevel, hidden: string[] | null): void {
  if ((previews.get(level) ?? null) === hidden) return;
  previews.set(level, hidden);
  previewVersion += 1;
  for (const listener of [...previewListeners]) listener();
}

function subscribePreview(listener: () => void): () => void {
  previewListeners.add(listener);
  return () => {
    previewListeners.delete(listener);
  };
}

const previewSnapshot = () => previewVersion;

export interface LevelTabsModel {
  level: ScreenLevel;
  /** Every tab the level could show, hidden ones included: what the Tabs editor lists. */
  all: StudioScreenExtension[];
  /** The tabs that show, in the order the person keeps. */
  ordered: OrderedTab[];
  /** The tab ids in their declared order. */
  defaultOrder: string[];
  /** Whether the person keeps an order other than the default. */
  reordered: boolean;
  /** Keeps `next` (tab ids) as the level's order. */
  saveOrder: (next: string[]) => void;
  /** The mounted screen, and whether a tab is its tab. */
  mounted: StudioScreenExtension | undefined;
  isActive: (item: StudioScreenExtension) => boolean;
  /** The tab on screen, when it is one of this level's. */
  active: StudioScreenExtension | undefined;
  /** The pin the tab on screen would be, and whether it is pinned. */
  pin: Pin | null;
  pinned: boolean;
  togglePin: (pin: Pin) => void;
  /** What the level's settings hide, and how to change it (null: not here). */
  hidden: string[];
  saveHidden: ((next: string[]) => Promise<void>) | null;
  setPreview: (hidden: string[] | null) => void;
  kitIcons: ReadonlyMap<string, KitIconRef>;
  /** The manifests are still being read: nothing to draw yet is not "no tabs". */
  pending: boolean;
}

const selectContext = (state: Record<string, unknown>) => state[APP_CONTEXT_SLICE_KEY] as AppContextState | undefined;

/** `level`'s tabs. `scoped`: read the kits of that level, not of the place on screen. */
export function useLevelTabs(level: ScreenLevel, { scoped = false }: { scoped?: boolean } = {}): LevelTabsModel {
  const registered = useDomainExtensions(FRONTX_SCREEN_DOMAIN) as StudioScreenExtension[];
  const installed = useInstalledKits(scoped ? level : undefined);
  // A tab whose screen names no icon shows its kit's (#1081).
  const kitIcons = useKitIcons();
  // A platform administrator's screens (Admin › System) for them alone.
  const platformAdmin = useDecidesRequests();
  const leveled = resolveLevelMenu(registered, level);
  const types = useInstalledTypes(leveled.some((ext) => typesNeeded(ext).length > 0));
  const modelTabs = useLevelModelTabs(level);
  const all = withModelTabs(
    leveled.filter((ext) => screenShows(ext, installed, types) && offeredTo(ext, platformAdmin)),
    registered,
    level,
    modelTabs
  );
  const tenant = useLevelTenant(level);
  const { hidden, save: saveHidden } = useHiddenTabs(level, tenant);
  useSyncExternalStore(subscribePreview, previewSnapshot, previewSnapshot);
  const preview = previews.get(level) ?? null;
  const items = visibleTabs(all, preview ?? hidden);
  const mounted = useMountedExtensions(FRONTX_SCREEN_DOMAIN)[0] as StudioScreenExtension | undefined;
  const section = useAppSelector((state) => selectContext(state)?.section ?? null);
  const org = useAppSelector((state) => selectContext(state)?.org ?? null);
  const workspace = useAppSelector((state) => selectContext(state)?.workspace ?? null);
  const project = useAppSelector((state) => selectContext(state)?.project ?? null);
  const pending =
    useAppSelector(
      (state) => (state[MFE_BOOTSTRAP_SLICE_KEY] as MfeBootstrapState | undefined)?.status ?? 'pending'
    ) === 'pending';

  // The order the person keeps (`/me/ui-preferences`), read against the
  // level's own list on every render: a tab added since keeps its place.
  const [stored, setStored] = usePreference(tabOrderKey(level));
  const ordered = orderLevelTabs(items, stored);
  const declared = orderLevelTabs(items, '');
  const defaults = declared.map((tab) => tab.id);
  const reordered = !!stored && !isDefaultOrder(ordered.map((tab) => tab.id), declared);
  const saveOrder = (next: string[]) => setStored(isDefaultOrder(next, declared) ? '' : serializeOrder(next));

  const { pins, toggle } = usePins();
  const isActive = (item: StudioScreenExtension) => isActiveItem(item, mounted, section);
  const active = items.find(isActive);
  const pin = active ? pinFor(active, level, { org, workspace, project }) : null;
  const pinned = pin ? isPinned(pins, pin) : false;
  const preview$ = useCallback((next: string[] | null) => setPreview(level, next), [level]);

  return {
    level,
    all,
    ordered,
    defaultOrder: defaults,
    reordered,
    saveOrder,
    mounted,
    isActive,
    active,
    pin,
    pinned,
    togglePin: toggle,
    hidden,
    saveHidden,
    setPreview: preview$,
    kitIcons,
    pending,
  };
}
