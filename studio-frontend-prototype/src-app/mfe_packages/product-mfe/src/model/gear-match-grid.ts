/**
 * One gear match's report as the rows of Project › Gear match's two grids
 * (the Gears matcher kit, ADR-0072): pure, so the grids only draw.
 *
 * - **By requirement**: a row per requirement, opening (the grid's tree) into
 *   the passage it was read from and its candidate gears.
 * - **By gear**: a row per gear any requirement named as a candidate, across
 *   the run, with how many requirements it covers fully or partly, opening
 *   into the requirements it answers.
 *
 * Both read the one report; nothing is fetched here.
 */

import { addability, type GearMatch, type GearMatchCandidate, type GearMatchRequirement } from './gear-match';

export type MatchView = 'requirement' | 'gear';

export const MATCH_VIEWS: readonly MatchView[] = ['requirement', 'gear'];

/** The verdicts the requirement view filters on, in the order a person reads them. */
export const VERDICTS = ['covered', 'partial', 'gap', 'clarification_needed', 'not_assessed'] as const;

/** The requirement view's verdict filter key (also in the address). */
export const VERDICT_FILTER = 'verdict';
/** The gear view's filter key: whether the product has the gear. */
export const GEAR_FILTER = 'gear';
export const GEAR_FILTERS = ['in_product', 'addable', 'no_code'] as const;
export type GearFilter = (typeof GEAR_FILTERS)[number];

/** A row of the requirement view. */
export type RequirementRow =
  | { id: string; kind: 'requirement'; r: GearMatchRequirement; best: GearMatchCandidate | null }
  | { id: string; kind: 'passage'; r: GearMatchRequirement }
  | { id: string; kind: 'candidate'; r: GearMatchRequirement; c: GearMatchCandidate };

/** One requirement a gear was a candidate for. */
export interface GearAnswer {
  r: GearMatchRequirement;
  c: GearMatchCandidate;
}

/** A row of the gear view. */
export type GearRow =
  | {
      id: string;
      kind: 'gear';
      gear_id: string;
      pick: string;
      name: string;
      /** The repository part of `gear_id` (`gears-rust`), or null. */
      repo: string | null;
      covered: number;
      partial: number;
      confidence: number | null;
      /** Has code: no candidate of it said "future part only". */
      in_code: boolean;
      /** The requirements it is a candidate for, best verdict first. */
      answers: GearAnswer[];
    }
  | { id: string; kind: 'answer'; gear_id: string; r: GearMatchRequirement; c: GearMatchCandidate };

const VERDICT_RANK: Record<string, number> = { covered: 0, partial: 1 };
const rank = (verdict: string) => VERDICT_RANK[verdict] ?? 2;

/** The candidate a requirement's row names: the one the matcher chose, else its best proposal, else its best verdict. */
export function bestCandidate(r: GearMatchRequirement): GearMatchCandidate | null {
  if (r.candidates.length === 0) return null;
  const chosen = r.candidates.find((c) => c.role === 'chosen');
  if (chosen) return chosen;
  const sorted = [...r.candidates].sort(
    (a, b) => Number(b.proposed) - Number(a.proposed) || rank(a.verdict) - rank(b.verdict) || (b.confidence ?? 0) - (a.confidence ?? 0)
  );
  return sorted[0];
}

/** The candidates a requirement opens into: the ones judged at all (all of them when there is only one). */
export function shownCandidates(r: GearMatchRequirement): GearMatchCandidate[] {
  return r.candidates.filter((c) => c.verdict !== 'none' || r.candidates.length === 1);
}

export function requirementRows(match: GearMatch): RequirementRow[] {
  return match.requirements.map((r) => ({ id: r.requirement_id, kind: 'requirement', r, best: bestCandidate(r) }));
}

/** What a requirement opens into: its passage first, then its candidates. */
export function requirementChildren(r: GearMatchRequirement): RequirementRow[] {
  return [
    { id: `${r.requirement_id}::passage`, kind: 'passage', r },
    ...shownCandidates(r).map(
      (c): RequirementRow => ({ id: `${r.requirement_id}::${c.gear_id}`, kind: 'candidate', r, c })
    ),
  ];
}

/** A requirement row's confidence: the requirement's own, else its best candidate's. */
export function requirementConfidence(row: RequirementRow): number | null {
  if (row.kind === 'candidate') return row.c.confidence ?? null;
  if (row.kind === 'passage') return null;
  return row.r.confidence ?? row.best?.confidence ?? null;
}

const repoOf = (gearId: string) => (gearId.includes('/') ? gearId.slice(0, gearId.indexOf('/')) : null);

/** Every gear named as a candidate in the run, with what it covers. */
export function gearRows(match: GearMatch): GearRow[] {
  const by = new Map<string, Extract<GearRow, { kind: 'gear' }>>();
  for (const r of match.requirements) {
    for (const c of r.candidates) {
      let g = by.get(c.gear_id);
      if (!g) {
        g = {
          id: c.gear_id,
          kind: 'gear',
          gear_id: c.gear_id,
          pick: c.pick,
          name: c.name ?? c.pick,
          repo: repoOf(c.gear_id),
          covered: 0,
          partial: 0,
          confidence: null,
          in_code: true,
          answers: [],
        };
        by.set(c.gear_id, g);
      }
      if (c.verdict === 'covered') g.covered += 1;
      if (c.verdict === 'partial') g.partial += 1;
      if (c.confidence != null && (c.verdict === 'covered' || c.verdict === 'partial'))
        g.confidence = Math.max(g.confidence ?? 0, c.confidence);
      if (c.in_code === false) g.in_code = false;
      g.answers.push({ r, c });
    }
  }
  for (const g of by.values())
    g.answers.sort((a, b) => rank(a.c.verdict) - rank(b.c.verdict) || (b.c.confidence ?? 0) - (a.c.confidence ?? 0));
  return [...by.values()];
}

/** What a gear opens into: the requirements it was a candidate for. */
export function gearChildren(g: Extract<GearRow, { kind: 'gear' }>): GearRow[] {
  return g.answers.map(({ r, c }) => ({ id: `${g.gear_id}::${r.requirement_id}`, kind: 'answer', gear_id: g.gear_id, r, c }));
}

/** How much of the product a gear carries: fully covered first, then partly. */
export function coverageScore(g: Extract<GearRow, { kind: 'gear' }>): number {
  return g.covered * 1000 + g.partial;
}

/** The candidates of a gear row that the matcher proposed: what Add and Reject act on. */
export function proposedAnswers(g: Extract<GearRow, { kind: 'gear' }>): GearAnswer[] {
  return g.answers.filter((a) => a.c.proposed);
}

/** Where a gear stands against the product: in it, addable from the catalogue, or not (unknown, future). */
export function gearStanding(
  g: Extract<GearRow, { kind: 'gear' }>,
  picks: readonly string[],
  catalogue: ReadonlySet<string> | null
): 'in' | 'add' | 'unknown' | 'future' {
  const any = g.answers[0]?.c;
  if (!any) return 'unknown';
  return addability({ ...any, in_code: g.in_code ? any.in_code : false }, picks, catalogue);
}

/** Whether a gear row passes the gear view's filter. */
export function keepsGear(standing: ReturnType<typeof gearStanding>, filter: GearFilter | null): boolean {
  if (!filter) return true;
  if (filter === 'in_product') return standing === 'in';
  if (filter === 'addable') return standing === 'add';
  return standing === 'future';
}

/** The view an address names (`gmv.f.view=gear`); the requirement view otherwise. */
export function viewOf(value: string | null | undefined): MatchView {
  return value === 'gear' ? 'gear' : 'requirement';
}
