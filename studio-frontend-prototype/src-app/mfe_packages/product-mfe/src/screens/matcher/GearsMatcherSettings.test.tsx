import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubResizeObserver } from '@frontx-test-utils/stubResizeObserver';

stubResizeObserver();

vi.mock('../../i18n', () => ({
  useAssemblyTranslations: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
    loading: false,
  }),
}));

import { api } from '../../api/client';
import type { AssemblyStrategy } from '../../model/assembly';
import type { GearMatchUsage } from '../../model/gear-match-usage';
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

const found = (selector: string) =>
  waitFor(() => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`not drawn: ${selector}`);
    return el as HTMLElement;
  });

describe('GearsMatcherSettings', () => {
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
});
