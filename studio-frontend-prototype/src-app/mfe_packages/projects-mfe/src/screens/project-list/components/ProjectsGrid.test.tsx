import { withOwnQueryCache } from '@frontx-test-utils/withOwnQueryCache';
import { stubResizeObserver } from '@frontx-test-utils/stubResizeObserver';
import { TENANT_TYPES, type Tenant } from '@constructor-studio/mfe-shared';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FrontXProvider, i18nRegistry } from '@gears-frontx/react';
import {
  createMfeBridgeFixture,
  mfeContextValue,
} from '../../../../../../__test-utils__/createMfeBridgeFixture';
import { OrganizationProvider, STUDIO_SHARED_PROPERTY_CONTEXT_ORGANIZATION } from '@constructor-studio/mfe-shared';
import { PROJECT_LIST_NAMESPACE } from '../../../i18n';
import en from '../i18n/en.json';
import { ProjectsGrid } from './ProjectsGrid';
import type { ProjectConfigState } from '../../../shared/useProjectConfig';
import type { UserLookup } from '../../../shared/users';

/**
 * The projects list on the kit's DataGrid (#1076), without any HTTP: the rows
 * come from a mocked workspace scope. The click test exists because "the
 * project row does not react" has two very different causes — a wrong
 * `tenant_type` on the wire, or this code — and it rules out the second one.
 */

// The kit's DataGrid measures its table.
stubResizeObserver();

const CONFIG = { status: 'draft' as const, owner_id: 'user-1' };

/** Reassigned per test: the Status cell reads all four fields differently. */
let configState: ProjectConfigState;

vi.mock('@gears-frontx/react', (importOriginal) => withOwnQueryCache(importOriginal));

vi.mock('../../../shared/useProjectConfig', () => ({
  useProjectConfig: () => configState,
}));

let scope: {
  org: { id: string; name: string } | null;
  workspace: { id: string; name: string } | null;
  projects: Tenant[];
};

vi.mock('../../../shared/workspaceProjects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/workspaceProjects')>()),
  useWorkspaceProjects: () => ({ ...scope, loading: false, failed: false }),
}));

/** Reassigned per test, like `configState`: the Owner cell reads all three. */
let ownerState: UserLookup;

vi.mock('../../../shared/users', async () => {
  const actual = await vi.importActual<typeof import('../../../shared/users')>('../../../shared/users');
  return { ...actual, useUserById: () => ownerState };
});

function tenant(id: string, updatedAt = '2026-08-20T09:00:00Z'): Tenant {
  return {
    id,
    name: id,
    status: 'active',
    tenant_type: TENANT_TYPES.project,
    parent_id: 'ws',
    self_managed: false,
    depth: 3,
    child_count: 0,
    created_at: '2026-08-20T09:00:00Z',
    updated_at: updatedAt,
  };
}

const PROJECT = tenant('proj');

async function mount(phases?: Record<string, string>) {
  const { mfeApp } = await import('../../../init');
  const { bridge, executeActionsChain } = createMfeBridgeFixture({
    domainId: 'screen',
    instanceId: 'inst',
    // The shell publishes an object here, not a string — the fixture's property
    // map is typed for strings only, which is all this cast is about.
    initialProperties: {
      [STUDIO_SHARED_PROPERTY_CONTEXT_ORGANIZATION]: { id: 'org', name: 'Org' } as unknown as string,
    },
  });
  i18nRegistry.register(PROJECT_LIST_NAMESPACE, 'en' as never, en);

  render(
    <FrontXProvider app={mfeApp} mfeBridge={mfeContextValue(bridge)}>
      <OrganizationProvider>
        <ProjectsGrid phases={phases} />
      </OrganizationProvider>
    </FrontXProvider>
  );
  return { mfeApp, executeActionsChain };
}

const openedPayloads = (executeActionsChain: ReturnType<typeof createMfeBridgeFixture>['executeActionsChain']) =>
  executeActionsChain.mock.calls.map(([chain]) => chain.action.payload);

/** The names in the grid's body, top to bottom. */
const shownNames = () =>
  Array.from(document.querySelectorAll('[data-project-row]')).map((row) => row.getAttribute('data-project-row'));

beforeEach(() => {
  scope = { org: { id: 'org', name: 'Org' }, workspace: { id: 'ws-1', name: 'Platform' }, projects: [PROJECT] };
  configState = { config: CONFIG, loading: false, unset: false, failed: false };
  ownerState = {
    user: { id: 'user-1', username: 'ada', display_name: 'Ada L.' },
    loading: false,
    failed: false,
  };
});

afterEach(cleanup);

