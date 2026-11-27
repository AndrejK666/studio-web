import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgOverview, OverviewBlock } from '../../overview/types';

const { query, available, openScreen, openPlace, requestWorkspace } = vi.hoisted(() => ({
  query: vi.fn(),
  available: { value: null as unknown },
  openScreen: vi.fn(),
  openPlace: vi.fn(),
  requestWorkspace: vi.fn(),
}));

vi.mock('../../i18n', () => {
  const t = (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key);
  t.count = (key: string, count: number) => `${key} ${count}`;
  return { useOverviewTranslations: () => ({ t, loading: false }), useBackgroundTranslations: () => ({ t }) };
});
// The Inbox has its own test (InboxGroup.test.tsx): here it reports one item waiting on the reader.
vi.mock('./InboxGroup', async () => {
  const { useEffect } = await import('react');
  return {
    InboxGroup: ({ onCount }: { onCount?: (n: number) => void }) => {
      useEffect(() => onCount?.(1), [onCount]);
      return <div data-attention-group="you" />;
    },
  };
});
vi.mock('@constructor-studio/mfe-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@constructor-studio/mfe-shared')>()),
  useOrganization: () => ({ org: { id: 'o1', name: 'Acme' }, loading: false, failed: false }),
  openScreen,
  openPlace,
}));
vi.mock('../../actions/workspaceActions', () => ({ requestWorkspace }));
vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  apiRegistry: { getService: () => ({ overview: () => ({}), run: () => ({ detail: true }) }) },
  useApiQuery: query,
  useSharedProperty: (id: string) => (id.includes('screens.available') ? available.value : 'en'),
  useMfeBridge: () => null,
}));

import { OverviewScreen } from './OverviewScreen';

const en = (text: string) => ({ en: text });

/** The Costs kit's block, as studio-usage words it. */
const spend: OverviewBlock = {
  kit: 'org-costs',
  id: 'spend',
  order: 10,
  tile: {
    title: { en: 'Spend, 30 days', ru: 'Расходы за 30 дней' },
    value: { text: en('{current}'), args: { current: { kind: 'money', value: 120, currency: 'USD' } } },
    lines: [{ text: en('{growth} against the days before'), args: { growth: { kind: 'text', text: '+20%' } } }],
    link: { route: '/costs', label: en('Costs →') },
  },
  needs: [{
    key: 'spend', tone: 'warn',
    sentence: { text: en('Spend {growth} against the same days last month'), args: { growth: { kind: 'text', text: '+50%' } } },
    action: { route: '/costs', label: en('Open Costs') },
  }],
  data: {},
};

/** The Git kit's block: a figure unknown, a queue nobody reviews. */
const delivery: OverviewBlock = {
  kit: 'project-git',
  id: 'delivery',
  order: 20,
  tile: {
    title: en('Delivery'),
    value: { text: en('{merged} merged'), args: { merged: { kind: 'count', value: 12 } } },
    lines: [{ text: en('median wait {wait} d'), args: { wait: { kind: 'count', value: null } } }],
    link: { route: '/organization/workspaces', label: en('Workspaces →') },
  },
  needs: [{
    key: 'queue:nobody', tone: 'warn',
    sentence: { text: en('1 pull request waits on nobody'), args: {} },
    action: { route: '/organization/workspaces', label: en('Open workspaces') },
    details: {
      label: en('View PRs without reviewers'),
      rows: [{ text: '#41 Update checkout', href: 'https://github.com/acme/app/pull/41', note: [
        { text: en('{days} days without an update'), args: { days: { kind: 'count', value: 8 } } },
      ] }],
    },
  }],
  data: {},
};

