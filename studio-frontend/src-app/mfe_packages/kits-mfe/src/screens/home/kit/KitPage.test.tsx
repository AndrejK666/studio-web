import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { stubResizeObserver } from '@frontx-test-utils/stubResizeObserver';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogKit, KitContents, ScreenPreview } from '../../../api/KitsApiService';
import { levelMaps, modelGraph, type LevelMap as Level } from '../../../model/kitPage';
import { KitDetailView } from '../KitDetailView';
import { LevelMap } from './LevelMap';
import { ModelDiagram } from './ModelDiagram';
import { Permissions } from './PeopleAndAgents';

// The kit's DataGrid measures its table ("Show all routes", the list view).
stubResizeObserver();

/** The key with its parameters, so a test reads what a string would say. */
const t = ((key: string, params?: Record<string, unknown>) =>
  params ? `${key}(${Object.values(params).join('|')})` : key) as never;

const EMPTY: KitContents = {
  screens: [],
  types: [],
  rules: [],
  functions: [],
  services: [],
  inbox: [],
  mcp_tools: [],
  permissions: { reads: [], writes: [], listens: [] },
  material: [],
  kinds: [],
  docs: [],
};

const ACTIVITY: KitContents = {
  ...EMPTY,
  screens: [
    { kind: 'tab', level: 'project', label: 'Activity', route: '/projects/activity', slot: null },
    { kind: 'tab', level: 'project', label: 'Timeline', route: '/projects/timeline', slot: null },
  ],
};

const levels: Level[] = levelMaps({
  slug: 'project-activity',
  contents: ACTIVITY,
  shellTabs: [
    {
      level: 'project',
      route: '/projects/overview',
      label: 'Overview',
      icon: null,
      placement: 'main',
      order: 10,
      kit: null,
      modelTab: 'overview',
      entry: 'gts.x~constructor_studio.projects.mfe.main.v1',
    },
    {
      level: 'project',
      route: '/projects/activity',
      label: 'Activity',
      icon: null,
      placement: 'main',
      order: 20,
      kit: 'project-activity',
      modelTab: 'activity',
      entry: 'gts.x~constructor_studio.activity.mfe.main.v1',
    },
    {
      level: 'project',
      route: '/projects/timeline',
      label: 'Timeline',
      icon: null,
      placement: 'main',
      order: 30,
      kit: 'project-activity',
      modelTab: 'timeline',
      entry: 'gts.x~constructor_studio.activity.mfe.main.v1',
    },
  ],
  routes: null,
  modelTabs: null,
});

const picture = (route: string): ScreenPreview => ({
  component: '@constructor-studio/activity-mfe',
  version: '0.1.0',
  commit: 'abc1234',
  route,
  label: 'Activity',
  order: 0,
  image: 'data:image/webp;base64,AAAA',
  width: 640,
  height: 400,
  captured_at: '2026-11-01T00:00:00Z',
});

describe('LevelMap', () => {
  it("highlights the kit's tabs among the shell's, shows the first one's picture, and selects another", async () => {
    const loadPreviews = vi.fn(() => Promise.resolve([picture('/projects/activity')]));
    render(<LevelMap levels={levels} loadPreviews={loadPreviews} t={t} />);

    const bar = screen.getByRole('tablist');
    // The shell's tab is there, muted and not a tab one can select.
    const overview = within(bar).getByText('Overview');
    expect(overview.getAttribute('data-mine')).toBe('false');
    expect(overview.getAttribute('role')).toBeNull();
    const tabs = within(bar).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Activity', 'Timeline']);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');

    // The picture of the selected screen, with its label and route.
    const img = await screen.findByRole('img');
    expect(img.getAttribute('src')).toBe('data:image/webp;base64,AAAA');
    expect(screen.getByText('/projects/activity')).toBeTruthy();
    expect(loadPreviews).toHaveBeenCalledWith('@constructor-studio/activity-mfe');

    // The arrow key moves to the next kit tab and selects it; its screen has no picture.
    act(() => {
      fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
    });
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tabs[1]);
    const panel = screen.getByRole('tabpanel');
    expect(panel.querySelector('[data-preview="none"]')).toBeTruthy();
    expect(within(panel).getByText('/projects/timeline')).toBeTruthy();
    // One read per micro-frontend, however many of its tabs are picked.
    expect(loadPreviews).toHaveBeenCalledTimes(1);

    fireEvent.click(tabs[0]);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
  });

  it('says a screen has no picture, with its route, when the pictures cannot be read', async () => {
    render(<LevelMap levels={levels} loadPreviews={() => Promise.reject(new Error('404'))} t={t} />);
    await waitFor(() => expect(document.querySelector('[data-preview="none"]')).toBeTruthy());
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText('map_no_picture')).toBeTruthy();
    expect(within(panel).getByText('/projects/activity')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });
});

const LIFECYCLE: KitContents = {
  ...EMPTY,
  types: [
    {
      gts: 'g1',
      name: 'Phase',
      description: 'A phase of a project',
      id: 'project-lifecycle-phase',
      adopts: false,
      fields: [{ name: 'order', type: 'integer', description: null, required: true, origin: 'kit' }],
    },
    {
      gts: 'g2',
      name: 'Milestone',
      description: null,
      id: 'milestone',
      adopts: true,
      fields: [{ name: 'due', type: 'date', description: null, required: false, origin: 'core' }],
    },
  ],
  model: {
    fields: [{ on: 'project', name: 'phase', type: 'idea | build', description: null, required: false, origin: 'kit' }],
    relations: [{ on: 'milestone', name: 'tracks', target: 'project', label: 'tracks', verb: 'composes', origin: 'core' }],
    tabs: [],
  },
};

