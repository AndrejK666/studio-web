/**
 * Tells the micro-frontends which screens they may send the person to
 * (`…context.screens.available.v1~`): the registered screens that show where
 * the person is — the shell's own, and a kit's only where its kit is installed
 * (`screenShows`, the tabs' own rule) — and the installed kits. A row on an
 * Overview or in the Inbox reads it (mfe-shared `useScreenAvailability`) and
 * offers no button to a tab that is not there.
 *
 * It also lists every registered tab of every level, installed or not
 * (`tabs`), so a kit's page can draw a level's bar with the kit's tabs among
 * the shell's (#1099).
 *
 * Renders nothing; mounted once by the Layout.
 */

import { useEffect } from 'react';
import { useDomainExtensions, useFrontX, FRONTX_SCREEN_DOMAIN } from '@gears-frontx/react';
import type { AvailableScreens as Available, ShellTab } from '@constructor-studio/mfe-shared';
import {
  levelOf,
  placementOf,
  SCREEN_LEVELS,
  UNDECLARED_ORDER,
  type StudioScreenExtension,
} from '@/app/mfe/screenLevels';
import { publishAvailableScreens } from '@/app/mfe/sharedContext';
import { modelNameOf } from './modelTabs';
import { screenShows, useInstalledKits } from './useInstalledKits';

/** Every registered screen that is a tab on a level's bar, each level's main tabs then its settings, by order. */
export function shellTabs(screens: readonly StudioScreenExtension[]): ShellTab[] {
  const tabs: ShellTab[] = [];
  for (const screen of screens) {
    const placement = placementOf(screen);
    const route = screen.presentation?.route;
    if ((placement !== 'main' && placement !== 'settings') || !route) continue;
    const icon = screen.presentation.icon;
    tabs.push({
      level: levelOf(screen),
      route,
      label: String(screen.presentation.label ?? route),
      icon: typeof icon === 'string' ? icon : null,
      placement,
      order: screen.presentation.order ?? UNDECLARED_ORDER,
      kit: screen.presentation.kit ?? null,
      modelTab: modelNameOf(screen),
      entry: String(screen.entry),
    });
  }
  const level = (tab: ShellTab) => (SCREEN_LEVELS as readonly string[]).indexOf(tab.level);
  return tabs.sort(
    (a, b) =>
      level(a) - level(b) ||
      Number(a.placement === 'settings') - Number(b.placement === 'settings') ||
      a.order - b.order ||
      a.route.localeCompare(b.route)
  );
}

/** What the shell publishes for these screens and installed kits (`null`: unknown). */
export function availableScreens(
  screens: readonly StudioScreenExtension[],
  installed: ReadonlySet<string> | null
): Available {
  const routes = new Set<string>();
  for (const screen of screens) {
    const route = screen.presentation?.route;
    if (route && screenShows(screen, installed)) routes.add(route);
  }
  return { routes: [...routes].sort(), kits: installed ? [...installed].sort() : null, tabs: shellTabs(screens) };
}

export const AvailableScreens: React.FC = () => {
  const app = useFrontX();
  const screens = useDomainExtensions(FRONTX_SCREEN_DOMAIN) as StudioScreenExtension[];
  const installed = useInstalledKits();
  const value = availableScreens(screens, installed);
  // Published by content: a new array of the same screens is not news.
  const tabsKey = (value.tabs ?? []).map((tab) => `${tab.level}:${tab.route}:${tab.label}:${tab.order}`).join('\n');
  const key = `${value.routes.join('\n')}|${value.kits?.join('\n') ?? '?'}|${tabsKey}`;
  useEffect(() => {
    publishAvailableScreens(app, value);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `value` is read through its key
  }, [app, key]);
  return null;
};

AvailableScreens.displayName = 'AvailableScreens';
