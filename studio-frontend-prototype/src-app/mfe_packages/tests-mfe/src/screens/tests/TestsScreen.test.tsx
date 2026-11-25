import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  FRONTX_SHARED_PROPERTY_LANGUAGE,
  FRONTX_SHARED_PROPERTY_THEME,
} from '@gears-frontx/react';
import { createMfeBridgeFixture } from '@frontx-test-utils/createMfeBridgeFixture';
import { stubResizeObserver } from '@frontx-test-utils/stubResizeObserver';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The kit's DataGrid measures its header.
stubResizeObserver();

const { translations, service, scope } = vi.hoisted(() => ({
  translations: vi.fn(),
  scope: {
    project: 'p1' as string | null,
    workspace: { id: 'w1' } as { id: string } | null,
    available: null as unknown,
  },
  service: {} as Record<string, unknown>,
}));

vi.mock('../../i18n', () => ({ useTestsTranslations: translations }));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  apiRegistry: { getService: () => service },
  // The shared kit-absent state reads its own words and the bridge.
  useScreenTranslations: () => ({ isLoaded: true }),
  useTranslation: () => ({ language: 'en', t: (key: string) => key }),
  useMfeBridge: () => null,
  useSharedProperty: (id: string) =>
    id.includes('context.project.')
      ? scope.project
      : id.includes('screens.available')
        ? scope.available
        : scope.workspace,
}));

import { TestsScreen } from './TestsScreen';

const query = (value: unknown) => () => ({ fetch: () => Promise.resolve(value) });
const NOW = new Date().toISOString();

function bridge() {
  return createMfeBridgeFixture({
    domainId: 'd',
    instanceId: 'i',
    initialProperties: { [FRONTX_SHARED_PROPERTY_THEME]: 'default', [FRONTX_SHARED_PROPERTY_LANGUAGE]: 'en' },
  }).bridge;
}