/** The Specs kit's block: a fold-out list leading into a project. */
const specs: OverviewBlock = {
  kit: 'project-specs',
  id: 'specs',
  order: 30,
  tile: {
    title: en('Specs, every project'),
    value: { text: en('{failing} of {specs} failing'), args: { failing: { kind: 'count', value: 1 }, specs: { kind: 'count', value: 10 } } },
    lines: [],
    items: {
      label: en('Find failing specs'),
      rows: [{
        text: { text: en('{place} · {count} failing specs'), args: { place: { kind: 'text', text: 'Main / App' }, count: { kind: 'count', value: 1 } } },
        link: { route: '/projects/specs', view: 'failing-specs', label: en('Specs'), workspace_id: 'w1', project_id: 'p1' },
      }],
    },
  },
  needs: [],
  data: {},
};

/** The Components kit's block: no tile, one need. */
const decisions: OverviewBlock = {
  kit: 'components',
  id: 'decisions',
  order: 40,
  tile: null,
  needs: [{
    key: 'components', tone: 'warn',
    sentence: { text: en('{components} for a decision'), args: { components: { kind: 'text', text: '2 components wait' } } },
    action: { route: '/components', view: 'needs-decision', label: en('Decide') },
  }],
  data: {},
};

const overview: OrgOverview = {
  organization_id: 'o1',
  name: 'Acme',
  period_from: '',
  period_to: '',
  previous_from: '',
  previous_to: '',
  stuck_days: 7,
  growth_alert: 0.2,
  quiet_days: 14,
  needs: [{ kind: 'connection', tone: 'danger', provider: 'github', status: '401', projects: ['app'] }],
  blocks: [spend, delivery, specs],
  people: { active: 6, idle: [] },
  workspaces: [
    { id: 'w1', name: 'Main', spend: null, previous: null, specs_failing: 0, stuck: 0, quiet_days: 1, score: 0, projects: [] },
  ],
};

const tiles = () => Array.from(document.querySelectorAll('[data-overview-block]')).map((t) => t.getAttribute('data-overview-block'));

