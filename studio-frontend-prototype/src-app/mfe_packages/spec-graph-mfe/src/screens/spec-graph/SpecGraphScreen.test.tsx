import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FRONTX_SHARED_PROPERTY_LANGUAGE, FRONTX_SHARED_PROPERTY_THEME } from '@gears-frontx/react';
import { createMfeBridgeFixture } from '@frontx-test-utils/createMfeBridgeFixture';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { translations, service, scope } = vi.hoisted(() => ({
  translations: vi.fn(),
  scope: { project: 'p1' as string | null, available: null as unknown },
  service: {} as Record<string, unknown>,
}));

vi.mock('../../i18n', () => ({ useSpecGraphTranslations: translations }));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  apiRegistry: { getService: () => service },
  useSharedProperty: (id: string) =>
    id.includes('context.project.') ? scope.project : id.includes('screens.available') ? scope.available : null,
}));

import { SpecGraphScreen } from './SpecGraphScreen';

const query = (value: unknown) => () => ({ fetch: () => Promise.resolve(value) });
const anchor = (line: number) => ({ section: null, line_start: line, line_end: line, quote: 'the passage' });
const finding = (id: string, gate: 'block' | 'advise', rule: string) => ({
  id,
  rule,
  detector: 'spec_graph',
  severity: gate === 'block' ? 'high' : 'medium',
  gate,
  title: `${rule} title`,
  message: `${rule} message`,
  anchor: anchor(4),
  related: [{ path: 'b.md', anchor: anchor(7) }],
  evidence: [],
  source: 'deterministic',
  suggestion: null,
});

function bridge() {
  return createMfeBridgeFixture({
    domainId: 'd',
    instanceId: 'i',
    initialProperties: { [FRONTX_SHARED_PROPERTY_THEME]: 'default', [FRONTX_SHARED_PROPERTY_LANGUAGE]: 'en' },
  }).bridge;
}

describe('SpecGraphScreen', () => {
  beforeEach(() => {
    translations.mockReturnValue({
      t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
      loading: false,
    });
    scope.project = 'p1';
    scope.available = null;
    for (const k of Object.keys(service)) delete service[k];
  });

  it('asks for a project when none is open', () => {
    scope.project = null;
    render(<SpecGraphScreen bridge={bridge()} />);
    expect(screen.getByText('no_project')).toBeTruthy();
  });

  it('offers the setup form for a project the service does not know', async () => {
    const setup = vi.fn(() => Promise.resolve({ project_id: 'p1', registered: true, project: null, service: null }));
    Object.assign(service, {
      project: query({ project_id: 'p1', registered: false, project: null, service: null }),
      setup: () => ({ fetch: setup }),
      check: () => ({ fetch: () => Promise.resolve({ revision: 'abc', count: 0, blocking: 0, dismissed: 0, documents: [] }) }),
    });
    render(<SpecGraphScreen bridge={bridge()} />);
    fireEvent.change(await screen.findByDisplayValue('--docs-root docs --name docs .'), {
      target: { value: 'gears/a gears/b' },
    });
    fireEvent.click(screen.getByText('setup_submit'));
    await waitFor(() => expect(setup).toHaveBeenCalledWith({ scope: 'gears/a gears/b' }));
    expect(await screen.findByText('nothing')).toBeTruthy();
  });

  it('lists the findings now by document, blocking first, and a decision takes one out', async () => {
    const decide = vi.fn((..._args: unknown[]) => Promise.resolve({}));
    Object.assign(service, {
      project: query({
        project_id: 'p1',
        registered: true,
        project: { repository: { url: 'u', ref: 'main' } },
        service: null,
      }),
      check: () => ({
        fetch: () =>
          Promise.resolve({
            revision: 'a92339a1a9b1b99e',
            count: 2,
            blocking: 1,
            dismissed: 0,
            documents: [
              { path: 'z.md', detector: 'spec_graph', findings: [finding('f2', 'advise', 'contradiction.value')] },
              { path: 'a.md', detector: 'spec_graph', findings: [finding('f1', 'block', 'link.resolves')] },
            ],
          }),
      }),
      decide: (projectId: string, fingerprint: string) => ({
        fetch: (body: unknown) => decide(projectId, fingerprint, body),
      }),
    });
    render(<SpecGraphScreen bridge={bridge()} />);
    expect(await screen.findByText('link.resolves title')).toBeTruthy();
    const paths = screen.getAllByText(/^[az]\.md$/).map((e) => e.textContent);
    expect(paths).toEqual(['a.md', 'z.md']);
    expect(screen.getByText('a.md:4')).toBeTruthy();
    expect(screen.getAllByText('b.md:7')).toHaveLength(2);
    expect(screen.getByText(/main @ a92339a1a9b1/)).toBeTruthy();

    fireEvent.click(screen.getAllByText('dismiss')[0]);
    await waitFor(() =>
      expect(decide).toHaveBeenCalledWith('p1', 'f1', { decision: 'dismissed', rule: 'link.resolves' })
    );
    await waitFor(() => expect(screen.queryByText('link.resolves title')).toBeNull());
    expect(screen.getByText(/dismissed_one/)).toBeTruthy();
  });

  it('reads the stored findings on the second view', async () => {
    const findings = vi.fn(() =>
      Promise.resolve({
        items: [{ path: 'd.md', detector: 'spec_graph', findings: [finding('g1', 'advise', 'contradiction.value')] }],
        total: 1,
        dismissed: 0,
      })
    );
    Object.assign(service, {
      project: query({ project_id: 'p1', registered: true, project: null, service: null }),
      check: () => ({ fetch: () => Promise.resolve({ revision: 'r', count: 0, blocking: 0, dismissed: 0, documents: [] }) }),
      findings: () => ({ fetch: findings }),
    });
    render(<SpecGraphScreen bridge={bridge()} />);
    await screen.findByText('nothing');
    fireEvent.click(screen.getByText('view_stored'));
    expect(await screen.findByText('contradiction.value title')).toBeTruthy();
    expect(findings).toHaveBeenCalled();
  });

  it("offers Pull requests only where project-git's pull-request is installed", async () => {
    Object.assign(service, {
      project: query({ project_id: 'p1', registered: true, project: null, repository: 'o/r', service: null }),
      check: () => ({ fetch: () => Promise.resolve({ revision: 'r', count: 0, blocking: 0, dismissed: 0, documents: [] }) }),
    });
    scope.available = { routes: ['/spec-graph'], kits: ['spec-graph'], types: [] };
    const { unmount } = render(<SpecGraphScreen bridge={bridge()} />);
    await screen.findByText('nothing');
    expect(screen.queryByText('view_pulls')).toBeNull();
    expect(screen.getByText('view_graph')).toBeTruthy();
    unmount();

    scope.available = { routes: ['/spec-graph'], kits: ['spec-graph'], types: ['gts.cf.studio.domain.pull_request.v1~'] };
    render(<SpecGraphScreen bridge={bridge()} />);
    await screen.findByText('nothing');
    expect(screen.getByText('view_pulls')).toBeTruthy();
  });
});
