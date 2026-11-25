/**
 * The sidebar layout's two pieces, placed by `Layout`: the navigation on the
 * left (`SidebarNav`) and the bar over the screen (`ScreenBar`).
 *
 * - Open, the sidebar lists the level's tabs; the bar names the screen and
 *   carries what follows the tab row in the top layout (Default order, Pin,
 *   Tabs, the kits' toolbar actions) and the project's status chip.
 * - Folded to its rail, the sidebar keeps the icons; the bar takes the path
 *   (`ContextChain`) and `Layout` puts the level's tab row back under it, so
 *   nothing the top layout reaches is out of reach.
 * - Under 900px the sidebar is a drawer over the screen, opened from the bar.
 */

import React, { useEffect, useRef } from 'react';
import { useAppSelector, useDomainExtensions, FRONTX_SCREEN_DOMAIN } from '@gears-frontx/react';
import { Menu } from 'lucide-react';
import { APP_CONTEXT_SLICE_KEY, type AppContextState } from '@/app/slices/appContextSlice';
import { placementOf, type StudioScreenExtension } from '@/app/mfe/screenLevels';
import { useShellText } from '@/app/i18n/shellTranslations';
import { ContextChain } from '../ContextChain';
import { ProjectStatusSlot } from '../KitSlot';
import { LevelTabActions } from '../LevelTabs';
import { useScreenLevel } from '../useScreenLevel';
import { useSearchEntry } from '../useSearchEntry';
import { useLevelTabs } from '../useLevelTabs';
import { ShellSidebar, type SidebarModels } from './ShellSidebar';
import styles from './ShellSidebar.module.css';

// Below the breakpoint the sidebar is a drawer over the screen.
export { NARROW_VIEWPORT_PX, useNarrowViewport } from '../useNarrowViewport';

/** The id of the drawer the bar's menu button opens. */
export const SIDEBAR_DRAWER_ID = 'shell-sidebar-drawer';

/** Whether a key press happened where typing is going on. */
function typingIn(event: KeyboardEvent): boolean {
  const target = (event.composedPath?.()[0] ?? event.target) as HTMLElement | null;
  if (!target || typeof target.closest !== 'function') return false;
  return !!target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
}

/** Ctrl K (⌘K on a Mac) opens Search, unless somebody is typing or a screen took the key. */
export function useSearchShortcut(open: () => void, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.shiftKey) return;
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return;
      if (typingIn(event)) return;
      event.preventDefault();
      open();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, enabled]);
}

/** Every level's tabs, once, for the sidebar's lists. */
function useSidebarModels(): SidebarModels {
  return {
    platform: useLevelTabs('platform'),
    organization: useLevelTabs('organization', { scoped: true }),
    workspace: useLevelTabs('workspace', { scoped: true }),
    project: useLevelTabs('project'),
    admin: useLevelTabs('admin'),
  };
}

const FOCUSABLE = 'button:not([disabled]), [href], input, [tabindex]:not([tabindex="-1"])';

export interface SidebarNavProps {
  rail: boolean;
  onToggleRail: () => void;
  narrow: boolean;
  drawerOpen: boolean;
  onCloseDrawer: () => void;
}