describe('OverviewScreen', () => {
  beforeEach(() => {
    query.mockReturnValue({ data: overview, isLoading: false, isError: false, error: null });
    available.value = null;
    openScreen.mockReset();
    openPlace.mockReset();
    requestWorkspace.mockReset();
  });

  it("draws every kit's block as a tile in its words, and People after them", () => {
    render(<OverviewScreen />);
    expect(tiles()).toEqual(['org-costs/spend', 'project-git/delivery', 'project-specs/specs']);
    expect(screen.getByText('Spend, 30 days')).toBeTruthy();
    expect(screen.getByText('$120')).toBeTruthy();
    expect(screen.getByText('+20% against the days before')).toBeTruthy();
    expect(screen.getByText('12 merged')).toBeTruthy();
    // An unknown figure is said as unknown, never as zero.
    expect(screen.getByText('median wait unknown d')).toBeTruthy();
    expect(screen.getByText(/tile_people_value/)).toBeTruthy();
  });

  it('shows no tile and no need of a kit whose block is not in the answer', () => {
    query.mockReturnValue({ data: { ...overview, blocks: [specs] } });
    render(<OverviewScreen />);
    expect(tiles()).toEqual(['project-specs/specs']);
    expect(screen.queryByText('Spend, 30 days')).toBeNull();
    expect(screen.queryByText('Delivery')).toBeNull();
    expect(screen.queryByText(/Spend \+50%/)).toBeNull();
    // The organization's own tile and need stay.
    expect(screen.getByText(/tile_people_value/)).toBeTruthy();
    expect(screen.getByText('A github connection is refused (401)')).toBeTruthy();
  });

  it('leads where the block says, and only to a screen that shows here', () => {
    available.value = { routes: ['/organization/workspaces', '/people', '/costs'], kits: ['org-costs'] };
    query.mockReturnValue({ data: { ...overview, blocks: [spend, decisions] } });
    render(<OverviewScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Costs →' }));
    expect(openScreen).toHaveBeenLastCalledWith(null, '/costs');
    fireEvent.click(screen.getByRole('button', { name: 'Open Costs' }));
    expect(openScreen).toHaveBeenLastCalledWith(null, '/costs');
    // Components does not show here: the need is said, without a button.
    expect(screen.getByText('2 components wait for a decision')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Decide' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'open_people' }));
    expect(openScreen).toHaveBeenLastCalledWith(null, '/people');
  });

  it("opens a kit's view the need names", () => {
    query.mockReturnValue({ data: { ...overview, blocks: [decisions] } });
    render(<OverviewScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Decide' }));
    expect(openScreen).toHaveBeenCalledWith(null, '/components', 'needs-decision');
  });

  it('offers no button to a screen the shell does not list', () => {
    available.value = { routes: ['/organization/workspaces'], kits: [] };
    render(<OverviewScreen />);
    expect(screen.queryByRole('button', { name: 'Fix the connection' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Costs →' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'open_people' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Workspaces →' })).toBeTruthy();
  });

  it("folds out a block's list into the project it names", () => {
    render(<OverviewScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Find failing specs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Main / App · 1 failing specs' }));
    expect(openPlace).toHaveBeenCalledWith(null, {
      organizationId: 'o1', workspaceId: 'w1', projectId: 'p1', route: '/projects/specs', view: 'failing-specs',
    });
  });

  it("folds out what a kit's need is about instead of its action", () => {
    render(<OverviewScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'View PRs without reviewers' }));
    const pull = screen.getByRole('link', { name: '#41 Update checkout' });
    expect(pull.getAttribute('href')).toBe('https://github.com/acme/app/pull/41');
    expect(screen.getByText(/8 days without an update/)).toBeTruthy();
    expect(openScreen).not.toHaveBeenCalled();
  });

  it('opens a workspace from its row', () => {
    render(<OverviewScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'open_workspace' }));
    expect(requestWorkspace).toHaveBeenCalledWith(null, { id: 'w1', name: 'Main' }, 'o1');
  });

  it('shows a short run failure with its project and environment in context', () => {
    const environment = 'fb8aa971-8f7b-437d-b007-d3ce83d15099';
    const recent = { id: 'r1', tenant_id: 'p1', task_type: 'environments.build', created_at: '2026-11-18T00:00:00Z' };
    const data: OrgOverview = {
      ...overview,
      needs: [{ kind: 'runs', tone: 'danger', projects: [], runs: 1 }],
      blocks: [],
      recent_failures: [recent],
      workspaces: [{ ...overview.workspaces[0], projects: [{
        id: 'p1', name: 'App', spend: null, previous: null, specs_failing: null, open_findings: null,
        stuck: 0, quiet_days: null, broken: false, score: 0, reasons: [],
      }] }],
    };
    query.mockImplementation((request) => request.detail
      ? { data: { ...recent, last_error: 'Registry refused the push\nFull diagnostics', payload: { environment_id: environment } } }
      : { data });
    available.value = { routes: ['/releases'], kits: [] };
    render(<OverviewScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'show_recent_failures' }));
    const run = screen.getByText(/^environments\.build/).closest('details')!;
    run.open = true;
    fireEvent(run, new Event('toggle'));
    expect(screen.getByText('Registry refused the push')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /run_open_project/ }));
    expect(openPlace).toHaveBeenCalledWith(null, {
      organizationId: 'o1', workspaceId: 'w1', projectId: 'p1', route: '/releases', view: `environment-${environment}`,
    });
  });

  it('names the refused connection and the workspaces, and counts what needs attention', () => {
    render(<OverviewScreen />);
    expect(screen.getByText('Acme')).toBeTruthy();
    expect(screen.getByText('A github connection is refused (401)')).toBeTruthy();
    expect(screen.getByText('Main')).toBeTruthy();
    // The connection, the spend and the queue for others, and one item for the reader.
    expect(screen.getByText('4 things need attention')).toBeTruthy();
    expect(document.querySelector('[data-attention-group="you"]')).toBeTruthy();
    // A refused connection is fixed on Connections, which this portal has.
    expect(screen.getByRole('button', { name: 'Fix the connection' })).toBeTruthy();
  });

  it('says when the overview cannot be read', () => {
    query.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: new Error('403') });
    render(<OverviewScreen />);
    expect(screen.getByText('unreadable')).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});
