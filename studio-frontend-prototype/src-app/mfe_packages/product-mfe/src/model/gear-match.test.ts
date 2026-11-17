import { describe, expect, it } from 'vitest';
import {
  addability,
  byAction,
  coverageTone,
  filtered,
  gapDraft,
  isRunning,
  progressOf,
  shortId,
  specPlanGears,
  type GearMatchCandidate,
  type GearMatchRequirement,
} from './gear-match';

const req = (id: string, coverage: string, action: string, extra: Partial<GearMatchRequirement> = {}): GearMatchRequirement => ({
  requirement_id: id,
  kind: 'fr',
  coverage,
  low_confidence: false,
  extracted: false,
  reason: 'r',
  gear_provides: '',
  remaining_work: '',
  action,
  candidates: [],
  ...extra,
});

const cand = (pick: string, extra: Partial<GearMatchCandidate> = {}): GearMatchCandidate => ({
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

describe('gear match', () => {
  it('orders what a person acts on first', () => {
    const out = byAction([req('b', 'gap', 'create_gear'), req('a', 'covered', 'propose'), req('c', 'clarification_needed', 'answer')]);
    expect(out.map((r) => r.action)).toEqual(['propose', 'answer', 'create_gear']);
    expect(filtered(out, 'gap').map((r) => r.requirement_id)).toEqual(['b']);
    expect(filtered(out, 'all')).toHaveLength(3);
  });

  it('says whether a candidate can be added to the product', () => {
    const cat = new Set(['event-broker']);
    expect(addability(cand('event-broker'), [], cat)).toBe('add');
    expect(addability(cand('event-broker'), ['event-broker'], cat)).toBe('in');
    expect(addability(cand('oagw'), [], cat)).toBe('unknown');
    expect(addability(cand('user-tasks-manager', { in_code: false }), [], cat)).toBe('future');
    expect(addability(cand('oagw'), [], null)).toBe('add');
  });

  it('reads tones, running states, progress and short ids', () => {
    expect(coverageTone('covered')).toBe('ok');
    expect(coverageTone('gap')).toBe('danger');
    expect(coverageTone('not_assessed')).toBe('neutral');
    expect(isRunning('cancelling')).toBe(true);
    expect(isRunning('partial')).toBe(false);
    expect(progressOf({ match_id: 'm', state: 'running', requested_by: 'p', created_at: '', progress: { requirements_done: 3, requirements_total: 8 } })).toEqual({ done: 3, total: 8 });
    expect(progressOf({ match_id: 'm', state: 'queued', requested_by: 'p', created_at: '' })).toBeNull();
    expect(shortId('cpt-examples-todo-app-fr-create-task')).toBe('fr-create-task');
  });

  it('collects the gears spec-mapping offers', () => {
    expect([...specPlanGears([{ candidates: [{ name: 'event-broker' }], providers: [{ name: 'oagw' }] }])].sort()).toEqual(['event-broker', 'oagw']);
  });

  it('drafts a gear for a gap from its passage', () => {
    const d = gapDraft(
      req('cpt-x-fr-offline-support', 'gap', 'create_gear', {
        passage: { path: 'PRD.md', line: 1, text: '#### Offline\n\n- [x] **ID**: `cpt-x-fr-offline-support`\n\nWorks offline.' },
      })
    );
    expect(d).toEqual({ name: 'offline-support', problem: 'Works offline.' });
  });
});