export const SidebarNav: React.FC<SidebarNavProps> = ({ rail, onToggleRail, narrow, drawerOpen, onCloseDrawer }) => {
  const t = useShellText();
  const level = useScreenLevel();
  const models = useSidebarModels();
  const screens = useDomainExtensions(FRONTX_SCREEN_DOMAIN) as StudioScreenExtension[];
  const drawer = useRef<HTMLDivElement | null>(null);
  const context = useAppSelector((state) => state[APP_CONTEXT_SLICE_KEY] as AppContextState | undefined);
  const place = `${models.organization.mounted?.id ?? ''}|${context?.section ?? ''}|${context?.project?.id ?? ''}|${context?.workspace?.id ?? ''}|${context?.org?.id ?? ''}`;

  // A drawer closes once it has taken somebody somewhere.
  const opened = useRef(place);
  useEffect(() => {
    if (!drawerOpen) {
      opened.current = place;
      return;
    }
    if (opened.current !== place) onCloseDrawer();
  }, [place, drawerOpen, onCloseDrawer]);

  // The drawer is modal: focus goes in, stays in, and Escape closes it.
  useEffect(() => {
    if (!narrow || !drawerOpen) return undefined;
    const root = drawer.current;
    root?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // A menu open inside the drawer closes first.
        if (document.querySelector('[role="menu"]')) return;
        onCloseDrawer();
        return;
      }
      if (event.key !== 'Tab' || !root) return;
      const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.querySelector<HTMLElement>(`[aria-controls="${SIDEBAR_DRAWER_ID}"]`)?.focus();
    };
  }, [narrow, drawerOpen, onCloseDrawer]);

  if (narrow) {
    if (!drawerOpen) return null;
    return (
      <>
        <div className={styles.drawerBackdrop} onClick={onCloseDrawer} aria-hidden="true" data-sidebar-backdrop />
        <div
          ref={drawer}
          id={SIDEBAR_DRAWER_ID}
          role="dialog"
          aria-modal="true"
          aria-label={t('sidebar')}
          className={styles.drawer}
          data-sidebar-drawer
        >
          <ShellSidebar models={models} level={level} screens={screens} onClose={onCloseDrawer} />
        </div>
      </>
    );
  }

  return (
    <div className="flex h-full shrink-0" data-shell-sidebar>
      <ShellSidebar models={models} level={level} screens={screens} rail={rail} onToggleRail={onToggleRail} />
    </div>
  );
};

SidebarNav.displayName = 'SidebarNav';

const ActionItem: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="inline-flex items-center">{children}</span>
);

export interface ScreenBarProps {
  rail: boolean;
  narrow: boolean;
  drawerOpen: boolean;
  onOpenDrawer: () => void;
  /** Whether a screen is in scope at all (not the organization gate). */
  withScreen: boolean;
}

/** The bar over the screen in the sidebar layout. */
export const ScreenBar: React.FC<ScreenBarProps> = ({ rail, narrow, drawerOpen, onOpenDrawer, withScreen }) => {
  const t = useShellText();
  const level = useScreenLevel();
  const model = useLevelTabs(level);
  const search = useSearchEntry();
  const context = useAppSelector((state) => state[APP_CONTEXT_SLICE_KEY] as AppContextState | undefined);
  useSearchShortcut(search.open, !!search.extension);

  const mounted = model.mounted;
  const product = !!mounted && placementOf(mounted) === 'product';
  // Folded, the path is here and the tab row under it carries the actions.
  const withPath = rail && !narrow;
  const where =
    level === 'platform'
      ? [t('level_platform')]
      : level === 'admin'
        ? [t('user_menu_admin')]
        : [
            context?.org?.name,
            level === 'workspace' || level === 'project' ? context?.workspace?.name : undefined,
            level === 'project' ? context?.project?.name : undefined,
          ].filter((name): name is string => !!name);
  const name = product ? mounted?.presentation?.label : (model.active?.presentation?.label ?? '');

  return (
    <div className={styles.screenBar} data-screen-bar>
      {narrow && (
        <button
          type="button"
          className={styles.iconButton}
          aria-label={t('sidebar_open')}
          title={t('sidebar_open')}
          aria-expanded={drawerOpen}
          aria-controls={SIDEBAR_DRAWER_ID}
          onClick={onOpenDrawer}
          data-sidebar-open
        >
          <Menu aria-hidden="true" className="size-5" />
        </button>
      )}
      {withPath ? (
        <div className="flex min-w-0 items-center">
          <ContextChain />
        </div>
      ) : (
        <div className={styles.screenTitle} aria-label={t('sidebar_where')} role="group">
          {!product && where.length > 0 && <span className={styles.screenWhere}>{where.join(' / ')}</span>}
          <span className={styles.screenName} data-screen-name>
            {name || where[where.length - 1] || ''}
          </span>
        </div>
      )}
      {/* A kit's status chip for the open project (slot project.header.status). */}
      <ProjectStatusSlot />
      {withScreen && !withPath && !product && (
        <div className={styles.screenActions}>
          <LevelTabActions model={model} Item={ActionItem} />
        </div>
      )}
    </div>
  );
};

ScreenBar.displayName = 'ScreenBar';
