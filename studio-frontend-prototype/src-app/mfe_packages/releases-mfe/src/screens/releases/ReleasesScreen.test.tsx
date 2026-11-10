import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeployEnvironment, Deployment, ProjectTargets } from '../../api/types';

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

function setUp({ deployments }: { deployments?: Deployment[] } = {}) {
  calls.length = 0;
  for (const k of Object.keys(service)) delete service[k];
  const targets: ProjectTargets = {
    organization_id: 'o1',
    project_name: 'Shop',
    environments: [
      { environment: env({}), namespace: 'shop-dev' },
      { environment: env({ id: 'e-prod', name: 'prod', promote_from: 'e-dev', protected: true }), namespace: 'shop-prod' },
    ],
    bindings: [{ profile: 'prod', environment_id: 'e-dev' }],
    secrets: [],
  };
  const builds = [
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
  ];
  Object.assign(service, {
    targets: read('targets', targets),
    deployments: read('deployments', { items: deployments ?? [deployment({})], total: 1 }),
    nodes: (params: { type: string }) => {
      calls.push({ name: 'nodes', args: [params] });
      const page = params.type === 'build' ? { nodes: builds } : { nodes: [] };
      return { fetch: () => Promise.resolve(page) };
    },
    connections: read('connections', { items: [] }),
    environments: read('environments', { items: [], total: 0, may_manage: true }),
    tenantUsers: read('tenantUsers', { items: [] }),
    projectConfig: read('projectConfig', { value: {} }),
    createDeployment: write('createDeployment', deployment({ id: 'd9', state: 'awaiting_approval' })),
    productDescription: read('productDescription', { latest: null }),
    saveBindings: write('saveBindings', { items: [], total: 0 }),
  });
}

describe('ReleasesScreen', () => {
  beforeEach(() => {
    scope.project = 'p1';
    try {
      window.localStorage.clear();
    } catch {
      // No storage: the tab is the next step's.
    }
    setUp();
  });
  afterEach(() => vi.clearAllMocks());

  it('asks for a project when none is open', () => {
    scope.project = null;
    render(<ReleasesScreen bridge={null} />);
    expect(screen.getByText('no_project')).toBeTruthy();
  });

  it('opens on Deploy with the ladder: what runs where, and Promote to the next rung', async () => {
    render(<ReleasesScreen bridge={null} />);
    expect(await screen.findByText('0.2.0 runs in dev')).toBeTruthy();
    const dev = document.querySelector('[data-ladder-step="dev"]');
    expect(dev?.getAttribute('data-ladder-state')).toBe('runs');
    const prod = document.querySelector('[data-ladder-step="prod"]');
    expect(prod?.getAttribute('data-ladder-state')).toBe('empty');
    // prod takes from dev, which runs studio-2: Promote installs it.
    const promote = document.querySelector('[data-ladder-promote]') as HTMLElement;
    expect(promote.textContent).toContain('0.2.0');
    fireEvent.click(promote);
    await waitFor(() => expect(calls.some((c) => c.name === 'createDeployment')).toBe(true));
    const asked = calls.find((c) => c.name === 'createDeployment');
    expect(asked?.args).toEqual(['p1']);
    expect(asked?.body).toEqual({ environment_id: 'e-prod', build: 'studio-2' });
    // A protected environment answers "waiting for an administrator".
    expect(await screen.findByText(/asked_waits/)).toBeTruthy();
  });

  it('asks before an uninstall and sends it only on confirm', async () => {
    render(<ReleasesScreen bridge={null} />);
    await screen.findByText('0.2.0 runs in dev');
    const deployButtons = document.querySelectorAll('[data-ladder-deploy]');
    fireEvent.click(deployButtons[0] as HTMLElement);
    fireEvent.click(await waitFor(() => document.querySelector('[data-deploy-uninstall]') as HTMLElement));
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

  it('binds a profile to an environment under the ladder, keeping the others', async () => {
    render(<ReleasesScreen bridge={null} />);
    await screen.findByText('0.2.0 runs in dev');
    const prod = document.querySelector('[data-binding-environment="prod"] select') as HTMLSelectElement;
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

  it('lists the builds on Build: the newest open, a failed one with whose it is to fix', async () => {
    setUp({ deployments: [] });
    render(<ReleasesScreen bridge={null} />);
    await screen.findByText('status_deploy_newest');
    fireEvent.click(document.querySelector('[data-release-tab="build"]') as HTMLElement);
    const failed = await waitFor(() => {
      const card = document.querySelector('[data-build-card="desktop-3"]');
      if (!card) throw new Error('not yet');
      return card;
    });
    expect(failed.querySelector('[data-build-cause="gear"]')?.textContent).toContain('Gear billing fails');
    expect(document.querySelectorAll('[data-product-build]').length).toBe(2);
  });
});
