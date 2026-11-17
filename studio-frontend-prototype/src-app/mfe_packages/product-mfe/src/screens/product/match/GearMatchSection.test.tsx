import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import type { ChildMfeBridge } from '@gears-frontx/react';

vi.mock('../../../i18n', () => ({
  useMatchTranslations: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
    loading: false,
  }),
  useComponentsTranslations: () => ({ t: (key: string) => key, loading: false }),
}));
vi.mock('../catalogue', () => ({
  useGearCatalogue: () => ({
    index: { gears: [{ id: 'event-broker' }, { id: 'authn-resolver' }], name: (g: { id: string }) => g.id },
  }),
}));
vi.mock('../../components/ScaffoldDialog', () => ({
  ScaffoldDialog: ({ capability, problem }: { capability: string; problem?: string }) => (
    <div data-testid="scaffold">{`${capability}|${problem}`}</div>
  ),
}));

import { api } from '../../../api/client';
import type { GearMatch } from '../../../model/gear-match';
import { ScopeContext, type Scope } from '../../common';
import { GearMatchSection } from './GearMatchSection';

const scope: Scope = {
  projectId: 'p1',
  workspaceId: 'w1',
  orgId: 'o1',
  language: 'en',
  bridge: {} as ChildMfeBridge,
  container: createRef<HTMLDivElement>(),
};

const candidate = (pick: string, extra = {}) => ({
  gear_id: `gears-rust/${pick}`,
  pick,
  verdict: 'covered',
  role: 'chosen',
  evidence: 'resolves a bearer',
  covers: '',
  missing: '',
  rationale: '',
  in_code: true,
  proposed: true,
  ...extra,
});

const MATCH: GearMatch = {
  summary: {
    match_id: 'm1',
    state: 'succeeded',
    requested_by: 'me',
    created_at: '2026-11-17T10:00:00Z',
    totals: { requirements: 3, covered: 1, partial: 0, gap: 1, clarification_needed: 1, not_assessed: 0 },
  },
  project_id: 'p1',
  product: 'todo-app',
  documents: [{ path: 'upload:PRD.md', matcher_path: 'upload/PRD.md', sha256: 'a'.repeat(64), bytes: 10, answered: [] }],
  catalogue_commit: 'c14f0fb5dd42',
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
      candidates: [candidate('authn-resolver')],
      passage: { path: 'upload:PRD.md', line: 3, text: '#### Sign in\nUsers sign in.' },
    },
    {
      requirement_id: 'cpt-x-fr-offline',
      kind: 'fr',
      coverage: 'gap',
      low_confidence: false,
      extracted: false,
      reason: 'every candidate judged none',
      gear_provides: '',
      remaining_work: '',
      action: 'create_gear',
      candidates: [],
      passage: { path: 'upload:PRD.md', line: 9, text: '#### Offline\nWorks offline.' },
    },
    {
      requirement_id: 'cpt-x-fr-feed',
      kind: 'fr',
      coverage: 'clarification_needed',
      low_confidence: false,
      extracted: false,
      reason: 'the judge could not decide',
      gear_provides: '',
      remaining_work: '',
      action: 'answer',
      candidates: [candidate('event-broker', { verdict: 'unjudgeable', proposed: false })],
    },
  ],
  questions: [{ id: 'cpt-x-fr-feed', requirement_id: 'cpt-x-fr-feed', topic: 'cpt-x-fr-feed', reason: 'the judge could not decide' }],
};

/** The element `selector` names, once it is drawn. */
const found = (selector: string) =>
  waitFor(() => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`not drawn: ${selector}`);
    return el as HTMLElement;
  });

function draw() {
  return render(
    <ScopeContext.Provider value={scope}>
      <GearMatchSection />
    </ScopeContext.Provider>
  );
}

