import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openScreen } from '@constructor-studio/mfe-shared';
import { stubResizeObserver } from '@frontx-test-utils/stubResizeObserver';
import type { DeployEnvironment, Deployment, ProjectPath, ProjectTargets } from '../../api/types';

// The lists are the kit's DataGrid, which measures its header.
stubResizeObserver();

const { service, calls, scope } = vi.hoisted(() => ({
  service: {} as Record<string, unknown>,
  calls: [] as { name: string; args: unknown[]; body?: unknown }[],
  scope: { project: 'p1' as string | null },
}));

vi.mock('../../i18n', () => {
  const t = (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key);
  t.count = (key: string, count: number) => `${key}_${count === 1 ? 'one' : 'many'} ${count}`;
  return { useReleasesTranslations: () => ({ t, loading: false }) };
});
vi.mock('@constructor-studio/mfe-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@constructor-studio/mfe-shared')>()),
  useHostChrome: () => ({ containerRef: { current: null }, dataTheme: 'light', language: 'en' }),
  openScreen: vi.fn(),
}));
vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  apiRegistry: { getService: () => service },
  useSharedProperty: () => scope.project,
}));

import { ReleasesScreen } from './ReleasesScreen';

/** A read: `api.name(params).fetch()`. */
const read = (name: string, value: unknown) => (params?: unknown) => {
  calls.push({ name, args: [params] });
  return { fetch: () => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value)) };
};
/** A write: `api.name(...args).fetch(body)`. */
const write = (name: string, value: unknown) => (...args: unknown[]) => ({
  fetch: (body?: unknown) => {
    calls.push({ name, args, body });
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  },
});

const env = (patch: Partial<DeployEnvironment>): DeployEnvironment => ({
  id: 'e-dev',
  name: 'dev',
  description: '',
  kind: 'kubernetes',
  connection_id: 'c-k8s',
  registry: 'ghcr.io/acme',
  namespace_pattern: '{project}-{environment}',
  database: 'none',
  protected: false,
  updated_by: 'u1',
  updated_at: '2026-11-01T00:00:00Z',
  ...patch,
});

const deployment = (patch: Partial<Deployment>): Deployment => ({
  id: 'd1',
  project_id: 'p1',
  project_name: 'Shop',
  environment_id: 'e-dev',
  environment_name: 'dev',
  profile: 'prod',
  product: 'shop',
  build: 'studio-2',
  images: [],
  namespace: 'shop-dev',
  chart_sha256: '',
  chart_ref: 'oci://ghcr.io/acme/charts/shop',
  chart_version: '0.2.0',
  state: 'succeeded',
  requested_by: 'u2',
  requested_by_name: 'Ann',
  requested_at: '2026-11-08T10:00:00Z',
  ...patch,
});

const buildNode = (id: string, v: Record<string, unknown>) => ({ type_id: 'build', instance_id: id, value: v });

/** The path the server answers: the product composed, built, published, ready for dev. */
const readyPath = (patch: Partial<ProjectPath> = {}): ProjectPath => ({
  organization_id: 'o1',
  current: 'running',
  environment_id: 'e-dev',
  steps: [
    { id: 'product', state: 'done', reason: 'The product is described (revision 3).', checklist: [] },
    { id: 'build', state: 'done', reason: 'Build studio-2 passed.', checklist: [], build_id: 'studio-2' },
    { id: 'image', state: 'done', reason: '0.2.0 is published with 1 image(s).', checklist: [] },
    { id: 'environment', state: 'done', reason: 'dev is ready for a deploy.', checklist: [] },
    {
      id: 'running',
      state: 'next',
      reason: 'Nothing is deployed yet.',
      checklist: [],
      action: { kind: 'deploy', label: 'Deploy', environment_id: 'e-dev' },
    },
  ],
  running_in: [],
  research_kit: false,
  ...patch,
});

const runNode = (id: string, v: Record<string, unknown>) => ({ type_id: 'workflow_run', instance_id: id, value: v });

/**
 * The services the screen reads. By default the path carries no targets and no
 * deploys (a backend before `include`), so they are read on their own; `carry`
 * puts them in the path's answer, as a backend with `include` does.
 */
