/**
 * Which screens a micro-frontend may send the person to (ADR-0068 §5): the
 * shell publishes the routes that show where the person is — its own, and a
 * kit's only where that kit is installed — so a row's button never leads to a
 * tab that is not there. A screen hides such a button instead of offering a
 * dead one.
 *
 * Unknown never hides anything, as in the shell's tabs: outside the shell, or
 * before it knows, every route counts as available; while the installed kits
 * are unknown, every kit does.
 *
 * Declare `STUDIO_SHARED_PROPERTY_SCREENS_AVAILABLE` in the entry's
 * `requiredProperties` to read it.
 */

import { useMemo } from 'react';
import { useSharedProperty, type ChildMfeBridge } from '@gears-frontx/react';
import { STUDIO_SHARED_PROPERTY_SCREENS_AVAILABLE } from './hostProperties';

export interface AvailableScreens {
  /** The routes of the screens that show where the person is. */
  routes: string[];
  /** The kits installed where the person is, or `null` while unknown. */
  kits: string[] | null;
  /**
   * Every registered screen that is a tab on a level's bar, installed or not,
   * in each level's order (#1099): what a kit's page draws the shell's tabs
   * from. Absent from a shell that predates it.
   */
  tabs?: ShellTab[];
}

/** One registered screen as a level's tab bar lists it (`AvailableScreens.tabs`). */
export interface ShellTab {
  /** `platform`, `organization`, `workspace`, `project` or `admin`. */
  level: string;
  route: string;
  label: string;
  /** The manifest's icon (`lucide:<name>`), or null. */
  icon: string | null;
  /** `main` tabs first, then `settings` ones, each by `order`. */
  placement: 'main' | 'settings';
  order: number;
  /** The kit that brings it; null for the shell's own. */
  kit: string | null;
  /** The name the Studio domain model and `hidden_tabs` know the tab by. */
  modelTab: string;
  /** The extension's entry: which micro-frontend draws it. */
  entry: string;
}

function isShellTab(value: unknown): value is ShellTab {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<ShellTab>;
  return (
    typeof v.level === 'string' &&
    typeof v.route === 'string' &&
    typeof v.label === 'string' &&
    typeof v.entry === 'string' &&
    typeof v.modelTab === 'string'
  );
}

/** The registered tabs the shell publishes, or `null` before it does (or from a shell that does not). */
export function shellTabsOf(value: unknown): ShellTab[] | null {
  if (!isAvailableScreens(value) || !Array.isArray(value.tabs)) return null;
  return value.tabs.filter(isShellTab);
}

export function isAvailableScreens(value: unknown): value is AvailableScreens {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<AvailableScreens>;
  return (
    Array.isArray(v.routes) &&
    v.routes.every((r) => typeof r === 'string') &&
    (v.kits === null || (Array.isArray(v.kits) && v.kits.every((k) => typeof k === 'string')))
  );
}

/** Whether `route` may be opened: unknown counts as yes. */
export function routeAvailable(available: AvailableScreens | null, route: string | null | undefined): boolean {
  if (!route) return false;
  return available === null || available.routes.includes(route);
}

/** Whether the kit `slug` is installed where the person is: unknown counts as yes. */
export function kitAvailable(available: AvailableScreens | null, slug: string | null | undefined): boolean {
  if (!slug) return true;
  return available === null || available.kits === null || available.kits.includes(slug);
}

export interface ScreenAvailability {
  /** Whether a screen at this route may be opened now. */
  route: (route: string | null | undefined) => boolean;
  /** Whether this kit is installed where the person is. */
  kit: (slug: string | null | undefined) => boolean;
}

/** The shell's answer, as two questions a screen asks before drawing a button. */
export function useScreenAvailability(options?: { bridge?: ChildMfeBridge }): ScreenAvailability {
  const value = useSharedProperty<unknown>(STUDIO_SHARED_PROPERTY_SCREENS_AVAILABLE, options);
  // By content: the bridge hands a new object on every publish.
  const key = isAvailableScreens(value) ? JSON.stringify({ routes: value.routes, kits: value.kits }) : '';
  return useMemo(() => {
    const available = key ? (JSON.parse(key) as AvailableScreens) : null;
    return {
      route: (route) => routeAvailable(available, route),
      kit: (slug) => kitAvailable(available, slug),
    };
  }, [key]);
}
