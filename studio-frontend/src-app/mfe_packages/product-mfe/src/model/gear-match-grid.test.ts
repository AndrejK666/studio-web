import { describe, expect, it } from 'vitest';
import type { DataGridLoadContext } from '@gears-frontx/ui-kit';
import type { GearMatch, GearMatchCandidate, GearMatchRequirement } from './gear-match';
import {
  bestCandidate,
  coverageScore,
  gearChildren,
  gearRows,
  gearStanding,
  keepsGear,
  requirementChildren,
  requirementRows,
  viewOf,
} from './gear-match-grid';
import { gearGridLoad, gearOptions, requirementGridLoad } from '../screens/product/match/MatchReportGrids';

const cand = (pick: string, extra: Partial<GearMatchCandidate> = {}): GearMatchCandidate => ({
  gear_id: `gears-rust/${pick}`,
  pick,
  verdict: 'covered',
  role: 'other',
  evidence: '',
  covers: '',
  missing: '',
  rationale: '',
  proposed: false,
  ...extra,
});

const req = (id: string, coverage: string, candidates: GearMatchCandidate[], extra: Partial<GearMatchRequirement> = {}): GearMatchRequirement => ({
  requirement_id: id,
  kind: 'fr',
  coverage,
  low_confidence: false,
  extracted: false,
  reason: '',
  gear_provides: '',
  remaining_work: '',
  action: 'none',
  candidates,
  ...extra,
});

const MATCH: GearMatch = {
  summary: { match_id: 'm', state: 'succeeded', requested_by: 'u', created_at: '' },
  project_id: 'p',
  product: 'x',
  documents: [],
  questions: [],
  requirements: [
    req('cpt-a', 'covered', [cand('am', { role: 'chosen', proposed: true, confidence: 0.9 }), cand('de', { verdict: 'none' })]),
    req('cpt-b', 'partial', [cand('am', { verdict: 'partial', confidence: 0.6, proposed: true }), cand('eb', { verdict: 'partial', confidence: 0.7 })]),
    req('cpt-c', 'gap', []),
    req('cpt-d', 'covered', [cand('eb', { confidence: 0.8, proposed: true, in_code: false })]),
  ],
};

const ctx = (extra: Partial<DataGridLoadContext> = {}) =>
  ({ pagination: { page: 1, limit: 25 }, filters: {}, ...extra }) as unknown as DataGridLoadContext;

describe('gear match grid rows', () => {
  it('names the chosen candidate as a requirement best gear, else the best proposal', () => {
    expect(bestCandidate(MATCH.requirements[0])?.pick).toBe('am');
    expect(bestCandidate(MATCH.requirements[1])?.pick).toBe('am');
    expect(bestCandidate(MATCH.requirements[2])).toBeNull();
  });

  it('opens a requirement into its passage, then the candidates judged at all', () => {
    const kids = requirementChildren(MATCH.requirements[0]);
    expect(kids.map((k) => k.kind)).toEqual(['passage', 'candidate']);
    expect(kids[1].id).toBe('cpt-a::gears-rust/am');
  });

  it('gathers every gear across the run with what it covers fully and partly', () => {
    const rows = gearRows(MATCH);
    const am = rows.find((g) => g.id === 'gears-rust/am')!;
    expect(am.kind === 'gear' && [am.covered, am.partial, am.confidence, am.answers.length]).toEqual([1, 1, 0.9, 2]);
    const eb = rows.find((g) => g.id === 'gears-rust/eb')!;
    expect(eb.kind === 'gear' && [eb.covered, eb.partial, eb.in_code]).toEqual([1, 1, false]);
    // A gear judged "none" is listed, covering nothing.
    const de = rows.find((g) => g.id === 'gears-rust/de')!;
    expect(de.kind === 'gear' && coverageScore(de)).toBe(0);
    expect(am.kind === 'gear' && gearChildren(am).map((c) => c.id)).toEqual(['gears-rust/am::cpt-a', 'gears-rust/am::cpt-b']);
  });

  it('says where a gear stands against the product, and filters on it', () => {
    const [am] = gearRows(MATCH).filter((g) => g.id === 'gears-rust/am');
    const eb = gearRows(MATCH).find((g) => g.id === 'gears-rust/eb')!;
    if (am.kind !== 'gear' || eb.kind !== 'gear') throw new Error('rows');
    expect(gearStanding(am, ['am'], null)).toBe('in');
    expect(gearStanding(am, [], new Set(['am']))).toBe('add');
    expect(gearStanding(am, [], new Set())).toBe('unknown');
    expect(gearStanding(eb, [], null)).toBe('future');
    expect(keepsGear('add', 'addable')).toBe(true);
    expect(keepsGear('in', 'addable')).toBe(false);
    expect(keepsGear('future', 'no_code')).toBe(true);
    expect(keepsGear('in', null)).toBe(true);
  });

  it('reads the view from the address, requirements unless it says gear', () => {
    expect(viewOf('gear')).toBe('gear');
    expect(viewOf(undefined)).toBe('requirement');
    expect(viewOf('nonsense')).toBe('requirement');
  });
});

describe('gear match grid loads', () => {
  it('filters requirements by verdict, searches them and answers a branch apart', () => {
    const rows = requirementRows(MATCH);
    const covered = requirementGridLoad(rows, ctx({ filters: { verdict: { value: ['covered'] } } as never }));
    expect(covered.results.map((r) => r.id)).toEqual(['cpt-a', 'cpt-d']);
    const all = requirementGridLoad(rows, ctx({ filters: { verdict: { value: ['all'] } } as never }));
    expect(all.total).toBe(4);
    const searched = requirementGridLoad(rows, ctx({ filters: { textSearch: { value: 'gears-rust/eb' } } as never }));
    expect(searched.results.map((r) => r.id)).toEqual(['cpt-b', 'cpt-d']);
    const branch = requirementGridLoad(rows, ctx({ tree: { parentId: 'cpt-b' } } as never));
    expect(branch.results.map((r) => r.kind)).toEqual(['passage', 'candidate', 'candidate']);
  });

  it('orders gears by coverage, those that carry the product first', () => {
    const rows = gearRows(MATCH);
    const options = gearOptions([], null);
    const page = gearGridLoad(rows, ctx({ order: [{ column: 'coverage', direction: 'desc' }] } as never), options);
    expect(page.results.map((r) => r.id)).toEqual(['gears-rust/am', 'gears-rust/eb', 'gears-rust/de']);
    const addable = gearGridLoad(rows, ctx({ filters: { gear: { value: ['addable'] } } as never }), gearOptions([], new Set(['am', 'de'])));
    expect(addable.results.map((r) => r.id)).toEqual(['gears-rust/am', 'gears-rust/de']);
  });
});
