import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { stubResizeObserver } from '@frontx-test-utils/stubResizeObserver';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MnaDeal, MnaEvidence, MnaFinding } from '../../api/types';

// The kit's DataGrid measures its header.
stubResizeObserver();

const { state, service, cache, calls } = vi.hoisted(() => ({
  state: { project: 'p1' as string | null, reads: {} as Record<string, unknown> },
  service: {} as Record<string, unknown>,
  cache: { set: vi.fn(), invalidate: vi.fn(() => Promise.resolve()) },
  calls: [] as { what: string; body?: unknown }[],
}));

vi.mock('../../i18n', () => ({
  useMnaTranslations: () => ({
    t: Object.assign(
      (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
      { count: (key: string, n: number) => `${key}:${n}` }
    ),
    loading: false,
  }),
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  apiRegistry: { getService: () => service },
  useSharedProperty: () => state.project,
  useQueryCache: () => cache,
  // A read is `{ key }`: the screen sees what the test put under that key.
  useApiQuery: (query: { key: string }) => {
    const value = state.reads[query.key];
    return value instanceof Error
      ? { data: undefined, error: value, isLoading: false, isFetching: false, refetch: vi.fn() }
      : { data: value, error: null, isLoading: false, isFetching: false, refetch: vi.fn() };
  },
}));

vi.mock('@constructor-studio/mfe-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@constructor-studio/mfe-shared')>()),
  useHostChrome: () => ({ containerRef: { current: null }, dataTheme: 'light', language: 'en' }),
}));

import { DealScreen } from './DealScreen';

const NOW = '2026-11-19T10:00:00Z';

const DEAL: MnaDeal = {
  project_id: 'p1',
  installed: true,
  target: 'Acme Robotics',
  thesis: 'Buy the fleet platform',
  deal_phase: 'confirmatory_dd',
  ic_date: '2026-12-01',
  recommendation: 'proceed_with_conditions',
  conditions: ['Fix the mainline'],
  signed_off_by: null,
  signed_off_at: null,
  deal_lead: 'lead-1',
  may_sign_off: true,
  phases: ['screening', 'confirmatory_dd', 'signing', 'integration'],
  recommendations: ['proceed', 'proceed_with_conditions', 'stop'],
};

const EVIDENCE: MnaEvidence = {
  project_id: 'p1',
  read_at: NOW,
  repositories: [{ full_path: 'acme/fleet', branch: 'main', synced_at: NOW, contributors: 7, truck_factor: 2 }],
  facts: [
    { key: 'repositories', value: 1, total: null, available: true, source: 'studio-artifact-ingest', detail: null },
    { key: 'truck_factor', value: 5, total: null, available: false, source: 'git history', detail: 'no commits read yet' },
    { key: 'ci_pass_rate', value: 0.5, total: 12, available: true, source: 'CI runs', detail: null },
    { key: 'brand_new_fact', value: 4, total: null, available: true, source: 'somewhere', detail: null },
  ],
};

const FINDING: MnaFinding = {
  id: 'f1',
  title: 'Secrets in the repository',
  severity: 'critical',
  source: 'acme/fleet',
  evidence: null,
  origin: 'manual',
  status: 'open',
  created_by: 'u1',
  created_at: NOW,
  updated_at: NOW,
};

