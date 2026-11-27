/**
 * The Deal tab's pure parts: how the evidence is grouped and how one fact
 * reads, the patch an edit sends, the badge tone of every enum, who signed
 * off, and the bodies the ledgers' dialogs write. No React, no requests: the
 * screen draws what these answer.
 */

import type { MnaDeal, MnaDealPatch, MnaFact } from '../api/types';

/* ── Evidence ── */

export type FactGroup = 'repositories' | 'people' | 'delivery' | 'deal' | 'other';

/** The known fact keys, by the group they show in, in the order they show. */
export const FACT_GROUPS: ReadonlyArray<{ group: Exclude<FactGroup, 'other'>; keys: readonly string[] }> = [
  { group: 'repositories', keys: ['repositories', 'repositories_synced'] },
  { group: 'people', keys: ['active_contributors', 'contributors', 'truck_factor'] },
  {
    group: 'delivery',
    keys: ['ci_pass_rate', 'mainline_build', 'specs_checked', 'specs_failing', 'spec_findings_open'],
  },
  { group: 'deal', keys: ['findings_open', 'risks_open', 'questions_open'] },
];

const KNOWN_KEYS: ReadonlySet<string> = new Set(FACT_GROUPS.flatMap((g) => g.keys));

/** Whether the screen has a label of its own for `key`; an unknown key is shown as itself. */
export const isKnownFact = (key: string): boolean => KNOWN_KEYS.has(key);

/** The facts by group, known keys in their order, unknown ones under `other` as they came; empty groups left out. */
export function groupFacts(facts: readonly MnaFact[]): { group: FactGroup; facts: MnaFact[] }[] {
  const byKey = new Map(facts.map((f) => [f.key, f]));
  const out: { group: FactGroup; facts: MnaFact[] }[] = [];
  for (const { group, keys } of FACT_GROUPS) {
    const found = keys.map((k) => byKey.get(k)).filter((f): f is MnaFact => f !== undefined);
    if (found.length) out.push({ group, facts: found });
  }
  const other = facts.filter((f) => !KNOWN_KEYS.has(f.key));
  if (other.length) out.push({ group: 'other', facts: other });
  return out;
}

/**
 * How one fact reads, before translation. `unavailable`: no number, ever —
 * the reason is the fact's `detail`. `percent`: a pass rate of 0..1 as a whole
 * percent over `total` runs. `build`: the mainline's build, passed (1) or
 * failed (0). `count`: a number, `of` the total when there is one. `unknown`:
 * available, and no value.
 */
export type FactReading =
  | { kind: 'unavailable'; reason: string | null }
  | { kind: 'percent'; percent: number; total: number | null }
  | { kind: 'build'; passed: boolean }
  | { kind: 'count'; value: number; of: number | null }
  | { kind: 'unknown' };

export function readFact(fact: MnaFact): FactReading {
  if (!fact.available) return { kind: 'unavailable', reason: fact.detail?.trim() || null };
  if (fact.value === null || !Number.isFinite(fact.value)) return { kind: 'unknown' };
  if (fact.key === 'ci_pass_rate') {
    return { kind: 'percent', percent: Math.round(Math.min(1, Math.max(0, fact.value)) * 100), total: fact.total };
  }
  if (fact.key === 'mainline_build') return { kind: 'build', passed: fact.value >= 1 };
  return { kind: 'count', value: fact.value, of: fact.total };
}

/* ── The deal's attributes ── */

/** What the header's and the recommendation's dialogs edit, as text. */
export interface DealDraft {
  target: string;
  deal_phase: string;
  ic_date: string;
  thesis: string;
  recommendation: string;
  /** One condition per line. */
  conditions: string;
}

export function draftOf(deal: MnaDeal): DealDraft {
  return {
    target: deal.target ?? '',
    deal_phase: deal.deal_phase ?? '',
    ic_date: deal.ic_date ?? '',
    thesis: deal.thesis ?? '',
    recommendation: deal.recommendation ?? '',
    conditions: (deal.conditions ?? []).join('\n'),
  };
}

