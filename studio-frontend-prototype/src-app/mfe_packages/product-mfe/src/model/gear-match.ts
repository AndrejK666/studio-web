/**
 * A gear match as Project › Product › Gear match shows it: what the
 * gears-matcher service read in the project's specifications
 * (`GET /studio-product/v1/gear-matches/{match_id}`), and what a person can
 * do about each requirement (docs/design/product-gear-match.md §3). Pure.
 */

export type GearMatchState = 'queued' | 'running' | 'cancelling' | 'succeeded' | 'partial' | 'failed' | 'cancelled';

export type Coverage = 'covered' | 'partial' | 'gap' | 'clarification_needed' | 'not_assessed';

export type MatchAction = 'propose' | 'review' | 'create_gear' | 'answer' | 'rerun' | 'none';

export interface GearMatchTotals {
  requirements: number;
  covered: number;
  partial: number;
  gap: number;
  clarification_needed: number;
  not_assessed: number;
}

export interface GearMatchItem {
  match_id: string;
  run_id?: string | null;
  state: GearMatchState | string;
  requested_by: string;
  created_at: string;
  finished_at?: string | null;
  matcher_run_id?: string | null;
  totals?: GearMatchTotals | null;
  progress?: { requirements_done?: number | null; requirements_total?: number | null } | null;
  error?: string | null;
}

export interface GearMatchCandidate {
  gear_id: string;
  pick: string;
  name?: string | null;
  verdict: string;
  confidence?: number | null;
  role: string;
  evidence: string;
  covers: string;
  missing: string;
  rationale: string;
  in_code?: boolean | null;
  listed?: string | null;
  proposed: boolean;
  decision?: 'accepted' | 'rejected' | string | null;
}

export interface GearMatchRequirement {
  requirement_id: string;
  kind: string;
  coverage: Coverage | string;
  confidence?: number | null;
  low_confidence: boolean;
  extracted: boolean;
  reason: string;
  gear_provides: string;
  remaining_work: string;
  action: MatchAction | string;
  candidates: GearMatchCandidate[];
  passage?: { path: string; line: number; text: string } | null;
}

export interface GearMatchQuestion {
  id: string;
  requirement_id?: string | null;
  topic: string;
  reason: string;
  quote?: string | null;
  path?: string | null;
  answer?: string | null;
  answered_by?: string | null;
}

export interface GearMatchDocument {
  path: string;
  matcher_path: string;
  sha256: string;
  bytes: number;
  doc_type?: string | null;
  commit?: string | null;
  branch?: string | null;
  answered: string[];
}

export interface GearMatch {
  summary: GearMatchItem;
  project_id: string;
  product: string;
  documents: GearMatchDocument[];
  matcher?: Record<string, unknown> | null;
  catalogue_commit?: string | null;
  schema_version?: string | null;
  usage?: { calls?: number; cache_hits?: number } | null;
  requirements: GearMatchRequirement[];
  questions: GearMatchQuestion[];
}

export interface GearMatchChange {
  requirement_id: string;
  before?: string | null;
  after?: string | null;
  gears_before: string[];
  gears_after: string[];
}

export interface GearMatchDiff {
  match_id: string;
  base: string;
  changes: GearMatchChange[];
  same: number;
}

/** A match still on its way. */
export function isRunning(state: string): boolean {
  return state === 'queued' || state === 'running' || state === 'cancelling';
}

/** A coverage verdict as a chip's tone. */
export function coverageTone(coverage: string): 'ok' | 'warn' | 'danger' | 'info' | 'neutral' {
  switch (coverage) {
    case 'covered':
      return 'ok';
    case 'partial':
      return 'warn';
    case 'gap':
      return 'danger';
    case 'clarification_needed':
      return 'info';
    default:
      return 'neutral';
  }
}

/** The order requirements are shown in: what a person acts on first. */
const ACTION_ORDER: Record<string, number> = { propose: 0, answer: 1, create_gear: 2, review: 3, rerun: 4, none: 5 };

