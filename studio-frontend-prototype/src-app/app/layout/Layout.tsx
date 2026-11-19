/**
 * Layout Component
 *
 * Main layout orchestrator for the application.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { fetchCurrentUser, fetchAppContext } from '@/app/actions/bootstrapActions';
import { Header } from './Header';
import { LevelTabs } from './LevelTabs';
import { RuntimeKits } from './RuntimeKits';
import { AvailableScreens } from './AvailableScreens';
import { Screen } from './Screen';
import { KitDock } from './KitDock';
import { Popup } from './Popup';
import { Overlay } from './Overlay';
import { OverlayDialog } from './OverlayDialog';
import { OrganizationAccessGate, useHasNoOrganization } from './OrganizationAccessGate';
import { useLiveChannelFollowsOrganization, useLiveChannelOpen } from '@/app/live/useLiveChannel';
import { Presence } from './Presence';
import { useShellLayout, useSidebarCollapsed } from '@/app/preferences/shellLayout';
import { useRecordRecentProject } from './sidebar/recentProjects';
import { ScreenBar, SidebarNav, useNarrowViewport } from './sidebar/SidebarLayout';

export interface LayoutProps {
  children?: React.ReactNode;
}

export const Layout: React.FC<LayoutProps> = ({ children }) => {
  // An authenticated person with no organization membership gets the onboarding
  // state instead of the mounted screen (ADR-0011 §3). The top bar stays — they
  // still need the account menu and a way to sign out — but its context slot has
  // nothing to offer and the screen below has no scope to render in.
  const noOrganization = useHasNoOrganization();
  // The Layout is mounted only behind the AuthGate: the live channel is open
  // exactly while somebody is signed in (app/live/liveChannel.ts).
  useLiveChannelOpen();
  // …listening to the organization on screen, not only the person's home tenant.
  useLiveChannelFollowsOrganization();

  useEffect(() => {
    fetchCurrentUser();
    fetchAppContext();
  }, []);

  // The person's layout (`shell.layout`): the top bar, or the sidebar. Both
  // draw the same levels' tabs and mount the same screen, which keeps its
  // place in the tree below, so switching moves the chrome and not the screen.
  const [layout] = useShellLayout();
  const [collapsed, setCollapsed] = useSidebarCollapsed();
  const narrow = useNarrowViewport();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const openDrawer = useCallback(() => setDrawerOpen(true), []);
  const toggleRail = useCallback(() => setCollapsed(!collapsed), [collapsed, setCollapsed]);
  // What "Recent projects" lists, kept in either layout.
  useRecordRecentProject();

  const sidebar = layout === 'sidebar';
  // Folded to its rail, the sidebar leaves the level's tab row to the screen.
  const rail = sidebar && collapsed && !narrow;
  const inset = sidebar && !narrow && !noOrganization;

  return (
    <div
      className={
        sidebar ? 'flex h-full w-full overflow-hidden bg-[var(--sidebar)]' : 'flex h-full w-full flex-col overflow-hidden'
      }
      data-shell-layout={layout}
    >
      {/* The sidebar layout's navigation (the designer's). */}
      {sidebar && !noOrganization && (
        <SidebarNav
          rail={rail}
          onToggleRail={toggleRail}
          narrow={narrow}
          drawerOpen={drawerOpen}
          onCloseDrawer={closeDrawer}
        />
      )}
      {/* In the sidebar layout the screen sits on the sidebar as a card (the designer's). */}
      <div
        className={
          inset
            ? 'my-2 mr-2 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card'
            : 'flex min-h-0 min-w-0 flex-1 flex-col'
        }
      >
        {/* Global top bar: brand, the path to the level in scope, session. In
            the sidebar layout, the bar that names the screen instead; a
            person with no organization keeps the top bar and its menu. */}
        {sidebar && !noOrganization ? (
          <ScreenBar
            rail={rail}
            narrow={narrow}
            drawerOpen={drawerOpen}
            onOpenDrawer={openDrawer}
            withScreen={!noOrganization}
          />
        ) : (
          <Header />
        )}

        {/* The level's tabs, then the screen they mount. Its name is in the path
            (ContextChain), the prototype's way (ADR-0069). The open sidebar
            lists them itself. */}
        {!noOrganization && (!sidebar || rail) && <LevelTabs />}
        {/* Kits' screens loaded at run time, and a tile for any that did not come up. */}
        {!noOrganization && <RuntimeKits />}
        {/* Which screens a row inside a screen may lead to (kits installed here). */}
        {!noOrganization && <AvailableScreens />}
        {/* The screen, and beside it what a kit docks there (Studio AI). */}
        <div className="flex min-h-0 flex-1">
          <Screen>{noOrganization ? <OrganizationAccessGate /> : children}</Screen>
          {!noOrganization && <KitDock />}
        </div>
      </div>

      {/* Out of the flow, over everything: dialogs and overlays. */}
      <OverlayDialog />
      <Popup />
      <Overlay />
      {/* The heartbeat that puts this person in Admin › System's list, and the notes left for them. */}
      <Presence />
    </div>
  );
};

Layout.displayName = 'Layout';