describe('ProjectsGrid rows', () => {
  it('tells the shell to open the project, and opens nothing itself', async () => {
    const { mfeApp, executeActionsChain } = await mount();
    const name = await screen.findByText('proj');

    await act(async () => {
      fireEvent.click(name);
    });

    // The shell owns which project is open. A row asks; it does not decide —
    // and it names the workspace it read the project in, or the shell cannot
    // tell a late announcement from a current one.
    expect(openedPayloads(executeActionsChain)).toContainEqual(
      expect.objectContaining({
        kind: 'opened',
        project: { id: 'proj', name: 'proj' },
        workspaceId: 'ws-1',
      })
    );

    // Local state stays put until the shell publishes the project back. It used
    // to be written here too, and that second writer is what made the shell's
    // echo look like "nothing changed" — the tabs then marked no section.
    const state = mfeApp.store.getState() as Record<string, { projectId: string | null }>;
    expect(state['projects/nav'].projectId).toBeNull();
  });

  it('announces nothing at all while no workspace is in scope', async () => {
    scope = { ...scope, workspace: null };
    const { executeActionsChain } = await mount();

    await act(async () => {
      fireEvent.click(await screen.findByText('proj'));
    });

    expect(openedPayloads(executeActionsChain)).not.toContainEqual(expect.objectContaining({ kind: 'opened' }));
  });

  it('draws a row from the project metadata, not from the tenant', async () => {
    await mount();

    // The project's own status, not the tenant lifecycle every tenant reports.
    expect(await screen.findByText(en.status_draft)).toBeTruthy();
    // The owner id resolved against the organization's users.
    expect(screen.getByText('Ada L.')).toBeTruthy();
    expect(screen.getByText(`${en.in_workspace} Platform`)).toBeTruthy();
  });

  it('keeps the tenant lifecycle ahead of missing metadata', async () => {
    // A project that never reached the wizard 404s on its metadata; suspending
    // it must still read as suspended rather than as "no attributes".
    configState = { config: null, loading: false, unset: true, failed: false };
    scope = { ...scope, projects: [{ ...tenant('susp'), status: 'suspended' as const }] };
    await mount();

    expect(await screen.findByText(en.status_suspended)).toBeTruthy();
    expect(screen.queryByText(en.status_unset)).toBeNull();
  });

  it("shows a project's phase only where Project lifecycle gives it one", async () => {
    await mount();
    await screen.findByText('proj');
    expect(document.querySelector('[data-project-phase]')).toBeNull();
  });

  it('shows the phase beside the name when the kit applies', async () => {
    await mount({ proj: 'build' });
    await screen.findByText('proj');
    expect(document.querySelector('[data-project-phase]')?.textContent).toBe(en.phase_build);
  });

  it('says so when a healthy project carries no attributes yet', async () => {
    configState = { config: null, loading: false, unset: true, failed: false };
    await mount();

    expect(await screen.findByText(en.status_unset)).toBeTruthy();
  });

  it('shows a degraded cell, not a value, when the metadata read fails', async () => {
    // 500/timeout: neither "Unknown" nor "no owner" is true, and both would
    // outlive the failure by a cache window.
    configState = { config: null, loading: false, unset: false, failed: true };
    await mount();

    await screen.findByText('proj');
    expect(screen.getAllByText(en.load_failed)).toHaveLength(2);
    expect(screen.queryByText(en.status_unknown)).toBeNull();
    expect(screen.queryByTitle(en.no_owner)).toBeNull();
  });
});

describe('ProjectsGrid order and search', () => {
  it('lists the most recently updated project first', async () => {
    scope = {
      ...scope,
      projects: [
        tenant('older', '2026-08-01T00:00:00Z'),
        tenant('newest', '2026-09-01T00:00:00Z'),
        tenant('middle', '2026-08-15T00:00:00Z'),
      ],
    };
    await mount();

    await screen.findByText('newest');
    expect(shownNames()).toEqual(['newest', 'middle', 'older']);
  });

  it('narrows the list by name, says when nothing matched, and Clear search brings the rows back', async () => {
    scope = { ...scope, projects: [tenant('billing'), tenant('catalog')] };
    await mount();
    await screen.findByText('catalog');

    fireEvent.change(screen.getByPlaceholderText(en.search_placeholder), { target: { value: 'bil' } });
    await waitFor(() => expect(shownNames()).toEqual(['billing']));

    fireEvent.change(screen.getByPlaceholderText(en.search_placeholder), { target: { value: 'zzz' } });
    expect(await screen.findByText(en.empty_no_match)).toBeTruthy();
    expect(screen.queryByText(`${en.in_workspace} Platform`)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: en.clear_search }));
    expect(await screen.findByText('catalog')).toBeTruthy();
    expect(shownNames()).toHaveLength(2);
  });
});

describe('ProjectsGrid empty states', () => {
  it('says the workspace has no projects yet', async () => {
    scope = { ...scope, projects: [] };
    await mount();

    expect(await screen.findByText(en.empty_title)).toBeTruthy();
    expect(screen.getByText(en.empty_hint)).toBeTruthy();
  });

  it('says no workspace is in scope', async () => {
    scope = { ...scope, workspace: null, projects: [] };
    await mount();

    expect(await screen.findByText(en.empty_no_workspace)).toBeTruthy();
  });

  it('says no organization is in scope', async () => {
    scope = { org: null, workspace: null, projects: [] };
    await mount();

    expect(await screen.findByText(en.empty_no_org)).toBeTruthy();
  });
});
