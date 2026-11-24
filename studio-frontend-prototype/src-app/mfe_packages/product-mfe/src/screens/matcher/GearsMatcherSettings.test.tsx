import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubResizeObserver } from '@frontx-test-utils/stubResizeObserver';

stubResizeObserver();
// The kit's Checkbox (Base UI) builds a PointerEvent on click, which jsdom lacks.
if (typeof window.PointerEvent === 'undefined') {
  (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = MouseEvent;
}

vi.mock('../../i18n', () => ({
  useAssemblyTranslations: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
    loading: false,
  }),
}));

import { api } from '../../api/client';
import type { AssemblyStrategy } from '../../model/assembly';
import type { GearMatchUsage } from '../../model/gear-match-usage';
import type { MatcherSettings } from '../../model/matcher-settings';
import { GearsMatcherSettings } from './GearsMatcherSettings';

const strategy = (extra: Partial<AssemblyStrategy> = {}): AssemblyStrategy => ({
  organization_id: 'o1',
  strategy: 'spec_mapping',
  chosen: 'spec_mapping',
  source: 'studio',
  gears_matcher: { kit_installed: true, configured: true, offered: true },
  strategies: ['spec_mapping', 'gears_matcher'],
  strategy_kits: [
    { id: 'spec_mapping', name: 'Spec mapping', description: '', kit: 'spec-mapping', offered: true },
    { id: 'gears_matcher', name: 'Gears matcher', description: '', kit: 'gears-matcher', offered: true },
  ],
  settable: true,
  may_set_default: true,
  ...extra,
});

const usage = (extra: Partial<GearMatchUsage> = {}): GearMatchUsage => ({
  organization_id: 'o1',
  period_days: 30,
  since: '2026-10-20T00:00:00Z',
  summary: {
    projects: 2,
    projects_matched: 1,
    strategies: [
      { key: 'gears_matcher', projects: 1 },
      { key: 'spec_mapping', projects: 1 },
    ],
    sources: [{ key: 'organization', projects: 2 }],
    fallbacks: [],
    runs: { total: 2, succeeded: 1, partial: 0, failed: 1, cancelled: 0, running: 0 },
    usage: { calls: 127, cache_hits: 0, input_tokens: 651_649, output_tokens: 51_192 },
    accepted: 0,
    rejected: 0,
    questions_open: 17,
    questions_answered: 0,
    median_run_ms: 1_340_830,
  },
  service: {
    configured: true,
    answers: true,
    checked_at: '2026-11-19T08:00:00Z',
    service_version: '0.1.0',
    catalogue_source: 'gears-rust',
    catalogue_commit: 'c14f0fb5dd420fbed2476768064962e0b4c74d48',
    models: ['claude-sonnet-4-6'],
    limits: { max_documents: 20, max_document_bytes: 500_000, max_request_bytes: 2_000_000 },
  },
  items: [
    {
      project_id: 'd5e76267',
      project_name: 'Studioweb',
      workspace_id: 'w1',
      workspace_name: 'Main',
      strategy: 'gears_matcher',
      chosen: 'gears_matcher',
      source: 'organization',
      last_run: {
        match_id: 'm1',
        state: 'succeeded',
        created_at: '2026-11-18T17:22:00Z',
        totals: { requirements: 54, covered: 3, partial: 10, gap: 24, clarification_needed: 17, not_assessed: 0 },
      },
      runs: { total: 2, succeeded: 1, partial: 0, failed: 1, cancelled: 0, running: 0 },
      usage: { calls: 127, cache_hits: 0, input_tokens: 651_649, output_tokens: 51_192 },
      accepted: 0,
      rejected: 0,
      questions_open: 17,
      questions_answered: 0,
    },
  ],
  total: 1,
  ...extra,
});

const runValues = { provider: 'constructor', models: ['c1', 'c1', 'c1'], max_calls: 400, max_extract_calls: 60 };
const runSettings = (extra: Partial<MatcherSettings> = {}): MatcherSettings => ({
  strategy: 'gears_matcher',
  scope: 'deployment',
  may_change: true,
  version: 2,
  updated_at: '2026-11-20T10:00:00Z',
  updated_by: 'u-1',
  effective: runValues,
  config: runValues,
  overrides: { provider: null, models: null, max_calls: null, max_extract_calls: null },
  providers: [
    { id: 'constructor', available: true },
    { id: 'anthropic', available: false, reason: 'ANTHROPIC_API_KEY is not set' },
    { id: 'openai', available: true },
  ],
  ceilings: { max_calls: 2000, max_extract_calls: 500 },
  ...extra,
});

const found = (selector: string) =>
  waitFor(() => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`not drawn: ${selector}`);
    return el as HTMLElement;
  });