describe('ModelDiagram', () => {
  it('draws the types and labelled edges; selecting a type lists its fields with their origin', async () => {
    render(<ModelDiagram graph={modelGraph(LIFECYCLE, 'project-lifecycle')} t={t} />);
    expect(document.querySelector('[data-edge="milestone→project"]')?.textContent).toContain('tracks');
    // The first of the kit's types is selected to begin with; its fields are on the grid.
    expect(await screen.findByText('order *')).toBeTruthy();

    const milestone = screen.getByRole('button', { name: 'Milestone' });
    fireEvent.keyDown(milestone, { key: 'Enter' });
    expect(milestone.getAttribute('aria-pressed')).toBe('true');
    expect(await screen.findByText('due')).toBeTruthy();
    const fields = document.querySelector('[data-type-fields="milestone"]') as HTMLElement;
    expect(within(fields).getByText('field_origin_core')).toBeTruthy();
    expect(within(fields).getByText('model_adopts')).toBeTruthy();

    // A type of the model shows what the kit adds to it.
    fireEvent.click(screen.getByRole('button', { name: 'Project (model_core_type)' }));
    expect(await screen.findByText('phase')).toBeTruthy();
    const project = document.querySelector('[data-type-fields="project"]') as HTMLElement;
    expect(within(project).getByText('field_origin_added')).toBeTruthy();
  });

  it('offers the list view, which lists every type on the grid', async () => {
    render(<ModelDiagram graph={modelGraph(LIFECYCLE, 'project-lifecycle')} t={t} />);
    fireEvent.click(screen.getByRole('button', { name: 'model_view_list' }));
    expect(await screen.findByRole('button', { name: 'Milestone' })).toBeTruthy();
    expect(document.querySelector('[data-model-row="project"]')).toBeTruthy();
  });
});

describe('Permissions', () => {
  it('groups by gear with methods as chips and short paths; the full list is one click away', async () => {
    render(
      <Permissions
        permissions={{
          reads: ['GET /studio-documents/v1/spec-rows', 'GET /studio-artifact-ingest/v1/nodes'],
          writes: ['POST /studio-documents/v1/spec-rows', 'DELETE /studio-documents/v1/spec-rows'],
          listens: ['kit.installed'],
        }}
        t={t}
      />
    );
    const docs = document.querySelector('[data-gear="studio-documents"]') as HTMLElement;
    expect(within(docs).getByText('studio-documents')).toBeTruthy();
    // Read once, written with two methods: the path once per side, shortened after /studio-documents/v1.
    expect(within(docs).getAllByText('/spec-rows')).toHaveLength(2);
    expect(within(docs).getByText('POST')).toBeTruthy();
    expect(within(docs).getByText('DELETE')).toBeTruthy();
    expect(document.querySelector('[data-gear="studio-artifact-ingest"] [data-path="/nodes"]')).toBeTruthy();
    expect(screen.getByText('kit.installed')).toBeTruthy();

    const toggle = screen.getByRole('button', { name: 'perm_show_all(4)' });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(await screen.findByText('/studio-artifact-ingest/v1/nodes')).toBeTruthy();
  });
});

const KIT: CatalogKit = {
  slug: 'org-costs',
  name: 'Costs',
  description: 'What the organization spends',
  publisher: 'Constructor Fabric',
  visibility: 'public',
  source: 'builtin',
  repository_url: '',
  default_version: 'builtin',
  manifest_path: '',
  shelf: 'builtin',
  icon: 'lucide:coins',
};

describe('KitDetailView', () => {
  it('collapses the sections a kit has nothing for into one line, and says what installing adds', () => {
    render(
      <KitDetailView
        kit={KIT}
        detail={{
          kit: KIT,
          manifest: 'built-in',
          contents: {
            ...EMPTY,
            screens: [{ kind: 'tab', level: 'organization', label: 'Costs', route: '/costs', slot: null }],
            permissions: { reads: ['GET /studio-usage/v1/costs'], writes: [], listens: [] },
          },
        }}
        failed={false}
        controls={null}
        onBack={() => {}}
        t={t}
        status="not_installed"
      />
    );
    expect(document.querySelector('[data-kit-block="screens"]')).toBeTruthy();
    expect(document.querySelector('[data-kit-block="agents"]')).toBeTruthy();
    expect(document.querySelector('[data-kit-block="model"]')).toBeNull();
    expect(document.querySelector('[data-kit-block="more"]')).toBeNull();
    // One line for the rest, not an empty card each.
    expect(screen.getByText('none_line(none_model, none_handlers, none_services, none_agents, none_material none_or none_kinds)')).toBeTruthy();
    // The header says what installing changes.
    const changes = document.querySelector('[data-kit-changes]') as HTMLElement;
    expect(within(changes).getByText('changes_install')).toBeTruthy();
    expect(within(changes).getByText(/Costs/)).toBeTruthy();
  });
});
