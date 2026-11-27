import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

interface TestContext {
  org: { id: string; name: string; count?: number } | null;
  orgs: { id: string; name: string; count?: number }[];
  workspace: { id: string; name: string; count?: number } | null;
  workspaces: { id: string; name: string; count?: number }[];
  workspacesStatus: 'pending' | 'ready' | 'failed';
  project: { id: string; name: string } | null;
  projects: { id: string; name: string }[];
  loading: boolean;
}

const { mockEventBus, context, level, screens, children } = vi.hoisted(() => ({
  children: {
    workspaces: {} as Record<string, { items: { id: string; name: string; count?: number }[]; loading: boolean; failed: boolean }>,
    projects: {} as Record<string, { items: { id: string; name: string }[]; loading: boolean; failed: boolean }>,
    asked: [] as string[],
    tab: undefined as { kit?: string } | undefined,
    kits: null as Set<string> | null,
  },
  screens: [] as Array<{ id: string; presentation: { label: string; route: string; level?: string } }>,
  mockEventBus: { emit: vi.fn() },
  level: { value: 'organization' as 'organization' | 'workspace' | 'project' },
  context: { value: {} as TestContext },
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  useAppSelector: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ 'app/context': context.value }),
  eventBus: mockEventBus,
  useDomainExtensions: () => screens,
}));

vi.mock('@/app/i18n/shellTranslations', () => import('@frontx-test-utils/shellText'));

vi.mock('./useScreenLevel', () => ({ useScreenLevel: () => level.value }));

// The lists are read lazily: `asked` records each one a submenu asked for.
// `openPlace` keeps its rule (a kit the place lacks is not kept) over a stub of the installer.
vi.mock('./chainChildren', () => {
  const none = { items: [], loading: false, failed: false };
  return {
    useWorkspacesOf: (orgId: string) => {
      children.asked.push(`workspaces:${orgId}`);
      return children.workspaces[orgId] ?? none;
    },
    useProjectsOf: (workspaceId: string) => {
      children.asked.push(`projects:${workspaceId}`);
      return children.projects[workspaceId] ?? none;
    },
    useTabOnScreen: () => children.tab,
    openPlace: async (place: Record<string, unknown>, keep: boolean, tab: { kit?: string } | undefined) => {
      const kept = keep && (!tab?.kit || !children.kits || children.kits.has(tab.kit));
      mockEventBus.emit('app/context/place/requested', kept ? { ...place, keep: true } : place);
    },
  };
});

import { ContextChain } from './ContextChain';
import { createLogoStore, setLogoStoreForTests } from './orgLogo';
import { stubResizeObserver } from '@frontx-test-utils/stubResizeObserver';

// cmdk scrolls the highlighted row into view and measures its list; jsdom has
// no layout for either.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  stubResizeObserver();
});