const read = (key: string) => () => ({ key });
const write = (what: string, answer: unknown = undefined) =>
  vi.fn(() => ({
    fetch: (body?: unknown) => {
      calls.push({ what, body });
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  }));

describe('Project › Deal', () => {
  beforeEach(() => {
    state.project = 'p1';
    state.reads = {
      deal: DEAL,
      evidence: EVIDENCE,
      findings: { items: [FINDING], total: 1 },
      risks: { items: [], total: 0 },
      questions: { items: [], total: 0 },
    };
    calls.length = 0;
    cache.set.mockReset();
    cache.invalidate.mockClear();
    Object.assign(service, {
      deal: read('deal'),
      evidence: read('evidence'),
      findings: read('findings'),
      risks: read('risks'),
      questions: read('questions'),
      updateDeal: write('updateDeal', { ...DEAL, thesis: 'New thesis' }),
      signOff: write('signOff', { ...DEAL, signed_off_by: 'lead-1', signed_off_at: NOW }),
      create: write('create', FINDING),
      update: write('update', FINDING),
      remove: write('remove'),
    });
  });
  afterEach(cleanup);

  it('shows the target, its phase and the recommendation, and lets the deal lead sign off', async () => {
    render(<DealScreen />);
    expect(screen.getByText('Acme Robotics')).toBeTruthy();
    expect(screen.getByText('phase_confirmatory_dd')).toBeTruthy();
    expect(screen.getByText('recommendation_proceed_with_conditions')).toBeTruthy();
    expect(screen.getByText('Fix the mainline')).toBeTruthy();
    const button = document.querySelector('[data-mna-sign-off]') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(document.querySelector('[data-mna-lead-only]')).toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(cache.set).toHaveBeenCalled());
    expect(calls).toEqual([{ what: 'signOff', body: undefined }]);
    expect(cache.set.mock.calls[0][1]).toMatchObject({ signed_off_by: 'lead-1' });
  });

  it('keeps Sign off closed to anyone but the deal lead, and says who signs', () => {
    state.reads.deal = { ...DEAL, may_sign_off: false };
    render(<DealScreen />);
    expect((document.querySelector('[data-mna-sign-off]') as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('[data-mna-lead-only]')).not.toBeNull();
  });

  it('keeps Sign off closed without a recommendation', () => {
    state.reads.deal = { ...DEAL, recommendation: null, conditions: [] };
    render(<DealScreen />);
    expect((document.querySelector('[data-mna-sign-off]') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('no_recommendation')).toBeTruthy();
  });

  it('says a sign-off is the caller’s, and that changing the recommendation clears it', () => {
    state.reads.deal = { ...DEAL, signed_off_by: 'lead-1', signed_off_at: NOW };
    render(<DealScreen />);
    expect(document.querySelector('[data-mna-signed-off]')?.textContent).toContain('"who":"you"');
    expect(screen.getByText('clears_sign_off')).toBeTruthy();
  });

  it('shows "not available" with the reason for a fact it could not read, never its number', () => {
    render(<DealScreen />);
    const tile = document.querySelector('[data-mna-fact="truck_factor"]')!;
    expect(tile.textContent).toContain('not_available');
    expect(tile.textContent).toContain('no commits read yet');
    expect(tile.textContent).not.toContain('5');
    expect(tile.textContent).toContain('git history');
    expect(document.querySelector('[data-mna-fact="ci_pass_rate"]')?.textContent).toContain('50%');
    expect(document.querySelector('[data-mna-fact="ci_pass_rate"]')?.textContent).toContain('of_runs:12');
    // An unknown key shows under its own name, with its source.
    const other = document.querySelector('[data-mna-fact-group="other"] [data-mna-fact="brand_new_fact"]')!;
    expect(other.textContent).toContain('brand_new_fact');
    expect(other.textContent).toContain('somewhere');
    expect(document.querySelector('[data-mna-repository="acme/fleet"]')).not.toBeNull();
  });

  it('lists the findings through the grid, and a row opens it for editing', async () => {
    render(<DealScreen />);
    await waitFor(() =>
      expect(document.querySelector('[data-list-grid="mna-findings"] [data-mna-finding="f1"]')).not.toBeNull()
    );
    fireEvent.click(document.querySelector('[data-mna-finding="f1"]')!.closest('td')!);
    const dialog = await waitFor(() => {
      const found = document.querySelector('[data-form-dialog="findings"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect((dialog.querySelector('#findings-title') as HTMLInputElement).value).toBe('Secrets in the repository');
    fireEvent.click(dialog.querySelector('[data-form-save]')!);
    await waitFor(() => expect(calls.some((c) => c.what === 'update')).toBe(true));
    expect(calls.find((c) => c.what === 'update')?.body).toEqual({
      title: 'Secrets in the repository',
      severity: 'critical',
      source: 'acme/fleet',
      origin: 'manual',
      status: 'open',
    });
    expect(cache.invalidate).toHaveBeenCalled();
  });

  it('adds a risk from the Add button', async () => {
    render(<DealScreen />);
    fireEvent.click(document.querySelector('[data-mna-add="risks"]')!);
    const dialog = await waitFor(() => document.querySelector('[data-form-dialog="risks"]')!);
    const save = dialog.querySelector('[data-form-save]') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(dialog.querySelector('#risks-title')!, { target: { value: 'Key person leaves' } });
    fireEvent.change(dialog.querySelector('#risks-finding_id')!, { target: { value: 'f1' } });
    fireEvent.click(save);
    await waitFor(() => expect(calls.some((c) => c.what === 'create')).toBe(true));
    expect(calls.find((c) => c.what === 'create')?.body).toEqual({
      title: 'Key person leaves',
      likelihood: 'medium',
      impact: 'medium',
      finding_id: 'f1',
      status: 'open',
    });
  });

  it('saves the thesis', async () => {
    render(<DealScreen />);
    const save = document.querySelector('[data-mna-thesis-save]') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(document.querySelector('[data-mna-thesis-text]')!, { target: { value: 'New thesis' } });
    fireEvent.click(save);
    await waitFor(() => expect(cache.set).toHaveBeenCalled());
    expect(calls).toEqual([{ what: 'updateDeal', body: { thesis: 'New thesis' } }]);
  });

  it('says the kit does not apply where it is not installed, and nothing else', () => {
    state.reads.deal = { ...DEAL, installed: false };
    render(<DealScreen />);
    expect(document.querySelector('[data-mna-not-installed]')).not.toBeNull();
    expect(document.querySelector('[data-mna-evidence]')).toBeNull();
    expect(document.querySelector('[data-mna-ledger]')).toBeNull();
  });

  it('shows why the deal could not be read', () => {
    state.reads.deal = new Error('studio-kits is down');
    render(<DealScreen />);
    expect(screen.getByRole('alert').textContent).toContain('studio-kits is down');
  });

  it('asks for a project when none is open', () => {
    state.project = null;
    render(<DealScreen />);
    expect(screen.getByText('no_project')).toBeTruthy();
  });
});
