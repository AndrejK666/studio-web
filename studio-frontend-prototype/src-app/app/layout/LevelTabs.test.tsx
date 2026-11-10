import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const SCREEN_DOMAIN = 'gts.frontx.mfes.ext.domain.v1~frontx.screensets.layout.screen.v1';

const people = {
  id: 'ext.people',
  domain: SCREEN_DOMAIN,
  entry: 'entry.people',
  presentation: {
    label: 'People',
    icon: 'lucide:users',
    route: '/people',
    order: 30,
    level: 'organization',
  },
};
const connections = {
  id: 'ext.connections',
  domain: SCREEN_DOMAIN,
  entry: 'entry.connections',
  presentation: {
    label: 'Connections',
    icon: 'lucide:plug',
    route: '/connections',
    order: 40,
    level: 'organization',
  },
};
const settings = {
  id: 'ext.organization',
  domain: SCREEN_DOMAIN,
  entry: 'entry.organization',
  presentation: {
    label: 'Settings',
    icon: 'lucide:settings',
    route: '/organization',
    order: 100,
    level: 'organization',
    placement: 'settings',
  },
};
const projects = {
  id: 'ext.projects',
  domain: SCREEN_DOMAIN,
  entry: 'entry.projects',
  presentation: {
    label: 'Projects',
    icon: 'lucide:folder',
    route: '/projects',
    order: 20,
    level: 'workspace',
  },
};
const overview = {
  id: 'ext.project.overview',
  domain: SCREEN_DOMAIN,
  entry: 'entry.projects',
  presentation: {
    label: 'Overview',
    icon: 'lucide:layout-dashboard',
    route: '/projects/overview',
    order: 10,
    level: 'project',
    section: 'overview',
  },
};
const artifacts = {
  id: 'ext.project.artifacts',
  domain: SCREEN_DOMAIN,
  entry: 'entry.projects',
  presentation: {
    label: 'Artifacts',
    icon: 'lucide:file-text',
    route: '/projects/artifacts',
    order: 20,
    level: 'project',
    section: 'artifacts',
  },
};
const editor = {
  id: 'ext.space',
  domain: SCREEN_DOMAIN,
  entry: 'entry.space',
  presentation: {
    label: 'Editor',
    icon: 'lucide:file-code',
    route: '/space',
    order: 900,
    level: 'project',
    placement: 'hidden',
    parentSection: 'artifacts',
  },
};

const { mockEventBus, mockRegistry, bootstrapState, registered, mounted, level, section } =
  vi.hoisted(() => ({
    mockEventBus: { emit: vi.fn() },
    mockRegistry: { executeActionsChain: vi.fn() },
    bootstrapState: { status: 'ready' as 'pending' | 'ready' | 'failed' },
    registered: { value: [] as unknown[] },
    mounted: { value: [] as unknown[] },
    level: { value: 'organization' as 'organization' | 'workspace' | 'project' },
    section: { value: null as string | null },
  }));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  useFrontX: () => ({ mfeRegistry: mockRegistry }),
  useAppSelector: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ 'app/mfe-bootstrap': bootstrapState, 'app/context': { section: section.value } }),
  useDomainExtensions: () => registered.value,
  eventBus: mockEventBus,
}));
const { installedKits } = vi.hoisted(() => ({
  installedKits: { value: null as ReadonlySet<string> | null },
}));
vi.mock('./useInstalledKits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./useInstalledKits')>()),
  useInstalledKits: () => installedKits.value,
}));
vi.mock('@/app/mfe/domainOccupancy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/mfe/domainOccupancy')>()),
  useMountedExtensions: () => mounted.value,
}));

vi.mock('@/app/i18n/shellTranslations', () => ({ useShellText: () => (key: string) => key }));
vi.mock('./useScreenLevel', () => ({ useScreenLevel: () => level.value }));

import { LevelTabs } from './LevelTabs';
import { setPreferenceStoreForTests, type PreferenceStore } from '@/app/preferences/uiPreferences';
import { resetPinsForTests } from '@/app/pins/usePins';
import { PINS_KEY } from '@/app/pins/pins';