describe('ContextChain (the path in the top bar)', () => {
  beforeEach(() => {
    level.value = 'organization';
    context.value = {
      org: { id: 'org-1', name: 'Acme Corporation', count: 3 },
      orgs: [
        { id: 'org-1', name: 'Acme Corporation', count: 3 },
        { id: 'org-2', name: 'Constructor Labs', count: 2 },
      ],
      workspace: { id: 'ws-1', name: 'Platform Workspace', count: 8 },
      workspaces: [
        { id: 'ws-1', name: 'Platform Workspace', count: 8 },
        { id: 'ws-2', name: 'Product Knowledge', count: 5 },
      ],
      workspacesStatus: 'ready',
      project: { id: 'p-1', name: 'Agent Platform' },
      projects: [
        { id: 'p-1', name: 'Agent Platform' },
        { id: 'p-2', name: 'Developer Portal' },
      ],
      loading: false,
    };
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    children.workspaces = {};
    children.projects = {};
    children.asked = [];
    children.tab = undefined;
    children.kits = null;
  });

  describe("the organization's logo (the prototype's OrgMark)", () => {
    afterEach(() => setLogoStoreForTests(null));

    it('shows the logo in the organization slot, and the glyph for one without', async () => {
      setLogoStoreForTests(
        createLogoStore((orgId) =>
          orgId === 'org-1'
            ? Promise.resolve({ content_type: 'image/png', data: 'AAAA' })
            : Promise.reject(new Error('404'))
        )
      );
      render(<ContextChain />);
      const slot = screen.getByRole('button', { name: 'Organization: Acme Corporation' });
      await vi.waitFor(() =>
        expect(slot.querySelector('[data-org-logo="org-1"]')?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
      );
    });
  });

  describe('slots per level', () => {
    it('shows a skeleton in a slot whose name the shell has not resolved yet', () => {
      level.value = 'project';
      context.value.project = { id: 'p-9', name: '' };
      context.value.projects = [];
      render(<ContextChain />);
      expect(screen.getByTestId('context-slot-pending')).toBeTruthy();
      expect(screen.queryByText('p-9')).toBeNull();
      // Reviewer finding (vasylcf): the accessible name must not trail off into nothing.
      expect(screen.getByLabelText('Project: …')).toBeTruthy();
    });

    // The organization is named and switched in its header, not in the path.
    it('names the organization first at every level, under its level caption (ADR-0069)', () => {
      for (const value of ['organization', 'workspace', 'project'] as const) {
        level.value = value;
        render(<ContextChain />);
        expect(screen.getByRole('button', { name: 'Organization: Acme Corporation' })).toBeTruthy();
        cleanup();
      }
    });

    it('starts the path at the platform once a platform screen is registered', () => {
      screens.push({ id: 'kits', presentation: { label: 'Kits', route: '/kits', level: 'platform' } });
      render(<ContextChain />);
      fireEvent.click(screen.getByRole('button', { name: 'Platform' }));
      expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/level/requested', { level: 'platform' });
      screens.length = 0;
    });

    it('keeps only the platform and the organization on the platform level', () => {
      screens.push({ id: 'kits', presentation: { label: 'Kits', route: '/kits', level: 'platform' } });
      level.value = 'platform' as never;
      render(<ContextChain />);
      expect(screen.getByRole('button', { name: 'Platform' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Organization: Acme Corporation' })).toBeTruthy();
      expect(screen.queryByText('All workspaces')).toBeNull();
      screens.length = 0;
    });

    it('holds the workspace slot alone at the organization level, naming none', () => {
      render(<ContextChain />);
      expect(screen.getByText('All workspaces')).toBeTruthy();
      expect(screen.queryByText('Platform Workspace')).toBeNull();
      expect(screen.queryByText('Agent Platform')).toBeNull();
    });

    it('holds a placeholder at the organization level while the workspaces are unread', () => {
      context.value.workspaces = [];
      context.value.workspacesStatus = 'pending';
      render(<ContextChain />);
      expect(screen.getByTestId('context-slot-pending')).toBeTruthy();
    });

    it('opens no empty menu from the placeholder', () => {
      context.value.workspaces = [];
      context.value.workspacesStatus = 'pending';
      render(<ContextChain />);
      fireEvent.click(screen.getByRole('button', { name: 'Workspace: …' }));
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('draws no workspace slot for an organization that has no workspace', () => {
      context.value.workspaces = [];
      render(<ContextChain />);
      expect(screen.queryByText('All workspaces')).toBeNull();
      expect(screen.getByRole('button', { name: 'Organization: Acme Corporation' })).toBeTruthy();
    });

    it('keeps the project out of the path until one is open', () => {
      level.value = 'workspace';
      render(<ContextChain />);
      expect(screen.getByText('Platform Workspace')).toBeTruthy();
      expect(screen.queryByText('Agent Platform')).toBeNull();
    });

    it('shows the workspace and the project at the project level', () => {
      level.value = 'project';
      render(<ContextChain />);
      expect(screen.getByText('Platform Workspace')).toBeTruthy();
      expect(screen.getByText('Agent Platform')).toBeTruthy();
    });

    it('skips a level nothing is selected at', () => {
      level.value = 'project';
      context.value.project = null;
      render(<ContextChain />);
      expect(screen.getByText('Platform Workspace')).toBeTruthy();
      expect(screen.queryByText('Agent Platform')).toBeNull();
    });

    it('draws no path below the organization while no workspace is selected', () => {
      level.value = 'workspace';
      context.value.workspace = null;
      render(<ContextChain />);
      expect(screen.getAllByRole('button')).toHaveLength(1);
    });

    it('renders nothing at all before an organization resolves', () => {
      context.value.org = null;
      const { container } = render(<ContextChain />);
      expect(container.firstChild).toBeNull();
    });
  });

  describe('switching', () => {
    // One announcement carries the workspace and the level it asks for.
    it('enters the workspace picked at the organization level', async () => {
      render(<ContextChain />);
      fireEvent.click(screen.getByText('All workspaces'));
      fireEvent.click(await screen.findByText('Product Knowledge'));
      await vi.waitFor(() =>
        expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/place/requested', {
          organizationId: 'org-1',
          workspaceId: 'ws-2',
        })
      );
      expect(mockEventBus.emit).not.toHaveBeenCalledWith(
        'app/context/level/requested',
        expect.anything()
      );
    });

    it('opens a workspace picked in its own slot on the workspace tab on screen', async () => {
      level.value = 'workspace';
      render(<ContextChain />);
      fireEvent.click(screen.getByText('Platform Workspace'));
      fireEvent.click(await screen.findByText('Product Knowledge'));
      await vi.waitFor(() =>
        expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/place/requested', {
          organizationId: 'org-1',
          workspaceId: 'ws-2',
          keep: true,
        })
      );
    });

    it('marks the slot of the level in scope as the current page', () => {
      level.value = 'project';
      render(<ContextChain />);
      expect(screen.getByText('Agent Platform').closest('button')?.getAttribute('aria-current')).toBe(
        'page'
      );
      expect(
        screen.getByText('Platform Workspace').closest('button')?.getAttribute('aria-current')
      ).toBeNull();
    });

    it('enters the level of the slot that was picked in, on its entry tab', async () => {
      level.value = 'project';
      render(<ContextChain />);
      fireEvent.click(screen.getByText('Platform Workspace'));
      fireEvent.click(await screen.findByText('Product Knowledge'));
      await vi.waitFor(() =>
        expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/place/requested', {
          organizationId: 'org-1',
          workspaceId: 'ws-2',
        })
      );
    });

    it('stays put when the pick is a sibling of the level in scope', async () => {
      level.value = 'project';
      render(<ContextChain />);
      fireEvent.click(screen.getByText('Agent Platform'));
      fireEvent.click(await screen.findByText('Developer Portal'));
      await vi.waitFor(() =>
        expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/place/requested', {
          organizationId: 'org-1',
          workspaceId: 'ws-1',
          projectId: 'p-2',
          keep: true,
        })
      );
      expect(mockEventBus.emit).not.toHaveBeenCalledWith(
        'app/context/level/requested',
        expect.anything()
      );
    });
  });

  describe('the level above', () => {
    it('leads from the workspace slot to the organization', async () => {
      level.value = 'project';
      render(<ContextChain />);
      fireEvent.click(screen.getByText('Platform Workspace'));
      fireEvent.click(await screen.findByText('All workspaces'));
      expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/level/requested', {
        level: 'organization',
      });
    });

    it('leads from the project slot to the workspace', async () => {
      level.value = 'project';
      render(<ContextChain />);
      fireEvent.click(screen.getByText('Agent Platform'));
      fireEvent.click(await screen.findByText('Projects in Platform Workspace'));
      expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/level/requested', {
        level: 'workspace',
      });
    });
  });

  describe('the project search', () => {
    it('filters the projects by name', async () => {
      level.value = 'project';
      render(<ContextChain />);
      fireEvent.click(screen.getByText('Agent Platform'));
      fireEvent.change(await screen.findByPlaceholderText('Search projects…'), {
        target: { value: 'portal' },
      });
      expect(await screen.findByText('Developer Portal')).toBeTruthy();
      expect(screen.queryAllByText('Agent Platform')).toHaveLength(1);
    });

    it('opens on the search field', async () => {
      level.value = 'project';
      render(<ContextChain />);
      fireEvent.click(screen.getByText('Agent Platform'));
      const search = await screen.findByRole('searchbox', { name: 'Search projects…' });
      await vi.waitFor(() => expect(document.activeElement).toBe(search));
    });

    it('announces nothing when the open project is picked, and closes', async () => {
      level.value = 'project';
      render(<ContextChain />);
      fireEvent.click(screen.getByText('Agent Platform'));
      fireEvent.click(await screen.findByRole('option', { name: 'Agent Platform' }));
      expect(mockEventBus.emit).not.toHaveBeenCalledWith(
        'app/context/place/requested',
        expect.anything()
      );
      await vi.waitFor(() => expect(screen.queryByRole('searchbox')).toBeNull());
    });

    it('opens again with an empty search', async () => {
      level.value = 'project';
      render(<ContextChain />);
      fireEvent.click(screen.getByText('Agent Platform'));
      fireEvent.change(await screen.findByRole('searchbox'), { target: { value: 'portal' } });
      fireEvent.click(await screen.findByRole('option', { name: 'Developer Portal' }));
      await vi.waitFor(() => expect(screen.queryByRole('searchbox')).toBeNull());
      fireEvent.click(screen.getByText('Agent Platform'));
      expect((await screen.findByRole('searchbox') as HTMLInputElement).value).toBe('');
    });

    it('opens the first project found on Enter', async () => {
      level.value = 'project';
      render(<ContextChain />);
      fireEvent.click(screen.getByText('Agent Platform'));
      const search = await screen.findByRole('searchbox', { name: 'Search projects…' });
      fireEvent.change(search, { target: { value: 'portal' } });
      await screen.findByText('Developer Portal');
      fireEvent.keyDown(search, { key: 'Enter' });
      await vi.waitFor(() =>
        expect(mockEventBus.emit).toHaveBeenCalledWith(
          'app/context/place/requested',
          expect.objectContaining({ projectId: 'p-2' })
        )
      );
    });
  });

  // The design's menus name each workspace and nothing else; counts live in the
  // organization switch and on the Workspaces screen.
  describe('the menus', () => {
    it('lists the workspaces without counting their projects', async () => {
      level.value = 'workspace';
      render(<ContextChain />);
      fireEvent.click(screen.getByText('Platform Workspace'));
      expect(await screen.findByText('Product Knowledge')).toBeTruthy();
      expect(screen.queryByText(/projects?$/)).toBeNull();
    });

    it('says nothing under a project, whose artifacts nobody has counted', async () => {
      level.value = 'project';
      render(<ContextChain />);
      fireEvent.click(screen.getByText('Agent Platform'));
      expect(await screen.findByText('Developer Portal')).toBeTruthy();
      expect(screen.queryByText(/artifact/)).toBeNull();
    });
  });

  // The menus go straight into the levels below: an organization's
  // workspaces and their projects, a workspace's projects — each read only
  // when its submenu opens — and a project picked there opens on the tab on screen.
  describe('the nested menus', () => {
    const rowOf = async (name: string) => (await screen.findByText(name)).closest('[role="menuitem"]') as HTMLElement;

    const openSubmenu = async (name: string) => {
      const row = await rowOf(name);
      row.focus();
      fireEvent.keyDown(row, { key: 'ArrowRight' });
      return row;
    };

    beforeEach(() => {
      children.projects['ws-2'] = {
        items: [
          { id: 'p-7', name: 'Knowledge Graph' },
          { id: 'p-8', name: 'Search Service' },
        ],
        loading: false,
        failed: false,
      };
      children.workspaces['org-2'] = {
        items: [{ id: 'ws-9', name: 'Labs Workspace' }],
        loading: false,
        failed: false,
      };
      children.projects['ws-9'] = { items: [{ id: 'p-9', name: 'Lab Project' }], loading: false, failed: false };
    });

    it("reads a workspace's projects only once its submenu opens, and lists them", async () => {
      level.value = 'workspace';
      render(<ContextChain />);
      fireEvent.click(screen.getByText('Platform Workspace'));
      await rowOf('Product Knowledge');
      expect(children.asked).toEqual([]);
      await openSubmenu('Product Knowledge');
      expect(await screen.findByText('Knowledge Graph')).toBeTruthy();
      expect(screen.getByText('Search Service')).toBeTruthy();
      expect(children.asked).toContain('projects:ws-2');
      expect(children.asked).not.toContain('projects:ws-1');
    });

    it('opens a project picked in a submenu on the project tab on screen', async () => {
      level.value = 'project';
      children.tab = { kit: 'tests' };
      children.kits = new Set(['tests']);
      render(<ContextChain />);
      fireEvent.click(screen.getByText('Platform Workspace'));
      await openSubmenu('Product Knowledge');
      fireEvent.click(await screen.findByText('Search Service'));
      await vi.waitFor(() =>
        expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/place/requested', {
          organizationId: 'org-1',
          workspaceId: 'ws-2',
          projectId: 'p-8',
          keep: true,
        })
      );
    });

    it("opens the project's own first tab when it lacks the kit of the tab on screen", async () => {
      level.value = 'project';
      children.tab = { kit: 'tests' };
      children.kits = new Set(['other']);
      render(<ContextChain />);
      fireEvent.click(screen.getByText('Platform Workspace'));
      await openSubmenu('Product Knowledge');
      fireEvent.click(await screen.findByText('Search Service'));
      await vi.waitFor(() =>
        expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/place/requested', {
          organizationId: 'org-1',
          workspaceId: 'ws-2',
          projectId: 'p-8',
        })
      );
    });

    it('goes from the organization menu through another organization and its workspace to a project', async () => {
      level.value = 'workspace';
      render(<ContextChain />);
      fireEvent.click(screen.getByRole('button', { name: 'Organization: Acme Corporation' }));
      await openSubmenu('Constructor Labs');
      expect(children.asked).toContain('workspaces:org-2');
      await openSubmenu('Labs Workspace');
      fireEvent.click(await screen.findByText('Lab Project'));
      await vi.waitFor(() =>
        expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/place/requested', {
          organizationId: 'org-2',
          workspaceId: 'ws-9',
          projectId: 'p-9',
        })
      );
    });

    it('opens a workspace picked under another organization on the workspace tab on screen', async () => {
      level.value = 'workspace';
      render(<ContextChain />);
      fireEvent.click(screen.getByRole('button', { name: 'Organization: Acme Corporation' }));
      await openSubmenu('Constructor Labs');
      fireEvent.click(await rowOf('Labs Workspace'));
      await vi.waitFor(() =>
        expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/place/requested', {
          organizationId: 'org-2',
          workspaceId: 'ws-9',
          keep: true,
        })
      );
    });

    it('still goes to a row with a submenu on a click', async () => {
      level.value = 'workspace';
      render(<ContextChain />);
      fireEvent.click(screen.getByRole('button', { name: 'Organization: Acme Corporation' }));
      fireEvent.click(await rowOf('Constructor Labs'));
      expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/org/changed', { orgId: 'org-2' });
    });

    it('says the list is being read, and that a workspace has no projects', async () => {
      level.value = 'workspace';
      children.projects['ws-2'] = { items: [], loading: true, failed: false };
      render(<ContextChain />);
      fireEvent.click(screen.getByText('Platform Workspace'));
      await openSubmenu('Product Knowledge');
      expect(await screen.findByText('Loading…')).toBeTruthy();
      cleanup();
      children.projects['ws-2'] = { items: [], loading: false, failed: false };
      render(<ContextChain />);
      fireEvent.click(screen.getByText('Platform Workspace'));
      await openSubmenu('Product Knowledge');
      expect(await screen.findByText('No projects')).toBeTruthy();
    });

    it('draws no submenu for a workspace known to have no projects', async () => {
      level.value = 'workspace';
      context.value.workspaces[1] = { id: 'ws-2', name: 'Product Knowledge', count: 0 };
      render(<ContextChain />);
      fireEvent.click(screen.getByText('Platform Workspace'));
      const row = await rowOf('Product Knowledge');
      expect(row.getAttribute('aria-haspopup')).toBeNull();
      const own = within(screen.getByRole('menu')).getByText('Platform Workspace').closest('[role="menuitem"]');
      expect(own?.getAttribute('aria-haspopup')).toBe('menu');
    });

    it('closes a submenu on ArrowLeft', async () => {
      level.value = 'workspace';
      render(<ContextChain />);
      fireEvent.click(screen.getByText('Platform Workspace'));
      await openSubmenu('Product Knowledge');
      const child = await screen.findByText('Knowledge Graph');
      fireEvent.keyDown(child.closest('[role="menuitem"]') as HTMLElement, { key: 'ArrowLeft' });
      await vi.waitFor(() => expect(screen.queryByText('Knowledge Graph')).toBeNull());
    });
  });
});
