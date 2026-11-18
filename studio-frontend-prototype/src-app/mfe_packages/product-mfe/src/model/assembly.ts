/**
 * How a product is assembled (ADR-0072): the strategy the server says the
 * project uses (`GET /studio-product/v1/project-assembly-strategy?project_id=`), and
 * the gears each strategy proposes before the engine's completion and a
 * person's confirmation. Pure.
 *
 * - `spec_mapping`: for every capability the specifications name that no
 *   pick answers yet, the first gear spec-mapping's plan offers for it with a
 *   contract, a declaration or a member's confirmation behind it.
 * - `gears_matcher`: every gear the latest finished gear match proposes that
 *   nobody rejected and the catalogue the product reads holds.
 */

import type { PlanRow } from '../api/types';
import { addability, type GearMatch } from './gear-match';
import { candidateStrength, couldBecomeGear } from './spec-coverage';

export type StrategyId = 'spec_mapping' | 'gears_matcher';

export const STRATEGIES: readonly StrategyId[] = ['spec_mapping', 'gears_matcher'];

export interface AssemblyStrategy {
  organization_id: string;
  project_id?: string | null;
  /** What is used. */
  strategy: StrategyId;
  /** What the settings ask for. */
  chosen: StrategyId;
  source: 'project' | 'organization' | 'studio';
  /** The project's own choice; null: it follows the organization's default. */
  project?: StrategyId | null;
  /** The organization's default; null: Studio's. */
  organization_default?: StrategyId | null;
  fallback?: { code: string; reason: string } | null;
  gears_matcher: {
    kit_installed?: boolean | null;
    configured: boolean;
    missing?: string | null;
    offered: boolean;
  };
  strategies: StrategyId[];
  settable: boolean;
  may_set_default: boolean;
}

/** What the project's choice control shows: the organization's default, or one strategy. */
export type ProjectChoice = 'default' | StrategyId;

export function projectChoice(a: AssemblyStrategy): ProjectChoice {
  return a.project ?? 'default';
}

/** The strategy the organization's default stands for (Studio's when it has none). */
export function organizationStrategy(a: AssemblyStrategy): StrategyId {
  return a.organization_default ?? 'spec_mapping';
}

/** One gear a strategy proposes, and what it answers. */
export interface Proposal {
  gear: string;
  /** Capabilities (spec mapping) or requirement ids (gears matcher). */
  answers: string[];
  /** For the matcher: the decisions to record once the gear is in. */
  decisions: { requirement_id: string; gear_id: string }[];
}

function add(out: Map<string, Proposal>, gear: string, answer: string, decision?: Proposal['decisions'][number]) {
  const p = out.get(gear) ?? { gear, answers: [], decisions: [] };
  if (!p.answers.includes(answer)) p.answers.push(answer);
  if (decision) p.decisions.push(decision);
  out.set(gear, p);
}

/**
 * The spec plan's proposals: per capability that no pick answers, its first
 * strong candidate that is built, not code that could become a gear, and
 * (when the catalogue is known) in it.
 */
export function specMappingProposals(
  plan: readonly PlanRow[],
  picks: readonly string[],
  catalogue: ReadonlySet<string> | null
): Proposal[] {
  const out = new Map<string, Proposal>();
  for (const row of plan) {
    if (row.nonfunctional) continue;
    const providers = row.providers?.map((p) => p.name) ?? row.candidates.map((c) => c.name);
    if (providers.some((name) => picks.includes(name))) continue;
    const pick = row.candidates.find(
      (c) =>
        candidateStrength(c) === 'strong' &&
        c.built === 'built' &&
        !couldBecomeGear(c) &&
        !(c.decision && !c.decision.needs_review && c.decision.decision === 'rejected') &&
        (!catalogue || catalogue.has(c.name))
    );
    if (pick) add(out, pick.name, row.label ?? row.capability);
  }
  return [...out.values()];
}

/** The latest match's proposals that can go in: proposed, not rejected, addable. */
export function matcherProposals(
  match: GearMatch,
  picks: readonly string[],
  catalogue: ReadonlySet<string> | null
): Proposal[] {
  const out = new Map<string, Proposal>();
  for (const r of match.requirements) {
    for (const c of r.candidates) {
      if (!c.proposed || c.decision === 'rejected') continue;
      if (addability(c, picks, catalogue) !== 'add') continue;
      add(out, c.pick, r.requirement_id, { requirement_id: r.requirement_id, gear_id: c.gear_id });
    }
  }
  return [...out.values()];
}

/** A match whose report can be proposed from. */
export function isFinished(state: string): boolean {
  return state === 'succeeded' || state === 'partial';
}