describe('GearMatchSection', () => {
  beforeEach(() => {
    vi.spyOn(api, 'gearMatches').mockResolvedValue({
      items: [MATCH.summary, { ...MATCH.summary, match_id: 'm0', created_at: '2026-11-16T10:00:00Z' }],
      total: 2,
    });
    vi.spyOn(api, 'gearMatch').mockResolvedValue(MATCH);
    vi.spyOn(api, 'projectProduct').mockResolvedValue({ product_id: 'todo-app', gears: ['api-gateway'] });
    vi.spyOn(api, 'projectPlan').mockResolvedValue({ items: [], total: 0 });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows each requirement with what can be done about it', async () => {
    draw();
    await screen.findByText('fr-sign-in');
    expect(document.querySelector('[data-gear-match-requirement="cpt-x-fr-sign-in"]')?.getAttribute('data-action')).toBe('propose');
    expect(document.querySelector('[data-gear-match-add]')).toBeTruthy();
    expect(document.querySelector('[data-gear-match-create]')).toBeTruthy();
    expect(document.querySelector('[data-gear-match-question="cpt-x-fr-feed"]')).toBeTruthy();
    expect(screen.getAllByText('resolves a bearer').length).toBeGreaterThan(0);
  });

  it('adds a proposed gear through the product completion and records the decision', async () => {
    const complete = vi
      .spyOn(api, 'completeProduct')
      .mockResolvedValue({ gears: ['api-gateway', 'authn-resolver', 'tenant-resolver'], changes: [{ gear: 'tenant-resolver', added: true, reason: 'needed' }], config: {} });
    const save = vi.spyOn(api, 'saveProjectProduct').mockResolvedValue({} as never);
    const decide = vi.spyOn(api, 'putGearMatchDecision').mockResolvedValue({ subject: 'cpt-x-fr-sign-in' });
    draw();
    fireEvent.click(await found('[data-gear-match-add]'));
    await waitFor(() => expect(decide).toHaveBeenCalled());
    expect(complete).toHaveBeenCalledWith('', ['api-gateway', 'authn-resolver'], {});
    expect(save.mock.calls[0][2]).toMatchObject({ product_id: 'todo-app', gears: ['api-gateway', 'authn-resolver', 'tenant-resolver'] });
    expect(decide.mock.calls[0][2]).toMatchObject({ gear_id: 'gears-rust/authn-resolver', decision: 'accepted' });
  });

  it('drafts a gear for a gap from its passage', async () => {
    draw();
    fireEvent.click(await found('[data-gear-match-create]'));
    expect((await screen.findByTestId('scaffold')).textContent).toBe('offline|Works offline.');
  });

  it('keeps an answer to a question', async () => {
    const answer = vi.spyOn(api, 'putGearMatchAnswer').mockResolvedValue({ subject: 'cpt-x-fr-feed' });
    draw();
    const form = await found('[data-gear-match-question="cpt-x-fr-feed"]');
    fireEvent.change(form.querySelector('textarea')!, { target: { value: 'within 2 s' } });
    fireEvent.click(form.querySelector('[data-gear-match-answer]')!);
    await waitFor(() => expect(answer).toHaveBeenCalled());
    expect(answer.mock.calls[0][2]).toMatchObject({ question_id: 'cpt-x-fr-feed', text: 'within 2 s', match_id: 'm1' });
  });

  it('starts a match and compares two', async () => {
    const start = vi.spyOn(api, 'startGearMatch').mockResolvedValue({ run_id: 'r', match_id: 'm2', state: 'queued' });
    const diff = vi.spyOn(api, 'gearMatchDiff').mockResolvedValue({
      match_id: 'm1',
      base: 'm0',
      same: 2,
      changes: [{ requirement_id: 'cpt-x-fr-feed', before: 'partial', after: 'clarification_needed', gears_before: [], gears_after: [] }],
    });
    draw();
    fireEvent.click(await found('[data-gear-match-compare]'));
    await waitFor(() => expect(document.querySelector('[data-gear-match-diff]')).toBeTruthy());
    expect(diff).toHaveBeenCalledWith('', 'p1', 'm1');
    fireEvent.click(document.querySelector('[data-gear-match-start]')!);
    await waitFor(() => expect(start).toHaveBeenCalled());
    expect(start.mock.calls[0][2]?.idempotency_key).toBeTruthy();
  });

  it('says plainly when the matcher is not configured', async () => {
    vi.spyOn(api, 'gearMatches').mockRejectedValue(Object.assign(new Error('off'), { response: { status: 503 } }));
    draw();
    await waitFor(() => expect(document.querySelector('[data-gear-match-unavailable]')).toBeTruthy());
  });
});
