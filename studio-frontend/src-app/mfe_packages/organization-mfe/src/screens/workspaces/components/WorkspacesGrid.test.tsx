import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { stubResizeObserver } from '@frontx-test-utils/stubResizeObserver';
import type { Tenant } from '@constructor-studio/mfe-shared';
import en from '../i18n/en.json';
import type { OrgWorkspace } from '../../../overview/types';

// The kit's DataGrid measures its table.
stubResizeObserver();

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  useFormatters: () => ({ formatRelative: (value: unknown) => `at ${String(value)}` }),
}));

vi.mock('../../../i18n', async () => {
  const { dictionaryText } = await import('@frontx-test-utils/dictionaryText');
  return { useWorkspacesText: () => dictionaryText(en) };
});

import { WorkspacesGrid, keepsWorkspace, workspaceGridLoad, type WorkspaceGridRow } from './WorkspacesGrid';

const tenant = (id: string, name: string, extra: Partial<Tenant> = {}): Tenant =>
  ({ id, name, tenant_type: 'workspace', status: 'active', child_count: 2, ...extra }) as Tenant;

const WORKSPACES = [
  tenant('w0', 'Platform', { updated_at: '2026-01-01' }),
  tenant('w1', 'Apps', { self_managed: true }),
  tenant('w2', 'Zeta'),
];

const HEALTH: OrgWorkspace = {
  id: 'w0',
  name: 'Platform',
  spend: 120,
  previous: 100,
  specs_failing: 3,
  stuck: 2,
  quiet_days: 4,
  score: 1,
  projects: [
    {
      id: 'p1',
      name: 'api',
      spend: 80,
      previous: 50,
      specs_failing: 3,
      open_findings: 1,
      stuck: 2,
      quiet_days: 1,
      broken: false,
      score: 1,
      reasons: [{ kind: 'stuck', value: 2 }],
      phase: 'build',
    },
    {
      id: 'p2',
      name: 'web',
      spend: null,
      previous: null,
      specs_failing: null,
      open_findings: null,
      stuck: 0,
      quiet_days: null,
      broken: false,
      score: 0,
      reasons: [],
    },
  ],
};

const health = (row: Tenant) => (row.id === 'w0' ? HEALTH : undefined);

function renderGrid(props: Partial<React.ComponentProps<typeof WorkspacesGrid>> = {}) {
  const handlers = { onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn() };
  render(
    <div data-theme="light">
      <WorkspacesGrid
        workspaces={WORKSPACES}
        health={health}
        stuckDays={7}
        cash={(v) => `$${v}`}
        {...handlers}
        {...props}
      />
    </div>
  );
  return handlers;
}

const rowOf = (id: string) => document.querySelector(`[data-workspace-row="${id}"]`)?.closest('tr');

/** The tree's toggle, in the row's first cell, apart from the row click. */
const toggleOf = (id: string) => rowOf(id)?.querySelector('td')?.querySelector('[data-grid-row-ignore-click] button') ?? null;

afterEach(cleanup);