describe('TestsScreen', () => {
  beforeEach(() => {
    translations.mockReturnValue({
      t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
      loading: false,
    });
    scope.project = 'p1';
    scope.available = null;
    Object.assign(service, {
      ciRuns: query({
        total: 1,
        latest_completed: 'r1',
        items: [
          {
            id: 'r1',
            repo: 'n1',
            workflow: 'CI',
            workflow_path: null,
            title: 'Fix it',
            event: 'push',
            branch: 'main',
            sha: 'abcdef1234',
            status: 'completed',
            conclusion: 'failure',
            url: null,
            number: 1,
            created_at: NOW,
            updated_at: NOW,
            jobs: [
              {
                name: 'test',
                status: 'completed',
                conclusion: 'failure',
                failed_step: 'cargo test',
                started_at: NOW,
                completed_at: NOW,
                duration_seconds: 60,
                url: null,
              },
            ],
          },
        ],
      }),
      repositories: query({ nodes: [{ type_id: 'repo', instance_id: 'n1', value: { full_path: 'acme/app' } }] }),
      openPullRequests: query({ items: [], total: 0 }),
      pullRequestChecks: { fetch: () => Promise.resolve({ items: [], total: 0, pulls: 0, reached: true }) },
      declaredCapabilities: query({ items: [{ key: 'auth' }], total: 1 }),
      capabilities: query({ items: [{ key: 'auth', label: 'Auth', terms: [] }] }),
      conformance: {
        fetch: () => Promise.resolve({ repo: 'acme/app', total: 1, items: [{ capability: 'auth', status: 'missing' }] }),
      },
    });
  });

  afterEach(() => vi.clearAllMocks());

  it('says the mainline is red, names the failed job, and counts spec ↔ code', async () => {
    render(<TestsScreen bridge={bridge()} />);
    expect(await screen.findByText('mainline_red')).toBeTruthy();
    expect(screen.getAllByText(/test → cargo test/).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByText(/spec_covered/)).toBeTruthy());
    expect(screen.getByText(/"implemented":0,"functional":1/)).toBeTruthy();
  });

  it('lists the runs through the grid: the search narrows them, a click opens the jobs under the list', async () => {
    const runs = (service.ciRuns as () => { fetch: () => Promise<{ items: unknown[] }> })().fetch();
    const first = (await runs).items[0] as Record<string, unknown>;
    service.ciRuns = query({
      total: 2,
      latest_completed: 'r1',
      items: [first, { ...first, id: 'r2', workflow: 'Deploy', conclusion: 'success', jobs: [] }],
    });
    render(<TestsScreen bridge={bridge()} />);
    await waitFor(() => expect(document.querySelector('[data-list-grid="tests-runs"] [data-tests-run-id="r2"]')).not.toBeNull());
    expect(document.querySelector('[data-tests-run-id="r1"]')).not.toBeNull();

    fireEvent.click(document.querySelector('[data-tests-run-id="r1"]')!.closest('td')!);
    expect(await waitFor(() => document.querySelector('[data-tests-jobs="r1"] [data-tests-job="failed"]'))).not.toBeNull();

    fireEvent.change(screen.getByPlaceholderText('search_runs'), { target: { value: 'deploy' } });
    await waitFor(() => expect(document.querySelector('[data-tests-run-id="r1"]')).toBeNull());
    expect(document.querySelector('[data-tests-run-id="r2"]')).not.toBeNull();
    fireEvent.change(screen.getByPlaceholderText('search_runs'), { target: { value: 'nothing like it' } });
    expect(await screen.findByText('no_runs_match')).toBeTruthy();
    fireEvent.click(screen.getByText('clear_search'));
    await waitFor(() => expect(document.querySelector('[data-tests-run-id="r1"]')).not.toBeNull());
  });

  it('says there was no run in two weeks, and lists the open pull requests through the grid', async () => {
    service.ciRuns = query({ total: 0, latest_completed: null, items: [] });
    service.openPullRequests = query({
      total: 2,
      items: [
        { id: 'pr1', repo: 'acme/app', number: 7, title: 'Add login', url: null, source_branch: 'login', waiting_on: [], days_open: 2 },
        { id: 'pr2', repo: 'acme/app', number: 8, title: 'Fix billing', url: null, source_branch: null, waiting_on: [], days_open: 1 },
      ],
    });
    render(<TestsScreen bridge={bridge()} />);
    expect(await screen.findByText('runs_empty')).toBeTruthy();
    await waitFor(() => expect(document.querySelector('[data-list-grid="tests-pulls"]')?.textContent).toContain('Add login'));
    expect(screen.getByText('branch_unknown')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('search_pulls'), { target: { value: 'billing' } });
    await waitFor(() => expect(screen.queryByText(/Add login/)).toBeNull());
    expect(screen.getByText(/Fix billing/)).toBeTruthy();
  });

  it('offers Retry when the runs could not be read', async () => {
    let fail = true;
    const ok = service.ciRuns as () => { fetch: () => Promise<unknown> };
    service.ciRuns = () => ({ fetch: () => (fail ? Promise.reject(new Error('down')) : ok().fetch()) });
    render(<TestsScreen bridge={bridge()} />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByText('retry'));
    expect(await screen.findByText('mainline_red')).toBeTruthy();
  });

  it('shows the open pull requests only where the pull-request type of project-git is installed (ADR-0071 §5)', async () => {
    const pulls = vi.fn(query({ items: [], total: 0 }));
    service.openPullRequests = pulls;
    // Known, and pull-request is not among the installed types.
    scope.available = { routes: ['/tests'], kits: ['project-tests'], types: [] };
    render(<TestsScreen bridge={bridge()} />);
    expect(await screen.findByText('mainline_red')).toBeTruthy();
    expect(document.querySelector('[data-tests-pulls-card]')).toBeNull();
    expect(document.querySelector('[data-tests-spec-card]')).toBeTruthy();
    expect(pulls).not.toHaveBeenCalled();
  });

  it('shows the open pull requests where the type is installed', async () => {
    scope.available = {
      routes: ['/tests'],
      kits: ['project-tests', 'project-git'],
      types: ['gts.cf.studio.domain.pull_request.v1~'],
    };
    render(<TestsScreen bridge={bridge()} />);
    expect(await screen.findByText('mainline_red')).toBeTruthy();
    expect(document.querySelector('[data-tests-pulls-card]')).toBeTruthy();
  });

  it('says project-git is not installed, not that the runs failed, when its gear refuses with KIT_NOT_INSTALLED', async () => {
    const refusal = Object.assign(new Error('Request failed with status code 400'), {
      response: {
        status: 400,
        data: { context: { violations: [{ type: 'KIT_NOT_INSTALLED', subject: 'project-git', description: 'not here' }] } },
      },
    });
    service.ciRuns = () => ({ fetch: () => Promise.reject(refusal) });
    render(<TestsScreen bridge={bridge()} />);
    await waitFor(() => expect(document.querySelector('[data-kit-absent="project-git"]')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('draws spec ↔ code as absent when the spec-mapping gear is not there (404)', async () => {
    service.declaredCapabilities = () => ({
      fetch: () => Promise.reject(Object.assign(new Error('404'), { response: { status: 404, data: '' } })),
    });
    render(<TestsScreen bridge={bridge()} />);
    expect(await screen.findByText('mainline_red')).toBeTruthy();
    await waitFor(() => expect(document.querySelector('[data-tests-spec-card] [data-kit-absent="spec-mapping"]')).toBeTruthy());
    expect(document.querySelector('[data-tests-spec-error]')).toBeNull();
  });

  it('asks for a project when none is open', () => {
    scope.project = null;
    render(<TestsScreen bridge={bridge()} />);
    expect(screen.getByText('no_project')).toBeTruthy();
  });
});