/** The conditions a text holds: one per line, trimmed, blank lines dropped. */
export function conditionsOf(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Only what changed among `fields`: an unchanged recommendation or condition
 * list is never sent, since sending one clears a sign-off. A cleared field
 * goes as an empty string.
 */
export function dealPatch(deal: MnaDeal, draft: DealDraft, fields: readonly (keyof DealDraft)[]): MnaDealPatch {
  const before = draftOf(deal);
  const patch: MnaDealPatch = {};
  for (const field of fields) {
    if (field === 'conditions') {
      const next = conditionsOf(draft.conditions);
      if (next.join('\n') !== (deal.conditions ?? []).join('\n')) patch.conditions = next;
      continue;
    }
    const next = field === 'thesis' ? draft.thesis : draft[field].trim();
    if (next !== before[field]) patch[field] = next;
  }
  return patch;
}

/** Whether a patch changes the recommendation or its conditions, which clears a sign-off. */
export const clearsSignOff = (patch: MnaDealPatch): boolean =>
  patch.recommendation !== undefined || patch.conditions !== undefined;

/** Whether the Sign off button is live: the caller is the deal lead, and there is a recommendation to sign. */
export const canSignOff = (deal: MnaDeal): boolean => deal.may_sign_off && Boolean(deal.recommendation);

/** Who signed off, for the screen: the caller, the deal lead, or another subject by a short id. */
export type Signer = { who: 'you' } | { who: 'lead'; id: string } | { who: 'other'; id: string };

export const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 8) : id);

export function signerOf(deal: MnaDeal): Signer | null {
  const by = deal.signed_off_by;
  if (!by) return null;
  if (by === deal.deal_lead) return deal.may_sign_off ? { who: 'you' } : { who: 'lead', id: shortId(by) };
  return { who: 'other', id: shortId(by) };
}

/* ── Badges ── */

export type Tone = 'danger' | 'warning' | 'info' | 'success' | 'secondary' | 'outline';

const TONES: Record<string, Record<string, Tone>> = {
  severity: { critical: 'danger', high: 'warning', medium: 'info', low: 'secondary', info: 'outline' },
  level: { critical: 'danger', high: 'warning', medium: 'info', low: 'secondary' },
  finding_status: { open: 'warning', accepted: 'secondary', resolved: 'success' },
  risk_status: { open: 'warning', mitigating: 'info', accepted: 'secondary', closed: 'success' },
  question_status: { open: 'warning', answered: 'success', closed: 'secondary' },
  recommendation: { proceed: 'success', proceed_with_conditions: 'warning', stop: 'danger' },
};

/** A value's badge tone in its scale; an unknown value is neutral. */
export function toneOf(scale: keyof typeof TONES, value: string | null | undefined): Tone {
  return (value && TONES[scale]?.[value]) || 'secondary';
}

/** A sort weight: an enum's position in its list (unknown last). */
export const rank = (list: readonly string[], value: string): number => {
  const i = list.indexOf(value);
  return i === -1 ? list.length : i;
};

/* ── The ledgers' dialogs ── */

/** A dialog's fields as text, keyed by the body's field names. */
export type RecordDraft = Record<string, string>;

/**
 * The body a dialog sends: `required` fields trimmed, the others trimmed and
 * left out when empty (PUT replaces the record, so a left-out field is cleared).
 */
export function bodyOf(draft: RecordDraft, fields: readonly string[]): Record<string, string> {
  const body: Record<string, string> = {};
  for (const name of fields) {
    const value = (draft[name] ?? '').trim();
    if (value) body[name] = value;
  }
  return body;
}

/** Whether every required field has text. */
export const hasRequired = (draft: RecordDraft, required: readonly string[]): boolean =>
  required.every((name) => (draft[name] ?? '').trim() !== '');