describe('the workspaces grid', () => {
  it('lists the workspaces by name, with the overview numbers and dashes where it has none', async () => {
    renderGrid();
    await screen.findByText('Platform');
    const names = [...document.querySelectorAll('[data-workspace-row]')].map((el) => el.textContent);
    expect(names.map((n) => n?.slice(0, 4))).toEqual(['Apps', 'Plat', 'Zeta']);
    const platform = rowOf('w0')!;
    expect(platform.textContent).toContain('$120');
    expect(platform.textContent).toContain('+20%');
    expect(platform.textContent).toContain('4 d');
    expect(platform.textContent).toContain('at 2026-01-01');
    expect(platform.querySelector('[data-workspace-description]')?.textContent).toMatch(/^api: /);
    expect(rowOf('w2')!.querySelectorAll('[title="Not known for this workspace"]').length).toBeGreaterThanOrEqual(5);
    expect(screen.getByText('PRs > 7 d')).toBeTruthy();
  });

  it('searches by name and offers to clear a search that matched nothing', async () => {
    renderGrid();
    await screen.findByText('Platform');
    fireEvent.change(screen.getByPlaceholderText('Search workspaces...'), { target: { value: 'zzz' } });
    expect(await screen.findByText('No workspace matches that search.')).toBeTruthy();
    fireEvent.click(screen.getByText('Clear search'));
    expect(await screen.findByText('Platform')).toBeTruthy();
  });

  it('says there are none yet, in its own words', async () => {
    renderGrid({ workspaces: [] });
    expect(await screen.findByText('No workspaces yet')).toBeTruthy();
  });

  it('opens a workspace from its row, and renames or deletes it from its actions', async () => {
    const { onOpen, onRename, onDelete } = renderGrid();
    await screen.findByText('Platform');
    fireEvent.click(screen.getByText('Zeta'));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'w2' }));
    fireEvent.click(document.querySelector('[data-workspace-rename="w0"]')!);
    fireEvent.click(document.querySelector('[data-workspace-delete="w1"]')!);
    expect(onRename).toHaveBeenCalledWith(expect.objectContaining({ id: 'w0' }));
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'w1' }));
    // The actions are not a click on the row.
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('folds a workspace open into its projects, with why each is in trouble', async () => {
    renderGrid();
    await screen.findByText('Platform');
    expect(document.querySelector('[data-workspace-project]')).toBeNull();
    const toggle = toggleOf('w0') as HTMLButtonElement;
    fireEvent.click(toggle);
    await waitFor(() => expect(document.querySelector('[data-workspace-project="p1"]')).toBeTruthy());
    expect(document.querySelector('[data-workspace-project="p2"]')?.textContent).toContain('nothing wrong');
    // Its phase beside its name (Project lifecycle), none where it has none.
    expect(document.querySelector('[data-workspace-project="p1"] [data-workspace-project-phase="build"]')).toBeTruthy();
    expect(document.querySelector('[data-workspace-project="p2"] [data-workspace-project-phase]')).toBeNull();
    // A workspace the overview has no projects for has nothing to open.
    expect(toggleOf('w2')).toBeNull();
  });

  it('opens either the project or its failing specs from the expanded row', async () => {
    const onOpenProject = vi.fn();
    const { onOpen } = renderGrid({ onOpenProject });
    await screen.findByText('Platform');
    fireEvent.click(toggleOf('w0')!);

    fireEvent.click(await screen.findByRole('button', { name: 'api' }));
    fireEvent.click(screen.getByRole('button', { name: /api: .*failing specs/ }));

    expect(onOpenProject).toHaveBeenNthCalledWith(1, 'w0', 'p1');
    expect(onOpenProject).toHaveBeenNthCalledWith(2, 'w0', 'p1', true);
    expect(onOpen).not.toHaveBeenCalled();
  });

  // Walk 2026-11-18: each page size picked, and each new overview, appended the list again.
  it('shows each workspace once after a new page size or new rows, keeping an open one open', async () => {
    const count = () => document.querySelectorAll('[data-workspace-row]').length;
    const projects = () => document.querySelectorAll('[data-workspace-project="p1"]').length;
    const props = { health, stuckDays: 7, cash: (v: number) => `$${v}`, onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn() };
    const view = render(
      <div data-theme="light">
        <WorkspacesGrid workspaces={WORKSPACES} {...props} />
      </div>
    );
    await screen.findByText('Platform');
    fireEvent.click(toggleOf('w0') as HTMLButtonElement);
    await waitFor(() => expect(projects()).toBe(1));

    for (const size of ['50', '100', '25']) {
      fireEvent.click(screen.getByRole('button', { name: size }));
      await waitFor(() => expect(count()).toBe(3));
    }
    view.rerender(
      <div data-theme="light">
        <WorkspacesGrid workspaces={[...WORKSPACES]} {...props} />
      </div>
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await waitFor(() => expect(count()).toBe(3));
    await waitFor(() => expect(projects()).toBe(1));
  });
});

describe('workspaceGridLoad', () => {
  const rows: WorkspaceGridRow[] = WORKSPACES.map((t) => ({ id: t.id, kind: 'workspace', tenant: t, health: health(t) }));

  it("answers a workspace's own load with its projects, whatever the page and filters", () => {
    const page = workspaceGridLoad(rows, {
      tree: { parentId: 'w0' },
      pagination: { page: 3, limit: 25 },
      filters: { managed: { value: ['self'] } },
    });
    expect(page.results.map((row) => row.id)).toEqual(['w0/p1', 'w0/p2']);
  });

  it('keeps the self-managed or the organization-managed workspaces, or all with none chosen', () => {
    const self = (filters: Record<string, unknown>) => rows.filter((row) => keepsWorkspace(row, filters)).map((r) => r.id);
    expect(self({})).toEqual(['w0', 'w1', 'w2']);
    expect(self({ managed: { value: ['self'] } })).toEqual(['w1']);
    expect(self({ managed: { value: ['org'] } })).toEqual(['w0', 'w2']);
    expect(self({ managed: { value: ['self', 'org'] } })).toEqual(['w0', 'w1', 'w2']);
  });
});
