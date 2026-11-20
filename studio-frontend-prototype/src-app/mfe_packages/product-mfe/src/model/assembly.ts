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

/** A strategy's id as its kit declares it: `spec_mapping`, `gears_matcher`, or an organization's kit's own (ADR-0074). */
export type StrategyId = string;

/** The strategy Studio ships whose service is the gears-matcher; every service strategy runs through its pipeline. */
export const SHIPPED_SERVICE: StrategyId = 'gears_matcher';

/** What a product is assembled by: a strategy, or `manual` where none can be used. */
export type StrategyUsed = StrategyId | 'manual';

/** Every strategy this screen knows how to propose with, in the order to offer them. Which of them a
 *  project may use is not this list: it is `strategies`, what the installed kits provide (ADR-0074). */
export const STRATEGIES: readonly StrategyId[] = ['spec_mapping', 'gears_matcher'];

/** A strategy a kit that applies provides. */
export interface StrategyKit {
  id: StrategyId;
  name: string;
  description: string;
  /** The kit that provides it. */
  kit: string;
  /** The contract of the service that runs it (`gears-matcher/v1`); null for `spec_mapping`. */
  service?: string | null;
  /** It can be used now; else `reason` says why. */
  offered: boolean;
  reason?: string | null;
}

export interface AssemblyStrategy {
  organization_id: string;
  project_id?: string | null;
  /** What is used; `manual` where no strategy can be. */
  strategy: StrategyUsed;
  /** What the settings ask for. */
  chosen: StrategyUsed;
  source: 'project' | 'organization' | 'studio';
  /** The project's own choice; null: it follows the organization's default. */
  project?: StrategyId | null;
  /** The organization's default; null: what the installed kits make it. */
  organization_default?: StrategyId | null;
  fallback?: { code: string; reason: string } | null;
  gears_matcher: {
    kit_installed?: boolean | null;
    configured: boolean;
    missing?: string | null;
    offered: boolean;
  };
  /** The strategies the kits that apply provide; empty: the product is assembled by hand. */
  strategies: StrategyId[];
  /** The same, with names and whether each can be used now (absent from an older server). */
  strategy_kits?: StrategyKit[];
  settable: boolean;
  may_set_default: boolean;
}

/** What the project's choice control shows: the organization's default, or one strategy. */
export type ProjectChoice = 'default' | StrategyId;

export function projectChoice(a: AssemblyStrategy): ProjectChoice {
  return a.project ?? 'default';
}

/** Why the gears matcher cannot be chosen here, most basic first; null when it can. */
export type MatcherUnavailable = 'kit_not_installed' | 'kit_unknown' | 'not_configured';

export function matcherUnavailable(a: AssemblyStrategy): MatcherUnavailable | null {
  if (a.gears_matcher.offered) return null;
  if (a.gears_matcher.kit_installed === false) return 'kit_not_installed';
  if (a.gears_matcher.kit_installed == null) return 'kit_unknown';
  return a.gears_matcher.configured ? null : 'not_configured';
}

/** What nobody's choice falls to: `spec_mapping` when the kits provide it, else the only one, else by hand. */
export function kitsDefault(strategies: readonly StrategyId[]): StrategyUsed {
  return strategies.includes('spec_mapping') ? 'spec_mapping' : (strategies[0] ?? 'manual');
}

/** The strategy the organization's default stands for (the kits' when it has none). */
export function organizationStrategy(a: AssemblyStrategy): StrategyUsed {
  return a.organization_default ?? kitsDefault(a.strategies);
}

/** The strategies to offer, from the kits; an older server's answer lists both with no names. */
export function offeredStrategies(a: AssemblyStrategy): StrategyKit[] {
  if (a.strategy_kits) return a.strategy_kits;
  return a.strategies.map((id) => ({
    id,
    name: id,
    description: '',
    kit: id === 'gears_matcher' ? 'gears-matcher' : 'spec-mapping',
    service: id === 'spec_mapping' ? null : 'gears-matcher/v1',
    offered: id === 'spec_mapping' || a.gears_matcher.offered,
  }));
}

/** Whether `id` is run by a service through the gear-match pipeline (every strategy but `spec_mapping`). */
export function isServiceStrategy(a: AssemblyStrategy | null, id: string): boolean {
  if (id === 'spec_mapping' || id === 'manual') return false;
  const kit = a ? offeredStrategies(a).find((k) => k.id === id) : undefined;
  return kit ? !!kit.service : true;
}

/** A strategy's name: Studio's own in the screen's words, an organization's as its kit names it. */
export function strategyName(
  id: string,
  t: (key: string) => string,
  kits: readonly Pick<StrategyKit, 'id' | 'name'>[] = []
): string {
  if (id === 'spec_mapping' || id === 'gears_matcher' || id === 'manual') return t(`strategy_${id}`);
  return kits.find((k) => k.id === id)?.name ?? id;
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