function setUp({
  deployments,
  path,
  runs,
  carry = false,
  extraEnvironments = [],
  extraBuilds = [],
  noBuilds = false,
}: {
  deployments?: Deployment[];
  path?: ProjectPath;
  runs?: ReturnType<typeof runNode>[];
  carry?: boolean;
  extraEnvironments?: ProjectTargets['environments'];
  extraBuilds?: ReturnType<typeof buildNode>[];
  /** No build on record at all. */
  noBuilds?: boolean;
} = {}) {
  calls.length = 0;
  for (const k of Object.keys(service)) delete service[k];
  const targets: ProjectTargets = {
    organization_id: 'o1',
    project_name: 'Shop',
    environments: [
      { environment: env({}), namespace: 'shop-dev' },
      { environment: env({ id: 'e-prod', name: 'prod', promote_from: 'e-dev', protected: true }), namespace: 'shop-prod' },
      ...extraEnvironments,
    ],
    bindings: [{ profile: 'prod', environment_id: 'e-dev' }],
    secrets: [],
  };
  const builds = noBuilds ? [] : [
    buildNode('n2', {
      build_id: 'studio-2',
      where: 'studio',
      status: 'passed',
      product: 'shop',
      started_at: '2026-11-08T09:00:00Z',
      finished_at: '2026-11-08T09:10:00Z',
      chart: { reference: 'oci://ghcr.io/acme/charts/shop', version: '0.2.0' },
    }),
    buildNode('n3', {
      build_id: 'desktop-3',
      where: 'desktop',
      status: 'failed',
      product: 'shop',
      started_at: '2026-11-09T09:00:00Z',
      failure: 'gear `billing` does not compile',
      failure_step: 'images',
    }),
    ...extraBuilds,
  ];
  const deploys = { items: deployments ?? [deployment({})], total: 1 };
  const answer = path ?? readyPath();
  Object.assign(service, {
    targets: read('targets', targets),
    deployments: read('deployments', deploys),
    nodes: (params: { type: string }) => {
      calls.push({ name: 'nodes', args: [params] });
      const page =
        params.type === 'build'
          ? { nodes: builds }
          : params.type === 'workflow_run'
            ? { nodes: runs ?? [] }
            : { nodes: [] };
      return { fetch: () => Promise.resolve(page) };
    },
    connections: read('connections', {
      items: [
        { id: 'c-k8s', label: 'Acme cluster', account: 'kube' },
        { id: 'c-research', label: 'Research account', account: 'r1' },
      ],
    }),
    environments: read('environments', { items: [], total: 0, may_manage: true }),
    tenantUsers: read('tenantUsers', { items: [] }),
    projectConfig: read('projectConfig', { value: {} }),
    createDeployment: write('createDeployment', deployment({ id: 'd9', state: 'awaiting_approval' })),
    productDescription: read('productDescription', { latest: null }),
    saveBindings: write('saveBindings', { items: [], total: 0 }),
    projectPath: read('projectPath', carry ? { ...answer, targets, deployments: deploys } : answer),
    deployment: read('deployment', deployment({})),
    deploymentLogs: read('deploymentLogs', { containers: [] }),
    myResearchProjects: read('myResearchProjects', { connection_id: 'c-research', items: [{ id: 'rp', name: 'ML team' }], total: 1 }),
    myResearchHardware: read('myResearchHardware', { items: [{ id: 'gpu', name: 'GPU', trial: true }], total: 1 }),
    createProjectEnvironment: write('createProjectEnvironment', env({ id: 'e-research', name: 'Research ML team', kind: 'research', research_project: 'rp' })),
    startBuild: write('startBuild', { build_id: 'research-7', run_id: 'r7', namespace: 'shop' }),
    deployBuiltImages: write('deployBuiltImages', deployment({ id: 'd8', state: 'queued', environment_id: 'e-research' })),
    buildImages: read('buildImages', { items: [], total: 0 }),
    deploymentStatus: read('deploymentStatus', { deployment: deployment({}), workloads: [], hosts: [] }),
    taskRun: read('taskRun', { id: 'r', state: 'running' }),
  });
}

/** Waits for an element, as the screen reads its answers. */
const el = (selector: string) =>
  waitFor(() => {
    const e = document.querySelector(selector);
    if (!e) throw new Error(`not yet: ${selector}`);
    return e as HTMLElement;
  });

/** Picks a stage on the release map. */
const openStage = async (stage: string) => {
  fireEvent.click(await el(`[data-map-stage="${stage}"]`));
  return el(`[data-release-stage="${stage}"]`);
};