describe('GearsMatcherSettings', () => {
  beforeEach(() => {
    vi.spyOn(api, 'matcherSettings').mockResolvedValue(runSettings({ may_change: false }));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/');
  });

  it('offers only the installed strategies, without a Studio default chip', async () => {
    vi.spyOn(api, 'organizationAssemblyStrategy').mockResolvedValue(strategy());
    vi.spyOn(api, 'gearMatchUsage').mockResolvedValue(usage());
    const set = vi.spyOn(api, 'setOrganizationAssemblyStrategy').mockResolvedValue(
      strategy({ organization_default: 'gears_matcher', strategy: 'gears_matcher', chosen: 'gears_matcher', source: 'organization' })
    );
    render(<GearsMatcherSettings orgId="o1" />);
    const choices = await waitFor(() => {
      const all = document.querySelectorAll('[data-gears-matcher-default-choice]');
      if (all.length === 0) throw new Error('no choice');
      return [...all].map((b) => b.getAttribute('data-gears-matcher-default-choice'));
    });
    expect(choices).toEqual(['spec_mapping', 'gears_matcher']);
    fireEvent.click(document.querySelector('[data-gears-matcher-default-choice="gears_matcher"]')!);
    await waitFor(() => expect(set).toHaveBeenCalledWith('', 'o1', 'gears_matcher'));
  });

  it('with one strategy kit, says it is the default with nothing to choose', async () => {
    vi.spyOn(api, 'organizationAssemblyStrategy').mockResolvedValue(
      strategy({
        strategy: 'gears_matcher',
        chosen: 'gears_matcher',
        strategies: ['gears_matcher'],
        strategy_kits: [{ id: 'gears_matcher', name: 'Gears matcher', description: '', kit: 'gears-matcher', offered: true }],
      })
    );
    vi.spyOn(api, 'gearMatchUsage').mockResolvedValue(usage());
    render(<GearsMatcherSettings orgId="o1" />);
    await found('[data-gears-matcher-default-only="gears_matcher"]');
    expect(document.querySelector('[data-gears-matcher-default-choice]')).toBeNull();
  });

  it('shows the live service check, the tiles and a row per project', async () => {
    vi.spyOn(api, 'organizationAssemblyStrategy').mockResolvedValue(strategy());
    vi.spyOn(api, 'gearMatchUsage').mockResolvedValue(usage());
    render(<GearsMatcherSettings orgId="o1" />);
    expect((await found('[data-gears-matcher-service]')).getAttribute('data-gears-matcher-service')).toBe('ready');
    await found('[data-gear-match-usage-tile="tokens"]');
    expect(document.querySelector('[data-gear-match-usage-tile="questions"]')?.textContent).toContain('17');
    await found('[data-gear-match-usage-project="d5e76267"]');
    expect(document.querySelector('[data-gear-match-usage-last="succeeded"]')).toBeTruthy();
  });

  it('says plainly when the service is configured but does not answer', async () => {
    vi.spyOn(api, 'organizationAssemblyStrategy').mockResolvedValue(strategy());
    vi.spyOn(api, 'gearMatchUsage').mockResolvedValue(
      usage({ service: { configured: true, answers: false, error: 'connection refused', models: [] } })
    );
    render(<GearsMatcherSettings orgId="o1" />);
    expect((await found('[data-gears-matcher-service="silent"]')).textContent).toContain('org_service_silent');
    expect((await found('[data-gears-matcher-service-error]')).textContent).toContain('connection refused');
  });

  it('keeps the period in the address and reads it again', async () => {
    vi.spyOn(api, 'organizationAssemblyStrategy').mockResolvedValue(strategy());
    const read = vi.spyOn(api, 'gearMatchUsage').mockResolvedValue(usage());
    window.history.replaceState(null, '', '/?gmu.f.period=7');
    render(<GearsMatcherSettings orgId="o1" />);
    await waitFor(() => expect(read).toHaveBeenCalledWith('', 'o1', 7));
    fireEvent.click(await found('[data-gear-match-usage-period="90"]'));
    await waitFor(() => expect(read).toHaveBeenCalledWith('', 'o1', 90));
    expect(window.location.search).toContain('period=90');
  });

  it("shows a block per service strategy and connects an organization kit's service", async () => {
    vi.spyOn(api, 'organizationAssemblyStrategy').mockResolvedValue(strategy());
    const shipped = usage().service;
    vi.spyOn(api, 'gearMatchUsage').mockResolvedValue(
      usage({
        services: {
          gears_matcher: { ...shipped, strategy: 'gears_matcher', name: 'Gears matcher', kit: 'gears-matcher', code: null },
          acme_matcher: {
            strategy: 'acme_matcher',
            name: 'Acme matcher',
            kit: 'acme-matcher',
            code: 'STRATEGY_NOT_CONNECTED',
            configured: false,
            missing: 'no service is connected',
            models: [],
          },
        },
      })
    );
    const connect = vi.spyOn(api, 'connectStrategyService').mockResolvedValue({ id: 'c1' });
    render(<GearsMatcherSettings orgId="o1" />);
    await found('[data-gears-matcher-service-card="gears_matcher"]');
    expect(document.querySelector('[data-gears-matcher-service="unconnected"]')).toBeTruthy();
    fireEvent.change(await found('[data-gears-matcher-connect-url]'), { target: { value: 'https://acme.example/matcher' } });
    fireEvent.change(await found('[data-gears-matcher-connect-secret]'), { target: { value: 's3cret' } });
    fireEvent.click(await found('[data-gears-matcher-connect-submit]'));
    await waitFor(() =>
      expect(connect).toHaveBeenCalledWith('', 'o1', 'acme_matcher', 'https://acme.example/matcher', 's3cret', 'Acme matcher')
    );
  });

  it('shows the run settings read-only to a caller who may not change them, with no key anywhere', async () => {
    vi.spyOn(api, 'organizationAssemblyStrategy').mockResolvedValue(strategy());
    vi.spyOn(api, 'gearMatchUsage').mockResolvedValue(usage());
    render(<GearsMatcherSettings orgId="o1" />);
    const block = await found('[data-matcher-settings="deployment"]');
    expect(block.getAttribute('data-matcher-settings-may-change')).toBe('false');
    expect(block.textContent).toContain('run_scope_deployment');
    expect(document.querySelector('[data-matcher-settings-effective]')?.textContent).toContain('c1, c1, c1');
    expect(document.querySelector('[data-matcher-settings-save]')).toBeNull();
    expect(block.querySelector('input[type="password"]')).toBeNull();
  });

  it('saves the override against the version read; an unavailable provider cannot be picked', async () => {
    vi.spyOn(api, 'organizationAssemblyStrategy').mockResolvedValue(strategy());
    const reads = vi.spyOn(api, 'gearMatchUsage').mockResolvedValue(usage());
    vi.spyOn(api, 'matcherSettings').mockResolvedValue(runSettings());
    const put = vi.spyOn(api, 'putMatcherSettings').mockResolvedValue(
      runSettings({ version: 3, overrides: { provider: 'openai', models: ['gpt-x'], max_calls: 300, max_extract_calls: null } })
    );
    render(<GearsMatcherSettings orgId="o1" />);
    const provider = (await found('[data-matcher-settings-provider]')) as HTMLSelectElement;
    expect(provider.querySelector('option[value="anthropic"]')?.hasAttribute('disabled')).toBe(true);
    fireEvent.change(provider, { target: { value: 'openai' } });
    fireEvent.click(await found('[data-matcher-settings-same-model]'));
    fireEvent.change(await found('[data-matcher-settings-model="0"]'), { target: { value: 'gpt-x' } });
    fireEvent.change(await found('[data-matcher-settings-max-calls]'), { target: { value: '300' } });
    const before = reads.mock.calls.length;
    fireEvent.click(await found('[data-matcher-settings-save]'));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('', 'o1', 'gears_matcher', {
        version: 2,
        overrides: { provider: 'openai', models: ['gpt-x'], max_calls: 300, max_extract_calls: null },
      })
    );
    // The card reads the service's live check again, for the new models.
    await waitFor(() => expect(reads.mock.calls.length).toBeGreaterThan(before));
  });

  it('refuses a bound over its ceiling before anything is sent', async () => {
    vi.spyOn(api, 'organizationAssemblyStrategy').mockResolvedValue(strategy());
    vi.spyOn(api, 'gearMatchUsage').mockResolvedValue(usage());
    vi.spyOn(api, 'matcherSettings').mockResolvedValue(runSettings());
    const put = vi.spyOn(api, 'putMatcherSettings');
    render(<GearsMatcherSettings orgId="o1" />);
    fireEvent.change(await found('[data-matcher-settings-max-calls]'), { target: { value: '5000' } });
    fireEvent.click(await found('[data-matcher-settings-save]'));
    expect((await found('[data-matcher-settings-save-error]')).textContent).toContain('run_max_calls_bad');
    expect(put).not.toHaveBeenCalled();
  });

  it('on a conflict says the settings changed and reads them again', async () => {
    vi.spyOn(api, 'organizationAssemblyStrategy').mockResolvedValue(strategy());
    vi.spyOn(api, 'gearMatchUsage').mockResolvedValue(usage());
    const read = vi.spyOn(api, 'matcherSettings').mockResolvedValue(runSettings());
    vi.spyOn(api, 'putMatcherSettings').mockRejectedValue(Object.assign(new Error('conflict'), { response: { status: 409 } }));
    render(<GearsMatcherSettings orgId="o1" />);
    fireEvent.click(await found('[data-matcher-settings-save]'));
    await found('[data-matcher-settings-conflict]');
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});
