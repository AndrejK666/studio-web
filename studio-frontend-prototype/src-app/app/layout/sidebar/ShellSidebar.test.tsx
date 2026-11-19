import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { StudioScreenExtension } from '@/app/mfe/screenLevels';
import type { LevelTabsModel } from '../useLevelTabs';

/**
 * The sidebar draws the levels' tabs it is handed (`useLevelTabs`, the same
 * lists the top bar's row draws) and the shell's own entries around them.
 */

const { mockEventBus, context, inbox, recent, pins, platformAdmin } = vi.hoisted(() => ({
  mockEventBus: { emit: vi.fn() },
  context: {
    org: { id: 'o1', name: 'Acme' } as { id: string; name: string } | null,
    workspace: { id: 'w1', name: 'Web' } as { id: string; name: string } | null,
    project: null as { id: string; name: string } | null,
  },
  inbox: { count: 3 as number | null, open: vi.fn(), screen: { id: 'ext.inbox' } as { id: string } | undefined },
  recent: [] as Array<{ org: { id: string; name: string }; workspace: { id: string; name: string }; project: { id: string; name: string } }>,
  pins: [] as Array<{ route: { token: string }; label: string; where: string[] }>,
  platformAdmin: { value: false },
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  eventBus: mockEventBus,
  useAppSelector: (selector: (state: Record<string, unknown>) => unknown) => selector({ 'app/context': context }),
}));
vi.mock('@/app/i18n/shellTranslations', () => import('@frontx-test-utils/shellText'));
vi.mock('../useInboxEntry', () => ({ useInboxEntry: () => inbox }));
vi.mock('../useSearchEntry', () => ({ useSearchEntry: () => ({ extension: { id: 'ext.search' }, open: vi.fn() }) }));
vi.mock('./recentProjects', () => ({ useRecentProjects: () => recent }));
vi.mock('@/app/pins/usePins', () => ({ usePins: () => ({ pins, toggle: vi.fn() }) }));
vi.mock('../OrganizationRequests', () => ({ useDecidesRequests: () => platformAdmin.value }));
vi.mock('./ContextSwitcher', () => ({ ContextSwitcher: () => <div data-testid="switcher" /> }));
vi.mock('../ProductMenu', () => ({ ProductMenu: () => <div data-testid="product-menu" /> }));
vi.mock('../UserMenu', () => ({ UserMenu: ({ variant }: { variant: string }) => <div data-testid="user-menu" data-variant={variant} /> }));
vi.mock('../WorkInbox', () => ({ WorkInbox: () => <div data-testid="bell" /> }));
vi.mock('../PinsMenu', () => ({ PinsMenu: () => <div data-testid="pins-menu" /> }));

import { ShellSidebar, type SidebarModels } from './ShellSidebar';

function ext(id: string, route: string, label: string, level: string, extra: Record<string, unknown> = {}): StudioScreenExtension {
  return { id, entry: `entry.${id}`, presentation: { route, label, level, ...extra } } as unknown as StudioScreenExtension;
}

function model(level: LevelTabsModel['level'], tabs: StudioScreenExtension[], activeId?: string): LevelTabsModel {
  return {
    level,
    all: tabs,
    ordered: tabs.map((extension) => ({ id: extension.id, extension })),
    defaultOrder: tabs.map((t) => t.id),
    reordered: false,
    saveOrder: vi.fn(),
    mounted: tabs.find((t) => t.id === activeId),
    isActive: (item) => item.id === activeId,
    active: tabs.find((t) => t.id === activeId),
    pin: null,
    pinned: false,
    togglePin: vi.fn(),
    hidden: [],
    saveHidden: null,
    setPreview: vi.fn(),
    kitIcons: new Map(),
    pending: false,
  };
}

const orgTabs = [
  ext('org.overview', '/organization/overview', 'Overview', 'organization'),
  ext('org.workspaces', '/organization/workspaces', 'Workspaces', 'organization'),
  ext('org.people', '/people', 'People', 'organization'),
  ext('org.components', '/components', 'Components', 'organization'),
];
const wsTabs = [ext('ws.projects', '/projects', 'Projects', 'workspace'), ext('ws.attributes', '/model-workspace/attributes', 'Attributes', 'workspace')];
const projectTabs = [ext('p.overview', '/projects/overview', 'Overview', 'project'), ext('p.specs', '/projects/specs', 'Specs', 'project')];
const platformTabs = [ext('pl.kits', '/kits', 'Kits', 'platform')];
const screens = [...orgTabs, ...wsTabs, ...projectTabs, ...platformTabs];

function models(active?: string): SidebarModels {
  return {
    platform: model('platform', platformTabs, active),
    organization: model('organization', orgTabs, active),
    workspace: model('workspace', wsTabs, active),
    project: model('project', projectTabs, active),
    admin: model('admin', [], active),
  };
}

const item = (name: string) => document.querySelector<HTMLElement>(`[data-sidebar-item="${name}"]`);

