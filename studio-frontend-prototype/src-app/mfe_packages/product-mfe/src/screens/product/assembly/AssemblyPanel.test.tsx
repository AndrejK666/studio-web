import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import type { ChildMfeBridge } from '@gears-frontx/react';

vi.mock('../../../i18n', () => ({
  useAssemblyTranslations: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
    loading: false,
  }),
}));

import { api } from '../../../api/client';
import type { AssemblyStrategy } from '../../../model/assembly';
import type { GearMatch } from '../../../model/gear-match';
import { ScopeContext, type Scope } from '../../common';
import { AssemblyPanel } from './AssemblyPanel';

const scope: Scope = {
  projectId: 'p1',
  workspaceId: 'w1',
  orgId: 'o1',
  language: 'en',
  bridge: {} as ChildMfeBridge,
  container: createRef<HTMLDivElement>(),
};

const strategy = (extra: Partial<AssemblyStrategy> = {}): AssemblyStrategy => ({
  organization_id: 'o1',
  project_id: 'p1',
  strategy: 'spec_mapping',
  chosen: 'spec_mapping',
  source: 'studio',
  gears_matcher: { kit_installed: true, configured: true, offered: true },
  strategies: ['spec_mapping', 'gears_matcher'],
  settable: true,
  may_set_default: false,
  ...extra,
});

const MATCH: GearMatch = {
  summary: { match_id: 'm1', state: 'succeeded', requested_by: 'u', created_at: '2026-11-18T10:00:00Z' },
  project_id: 'p1',
  product: 'todo-app',
  documents: [],
  questions: [],
  requirements: [
    {
      requirement_id: 'cpt-x-fr-sign-in',
      kind: 'fr',
      coverage: 'covered',
      low_confidence: false,
      extracted: false,
      reason: '',
      gear_provides: '',
      remaining_work: '',
      action: 'propose',
      candidates: [
        {
          gear_id: 'gears-rust/authn-resolver',
          pick: 'authn-resolver',
          verdict: 'covered',
          role: 'chosen',
          evidence: '',
          covers: '',
          missing: '',
          rationale: '',
          proposed: true,
        },
      ],
    },
  ],
};

const found = (selector: string) =>
  waitFor(() => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`not drawn: ${selector}`);
    return el as HTMLElement;
  });

function draw() {
  const changed = vi.fn();
  render(
    <ScopeContext.Provider value={scope}>
      <AssemblyPanel round={0} onChanged={changed} />
    </ScopeContext.Provider>
  );
  return changed;
}

describe('AssemblyPanel', () => {
  beforeEach(() => {
    vi.spyOn(api, 'projectProduct').mockResolvedValue({ product_id: 'todo-app', gears: ['api-gateway'] });
    vi.spyOn(api, 'gearboxCatalogue').mockRejectedValue(new Error('no corpus'));
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the strategy used and where it comes from, and why it falls back', async () => {
    vi.spyOn(api, 'assemblyStrategy').mockResolvedValue(
      strategy({
        chosen: 'gears_matcher',
        source: 'organization',
        organization_default: 'gears_matcher',
        fallback: { code: 'KIT_NOT_INSTALLED', reason: 'not installed' },
        gears_matcher: { kit_installed: false, configured: true, offered: false },
      })
    );
    draw();
    expect((await found('[data-product-assembly-effective]')).getAttribute('data-product-assembly-effective')).toBe('spec_mapping');
    expect(document.querySelector('[data-product-assembly-source="organization"]')).toBeTruthy();
    expect(document.querySelector('[data-product-assembly-fallback="KIT_NOT_INSTALLED"]')).toBeTruthy();
    // The matcher is shown, not offered.
    expect((document.querySelector('[data-product-assembly-choice="gears_matcher"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps the project choice', async () => {
    vi.spyOn(api, 'assemblyStrategy').mockResolvedValue(strategy());
    const set = vi
      .spyOn(api, 'setAssemblyStrategy')
      .mockResolvedValue(strategy({ strategy: 'gears_matcher', chosen: 'gears_matcher', source: 'project', project: 'gears_matcher' }));
    draw();
    fireEvent.click(await found('[data-product-assembly-choice="gears_matcher"]'));
    await waitFor(() => expect(set).toHaveBeenCalledWith('', 'p1', 'gears_matcher'));
    await found('[data-product-assembly-effective="gears_matcher"]');
    fireEvent.click(document.querySelector('[data-product-assembly-choice="default"]')!);
    await waitFor(() => expect(set).toHaveBeenCalledWith('', 'p1', null));
  });

  it('proposes from the spec plan and adds only what the person confirms', async () => {
    vi.spyOn(api, 'assemblyStrategy').mockResolvedValue(strategy());
    vi.spyOn(api, 'projectPlan').mockResolvedValue({
      items: [
        {
          capability: 'auth',
          gap: false,
          unbuilt: false,
          candidates: [{ name: 'authn-resolver', kind: 'gear', step: 'contract', score: 1, why: [], built: 'built', composable: 'runs' }],
        },
      ],
      total: 1,
    });
    const complete = vi
      .spyOn(api, 'completeProduct')
      .mockResolvedValue({ gears: ['api-gateway', 'authn-resolver', 'tenant-resolver'], changes: [{ gear: 'tenant-resolver', added: true, reason: 'needed' }], config: {} });
    const save = vi.spyOn(api, 'saveProjectProduct').mockResolvedValue({} as never);
    const changed = draw();
    fireEvent.click(await found('[data-product-assembly-propose]'));
    await found('[data-product-assembly-proposal="authn-resolver"]');
    expect(complete).toHaveBeenCalledWith('', ['api-gateway', 'authn-resolver'], {});
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector('[data-product-assembly-confirm]')!);
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(save.mock.calls[0][2]).toMatchObject({ product_id: 'todo-app', gears: ['api-gateway', 'authn-resolver', 'tenant-resolver'] });
  });

  it('proposes from the latest gear match and accepts what went in', async () => {
    vi.spyOn(api, 'assemblyStrategy').mockResolvedValue(
      strategy({ strategy: 'gears_matcher', chosen: 'gears_matcher', source: 'project', project: 'gears_matcher' })
    );
    vi.spyOn(api, 'gearMatch').mockResolvedValue(MATCH);
    vi.spyOn(api, 'completeProduct').mockResolvedValue({ gears: ['api-gateway', 'authn-resolver'], changes: [], config: {} });
    vi.spyOn(api, 'saveProjectProduct').mockResolvedValue({} as never);
    const decide = vi.spyOn(api, 'putGearMatchDecision').mockResolvedValue({ subject: 'cpt-x-fr-sign-in' });
    draw();
    fireEvent.click(await found('[data-product-assembly-propose]'));
    fireEvent.click(await found('[data-product-assembly-confirm]'));
    await waitFor(() => expect(decide).toHaveBeenCalled());
    expect(decide.mock.calls[0][2]).toMatchObject({ gear_id: 'gears-rust/authn-resolver', decision: 'accepted' });
  });
});
