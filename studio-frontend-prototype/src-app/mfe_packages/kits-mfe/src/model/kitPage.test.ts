import { describe, expect, it } from 'vitest';
import type { ShellTab } from '@constructor-studio/mfe-shared';
import type { KitContents, ScreenPreview } from '../api/KitsApiService';
import {
  componentOfEntry,
  emptySections,
  groupPermissions,
  installChanges,
  layoutDiagram,
  levelMaps,
  modelGraph,
  parseRoute,
  pictureFor,
  DIAGRAM_CAP,
} from './kitPage';

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

const tab = (route: string, more: Partial<ShellTab> = {}): ShellTab => ({
  level: 'project',
  route,
  label: route.split('/').pop() ?? route,
  icon: null,
  placement: 'main',
  order: 10,
  kit: null,
  modelTab: route.split('/').pop() ?? route,
  entry: 'gts.x~constructor_studio.projects.mfe.main.v1',
  ...more,
});

const SHELL: ShellTab[] = [
  tab('/projects/overview', { label: 'Overview', order: 10 }),
  tab('/issues', {
    label: 'Issues',
    order: 30,
    kit: 'project-issues',
    entry: 'gts.x~constructor_studio.issues.mfe.main.v1',
  }),
  tab('/releases', { label: 'Releases', order: 40, kit: 'product-releases' }),
  tab('/projects/settings', { label: 'Settings', placement: 'settings', order: 1 }),
  tab('/organization/overview', { level: 'organization', label: 'Overview' }),
];

const ISSUES: KitContents = {
  ...EMPTY,
  screens: [{ kind: 'tab', level: 'project', label: 'Issues', route: '/issues', slot: null }],
  model: { fields: [], relations: [], tabs: [{ level: 'project', name: 'issues', label: 'Issues', target: 'finding' }] },
};

describe('levelMaps', () => {
  it("draws a level's bar with the kit's tab highlighted among the shell's, in the shell's order", () => {
    const [project, ...rest] = levelMaps({
      slug: 'project-issues',
      contents: ISSUES,
      shellTabs: SHELL,
      routes: ['/projects/overview', '/issues', '/projects/settings'],
      modelTabs: null,
    });
    expect(rest).toEqual([]);
    expect(project.level).toBe('project');
    // Another kit's tab that does not show here is left off; settings stay last.
    expect(project.tabs.map((t) => [t.label, t.mine])).toEqual([
      ['Overview', false],
      ['Issues', true],
      ['Settings', false],
    ]);
    const issues = project.tabs[1];
    expect(issues.component).toBe('@constructor-studio/issues-mfe');
    expect(issues.route).toBe('/issues');
  });

  it("keeps the kit's tab before it is installed, and adds what the shell has not registered", () => {
    const [project] = levelMaps({
      slug: 'product-releases',
      contents: {
        ...EMPTY,
        screens: [
          { kind: 'tab', level: 'project', label: 'Releases', route: '/releases', slot: null },
          { kind: 'tab', level: 'project', label: 'Roadmap', route: null, slot: null },
          { kind: 'section', level: 'project', label: 'Release notes', route: null, slot: 'overview' },
        ],
      },
      shellTabs: SHELL,
      routes: ['/projects/overview'],
      modelTabs: null,
    });
    expect(project.tabs.filter((t) => t.mine).map((t) => [t.label, t.source])).toEqual([
      ['Releases', 'screen'],
      ['Roadmap', 'manifest'],
    ]);
    expect(project.sections.map((s) => s.label)).toEqual(['Release notes']);
  });

  it("adds the model's tabs no screen answers, the kit's own highlighted", () => {
    const [project] = levelMaps({
      slug: 'project-lifecycle',
      contents: {
        ...EMPTY,
        model: {
          fields: [],
          relations: [],
          tabs: [{ level: 'project', name: 'phases', label: 'Phases', target: 'project-lifecycle-phase' }],
        },
      },
      shellTabs: SHELL,
      routes: null,
      modelTabs: { project: [{ name: 'risks', label: 'Risks', target: 'risk' }] },
    });
    expect(project.tabs.map((t) => [t.label, t.mine, t.source])).toEqual([
      ['Overview', false, 'screen'],
      ['Issues', false, 'screen'],
      ['Releases', false, 'screen'],
      ['Risks', false, 'model'],
      ['Phases', true, 'model'],
      ['Settings', false, 'screen'],
    ]);
  });

  it("without the shell's tabs, still shows the kit's", () => {
    const [project] = levelMaps({ slug: 'project-issues', contents: ISSUES, shellTabs: null, routes: null, modelTabs: null });
    expect(project.tabs.map((t) => [t.label, t.mine])).toEqual([['Issues', true]]);
  });
});

describe('componentOfEntry', () => {
  it("names the micro-frontend an entry belongs to, and none outside Studio's namespace", () => {
    expect(componentOfEntry('gts.frontx.mfes.mfe.entry.v1~frontx.mfes.mfe.entry_mf.v1~constructor_studio.project_templates.mfe.main.v1')).toBe(
      '@constructor-studio/project-templates-mfe'
    );
    expect(componentOfEntry('gts.x~acme.runbooks.mfe.main.v1')).toBeNull();
    expect(componentOfEntry(null)).toBeNull();
  });
});