describe('ReleasesScreen', () => {
  beforeEach(() => {
    scope.project = 'p1';
    window.history.replaceState(null, '', '/');
    setUp();
  });
  afterEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, '', '/');
  });

  it('asks for a project when none is open', () => {
    scope.project = null;
    render(<ReleasesScreen bridge={null} />);
    expect(screen.getByText('no_project')).toBeTruthy();
  });

  describe('the release map', () => {
    it('draws Build → Images → Environment → Deploy with each state and fact, and opens on the stage that failed', async () => {
      render(<ReleasesScreen bridge={null} />);
      const map = await el('[data-release-map]');
      await waitFor(() =>
        expect([...map.querySelectorAll('[data-map-stage]')].map((n) => `${n.getAttribute('data-map-stage')}:${n.getAttribute('data-map-state')}`)).toEqual([
          'build:failed',
          'images:done',
          'environment:done',
          'deploy:done',
        ])
      );
      // The newest build failed; the images are the passed one's, deployed to dev.
      expect(map.querySelector('[data-map-stage="build"] [data-map-fact]')?.textContent).toBe('desktop-3');
      expect(map.querySelector('[data-map-stage="images"]')?.textContent).toContain('map_images_from {"build":"studio-2"}');
      expect(map.querySelector('[data-map-stage="environment"] [data-map-fact]')?.textContent).toBe('dev');
      expect(map.querySelector('[data-map-stage="deploy"]')?.textContent).toContain('0.2.0');
      // The page opens on the stage that needs attention, and says so in the map.
      expect((await el('[data-release-stage]')).getAttribute('data-release-stage')).toBe('build');
      expect(map.querySelector('[data-map-stage="build"]')?.getAttribute('aria-selected')).toBe('true');
      // No overview, no path: the map replaced them.
      expect(document.querySelector('[data-release-overview]')).toBeNull();
      expect(document.querySelector('[data-project-path]')).toBeNull();
    });

    it('shows one stage at a time and keeps the stage in the address', async () => {
      render(<ReleasesScreen bridge={null} />);
      await openStage('environment');
      expect(document.querySelector('[data-stage-panel="build"]')).toBeNull();
      expect(window.location.search).toContain('rel.stage=environment');
      await openStage('deploy');
      expect(document.querySelector('[data-stage-panel="environment"]')).toBeNull();
      expect(window.location.search).toContain('rel.stage=deploy');
    });

    it('opens on the stage, the build and the environment the address names', async () => {
      window.history.replaceState(null, '', '/?screen=releases;project=p1&rel.stage=images&rel.build=studio-2');
      render(<ReleasesScreen bridge={null} />);
      const panel = await el('[data-release-stage="images"]');
      await waitFor(() => expect(panel.querySelector('[data-images-build]')?.getAttribute('data-images-build')).toBe('studio-2'));
      expect(panel.querySelector('[data-build-chart]')?.textContent).toContain('oci://ghcr.io/acme/charts/shop:0.2.0');
      expect(panel.querySelector('[data-images-fits]')?.textContent).toBe('images_fits_count_many 2');
    });

    it('Can go to opens Environment on the environments that take the images', async () => {
      setUp({
        extraEnvironments: [
          { environment: env({ id: 'e-research', name: 'research-ml', kind: 'research', research_project: 'rp', project_id: 'p1' }), namespace: 'shop' },
        ],
      });
      window.history.replaceState(null, '', '/?rel.stage=images&rel.build=studio-2');
      render(<ReleasesScreen bridge={null} />);
      fireEvent.click(await el('[data-images-fits="2"]'));
      const envs = await el('[data-release-stage="environment"]');
      expect(window.location.search).toContain('rel.envs.f.fits=yes');
      await waitFor(() =>
        expect([...envs.querySelectorAll('[data-ladder-row]')].map((r) => r.getAttribute('data-ladder-row'))).toEqual(['dev', 'prod'])
      );
    });
  });

  describe('Deploy', () => {
    it('deploys the chosen images to the chosen environment, which waits for approval when protected', async () => {
      render(<ReleasesScreen bridge={null} />);
      const envs = await openStage('environment');
      const prodRow = () => envs.querySelector('[data-ladder-row="prod"]')?.closest('tr') as HTMLElement | null;
      const prod = await waitFor(() => {
        const row = prodRow();
        if (!row) throw new Error('not yet');
        return row;
      });
      expect(prod.querySelector('[data-ladder-fit]')?.getAttribute('data-ladder-fit')).toBe('yes');
      fireEvent.click(prod.querySelector('[data-ladder-choose]') as HTMLElement);
      await waitFor(() => expect(prodRow()?.querySelector('[data-ladder-selected]')).toBeTruthy());
      expect(window.location.search).toContain('rel.env=e-prod');
      fireEvent.click(await el('[data-environment-next]'));
      const deploy = await el('[data-release-stage="deploy"]');
      expect(deploy.querySelector('[data-deploy-plan-environment]')?.textContent).toContain('prod');
      fireEvent.click(deploy.querySelector('[data-deploy-run]') as HTMLElement);
      await waitFor(() => expect(calls.some((c) => c.name === 'createDeployment')).toBe(true));
      const asked = calls.find((c) => c.name === 'createDeployment');
      expect(asked?.args).toEqual(['p1']);
      expect(asked?.body).toEqual({ environment_id: 'e-prod', build: 'studio-2' });
      expect(await screen.findByText(/asked_waits/)).toBeTruthy();
    });

    it('a deploy to a Research environment goes by the deploy-only route', async () => {
      setUp({
        path: readyPath({ research_kit: true, research: { state: 'signed_in', connection_id: 'c-research' } }),
        extraEnvironments: [
          { environment: env({ id: 'e-research', name: 'research-ml', kind: 'research', research_project: 'rp', project_id: 'p1' }), namespace: 'shop' },
        ],
        extraBuilds: [
          buildNode('r1', {
            build_id: 'research-1',
            where: 'research',
            status: 'passed',
            environment_id: 'e-research',
            started_at: '2026-11-10T09:00:00Z',
            finished_at: '2026-11-10T09:20:00Z',
            images: [
              { app: 'api-gateway', image: 'research-image/studioweb/api-gateway:i1' },
              { app: 'ui', image: 'research-image/studioweb/ui:i2' },
              { app: 'studio-database-postgres', image: 'research-image/studioweb/postgres:i3' },
            ],
          }),
        ],
      });
      render(<ReleasesScreen bridge={null} />);
      // The passed Research build is the images' build: three, in Research.
      const images = await openStage('images');
      await waitFor(() => expect(images.querySelector('[data-images-build]')?.getAttribute('data-images-build')).toBe('research-1'));
      expect(document.querySelector('[data-map-stage="images"]')?.textContent).toContain('map_images_count {"done":3,"total":3}');
      // One row per image on the shared grid: where it lives, whether it can run.
      await waitFor(() => expect(images.querySelectorAll('[data-build-image]').length).toBe(3));
      expect([...images.querySelectorAll('[data-image-place]')].map((e) => e.getAttribute('data-image-place'))).toEqual([
        'research',
        'research',
        'research',
      ]);
      expect([...images.querySelectorAll('[data-image-status]')].map((e) => e.getAttribute('data-image-status'))).toEqual([
        'ready',
        'ready',
        'ready',
      ]);
      // The search narrows the rows.
      fireEvent.change(screen.getByPlaceholderText('search_images'), { target: { value: 'postgres' } });
      await waitFor(() => expect(images.querySelectorAll('[data-build-image]').length).toBe(1));
      fireEvent.change(screen.getByPlaceholderText('search_images'), { target: { value: '' } });
      // A passed build is deployable from Images.
      fireEvent.click(images.querySelector('[data-images-deploy]') as HTMLElement);
      const deploy = await el('[data-release-stage="deploy"]');
      expect(window.location.search).toContain('rel.env=e-research');
      fireEvent.click(deploy.querySelector('[data-deploy-run]') as HTMLElement);
      await waitFor(() => expect(calls.some((c) => c.name === 'deployBuiltImages')).toBe(true));
      const asked = calls.find((c) => c.name === 'deployBuiltImages');
      expect(asked?.args).toEqual(['p1', 'research-1']);
      expect(asked?.body).toEqual({ environment_id: 'e-research' });
      expect(calls.some((c) => c.name === 'createDeployment')).toBe(false);
    });

    it('says why the images cannot go to the chosen environment and keeps Deploy off', async () => {
      window.history.replaceState(null, '', '/?rel.stage=deploy&rel.build=desktop-3');
      render(<ReleasesScreen bridge={null} />);
      const deploy = await el('[data-release-stage="deploy"]');
      await waitFor(() => expect(deploy.querySelector('[data-deploy-why]')?.textContent).toBe('deploy_needs_images'));
      expect((deploy.querySelector('[data-deploy-run]') as HTMLButtonElement).disabled).toBe(true);
    });

    it('asks before an uninstall and sends it only on confirm', async () => {
      render(<ReleasesScreen bridge={null} />);
      await openStage('deploy');
      fireEvent.click(await el('[data-deploy-uninstall]'));
      expect(await screen.findByText(/uninstall_title/)).toBeTruthy();
      expect(calls.some((c) => c.name === 'createDeployment')).toBe(false);
      fireEvent.click(document.querySelector('[data-confirm]') as HTMLElement);
      await waitFor(() => expect(calls.some((c) => c.name === 'createDeployment')).toBe(true));
      expect(calls.find((c) => c.name === 'createDeployment')?.body).toEqual({
        environment_id: 'e-dev',
        product: 'shop',
        profile: 'prod',
        action: 'uninstall',
      });
    });

    it('a failed deploy shows its cause in the map and on the stage, which the page opens on', async () => {
      setUp({
        noBuilds: true,
        deployments: [deployment({ id: 'd5', state: 'failed', outcome: 'ImagePullBackOff: denied\nmore' })],
      });
      render(<ReleasesScreen bridge={null} />);
      const deploy = await el('[data-release-stage="deploy"]');
      expect(document.querySelector('[data-map-stage="deploy"]')?.getAttribute('data-map-state')).toBe('failed');
      expect(document.querySelector('[data-map-stage="deploy"] [data-map-more]')?.textContent).toBe('ImagePullBackOff: denied');
      expect(deploy.querySelector('[data-deploy-cause]')?.textContent).toBe('ImagePullBackOff: denied');
      fireEvent.click(deploy.querySelector('[data-deploy-open-detail]') as HTMLElement);
      expect(await el('[data-deployment-detail="d5"]')).toBeTruthy();
    });

    it('lists the deploys under it: search, a row opens what the deploy said, and an earlier one deploys again', async () => {
      setUp({
        deployments: [
          deployment({ id: 'd1', product: 'shop', reason: 'first try' }),
          deployment({ id: 'd2', product: 'billing', environment_name: 'prod', environment_id: 'e-prod', namespace: 'billing-prod' }),
          deployment({ id: 'd0', product: 'shop', chart_version: '0.1.0', requested_at: '2026-11-01T10:00:00Z' }),
        ],
      });
      render(<ReleasesScreen bridge={null} />);
      await openStage('deploy');
      await waitFor(() => expect(document.querySelectorAll('[data-deploy-history-row]').length).toBe(3));
      fireEvent.click(document.querySelector('[data-deploy-history-row="d1"]')?.closest('tr') as HTMLElement);
      const detail = await el('[data-deploy-history-detail="d1"]');
      expect(detail.textContent).toContain('first try');
      // What runs there now is not deployed again from here.
      expect(detail.querySelector('[data-deploy-again]')).toBeNull();
      fireEvent.click(document.querySelector('[data-deploy-history-row="d0"]')?.closest('tr') as HTMLElement);
      const earlier = await el('[data-deploy-history-detail="d0"]');
      fireEvent.click(earlier.querySelector('[data-deploy-again="d0"]') as HTMLElement);
      await waitFor(() => expect(calls.some((c) => c.name === 'createDeployment')).toBe(true));
      expect(calls.find((c) => c.name === 'createDeployment')?.body).toEqual({ environment_id: 'e-dev', redeploy_of: 'd0' });
      const search = screen.getByPlaceholderText('search_deploys');
      fireEvent.change(search, { target: { value: 'billing-prod' } });
      await waitFor(() => expect(document.querySelectorAll('[data-deploy-history-row]').length).toBe(1));
      expect(document.querySelector('[data-deploy-history-row="d2"]')).toBeTruthy();
    });
  });

  it('binds a profile to an environment on Environment, keeping the others', async () => {
    render(<ReleasesScreen bridge={null} />);
    await openStage('environment');
    const prod = (await el('[data-binding-environment="prod"] select')) as HTMLSelectElement;
    fireEvent.change(prod, { target: { value: 'prod' } });
    fireEvent.click(document.querySelector('[data-bindings-save]') as HTMLElement);
    await waitFor(() => expect(calls.some((c) => c.name === 'saveBindings')).toBe(true));
    const saved = calls.find((c) => c.name === 'saveBindings');
    expect(saved?.args).toEqual(['p1']);
    expect(saved?.body).toEqual({
      items: [
        { profile: 'prod', environment_id: 'e-dev' },
        { profile: 'prod', environment_id: 'e-prod' },
      ],
    });
  });

  describe('Build', () => {
    it('lists the builds: the newest open, a failed one with whose it is to fix, and its images on Images', async () => {
      setUp({ deployments: [] });
      render(<ReleasesScreen bridge={null} />);
      const failed = await el('[data-build-card="desktop-3"]');
      expect(failed.querySelector('[data-build-cause="gear"]')?.textContent).toContain('Gear billing fails');
      await waitFor(() => expect(document.querySelectorAll('[data-product-build]').length).toBe(2));
      expect(document.querySelector('[data-product-build="desktop-3"]')?.hasAttribute('data-product-build-open')).toBe(true);
      // A click on another row opens it under the list instead; a second click closes it.
      const row = () => document.querySelector('[data-product-build="studio-2"]')?.closest('tr') as HTMLElement;
      fireEvent.click(row());
      const card = await el('[data-build-card="studio-2"]');
      expect(document.querySelector('[data-build-card="desktop-3"]')).toBeNull();
      // What it made is the Images stage's.
      fireEvent.click(card.querySelector('[data-build-see-images]') as HTMLElement);
      expect((await el('[data-release-stage="images"]')).querySelector('[data-images-build]')?.getAttribute('data-images-build')).toBe('studio-2');
      expect(window.location.search).toContain('rel.build=studio-2');
    });

    it("lists the CI runs folded under the builds, in a grid that searches them", async () => {
      setUp({
        deployments: [],
        runs: [
          runNode('r1', { workflow: 'ci', title: 'Fix the cart', branch: 'main', sha: 'aaaaaaa1', status: 'completed', conclusion: 'success', author: 'ann', created_at: '2026-11-08T09:00:00Z' }),
          runNode('r2', { workflow: 'ci', title: 'Add billing', branch: 'main', sha: 'bbbbbbb2', status: 'completed', conclusion: 'failure', author: 'bob', created_at: '2026-11-09T09:00:00Z' }),
        ],
      });
      render(<ReleasesScreen bridge={null} />);
      const ci = await el('[data-build-in-ci]');
      expect(ci.tagName).toBe('DETAILS');
      expect(ci.hasAttribute('open')).toBe(false);
      expect(await screen.findByText('Fix the cart')).toBeTruthy();
      expect(screen.getByText('Add billing')).toBeTruthy();
      const search = screen.getByPlaceholderText('search_runs');
      fireEvent.change(search, { target: { value: 'billing' } });
      await waitFor(() => expect(screen.queryByText('Fix the cart')).toBeNull());
      expect(screen.getByText('Add billing')).toBeTruthy();
      fireEvent.change(search, { target: { value: 'nothing like it' } });
      expect(await screen.findByText('no_runs_match')).toBeTruthy();
      fireEvent.click(document.querySelector('[data-grid-clear-filters]') as HTMLElement);
      expect(await screen.findByText('Fix the cart')).toBeTruthy();
    });

    it('a failed build names its gear under Build and its cause leads to the gear', async () => {
      setUp({
        path: readyPath({
          current: 'build',
          steps: [
            { id: 'product', state: 'done', reason: '', checklist: [] },
            {
              id: 'build',
              state: 'failed',
              reason: 'Build b3 failed: Gear billing did not build.',
              checklist: [],
              build_id: 'b3',
              cause: {
                code: 'GEAR_BUILD_FAILED',
                summary: 'Gear billing did not build.',
                gear: 'billing',
                lines: ['error: gear `billing` · help: currency is required'],
                actions: [
                  { kind: 'open_gear', label: 'Open the gear', gear: 'billing' },
                  { kind: 'retry', label: 'Build again' },
                ],
              },
            },
          ],
        }),
      });
      render(<ReleasesScreen bridge={null} />);
      const cause = await el('[data-release-stage="build"] [data-path-open="build"] [data-failure-cause="GEAR_BUILD_FAILED"]');
      expect(cause.textContent).toContain('gear `billing`');
      fireEvent.click(cause.querySelector('[data-path-action="open_gear"]') as HTMLElement);
      expect(openScreen).toHaveBeenCalledWith(null, '/product');
    });

    it('a running Research build shows how far it got in the map and under Build', async () => {
      setUp({
        path: readyPath({ research_kit: true, research: { state: 'signed_in', connection_id: 'c-research' } }),
        extraBuilds: [
          buildNode('r1', {
            build_id: 'research-1',
            where: 'research',
            status: 'running',
            step: 'images',
            started_at: '2026-11-10T09:00:00Z',
          }),
        ],
      });
      render(<ReleasesScreen bridge={null} />);
      const build = await el('[data-release-stage="build"]');
      expect(document.querySelector('[data-map-stage="build"]')?.getAttribute('data-map-state')).toBe('running');
      expect(document.querySelector('[data-map-stage="build"]')?.textContent).toContain('map_build_running_at');
      const card = await el('[data-build-card="research-1"]');
      expect(card.querySelector('[data-research-progress]')?.getAttribute('data-research-progress')).toBe('images');
      // Build and run in Research opens the dialog on the Research target.
      fireEvent.click(build.querySelector('[data-research-open]') as HTMLElement);
      expect(await el('[data-deploy-dialog] [data-deploy-target-research]')).toBeTruthy();
    });
  });

  describe('targets and deploys from the path', () => {
    const asked = (name: string) => calls.filter((c) => c.name === name).length;

    it('takes them from the path answer and does not read them again', async () => {
      setUp({ carry: true });
      render(<ReleasesScreen bridge={null} />);
      await el('[data-map-stage="deploy"][data-map-state="done"]');
      expect(calls.find((c) => c.name === 'projectPath')?.args).toEqual([
        { projectId: 'p1', include: 'targets,deployments' },
      ]);
      expect(asked('targets')).toBe(0);
      expect(asked('deployments')).toBe(0);
    });

    it('reads them on their own from a backend whose path does not carry them', async () => {
      render(<ReleasesScreen bridge={null} />);
      await el('[data-map-stage="deploy"][data-map-state="done"]');
      expect(asked('targets')).toBe(1);
      expect(asked('deployments')).toBe(1);
    });

    it('reads them on their own when the path fails and shows an unreadable deployment history', async () => {
      Object.assign(service, {
        projectPath: read('projectPath', new Error('path is down')),
        deployments: read('deployments', new Error('deploys are down')),
      });
      render(<ReleasesScreen bridge={null} />);
      expect(await screen.findByText(/release_deployments_unavailable/)).toBeTruthy();
      expect(screen.getByText(/deploys are down/)).toBeTruthy();
      expect(asked('targets')).toBe(1);
      expect(asked('deployments')).toBe(1);
    });

    it('a 404 from the targets is a deployment without environments, not an error', async () => {
      Object.assign(service, {
        projectPath: read('projectPath', new Error('path is down')),
        targets: read('targets', Object.assign(new Error('not found'), { response: { status: 404 } })),
      });
      render(<ReleasesScreen bridge={null} />);
      expect(await screen.findByText('no_environments_here')).toBeTruthy();
    });
  });

  it('a missing secret is a checklist item on Environment, and Provide it stays there on its environment', async () => {
    setUp({
      path: readyPath({
        current: 'environment',
        steps: [
          {
            id: 'environment',
            state: 'blocked',
            reason: '1 thing is missing before a deploy to dev.',
            environment_id: 'e-dev',
            checklist: [
              { code: 'PROFILE_BOUND', text: 'A profile is bound to dev.', done: true },
              {
                code: 'SECRET',
                text: 'The product needs the secret SMTP_PASSWORD in dev.',
                done: false,
                action: { kind: 'provide_secret', label: 'Provide it', key: 'SMTP_PASSWORD', environment_id: 'e-dev' },
              },
            ],
            action: { kind: 'provide_secret', label: 'Provide it', key: 'SMTP_PASSWORD', environment_id: 'e-dev' },
          },
        ],
      }),
    });
    render(<ReleasesScreen bridge={null} />);
    await openStage('environment');
    const missing = await el('[data-path-checklist] [data-check="SECRET"]');
    expect(missing.getAttribute('data-check-done')).toBeNull();
    expect(missing.textContent).toContain('SMTP_PASSWORD');
    fireEvent.click(missing.querySelector('[data-path-action="provide_secret"]') as HTMLElement);
    expect(await el('[data-environment-chosen="dev"] [data-environment-config="dev"]')).toBeTruthy();
    expect(window.location.search).toContain('rel.env=e-dev');
  });

  describe('Deploy to… (#1053)', () => {
    const openDialog = async () => {
      render(<ReleasesScreen bridge={null} />);
      fireEvent.click(await el('[data-deploy-to]'));
      return el('[data-deploy-dialog]');
    };

    it('lists the environments and no Research target without the kit', async () => {
      const dialog = await openDialog();
      expect(dialog.querySelectorAll('[data-deploy-target]').length).toBe(2);
      expect(dialog.querySelector('[data-deploy-target-research]')).toBeNull();
      expect(calls.some((c) => c.name === 'myResearchProjects')).toBe(false);
    });

    it("with the kit offers the caller's Research projects and builds there", async () => {
      setUp({ path: readyPath({ research_kit: true, research: { state: 'signed_in', connection_id: 'c-research' } }) });
      const dialog = await openDialog();
      const research = await waitFor(() => {
        const r = dialog.querySelector('[data-deploy-target-research]');
        if (!r?.querySelector('[data-research-run]')) throw new Error('not yet');
        return r;
      });
      expect(research.querySelector('[data-research-sign-in]')?.getAttribute('data-research-sign-in')).toBe('signed_in');
      await waitFor(() => expect(research.textContent).toContain('GPU'));
      fireEvent.click(research.querySelector('[data-research-run]') as HTMLElement);
      await waitFor(() => expect(calls.some((c) => c.name === 'startBuild')).toBe(true));
      expect(calls.find((c) => c.name === 'createProjectEnvironment')?.body).toMatchObject({
        kind: 'research',
        connection_id: 'c-research',
        research_project: 'rp',
      });
      expect(calls.find((c) => c.name === 'startBuild')?.body).toEqual({ environment_id: 'e-research', then_deploy: true });
      expect(await waitFor(() => research.querySelector('[data-research-build="research-7"]'))).toBeTruthy();
    });

    it('follows the deploy the build starts itself, and asks for none', async () => {
      setUp({ path: readyPath({ research_kit: true, research: { state: 'signed_in', connection_id: 'c-research' } }) });
      service.build = read('build', {
        build_id: 'research-7',
        where: 'research',
        status: 'passed',
        deploys_to: 'e-research',
        deployment_id: 'd-run',
      });
      service.taskRun = read('taskRun', { progress: 'built', result: {} });
      const dialog = await openDialog();
      const research = await waitFor(() => {
        const r = dialog.querySelector('[data-deploy-target-research]');
        if (!r?.querySelector('[data-research-run]')) throw new Error('not yet');
        return r;
      });
      await waitFor(() => expect(research.textContent).toContain('GPU'));
      fireEvent.click(research.querySelector('[data-research-run]') as HTMLElement);
      const followed = () => calls.some((c) => c.name === 'deployment' && (c.args[0] as { id?: string } | undefined)?.id === 'd-run');
      await waitFor(() => expect(followed()).toBe(true), { timeout: 8000 });
      expect(calls.some((c) => c.name === 'createDeployment')).toBe(false);
    }, 15000);

    it('folds the environments nothing can go to into one line that opens', async () => {
      setUp({ path: readyPath({ research_kit: true, research: { state: 'signed_in', connection_id: 'c-research' } }) });
      const t = (await (service.targets as (p: unknown) => { fetch: () => Promise<ProjectTargets> })({}).fetch());
      service.targets = read('targets', {
        ...t,
        environments: [
          ...t.environments,
          { environment: env({ id: 'e-rs', name: 'research-ml-team', kind: 'research', research_project: 'rp', project_id: 'p1' }), namespace: '' },
        ],
      });
      const dialog = await openDialog();
      const folded = await waitFor(() => {
        const f = dialog.querySelector('[data-deploy-folded]');
        if (!f) throw new Error('not yet');
        return f as HTMLElement;
      });
      expect(folded.getAttribute('data-deploy-folded')).toBe('1');
      expect(folded.textContent).toContain('targets_nothing_to_deploy_one 1');
      expect(dialog.querySelector('[data-deploy-target="e-rs"]')).toBeNull();
      expect(dialog.querySelectorAll('[data-deploy-target]').length).toBe(2);
      fireEvent.click(folded.querySelector('[data-deploy-unfold]') as HTMLElement);
      expect(dialog.querySelector('[data-deploy-target="e-rs"]')?.getAttribute('data-deploy-target-quiet')).toBe('true');
      // The Research target comes before the environments.
      const order = [...dialog.querySelectorAll('[data-deploy-target-research], [data-deploy-environments]')].map((e) =>
        e.hasAttribute('data-deploy-target-research') ? 'research' : 'environments'
      );
      expect(order).toEqual(['research', 'environments']);
    });

    it("reuses the project's Research environment for that Research project, and lists projects with Deployment off last, disabled", async () => {
      setUp({ path: readyPath({ research_kit: true, research: { state: 'signed_in', connection_id: 'c-research' } }) });
      const t = (await (service.targets as (p: unknown) => { fetch: () => Promise<ProjectTargets> })({}).fetch());
      service.targets = read('targets', {
        ...t,
        environments: [
          ...t.environments,
          {
            environment: env({
              id: 'e-rs',
              name: 'research-ml-team',
              kind: 'research',
              connection_id: 'c-research',
              research_project: 'rp',
              research_hardware: null,
              project_id: 'p1',
            }),
            namespace: '',
          },
        ],
      });
      service.myResearchProjects = read('myResearchProjects', {
        connection_id: 'c-research',
        items: [
          { id: 'off', name: 'Graph gear', deployment_enabled: false },
          { id: 'rp', name: 'ML team', deployment_enabled: true },
        ],
        total: 2,
      });
      const dialog = await openDialog();
      const research = await waitFor(() => {
        const r = dialog.querySelector('[data-deploy-target-research]');
        if (!r?.querySelector('[data-research-run]')) throw new Error('not yet');
        return r;
      });
      const options = [...research.querySelectorAll('select[aria-label="research_project"] option')] as HTMLOptionElement[];
      expect(options.map((o) => o.value)).toEqual(['rp', 'off']);
      expect(options[1].disabled).toBe(true);
      expect(options[1].textContent).toContain('research_deployment_off_short');
      expect(research.querySelector('[data-research-deployment-off]')).toBeNull();
      fireEvent.click(research.querySelector('[data-research-run]') as HTMLElement);
      await waitFor(() => expect(calls.some((c) => c.name === 'startBuild')).toBe(true));
      expect(calls.some((c) => c.name === 'createProjectEnvironment')).toBe(false);
      expect(calls.find((c) => c.name === 'startBuild')?.body).toEqual({ environment_id: 'e-rs', then_deploy: true });
      // The bar starts at the first step, the log under it.
      expect(research.querySelector('[data-research-progress]')?.getAttribute('data-research-progress')).toBe('prepare');
      expect(research.querySelector('[data-research-build-log]')).toBeTruthy();
    });

    it('asks to sign in when the Research sign-in ran out', async () => {
      setUp({ path: readyPath({ research_kit: true, research: { state: 'expired', days_left: 0 } }) });
      const dialog = await openDialog();
      const research = await waitFor(() => {
        const r = dialog.querySelector('[data-deploy-target-research]');
        if (!r) throw new Error('not yet');
        return r as HTMLElement;
      });
      expect(research.querySelector('[data-research-sign-in]')?.getAttribute('data-research-sign-in')).toBe('expired');
      expect(research.querySelector('[data-research-run]')).toBeNull();
      expect(calls.some((c) => c.name === 'myResearchProjects')).toBe(false);
    });
  });

  describe('a deploy the address names (#1054)', () => {
    afterEach(() => window.history.replaceState(null, '', '/'));

    it('opens that deploy with its cause and log, as the Inbox links it', async () => {
      const id = '0b1f5c2a-6f0e-4d7e-9a43-2f5e8c1d9b10';
      setUp();
      service.deployment = read(
        'deployment',
        deployment({
          id,
          state: 'failed',
          research: true,
          outcome: 'the Constructor Research connection cannot be used: invalid_grant',
          cause: {
            code: 'RESEARCH_SIGN_IN_EXPIRED',
            summary: 'Your sign-in ran out.',
            lines: ['invalid_grant'],
            actions: [{ kind: 'sign_in', label: 'Sign in again' }],
          },
        })
      );
      window.history.replaceState(null, '', `/?screen=releases;org=o1;project=p1&deployment=${id}`);
      render(<ReleasesScreen bridge={null} />);
      const detail = await waitFor(() => {
        const d = document.querySelector(`[data-deployment-detail="${id}"] [data-failure-cause]`);
        if (!d) throw new Error('not yet');
        return d;
      });
      expect(detail.getAttribute('data-failure-cause')).toBe('RESEARCH_SIGN_IN_EXPIRED');
      expect(calls.find((c) => c.name === 'deployment')?.args).toEqual([{ projectId: 'p1', id }]);
      fireEvent.click(detail.querySelector('[data-path-action="sign_in"]') as HTMLElement);
      expect(openScreen).toHaveBeenCalledWith(null, '/connections');
    });
  });

  describe('where each environment runs', () => {
    const researchEnv = {
      environment: env({
        id: 'e-research',
        name: 'research-ml',
        kind: 'research',
        connection_id: 'c-research',
        research_project: 'rp',
        research_hardware: 'gpu',
        project_id: 'p1',
      }),
      namespace: 'shop-research-ml',
    };
    const kit = { research_kit: true, research: { state: 'signed_in' as const, connection_id: 'c-research' } };
    const rows = (root: ParentNode) => [...root.querySelectorAll('[data-ladder-row]')].map((r) => r.getAttribute('data-ladder-row'));
    const rowOf = (name: string) => document.querySelector(`[data-ladder-row="${name}"]`)?.closest('tr') as HTMLElement;

    it('lists every environment on the shared grid, Kubernetes first, each with where it runs', async () => {
      setUp({ path: readyPath(kit), extraEnvironments: [researchEnv] });
      render(<ReleasesScreen bridge={null} />);
      const envs = await openStage('environment');
      await waitFor(() => expect(rows(envs)).toEqual(['dev', 'prod', 'research-ml']));
      const dev = rowOf('dev');
      expect(dev.querySelector('[data-environment-kind]')?.getAttribute('data-environment-kind')).toBe('kubernetes');
      await waitFor(() => expect(rowOf('dev').querySelector('[data-environment-target="kubernetes"]')?.textContent).toContain('Acme cluster'));
      expect(rowOf('dev').textContent).toContain('shop-dev');
      const research = rowOf('research-ml');
      expect(research.querySelector('[data-environment-kind]')?.getAttribute('data-environment-kind')).toBe('research');
      // studio-2 has a chart and no Research images: the Research row says so.
      expect(research.querySelector('[data-ladder-fit]')?.getAttribute('data-ladder-fit')).toBe('research_only');
      await waitFor(() => expect(rowOf('research-ml').querySelector('[data-environment-target="research"]')?.textContent).toContain('ML team'));
      await waitFor(() => expect(rowOf('research-ml').querySelector('[data-environment-target="research"]')?.textContent).toContain('GPU'));
      expect(rowOf('research-ml').textContent).toContain('Research account');
      // The search narrows the list; a row's click chooses it.
      fireEvent.change(screen.getByPlaceholderText('search_environments'), { target: { value: 'research' } });
      await waitFor(() => expect(rows(envs)).toEqual(['research-ml']));
      fireEvent.click(rowOf('research-ml'));
      await waitFor(() => expect(window.location.search).toContain('rel.env=e-research'));
      expect(await el('[data-environment-chosen="research-ml"] [data-ladder-detail="research-ml"]')).toBeTruthy();
    });

    it('says how to get a Research environment when the kit applies and there is none', async () => {
      setUp({ path: readyPath(kit) });
      render(<ReleasesScreen bridge={null} />);
      await openStage('environment');
      expect((await el('[data-releases-empty="research"]')).textContent).toContain('group_research_empty');
    });

    it('without the kit says nothing of Research', async () => {
      render(<ReleasesScreen bridge={null} />);
      const envs = await openStage('environment');
      await waitFor(() => expect(rows(envs)).toEqual(['dev', 'prod']));
      expect(document.querySelector('[data-releases-empty="research"]')).toBeNull();
    });

    it('without a product says why and leaves Choose and Build and run waiting', async () => {
      setUp({
        path: readyPath({
          ...kit,
          current: 'product',
          steps: [
            { id: 'product', state: 'next', reason: 'No product.', checklist: [], action: { kind: 'open_product', label: '' } },
          ],
        }),
      });
      render(<ReleasesScreen bridge={null} />);
      const line = await el('[data-releases-no-product]');
      expect(line.textContent).toContain('no_product_actions');
      await waitFor(() => expect(document.querySelector('[data-map-stage="build"]')?.getAttribute('data-map-state')).toBe('blocked'));
      expect(document.querySelector('[data-release-stage]')?.getAttribute('data-release-stage')).toBe('build');
      expect(((await el('[data-research-open]')) as HTMLButtonElement).disabled).toBe(true);
      await openStage('environment');
      const choose = (await el('[data-ladder-choose]')) as HTMLButtonElement;
      expect(choose.disabled).toBe(true);
      expect(choose.title).toBe('no_product_short');
      fireEvent.click(line.querySelector('[data-path-action="open_product"]') as HTMLElement);
      expect(openScreen).toHaveBeenCalledWith(null, '/product');
    });

    it('says what Builds and History will hold when there is nothing yet', async () => {
      setUp({ deployments: [], noBuilds: true });
      render(<ReleasesScreen bridge={null} />);
      await openStage('build');
      await waitFor(() => expect(document.querySelector('[data-releases-empty="builds"]')?.textContent).toContain('builds_empty'));
      await openStage('deploy');
      expect((await el('[data-releases-empty="history"]')).textContent).toContain('history_empty');
    });
  });
});