/** The person's preferences, in memory: what the tabs read and write. */
function fakePreferences(initial: Record<string, string> = {}) {
  let prefs: Record<string, string> = { ...initial };
  const listeners = new Set<() => void>();
  const store: PreferenceStore = {
    get: () => prefs,
    set: vi.fn((key: string, value: string) => {
      const next = { ...prefs };
      if (value) next[key] = value;
      else delete next[key];
      prefs = next;
      for (const listener of listeners) listener();
    }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    load: () => Promise.resolve(),
  };
  return store;
}

/** The section tabs only, in the order drawn — not the row's Pin and Default order. */
const tabLabels = () =>
  Array.from(document.querySelectorAll('[data-tab]')).map((element) => element.textContent);


const tab = (name: string) => screen.getByRole('button', { name });

describe('LevelTabs (the level navigation)', () => {
  beforeEach(() => {
    setPreferenceStoreForTests(fakePreferences());
    localStorage.removeItem(PINS_KEY);
    resetPinsForTests();
    level.value = 'organization';
    section.value = null;
    bootstrapState.status = 'ready';
    // Deliberately out of order: the tabs sort, the registry does not.
    registered.value = [settings, connections, people, projects];
    mounted.value = [people];
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('lists the items of the level in scope, in order, settings last', () => {
    render(<LevelTabs />);
    expect(tabLabels()).toEqual(['People', 'Connections', 'Settings']);
  });

  it('leaves out the items of another level', () => {
    render(<LevelTabs />);
    expect(screen.queryByText('Projects')).toBeNull();
  });

  it('is a navigation landmark', () => {
    render(<LevelTabs />);
    expect(screen.getByRole('navigation', { name: 'level_tabs' })).toBeTruthy();
  });

  // The tabs name the screen and stop there: leaving the project scope and the
  // mount itself belong to the shell, and are covered in appContextEffects.
  it('names the chosen screen to the shell', () => {
    render(<LevelTabs />);
    fireEvent.click(tab('Connections'));
    expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/screen/requested', {
      extensionId: 'ext.connections',
    });
  });

  it('mounts nothing itself', () => {
    render(<LevelTabs />);
    fireEvent.click(tab('Connections'));
    expect(mockRegistry.executeActionsChain).not.toHaveBeenCalled();
  });

  it('marks the mounted screen as the current page', () => {
    render(<LevelTabs />);
    expect(tab('People').getAttribute('aria-current')).toBe('page');
    expect(tab('Connections').getAttribute('aria-current')).toBeNull();
  });

  it('draws the row at a level with a single tab', () => {
    level.value = 'workspace';
    mounted.value = [projects];
    render(<LevelTabs />);
    expect(tab('Projects').getAttribute('aria-current')).toBe('page');
  });

  describe('sections of one screen', () => {
    beforeEach(() => {
      level.value = 'project';
      registered.value = [overview, artifacts, editor, people];
      mounted.value = [overview];
      section.value = 'overview';
    });

    // Same event for a section as for any other item: telling them apart is
    // the shell's job, since only it knows what is mounted right now.
    it('names the section the same way as any other item', () => {
      render(<LevelTabs />);
      fireEvent.click(tab('Artifacts'));
      expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/screen/requested', {
        extensionId: 'ext.project.artifacts',
      });
    });

    it('does not decide by itself that the project is being left', () => {
      render(<LevelTabs />);
      fireEvent.click(tab('Artifacts'));
      expect(mockEventBus.emit).not.toHaveBeenCalledWith('app/context/project/closed');
    });

    it('marks the active tab by the section, since every item shares one entry', () => {
      section.value = 'artifacts';
      render(<LevelTabs />);
      expect(tab('Artifacts').getAttribute('aria-current')).toBe('page');
      expect(tab('Overview').getAttribute('aria-current')).toBeNull();
    });

    it('keeps a hidden screen out of the row', () => {
      render(<LevelTabs />);
      expect(screen.queryByText('Editor')).toBeNull();
    });

    it('marks the section a mounted hidden screen belongs to', () => {
      mounted.value = [editor];
      section.value = null;
      render(<LevelTabs />);
      expect(tab('Artifacts').getAttribute('aria-current')).toBe('page');
      expect(tab('Overview').getAttribute('aria-current')).toBeNull();
    });
  });

  it('holds a placeholder while the manifest is still in flight', () => {
    registered.value = [];
    bootstrapState.status = 'pending';
    const { container } = render(<LevelTabs />);
    // Unknown, not empty: an empty row would claim the level has no sections.
    expect(container.firstChild).not.toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('is absent once a failed bootstrap leaves no items', () => {
    registered.value = [];
    bootstrapState.status = 'failed';
    const { container } = render(<LevelTabs />);
    expect(container.firstChild).toBeNull();
  });
});

describe('LevelTabs: the order a person keeps (tab-order.ts, /me/ui-preferences)', () => {
  beforeEach(() => {
    localStorage.removeItem(PINS_KEY);
    resetPinsForTests();
    level.value = 'organization';
    section.value = null;
    bootstrapState.status = 'ready';
    registered.value = [settings, connections, people, projects];
    mounted.value = [people];
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    setPreferenceStoreForTests(null);
  });

  it('draws the tabs in the stored order of their level', () => {
    setPreferenceStoreForTests(fakePreferences({ 'organization.tabs.order': 'organization,connections' }));
    render(<LevelTabs />);
    // People was never stored: it keeps its default place, first, in front of the stored ones.
    expect(tabLabels()).toEqual(['People', 'Settings', 'Connections']);
  });

  it('reads the order of another level as nothing', () => {
    setPreferenceStoreForTests(fakePreferences({ 'project.tabs.order': 'connections' }));
    render(<LevelTabs />);
    expect(tabLabels()).toEqual(['People', 'Connections', 'Settings']);
  });

  it('moves a focused tab with Alt+Shift+arrow, and stores the order', () => {
    const store = fakePreferences();
    setPreferenceStoreForTests(store);
    render(<LevelTabs />);
    fireEvent.keyDown(tab('Connections'), { key: 'ArrowLeft', altKey: true, shiftKey: true });
    expect(store.set).toHaveBeenCalledWith('organization.tabs.order', 'connections,people,organization');
    expect(tabLabels()).toEqual(['Connections', 'People', 'Settings']);
  });

  it('ignores a plain arrow, and a move past the end', () => {
    const store = fakePreferences();
    setPreferenceStoreForTests(store);
    render(<LevelTabs />);
    fireEvent.keyDown(tab('Connections'), { key: 'ArrowLeft' });
    fireEvent.keyDown(tab('People'), { key: 'ArrowLeft', altKey: true, shiftKey: true });
    expect(store.set).not.toHaveBeenCalled();
  });

  it('stores nothing for the default order', () => {
    const store = fakePreferences({ 'organization.tabs.order': 'connections,people,organization' });
    setPreferenceStoreForTests(store);
    render(<LevelTabs />);
    fireEvent.keyDown(tab('Connections'), { key: 'ArrowRight', altKey: true, shiftKey: true });
    expect(store.set).toHaveBeenCalledWith('organization.tabs.order', '');
  });

  it('offers the default order back only while another one is kept', () => {
    const store = fakePreferences({ 'organization.tabs.order': 'connections,people' });
    setPreferenceStoreForTests(store);
    render(<LevelTabs />);
    fireEvent.click(screen.getByRole('button', { name: 'level_tabs_default_order' }));
    expect(store.set).toHaveBeenCalledWith('organization.tabs.order', '');
    expect(screen.queryByRole('button', { name: 'level_tabs_default_order' })).toBeNull();
  });

  it('moves a dragged tab to where it is dropped', () => {
    const store = fakePreferences();
    setPreferenceStoreForTests(store);
    render(<LevelTabs />);
    const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(tab('Settings'), { dataTransfer });
    // jsdom lays nothing out: every box is 0 wide at 0, so a pointer left of 0 lands in front.
    fireEvent.dragOver(tab('People'), { dataTransfer, clientX: -1 });
    fireEvent.drop(tab('People'), { dataTransfer, clientX: -1 });
    expect(store.set).toHaveBeenCalledWith('organization.tabs.order', 'organization,people,connections');
  });
});

describe('LevelTabs: Pin (pins.ts)', () => {
  beforeEach(() => {
    setPreferenceStoreForTests(fakePreferences());
    localStorage.removeItem(PINS_KEY);
    resetPinsForTests();
    level.value = 'organization';
    section.value = null;
    bootstrapState.status = 'ready';
    registered.value = [settings, connections, people, projects];
    mounted.value = [people];
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    setPreferenceStoreForTests(null);
  });

  it('pins the section on screen, and unpins it again', () => {
    render(<LevelTabs />);
    const button = () => document.querySelector('[data-pin-toggle]') as HTMLElement;
    expect(button().getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button());
    expect(button().getAttribute('aria-pressed')).toBe('true');
    expect(JSON.parse(localStorage.getItem(PINS_KEY)!)).toEqual([
      { route: { token: 'people' }, label: 'People', where: [] },
    ]);
    fireEvent.click(button());
    expect(JSON.parse(localStorage.getItem(PINS_KEY)!)).toEqual([]);
  });

  it('offers no pin while no tab is on screen', () => {
    mounted.value = [];
    render(<LevelTabs />);
    expect(document.querySelector('[data-pin-toggle]')).toBeNull();
  });
});

describe('LevelTabs and kits (ADR-0069 §4)', () => {
  it('shows a kit\'s tab only where the kit is installed, and while that is unknown', async () => {
    const { screenShows } = await import('./useInstalledKits');
    const kitTab = { id: 'tests', presentation: { label: 'Tests', route: '/tests', level: 'project', kit: 'project-tests' } };
    const shellTab = { id: 'specs', presentation: { label: 'Specs', route: '/projects/specs', level: 'project' } };
    expect(screenShows(kitTab as never, null)).toBe(true);
    expect(screenShows(kitTab as never, new Set(['project-tests']))).toBe(true);
    expect(screenShows(kitTab as never, new Set())).toBe(false);
    expect(screenShows(shellTab as never, new Set())).toBe(true);
  });
});