describe('pictureFor', () => {
  const shot = (route: string, commit: string, label: string | null = null): ScreenPreview => ({
    component: 'c',
    version: null,
    commit,
    route,
    label,
    order: 0,
    image: 'data:image/webp;base64,AAAA',
    width: 10,
    height: 10,
    captured_at: '2026-11-01T00:00:00Z',
  });

  it('takes the newest build only, by route then by label', () => {
    const items = [shot('/tests', 'new'), shot('/issues', 'old'), shot('/x', 'new', 'Issues')];
    expect(pictureFor(items, { route: '/tests', label: 'Tests' })?.commit).toBe('new');
    expect(pictureFor(items, { route: '/issues', label: 'Issues' })?.route).toBe('/x');
    expect(pictureFor(items, { route: '/nothing', label: 'Nothing' })).toBeNull();
    expect(pictureFor([], { route: '/tests', label: 'Tests' })).toBeNull();
  });
});

describe('groupPermissions', () => {
  it('groups by gear and by read or write, a path once with its methods, shortened after the gear prefix', () => {
    const gears = groupPermissions({
      reads: [
        'GET /studio-documents/v1/project-domain-model',
        'GET /studio-documents/v1/project-domain-model/issues',
        'POST /studio-spec-mapping/v1/conformance',
        'gts.cf.studio.domain.project.v1~',
      ],
      writes: [
        'POST /studio-documents/v1/project-domain-model/issues',
        'PUT /studio-documents/v1/project-domain-model/issues',
      ],
      listens: ['kit.installed'],
    });
    expect(gears.map((g) => g.gear)).toEqual(['studio-documents', 'studio-spec-mapping', '']);
    expect(gears[0].reads).toEqual([
      { path: '/project-domain-model', methods: ['GET'] },
      { path: '/project-domain-model/issues', methods: ['GET'] },
    ]);
    expect(gears[0].writes).toEqual([{ path: '/project-domain-model/issues', methods: ['POST', 'PUT'] }]);
    expect(gears[2].reads).toEqual([{ path: 'gts.cf.studio.domain.project.v1~', methods: [] }]);
  });

  it('reads a route with no version and refuses what is not one', () => {
    expect(parseRoute('GET /health')).toEqual({ method: 'GET', gear: 'health', path: '/' });
    expect(parseRoute('studio-artifact-ingest runs')).toBeNull();
  });
});

describe('emptySections', () => {
  it('lists every section the kit has nothing for, in the page order', () => {
    expect(emptySections(EMPTY)).toEqual([
      'screens',
      'model',
      'handlers',
      'services',
      'agents',
      'permissions',
      'material',
      'kinds',
    ]);
    expect(
      emptySections({ ...ISSUES, mcp_tools: [{ name: 'x', description: null }], kinds: ['PRD'] })
    ).toEqual(['model', 'handlers', 'services', 'permissions', 'material']);
  });
});

const LIFECYCLE: KitContents = {
  ...EMPTY,
  types: [
    {
      gts: 'gts.cf.studio.kit.project_lifecycle.phase.v1~',
      name: 'Phase',
      description: null,
      id: 'project-lifecycle-phase',
      adopts: false,
      fields: [{ name: 'order', type: 'integer', description: null, required: false, origin: 'kit' }],
    },
    {
      gts: 'gts.cf.studio.domain.milestone.v1~',
      name: 'Milestone',
      description: null,
      id: 'milestone',
      adopts: true,
      fields: [],
    },
  ],
  model: {
    fields: [{ on: 'project', name: 'phase', type: 'idea | build', description: null, required: false, origin: 'kit' }],
    relations: [
      { on: 'milestone', name: 'tracks', target: 'project', label: 'tracks', verb: 'composes', origin: 'core' },
      { on: 'milestone', name: 'tracks_2', target: 'work-item', label: 'tracks', verb: 'composes', origin: 'core' },
    ],
    tabs: [{ level: 'project', name: 'phases', label: 'Phases', target: 'project-lifecycle-phase' }],
  },
};

describe('modelGraph', () => {
  it("draws the kit's types, the types they relate to, and labelled edges", () => {
    const graph = modelGraph(LIFECYCLE, 'project-lifecycle');
    expect(graph.nodes.map((n) => [n.id, n.kit])).toEqual([
      ['project-lifecycle-phase', true],
      ['milestone', true],
      ['project', false],
      ['work-item', false],
    ]);
    expect(graph.nodes.find((n) => n.id === 'project')?.fields.map((f) => f.name)).toEqual(['phase']);
    expect(graph.edges).toEqual([
      { from: 'milestone', to: 'project', labels: ['tracks'] },
      { from: 'milestone', to: 'work-item', labels: ['tracks'] },
    ]);
  });

  it('caps the diagram and says how many it left out', () => {
    const many: KitContents = {
      ...EMPTY,
      types: Array.from({ length: 9 }, (_, i) => ({ gts: `g${i}`, name: `T${i}`, description: null, id: `t${i}` })),
    };
    const layout = layoutDiagram(modelGraph(many, 'k'));
    expect(layout.nodes).toHaveLength(DIAGRAM_CAP.kit);
    expect(layout.hidden).toBe(9 - DIAGRAM_CAP.kit);
  });
});

describe('installChanges', () => {
  it('says the tabs that appear, the types that become active, and the ones it adopts', () => {
    expect(installChanges(LIFECYCLE)).toEqual({
      tabs: [{ level: 'project', label: 'Phases' }],
      types: ['Phase'],
      adopts: ['Milestone'],
      extends: ['Project'],
    });
  });
});
