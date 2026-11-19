import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { noOrganization, shell } = vi.hoisted(() => ({
  noOrganization: { value: false },
  /** The person's layout preferences and the window, as the hooks answer. */
  shell: { layout: 'top' as 'top' | 'sidebar', collapsed: false, narrow: false },
}));

vi.mock('@/app/actions/bootstrapActions', () => ({
  fetchCurrentUser: vi.fn(),
  fetchAppContext: vi.fn(),
}));
vi.mock('@/app/live/useLiveChannel', () => ({
  useLiveChannelOpen: () => undefined,
  useLiveChannelFollowsOrganization: () => undefined,
}));
vi.mock('./AvailableScreens', () => ({ AvailableScreens: () => null }));
vi.mock('./Header', () => ({ Header: () => <div data-testid="top-bar" /> }));
vi.mock('./LevelTabs', () => ({ LevelTabs: () => <div data-testid="level-tabs" /> }));
vi.mock('./RuntimeKits', () => ({ RuntimeKits: () => <div data-testid="runtime-kits" /> }));
vi.mock('./KitDock', () => ({ KitDock: () => <div data-testid="kit-dock" /> }));
vi.mock('./Popup', () => ({ Popup: () => null }));
vi.mock('./Overlay', () => ({ Overlay: () => null }));
vi.mock('./OverlayDialog', () => ({ OverlayDialog: () => null }));
vi.mock('./Presence', () => ({ Presence: () => <div data-testid="presence" /> }));
vi.mock('./OrganizationAccessGate', () => ({
  OrganizationAccessGate: () => <div data-testid="access-gate" />,
  useHasNoOrganization: () => noOrganization.value,
}));

vi.mock('@/app/preferences/shellLayout', () => ({
  useShellLayout: () => [shell.layout, vi.fn()],
  useSidebarCollapsed: () => [shell.collapsed, vi.fn()],
}));
vi.mock('./sidebar/recentProjects', () => ({ useRecordRecentProject: () => undefined }));
vi.mock('./sidebar/SidebarLayout', () => ({
  useNarrowViewport: () => shell.narrow,
  SidebarNav: (props: { rail: boolean; narrow: boolean }) => (
    <div data-testid="sidebar" data-rail={String(props.rail)} data-narrow={String(props.narrow)} />
  ),
  ScreenBar: () => <div data-testid="screen-bar" />,
}));

import { Layout } from './Layout';

const renderLayout = () =>
  render(
    <Layout>
      <div data-testid="mounted-screen" />
    </Layout>
  );

describe('Layout', () => {
  afterEach(() => {
    cleanup();
    noOrganization.value = false;
    shell.layout = 'top';
    shell.collapsed = false;
    shell.narrow = false;
  });

  it("draws the level's tabs between the top bar and the screen (the name is in the path)", () => {
    renderLayout();
    expect(screen.getByTestId('top-bar')).toBeTruthy();
    expect(screen.getByTestId('level-tabs')).toBeTruthy();
    expect(screen.getByTestId('mounted-screen')).toBeTruthy();
    // Signed in means reporting in: the heartbeat and the notes left for this person.
    expect(screen.getByTestId('presence')).toBeTruthy();
  });

  it("puts the kits' dock beside the screen, in the same row", () => {
    renderLayout();
    const dock = screen.getByTestId('kit-dock');
    expect(dock.parentElement).toBe(screen.getByTestId('mounted-screen').closest('main')?.parentElement);
  });

  // Onboarding: there is no level to name and no section to offer.
  it('draws neither for a person with no organization, who gets the gate instead', () => {
    noOrganization.value = true;
    renderLayout();
    expect(screen.getByTestId('top-bar')).toBeTruthy();
    expect(screen.queryByTestId('level-tabs')).toBeNull();
    expect(screen.queryByTestId('mounted-screen')).toBeNull();
    expect(screen.queryByTestId('kit-dock')).toBeNull();
    expect(screen.getByTestId('access-gate')).toBeTruthy();
  });

  describe('the sidebar layout', () => {
    it('puts the sidebar beside the screen and the bar that names it over it, with no top bar or tab row', () => {
      shell.layout = 'sidebar';
      renderLayout();
      expect(screen.getByTestId('sidebar')).toBeTruthy();
      expect(screen.getByTestId('screen-bar')).toBeTruthy();
      expect(screen.queryByTestId('top-bar')).toBeNull();
      expect(screen.queryByTestId('level-tabs')).toBeNull();
      expect(screen.getByTestId('mounted-screen')).toBeTruthy();
    });

    it('gives the tab row back to the screen when the sidebar is folded to its rail', () => {
      shell.layout = 'sidebar';
      shell.collapsed = true;
      renderLayout();
      expect(screen.getByTestId('sidebar').getAttribute('data-rail')).toBe('true');
      expect(screen.getByTestId('level-tabs')).toBeTruthy();
    });

    it('is a drawer under 900px, never a rail, its tabs in the drawer', () => {
      shell.layout = 'sidebar';
      shell.collapsed = true;
      shell.narrow = true;
      renderLayout();
      const sidebar = screen.getByTestId('sidebar');
      expect(sidebar.getAttribute('data-rail')).toBe('false');
      expect(sidebar.getAttribute('data-narrow')).toBe('true');
      expect(screen.queryByTestId('level-tabs')).toBeNull();
    });

    it('keeps the screen where it was when the layout switches: the chrome moves, the screen stays mounted', () => {
      const view = renderLayout();
      const mounted = screen.getByTestId('mounted-screen');
      shell.layout = 'sidebar';
      view.rerender(
        <Layout>
          <div data-testid="mounted-screen" />
        </Layout>
      );
      expect(screen.getByTestId('mounted-screen')).toBe(mounted);
      expect(screen.getByTestId('sidebar')).toBeTruthy();
    });

    it('keeps the top bar and its menu for a person with no organization', () => {
      shell.layout = 'sidebar';
      noOrganization.value = true;
      renderLayout();
      expect(screen.getByTestId('top-bar')).toBeTruthy();
      expect(screen.queryByTestId('sidebar')).toBeNull();
      expect(screen.getByTestId('access-gate')).toBeTruthy();
    });
  });
});
