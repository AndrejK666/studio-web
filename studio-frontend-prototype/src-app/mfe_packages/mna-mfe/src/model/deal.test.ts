import { describe, expect, it } from 'vitest';
import type { MnaDeal, MnaFact } from '../api/types';
import {
  bodyOf,
  canSignOff,
  clearsSignOff,
  conditionsOf,
  dealPatch,
  draftOf,
  groupFacts,
  hasRequired,
  rank,
  readFact,
  signerOf,
  toneOf,
} from './deal';

const fact = (key: string, more: Partial<MnaFact> = {}): MnaFact => ({
  key,
  value: 1,
  total: null,
  available: true,
  source: 'studio-artifact-ingest',
  detail: null,
  ...more,
});

const DEAL: MnaDeal = {
  project_id: 'p1',
  installed: true,
  target: 'Acme',
  thesis: 'Buy the platform',
  deal_phase: 'screening',
  ic_date: '2026-12-01',
  recommendation: 'proceed_with_conditions',
  conditions: ['Fix CI', 'Raise the truck factor'],
  signed_off_by: null,
  signed_off_at: null,
  deal_lead: 'lead-0001-aaaa',
  may_sign_off: true,
  phases: ['screening', 'confirmatory_dd', 'signing', 'integration'],
  recommendations: ['proceed', 'proceed_with_conditions', 'stop'],
};

describe('the evidence', () => {
  it('groups known facts in their order and keeps unknown ones under other', () => {
    const groups = groupFacts([
      fact('findings_open'),
      fact('mystery_metric'),
      fact('truck_factor'),
      fact('contributors'),
      fact('repositories'),
    ]);
    expect(groups.map((g) => [g.group, g.facts.map((f) => f.key)])).toEqual([
      ['repositories', ['repositories']],
      ['people', ['contributors', 'truck_factor']],
      ['deal', ['findings_open']],
      ['other', ['mystery_metric']],
    ]);
  });

  it('never reads a number off a fact that is not available', () => {
    expect(readFact(fact('truck_factor', { available: false, value: 3, detail: 'no git history' }))).toEqual({
      kind: 'unavailable',
      reason: 'no git history',
    });
    expect(readFact(fact('truck_factor', { available: false, detail: '  ' }))).toEqual({
      kind: 'unavailable',
      reason: null,
    });
  });

  it('reads a pass rate as a percent, the mainline as passed or failed, the rest as counts', () => {
    expect(readFact(fact('ci_pass_rate', { value: 0.876, total: 40 }))).toEqual({
      kind: 'percent',
      percent: 88,
      total: 40,
    });
    expect(readFact(fact('mainline_build', { value: 0 }))).toEqual({ kind: 'build', passed: false });
    expect(readFact(fact('mainline_build', { value: 1 }))).toEqual({ kind: 'build', passed: true });
    expect(readFact(fact('repositories_synced', { value: 2, total: 3 }))).toEqual({ kind: 'count', value: 2, of: 3 });
    expect(readFact(fact('contributors', { value: null }))).toEqual({ kind: 'unknown' });
  });
});

describe('the deal edits', () => {
  it('reads conditions one per line, blank lines dropped', () => {
    expect(conditionsOf(' a \n\n b\r\nc ')).toEqual(['a', 'b', 'c']);
  });

  it('sends only what changed, and a cleared field as an empty string', () => {
    const draft = { ...draftOf(DEAL), target: ' Acme ', deal_phase: 'signing', ic_date: '' };
    expect(dealPatch(DEAL, draft, ['target', 'deal_phase', 'ic_date'])).toEqual({ deal_phase: 'signing', ic_date: '' });
  });

  it('never sends unchanged conditions, which would clear a sign-off', () => {
    const same = { ...draftOf(DEAL), conditions: 'Fix CI\n\nRaise the truck factor\n' };
    const patch = dealPatch(DEAL, same, ['recommendation', 'conditions']);
    expect(patch).toEqual({});
    expect(clearsSignOff(patch)).toBe(false);
    const changed = dealPatch(DEAL, { ...same, conditions: 'Fix CI' }, ['recommendation', 'conditions']);
    expect(changed).toEqual({ conditions: ['Fix CI'] });
    expect(clearsSignOff(changed)).toBe(true);
  });

  it('lets only the deal lead sign, and only a recommendation', () => {
    expect(canSignOff(DEAL)).toBe(true);
    expect(canSignOff({ ...DEAL, may_sign_off: false })).toBe(false);
    expect(canSignOff({ ...DEAL, recommendation: null })).toBe(false);
  });

  it('says who signed off: you, the deal lead, or someone by a short id', () => {
    expect(signerOf(DEAL)).toBeNull();
    const signed = { ...DEAL, signed_off_by: DEAL.deal_lead };
    expect(signerOf(signed)).toEqual({ who: 'you' });
    expect(signerOf({ ...signed, may_sign_off: false })).toEqual({ who: 'lead', id: 'lead-000' });
    expect(signerOf({ ...signed, signed_off_by: 'someone-else' })).toEqual({ who: 'other', id: 'someone-' });
  });
});

describe('badges and records', () => {
  it('tones each scale and leaves an unknown value neutral', () => {
    expect(toneOf('severity', 'critical')).toBe('danger');
    expect(toneOf('recommendation', 'stop')).toBe('danger');
    expect(toneOf('risk_status', 'closed')).toBe('success');
    expect(toneOf('severity', 'catastrophic')).toBe('secondary');
    expect(toneOf('severity', null)).toBe('secondary');
  });

  it('ranks an enum by its order, unknown last', () => {
    expect(rank(['a', 'b'], 'b')).toBe(1);
    expect(rank(['a', 'b'], 'z')).toBe(2);
  });

  it('builds a body of trimmed fields, the empty ones left out', () => {
    expect(bodyOf({ title: ' Leak ', source: '', evidence: ' ', other: 'x' }, ['title', 'source', 'evidence'])).toEqual({
      title: 'Leak',
    });
    expect(hasRequired({ title: ' ' }, ['title'])).toBe(false);
    expect(hasRequired({ title: 'a', severity: 'low' }, ['title', 'severity'])).toBe(true);
  });
});
