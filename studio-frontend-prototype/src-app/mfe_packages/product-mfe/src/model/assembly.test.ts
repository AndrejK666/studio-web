import { describe, expect, it } from 'vitest';
import type { Candidate, PlanRow } from '../api/types';
import {
  isFinished,
  matcherProposals,
  matcherUnavailable,
  organizationStrategy,
  projectChoice,
  specMappingProposals,
  type AssemblyStrategy,
} from './assembly';
import type { GearMatch, GearMatchCandidate, GearMatchRequirement } from './gear-match';

const cand = (name: string, extra: Partial<Candidate> = {}): Candidate => ({
  name,
  kind: 'gear',
  step: 'contract',
  score: 1,
  why: [],
  built: 'built',
  composable: 'runs',
  ...extra,
});

const row = (capability: string, extra: Partial<PlanRow> = {}): PlanRow => ({
  capability,
  candidates: [],
  gap: false,
  unbuilt: false,
  ...extra,
});

const mcand = (pick: string, extra: Partial<GearMatchCandidate> = {}): GearMatchCandidate => ({
  gear_id: `gears-rust/${pick}`,
  pick,
  verdict: 'covered',
  role: 'chosen',
  evidence: '',
  covers: '',
  missing: '',
  rationale: '',
  proposed: true,
  ...extra,
});

const req = (id: string, candidates: GearMatchCandidate[]): GearMatchRequirement => ({
  requirement_id: id,
  kind: 'fr',
  coverage: 'covered',
  low_confidence: false,
  extracted: false,
  reason: '',
  gear_provides: '',
  remaining_work: '',
  action: 'propose',
  candidates,
});

const match = (requirements: GearMatchRequirement[]): GearMatch => ({
  summary: { match_id: 'm', state: 'succeeded', requested_by: 'p', created_at: '2026-11-18T00:00:00Z' },
  project_id: 'p',
  product: 'p',
  documents: [],
  requirements,
  questions: [],
});

const strategy = (extra: Partial<AssemblyStrategy> = {}): AssemblyStrategy => ({
  organization_id: 'o',
  strategy: 'spec_mapping',
  chosen: 'spec_mapping',
  source: 'studio',
  gears_matcher: { configured: true, offered: true, kit_installed: true },
  strategies: ['spec_mapping', 'gears_matcher'],
  settable: true,
  may_set_default: false,
  ...extra,
});

describe('assembly strategy', () => {
  it('reads the project choice and the organization default', () => {
    expect(projectChoice(strategy())).toBe('default');
    expect(projectChoice(strategy({ project: 'gears_matcher' }))).toBe('gears_matcher');
    expect(organizationStrategy(strategy())).toBe('spec_mapping');
    expect(organizationStrategy(strategy({ organization_default: 'gears_matcher' }))).toBe('gears_matcher');
  });

  it('says why the matcher cannot be chosen, the kit before the service', () => {
    const m = (gears_matcher: AssemblyStrategy['gears_matcher']) => matcherUnavailable(strategy({ gears_matcher }));
    expect(m({ kit_installed: true, configured: true, offered: true })).toBeNull();
    expect(m({ kit_installed: false, configured: false, missing: 'no address', offered: false })).toBe('kit_not_installed');
    expect(m({ kit_installed: null, configured: true, offered: false })).toBe('kit_unknown');
    expect(m({ kit_installed: true, configured: false, missing: 'no address', offered: false })).toBe('not_configured');
  });

  it('proposes one strong, built gear per capability no pick answers', () => {
    const plan = [
      row('auth', { label: 'Sign-in', candidates: [cand('wordy', { step: 'evidence' }), cand('resolver'), cand('other')] }),
      row('events', { candidates: [cand('event-broker')], providers: [{ name: 'event-broker', strong: true }] }),
      row('mail', { candidates: [cand('mailer', { built: 'docs-only' })] }),
      row('own', { candidates: [cand('mine', { origin: 'project', registry_state: 'candidate' })] }),
      row('nope', { candidates: [cand('rejected', { decision: { decision: 'rejected', needs_review: false } })] }),
      row('tls', { nonfunctional: true, candidates: [cand('tls')] }),
      row('auth2', { candidates: [cand('resolver')] }),
    ];
    const out = specMappingProposals(plan, ['event-broker'], null);
    expect(out).toEqual([{ gear: 'resolver', answers: ['Sign-in', 'auth2'], decisions: [] }]);
    // Outside the catalogue the product reads: not proposed.
    expect(specMappingProposals(plan, [], new Set(['event-broker'])).map((p) => p.gear)).toEqual(['event-broker']);
  });

  it('proposes what the latest match proposes, unless rejected, picked or unknown', () => {
    const m = match([
      req('fr-a', [mcand('event-broker'), mcand('oagw', { proposed: false })]),
      req('fr-b', [mcand('event-broker'), mcand('no-code', { in_code: false })]),
      req('fr-c', [mcand('said-no', { decision: 'rejected' }), mcand('picked')]),
      req('fr-d', [mcand('elsewhere')]),
    ]);
    const out = matcherProposals(m, ['picked'], new Set(['event-broker', 'said-no', 'picked', 'no-code']));
    expect(out).toEqual([
      {
        gear: 'event-broker',
        answers: ['fr-a', 'fr-b'],
        decisions: [
          { requirement_id: 'fr-a', gear_id: 'gears-rust/event-broker' },
          { requirement_id: 'fr-b', gear_id: 'gears-rust/event-broker' },
        ],
      },
    ]);
    expect(isFinished('partial')).toBe(true);
    expect(isFinished('running')).toBe(false);
  });
});
