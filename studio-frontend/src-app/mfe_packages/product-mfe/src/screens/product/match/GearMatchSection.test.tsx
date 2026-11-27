import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import type { ChildMfeBridge } from '@gears-frontx/react';
import { stubResizeObserver } from '@frontx-test-utils/stubResizeObserver';

// The kit's DataGrid measures its table.
stubResizeObserver();

vi.mock('../../../i18n', () => ({
  useMatchTranslations: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
    loading: false,
  }),
  useComponentsTranslations: () => ({ t: (key: string) => key, loading: false }),
}));
vi.mock('../catalogue', () => {
  const gears = [{ id: 'event-broker' }, { id: 'authn-resolver' }];
  const read = {
    index: { gears, name: (g: { id: string }) => g.id, find: (n: string) => gears.find((g) => g.id === n) },
  };
  return { useGearCatalogue: () => read };
});
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

/** A row of the grid, by the data attribute its first cell carries. */
const rowOf = (selector: string) => document.querySelector(selector)?.closest('tr') ?? null;
/** The tree's toggle, in the row's first cell. */
const toggleOf = (selector: string) =>
  (rowOf(selector)?.querySelector('td')?.querySelector('[data-grid-row-ignore-click] button') as HTMLButtonElement | null) ?? null;

describe('GearMatchSection', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    vi.spyOn(api, 'gearMatches').mockResolvedValue({
      items: [MATCH.summary, { ...MATCH.summary, match_id: 'm0', created_at: '2026-11-16T10:00:00Z' }],
      total: 2,
    });
    vi.spyOn(api, 'gearMatch').mockResolvedValue(MATCH);
    vi.spyOn(api, 'projectProduct').mockResolvedValue({ product_id: 'todo-app', gears: ['api-gateway'] });
    vi.spyOn(api, 'projectPlan').mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(api, 'assemblyStrategy').mockRejectedValue(new Error('No project strategy'));
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('lists the requirements on the grid, covered first, with what to do about each', async () => {
    draw();
    await found('[data-gear-match-requirement="cpt-x-fr-sign-in"]');
    const ids = [...document.querySelectorAll('[data-gear-match-requirement]')].map((e) => e.getAttribute('data-gear-match-requirement'));
    expect(ids).toEqual(['cpt-x-fr-sign-in', 'cpt-x-fr-offline', 'cpt-x-fr-feed']);
    const signIn = rowOf('[data-gear-match-requirement="cpt-x-fr-sign-in"]')!;
    expect(signIn.textContent).toContain('upload:PRD.md:3');
    expect(signIn.textContent).toContain('authn-resolver');
    expect(document.querySelector('[data-gear-match-create="cpt-x-fr-offline"]')).toBeTruthy();
    expect(document.querySelector('[data-gear-match-answer-open="cpt-x-fr-feed"]')).toBeTruthy();
    // Candidates wait in the tree until the requirement is opened.
    expect(document.querySelector('[data-gear-match-candidate]')).toBeNull();
  });

  it('opens a requirement into its passage and candidates, and adds one through the product completion', async () => {
    const complete = vi.spyOn(api, 'completeProduct').mockResolvedValue({
      gears: ['api-gateway', 'authn-resolver', 'tenant-resolver'],
      changes: [{ gear: 'tenant-resolver', added: true, reason: 'needed' }],
      config: {},
    });
    const save = vi.spyOn(api, 'saveProjectProduct').mockResolvedValue({} as never);
    const decide = vi.spyOn(api, 'putGearMatchDecision').mockResolvedValue({ subject: 'cpt-x-fr-sign-in' });
    draw();
    await found('[data-gear-match-requirement="cpt-x-fr-sign-in"]');
    fireEvent.click(toggleOf('[data-gear-match-requirement="cpt-x-fr-sign-in"]')!);
    expect((await found('[data-gear-match-passage="cpt-x-fr-sign-in"]')).textContent).toContain('Users sign in.');
    expect((await found('[data-gear-match-candidate="gears-rust/authn-resolver"]')).textContent).toContain('resolves a bearer');
    fireEvent.click(await found('[data-gear-match-add]'));
    await waitFor(() => expect(decide).toHaveBeenCalled());
    expect(complete).toHaveBeenCalledWith('o1', ['api-gateway', 'authn-resolver'], {});
    expect(save.mock.calls[0][2]).toMatchObject({ product_id: 'todo-app', gears: ['api-gateway', 'authn-resolver', 'tenant-resolver'] });
    expect(decide.mock.calls[0][2]).toMatchObject({ gear_id: 'gears-rust/authn-resolver', decision: 'accepted', match_id: 'm1' });
  });

  it('drafts a gear for a gap from its passage', async () => {
    draw();
    fireEvent.click(await found('[data-gear-match-create="cpt-x-fr-offline"]'));
    expect((await screen.findByTestId('scaffold')).textContent).toBe('offline|Works offline.');
  });

  it('answers a question from its row', async () => {
    const answer = vi.spyOn(api, 'putGearMatchAnswer').mockResolvedValue({ subject: 'cpt-x-fr-feed' });
    draw();
    fireEvent.click(await found('[data-gear-match-answer-open="cpt-x-fr-feed"]'));
    const form = await found('[data-gear-match-question="cpt-x-fr-feed"]');
    fireEvent.change(form.querySelector('textarea')!, { target: { value: 'within 2 s' } });
    fireEvent.click(form.querySelector('[data-gear-match-answer]')!);
    await waitFor(() => expect(answer).toHaveBeenCalled());
    expect(answer.mock.calls[0][2]).toMatchObject({ question_id: 'cpt-x-fr-feed', text: 'within 2 s', match_id: 'm1' });
  });

  it('shows the same report by gear, kept in the address, and opens a gear into the requirements it answers', async () => {
    draw();
    await found('[data-gear-match-requirement="cpt-x-fr-sign-in"]');
    fireEvent.click(await found('[data-gear-match-view="gear"]'));
    await found('[data-gear-match-gear="gears-rust/authn-resolver"]');
    expect(window.location.search).toContain('gmv.f.view=gear');
    // By coverage: the gear that covers a requirement before the one that covers none.
    const gears = [...document.querySelectorAll('[data-gear-match-gear]')].map((e) => e.getAttribute('data-gear-match-gear'));
    expect(gears).toEqual(['gears-rust/authn-resolver', 'gears-rust/event-broker']);
    expect(document.querySelector('[data-gear-match-coverage="1/0"]')).toBeTruthy();
    expect(document.querySelector('[data-gear-match-standing="add"]')).toBeTruthy();
    fireEvent.click(toggleOf('[data-gear-match-gear="gears-rust/authn-resolver"]')!);
    expect((await found('[data-gear-match-answer-row="cpt-x-fr-sign-in"]')).textContent).toContain('resolves a bearer');
    // Back to requirements, and out of the address.
    fireEvent.click(document.querySelector('[data-gear-match-view="requirement"]')!);
    await found('[data-gear-match-requirement="cpt-x-fr-sign-in"]');
    expect(window.location.search).not.toContain('gmv.f.view');
  });

  it('keeps the search in the address, though the grid has a tree', async () => {
    draw();
    await found('[data-gear-match-requirement="cpt-x-fr-sign-in"]');
    fireEvent.change(screen.getByPlaceholderText('search_requirements'), { target: { value: 'offline' } });
    await waitFor(() => expect(window.location.search).toContain('gm.q=offline'));
    await waitFor(() => expect(document.querySelectorAll('[data-gear-match-requirement]').length).toBe(1));
  });

  it('opens on the view the address names', async () => {
    window.history.replaceState(null, '', '/?gmv.f.view=gear');
    draw();
    await found('[data-gear-match-gear="gears-rust/authn-resolver"]');
  });

  it('lists the documents read one a line, and keeps its facts apart', async () => {
    vi.spyOn(api, 'gearMatch').mockResolvedValue({
      ...MATCH,
      usage: { calls: 127 },
      documents: [
        { ...MATCH.documents[0], path: 'docs/a.md', commit: 'c8163b4ae1b4' },
        { ...MATCH.documents[0], path: 'docs/b.md', commit: 'c8163b4ae1b4' },
      ],
    });
    draw();
    const list = await found('[data-gear-match-documents]');
    expect([...list.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['docs/a.mdc8163b4', 'docs/b.mdc8163b4']);
    expect(document.querySelector('[data-gear-match-facts]')?.textContent).toContain(' · ');
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
    expect(diff).toHaveBeenCalledWith('o1', 'p1', 'm1');
    fireEvent.click(document.querySelector('[data-gear-match-start]')!);
    await waitFor(() => expect(start).toHaveBeenCalled());
    expect(start.mock.calls[0][2]?.idempotency_key).toBeTruthy();
  });

  it('says plainly when the matcher is not configured', async () => {
    vi.spyOn(api, 'gearMatches').mockRejectedValue(Object.assign(new Error('off'), { response: { status: 503 } }));
    draw();
    await waitFor(() => expect(document.querySelector('[data-gear-match-unavailable]')).toBeTruthy());
  });

  it('loads the chosen service strategy’s history and starts a match through that service', async () => {
    vi.mocked(api.assemblyStrategy).mockResolvedValue({
      organization_id: 'o1',
      strategy: 'gears_matcher',
      chosen: 'gears_matcher',
      source: 'studio',
      gears_matcher: { configured: true, offered: true },
      strategies: ['gears_matcher', 'acme_matcher'],
      strategy_kits: [
        { id: 'acme_matcher', name: 'Acme Matcher', description: '', kit: 'acme', service: 'gears-matcher/v1', offered: true },
      ],
      settable: false,
      may_set_default: false,
    });
    const start = vi.spyOn(api, 'startGearMatch').mockResolvedValue({ run_id: 'r', match_id: 'm2', state: 'queued' });
    draw();
    fireEvent.change(await screen.findByLabelText('strategy_label'), { target: { value: 'acme_matcher' } });
    await waitFor(() => expect(api.gearMatches).toHaveBeenCalledWith('o1', 'p1', 'acme_matcher'));
    fireEvent.click(await found('[data-gear-match-start]'));
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith('o1', 'p1', expect.objectContaining({ idempotency_key: expect.any(String) }), 'acme_matcher')
    );
  });
});
