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
    // The graph's state above every view: an empty graph, no runs, one Git source.
    Object.assign(service, {
      ontology: query({ answer: { nodes: {}, edges: {}, counts: {} } }),
      runs: query({ items: [], total: 0 }),
      reviews: query({ items: [], total: 0 }),
      sources: query({ items: [{ name: 'insight' }] }),
    });
  });

  it('asks for a project when none is open', () => {
    scope.project = null;
    render(<SpecGraphScreen bridge={bridge()} />);
    expect(screen.getByText('no_project')).toBeTruthy();
  });

  it('offers the setup form for a project the service does not know', async () => {
    const setup = vi.fn(() => Promise.resolve({ project_id: 'p1', registered: true, project: null, service: null }));
    const start = vi.fn((..._args: unknown[]) => Promise.resolve({ run: { id: 'r1', job: 'index', state: 'queued' } }));
    Object.assign(service, {
      startRun: () => ({ fetch: start }),
      project: query({ project_id: 'p1', registered: false, project: null, service: null }),
      setup: () => ({ fetch: setup }),
      check: () => ({ fetch: () => Promise.resolve({ revision: 'abc', count: 0, blocking: 0, dismissed: 0, documents: [] }) }),
    });
    render(<SpecGraphScreen bridge={bridge()} />);
    // One documentation directory by default, named after the project's first source.
    expect(await screen.findByDisplayValue('insight')).toBeTruthy();
    expect(screen.getByText('--docs-root docs --name insight .')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('setup_layout_gears'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'gears/a\ngears/b' } });
    expect(screen.getByText('gears/a gears/b', { selector: 'code' })).toBeTruthy();
    fireEvent.click(screen.getByText('setup_submit'));
    await waitFor(() => expect(setup).toHaveBeenCalledWith({ scope: 'gears/a gears/b' }));
    // the graph is built at once: the structure and the deterministic findings, no model unless asked
    await waitFor(() => expect(start).toHaveBeenCalledWith({ job: 'index', params: { facts: false, findings: true } }));
    expect(start).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('nothing')).toBeTruthy();
  });

  it('builds the graph from the bar, and offers Show in graph only once it is built', async () => {
    const start = vi.fn((..._args: unknown[]) => Promise.resolve({ run: { id: 'r1', job: 'index', state: 'queued' } }));
    Object.assign(service, {
      project: query({ project_id: 'p1', registered: true, project: { repository: { url: 'u', ref: 'main' } }, service: null }),
      check: () => ({
        fetch: () =>
          Promise.resolve({
            revision: 'abc',
            count: 1,
            blocking: 1,
            dismissed: 0,
            documents: [{ path: 'docs/a.md', detector: 'spec_graph', findings: [finding('f1', 'block', 'link.resolves')] }],
          }),
      }),
      startRun: () => ({ fetch: start }),
    });
    render(<SpecGraphScreen bridge={bridge()} />);
    expect(await screen.findByText('status_empty')).toBeTruthy();
    expect(await screen.findByText('link.resolves title')).toBeTruthy();
    expect(screen.queryByText('show_in_graph')).toBeNull();
    fireEvent.click(screen.getByText('status_build'));
    await waitFor(() => expect(start).toHaveBeenCalledWith({ job: 'index', params: { facts: false, findings: true } }));
    // with contradictions: the facts are extracted first, then the judge runs over them
    start.mockClear();
    fireEvent.click(screen.getByLabelText('build_contradictions'));
    expect((screen.getByLabelText('build_facts') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByText('status_build'));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(start.mock.calls.map((c) => c[0])).toEqual([
      { job: 'index', params: { facts: true, findings: true } },
      { job: 'contradictions', params: { cap: 60 } },
    ]);
    // the cap is the person's, and the bar says what it costs before it runs
    expect(screen.getByText(/build_cost/).textContent).toContain('"usd":"0.45"');
  });

  it('labels a finding for calibration without hiding it, and shows the quality view', async () => {
    const label = vi.fn((..._args: unknown[]) => Promise.resolve({}));
    Object.assign(service, {
      project: query({ project_id: 'p1', registered: true, project: { repository: { url: 'u', ref: 'main' } }, service: null }),
      check: () => ({
        fetch: () =>
          Promise.resolve({
            revision: 'abc',
            count: 1,
            blocking: 1,
            dismissed: 0,
            documents: [{ path: 'docs/a.md', detector: 'spec_graph', findings: [finding('f1', 'advise', 'contradiction.value')] }],
          }),
      }),
      label: (_p: string, fp: string) => ({ fetch: (body: unknown) => label(fp, body) }),
      metrics: query({
        answer: {
          findings: { total: 3, block: 2, advise: 1, by_rule: { 'link.resolves (block)': 2, 'contradiction.value (advise)': 1 } },
          requirements_p1: { count: 10, realized_in_markup: 4, realized_with_judge: 5, share_in_markup: 0.4, share_with_judge: 0.5 },
          conflicting_pairs: { pairs: 2, passages_not_linked: 1, same_document: 0 },
        },
      }),
      calibration: query({
        answer: {
          rules: { 'contradiction.value': { real: 9, not: 1, unsure: 2, decided: 10, precision: 0.9, precision_lower_95: 0.6, may_block: false } },
          threshold: { min_labels: 10, min_precision_lower: 0.7 },
        },
      }),
    });
    render(<SpecGraphScreen bridge={bridge()} />);
    fireEvent.click(await screen.findByText('label'));
    fireEvent.click(screen.getByLabelText('verdict_unsure'));
    fireEvent.change(screen.getByLabelText('label_note'), { target: { value: 'two scopes' } });
    fireEvent.click(screen.getByText('label_save'));
    await waitFor(() =>
      expect(label).toHaveBeenCalledWith('f1', { verdict: 'unsure', rule: 'contradiction.value', note: 'two scopes' })
    );
    expect(await screen.findByText(/labelled/)).toBeTruthy();
    expect(screen.getByText('contradiction.value title')).toBeTruthy();       // still shown
    fireEvent.click(screen.getByText('view_quality'));
    expect(await screen.findByText('50%')).toBeTruthy();                     // p1 realized
    const rows = screen.getAllByRole('row').map((r) => r.textContent);
    expect(rows.find((r) => r?.includes('contradiction.value'))).toContain('9 / 1 / 2');
    expect(rows.find((r) => r?.includes('contradiction.value'))).toContain('90% (≥ 60%)');
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