describe('ShellSidebar', () => {
  beforeEach(() => {
    context.org = { id: 'o1', name: 'Acme' };
    context.workspace = { id: 'w1', name: 'Web' };
    context.project = null;
    inbox.count = 3;
    inbox.screen = { id: 'ext.inbox' };
    recent.length = 0;
    pins.length = 0;
    platformAdmin.value = false;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('is one navigation landmark with Inbox and its count, Projects, Components and Organization, in that order', () => {
    render(<ShellSidebar models={models('org.overview')} level="organization" screens={screens} />);
    expect(screen.getByRole('navigation', { name: 'Studio navigation' })).toBeTruthy();
    const order = Array.from(document.querySelectorAll('[data-sidebar-item]')).map((el) => el.getAttribute('data-sidebar-item'));
    expect(order.slice(0, 4)).toEqual(['inbox', 'projects', 'components', 'organization']);
    expect(within(item('inbox')!).getByText('3')).toBeTruthy();
    // Not a platform administrator, not on the platform: no Platform entry.
    expect(item('platform')).toBeNull();
  });

  it("lists the organization's tabs under Organization, Components raised out of them, the open one aria-current", () => {
    render(<ShellSidebar models={models('org.people')} level="organization" screens={screens} />);
    const list = document.querySelector('[data-level-tabs="organization"]')!;
    const labels = Array.from(list.querySelectorAll('[data-tab]')).map((el) => el.textContent);
    expect(labels).toEqual(['Overview', 'Workspaces', 'People']);
    const people = within(list as HTMLElement).getByText('People').closest('button')!;
    expect(people.getAttribute('aria-current')).toBe('page');
    fireEvent.click(people);
    expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/screen/requested', { extensionId: 'org.people' });
  });

  it("opens the workspace's projects from Projects, and lists the workspace's other tabs under Organization", () => {
    render(<ShellSidebar models={models('ws.attributes')} level="workspace" screens={screens} />);
    fireEvent.click(item('projects')!);
    expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/screen/requested', { extensionId: 'ws.projects' });
    const list = document.querySelector('[data-level-tabs="workspace"]')!;
    expect(Array.from(list.querySelectorAll('[data-tab]')).map((el) => el.textContent)).toEqual(['Attributes']);
  });

  it("opens the organization's workspaces from Projects when no workspace is in scope", () => {
    context.workspace = null;
    render(<ShellSidebar models={models('org.overview')} level="organization" screens={screens} />);
    fireEvent.click(item('projects')!);
    expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/screen/requested', { extensionId: 'org.workspaces' });
  });

  it("puts the open project under Projects with its tabs, folds the organization's away, and lists the recent ones", () => {
    context.project = { id: 'p1', name: 'Portal' };
    recent.push(
      { org: { id: 'o1', name: 'Acme' }, workspace: { id: 'w1', name: 'Web' }, project: { id: 'p1', name: 'Portal' } },
      { org: { id: 'o1', name: 'Acme' }, workspace: { id: 'w2', name: 'Data' }, project: { id: 'p2', name: 'Pipeline' } },
      { org: { id: 'o9', name: 'Other' }, workspace: { id: 'w9', name: 'X' }, project: { id: 'p9', name: 'Elsewhere' } }
    );
    render(<ShellSidebar models={models('p.specs')} level="project" screens={screens} />);
    expect(item('project')!.textContent).toContain('Portal');
    const tabs = document.querySelector('[data-level-tabs="project"]')!;
    expect(within(tabs as HTMLElement).getByText('Specs').closest('button')!.getAttribute('aria-current')).toBe('page');
    expect(document.querySelector('[data-level-tabs="organization"]')).toBeNull();
    // The open project is not repeated, another organization's is not listed.
    const recentList = document.querySelector('[data-recent-projects]')!;
    expect(Array.from(recentList.querySelectorAll('[data-recent-project]')).map((el) => el.textContent)).toEqual(['Pipeline']);
    fireEvent.click(within(recentList as HTMLElement).getByText('Pipeline'));
    expect(mockEventBus.emit).toHaveBeenCalledWith('app/pins/open', {
      route: expect.objectContaining({ org: 'o1', workspace: 'w2', project: 'p2' }),
    });
  });

  it('folds a group with its toggle, which says whether it is open', () => {
    render(<ShellSidebar models={models('org.overview')} level="organization" screens={screens} />);
    const toggle = screen.getByRole('button', { name: 'Show or hide Organization' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-level-tabs="organization"]')).toBeNull();
  });

  it('offers the platform to a platform administrator', () => {
    platformAdmin.value = true;
    render(<ShellSidebar models={models('org.overview')} level="organization" screens={screens} />);
    fireEvent.click(item('platform')!);
    expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/level/requested', { level: 'platform' });
  });

  it('shows the pins as a Pinned group', () => {
    pins.push({ route: { token: 'specs' }, label: 'Specs', where: ['Acme', 'Web', 'Portal'] });
    render(<ShellSidebar models={models('org.overview')} level="organization" screens={screens} />);
    const pin = document.querySelector('[data-pin]')!;
    expect(pin.textContent).toContain('Specs');
    fireEvent.click(within(pin as HTMLElement).getByText('Specs'));
    expect(mockEventBus.emit).toHaveBeenCalledWith('app/pins/open', { route: { token: 'specs' } });
  });

  it('keeps the person, the bell and the fold at the foot', () => {
    const fold = vi.fn();
    render(<ShellSidebar models={models('org.overview')} level="organization" screens={screens} onToggleRail={fold} />);
    expect(screen.getByTestId('user-menu').getAttribute('data-variant')).toBe('sidebar');
    expect(screen.getByTestId('bell')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse the sidebar' }));
    expect(fold).toHaveBeenCalled();
  });

  it('folded to its rail, keeps the icons with their names and drops the lists', () => {
    render(<ShellSidebar models={models('org.overview')} level="organization" screens={screens} rail onToggleRail={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Inbox' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Organization' })).toBeTruthy();
    expect(document.querySelector('[data-level-tabs]')).toBeNull();
    expect(screen.getByTestId('pins-menu')).toBeTruthy();
    expect(screen.getByTestId('user-menu').getAttribute('data-variant')).toBe('rail');
    expect(screen.getByRole('button', { name: 'Expand the sidebar' })).toBeTruthy();
  });
});