export function byAction(reqs: readonly GearMatchRequirement[]): GearMatchRequirement[] {
  return [...reqs].sort(
    (a, b) => (ACTION_ORDER[a.action] ?? 9) - (ACTION_ORDER[b.action] ?? 9) || a.requirement_id.localeCompare(b.requirement_id)
  );
}

/** Requirements whose coverage is `filter` (all for `all`). */
export function filtered(reqs: readonly GearMatchRequirement[], filter: string): GearMatchRequirement[] {
  return filter === 'all' ? [...reqs] : reqs.filter((r) => r.coverage === filter);
}

/**
 * What adding a candidate to the product would be: `in` (already picked),
 * `add` (the engine's catalogue has it), `unknown` (the catalogue the product
 * reads does not; it cannot be picked), `future` (no code yet).
 */
export function addability(
  c: GearMatchCandidate,
  picks: readonly string[],
  catalogue: ReadonlySet<string> | null
): 'in' | 'add' | 'unknown' | 'future' {
  if (picks.includes(c.pick)) return 'in';
  if (c.in_code === false) return 'future';
  if (catalogue && !catalogue.has(c.pick)) return 'unknown';
  return 'add';
}

/** The gear names spec-mapping's plan offers: where the two agree. */
export function specPlanGears(
  plan: readonly { candidates?: readonly { name?: string | null }[]; providers?: readonly { name: string }[] }[]
): Set<string> {
  const out = new Set<string>();
  for (const row of plan) {
    for (const c of row.candidates ?? []) if (c.name) out.add(c.name);
    for (const p of row.providers ?? []) out.add(p.name);
  }
  return out;
}

/** A requirement's id without the shared family prefix, for a compact list. */
export function shortId(id: string): string {
  const m = id.match(/-(fr|nfr)-(.+)$/);
  return m ? `${m[1]}-${m[2]}` : id;
}

/** The progress line's numbers, when the run says them. */
export function progressOf(item: GearMatchItem): { done: number; total: number } | null {
  const p = item.progress;
  if (!p || p.requirements_total == null || p.requirements_done == null || p.requirements_total <= 0) return null;
  return { done: p.requirements_done, total: p.requirements_total };
}

/** A gap's draft for "Create a gear": a name from the requirement, the passage as what it is for. */
export function gapDraft(r: GearMatchRequirement): { name: string; problem: string } {
  const slug = shortId(r.requirement_id).replace(/^(fr|nfr)-/, '');
  const passage = (r.passage?.text ?? '')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#') && !l.includes('**ID**'))
    .join(' ')
    .trim();
  return { name: slug, problem: passage || r.reason };
}

/**
 * What a person can do about a failed match, read off the server's sentence
 * (the matcher's problem code is kept in it): `null` when there is nothing
 * more to say than the sentence itself.
 */
export type FailureHint = 'not_a_template' | 'unreachable' | 'unauthorized';

export function failureHint(error: string | null | undefined): FailureHint | null {
  if (!error) return null;
  if (/\bnot_a_template\b/.test(error)) return 'not_a_template';
  if (/\b401\b|\bunauthorized\b/i.test(error)) return 'unauthorized';
  if (/did not answer/.test(error)) return 'unreachable';
  return null;
}

/**
 * What a requirement's card says it asks of the person. The matcher's
 * `propose` means "a gear could be added"; once every gear it proposes is in
 * the product, or none can be picked from the catalogue the product reads,
 * there is nothing to add, and the card says which.
 */
export function actionLabel(
  r: GearMatchRequirement,
  picks: readonly string[],
  catalogue: ReadonlySet<string> | null
): string {
  if (r.action !== 'propose') return r.action;
  const proposed = r.candidates.filter((c) => c.proposed);
  if (proposed.length === 0) return r.action;
  const can = proposed.map((c) => addability(c, picks, catalogue));
  if (can.includes('add')) return r.action;
  return can.every((a) => a === 'in') ? 'proposed_in_product' : 'proposed_not_pickable';
}
