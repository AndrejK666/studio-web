/**
 * How the shell lays itself out, one of the person's preferences
 * (`/me/ui-preferences`, through `uiPreferences.ts`):
 *
 * - `shell.layout` — `top` (the default: the path and the level's tab row
 *   across the top) or `sidebar` (a left sidebar, the designer's prototype);
 * - `shell.sidebar` — `collapsed` when the sidebar is folded to its icon rail.
 *
 * Both are the person's, not the organization's, and follow them to every
 * machine; the store mirrors them in `localStorage`, so a reload paints the
 * chosen layout at once. Kits never see either: both layouts draw the same
 * level menus (`resolveLevelMenu`) and mount the same screens.
 */

import { useCallback } from 'react';
import { usePreference } from './uiPreferences';

export const SHELL_LAYOUT_PREFERENCE = 'shell.layout';
export const SIDEBAR_STATE_PREFERENCE = 'shell.sidebar';

export type ShellLayout = 'top' | 'sidebar';

/** The layout a stored value names; anything else is the default, `top`. */
export function layoutOf(stored: string): ShellLayout {
  return stored === 'sidebar' ? 'sidebar' : 'top';
}

/** The chosen layout and a way to change it; the default is stored as absent. */
export function useShellLayout(): [ShellLayout, (layout: ShellLayout) => void] {
  const [stored, save] = usePreference(SHELL_LAYOUT_PREFERENCE);
  const choose = useCallback((layout: ShellLayout) => save(layout === 'top' ? '' : layout), [save]);
  return [layoutOf(stored), choose];
}

/** Whether the sidebar is folded to its rail, and a way to change it. */
export function useSidebarCollapsed(): [boolean, (collapsed: boolean) => void] {
  const [stored, save] = usePreference(SIDEBAR_STATE_PREFERENCE);
  const set = useCallback((collapsed: boolean) => save(collapsed ? 'collapsed' : ''), [save]);
  return [stored === 'collapsed', set];
}
