/* The Components tab as one flow: what to do next, how to make the product
 * resolve, and what the code already says.
 *
 * Pure rules behind `kits.tsx`, kept here so they can be tested:
 *   - `nextStep`: the one sentence at the top of the page, in place of three
 *     tiles a person had to read and combine;
 *   - `fixesFrom`: the engine's completion (`POST /gearbox/complete`) turned
 *     into separate fixes, each applied on its own, instead of one "Make it
 *     resolve" that changes everything at once;
 *   - `codeDiff`: the product against what the code depends on, for "Take
 *     the product from the code";
 *   - `rowShortlist` / `alsoCovers`: section 1 shows one recommendation per
 *     capability and says when one gear answers several;
 *   - `plainText`: a statement quoted from a spec without its markdown. */

import type { Candidate, Conformance, GearConfig, PlanRow, ProductChange } from "./api";
import { isPickable } from "./product";

/** A sentence from a document, without the markdown that was around it. */
export function plainText(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s*#+\s*/, "")
    .replace(/^\s*[-*]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Fixes ────────────────────────────────────────────────────────────────

export type Fix =
  | { kind: "add"; gear: string; reason: string }
  | { kind: "remove"; gear: string; reason: string }
  | { kind: "config"; gear: string; field: string; value: unknown; reason: string };

/** The engine's completion of the current product, as separate fixes. */
export function fixesFrom(
  picks: readonly string[],
  config: GearConfig,
  completion: { gears: string[]; changes: ProductChange[]; config?: GearConfig },
): Fix[] {
  const out: Fix[] = [];
  const seen = new Set<string>();
  for (const c of completion.changes) {
    const key = `${c.added ? "+" : "-"}${c.gear}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (c.added && !picks.includes(c.gear)) out.push({ kind: "add", gear: c.gear, reason: c.reason });
    if (!c.added && picks.includes(c.gear)) out.push({ kind: "remove", gear: c.gear, reason: c.reason });
  }
  for (const [gear, fields] of Object.entries(completion.config ?? {})) {
    for (const [field, value] of Object.entries(fields)) {
      if (JSON.stringify(config[gear]?.[field]) === JSON.stringify(value)) continue;
      out.push({
        kind: "config",
        gear,
        field,
        value,
        reason: `the engine needs ${field} = ${typeof value === "string" ? value : JSON.stringify(value)}`,
      });
    }
  }
  return out;
}

/** The picks and configuration with one fix applied. */
export function applyFix(
  picks: readonly string[],
  config: GearConfig,
  fix: Fix,
): { picks: string[]; config: GearConfig } {
  if (fix.kind === "add") return { picks: picks.includes(fix.gear) ? [...picks] : [...picks, fix.gear], config };
  if (fix.kind === "remove") {
    const next = { ...config };
    delete next[fix.gear];
    return { picks: picks.filter((p) => p !== fix.gear), config: next };
  }
  return { picks: [...picks], config: { ...config, [fix.gear]: { ...(config[fix.gear] ?? {}), [fix.field]: fix.value } } };
}

// ── The code ─────────────────────────────────────────────────────────────

/** The gears the code depends on that a product can pick. */
export function codeGears(report: Pick<Conformance, "components_in_code">): string[] {
  return report.components_in_code.filter((n) => isPickable({ name: n, kind: "gear" }));
}

/** The product against the code: what taking the product from the code adds,
 *  drops and keeps. */
export function codeDiff(picks: readonly string[], code: readonly string[]): { add: string[]; drop: string[]; keep: string[] } {
  return {
    add: code.filter((n) => !picks.includes(n)),
    drop: picks.filter((n) => !code.includes(n)),
    keep: picks.filter((n) => code.includes(n)),
  };
}

/** What the code says about one capability: the gears in it that fill it. */
export function codeFor(
  report: Conformance | null,
  capability: string,
): { status: "implemented" | "missing"; by: { name: string; declared: boolean }[] } | null {
  const item = report?.items.find((i) => i.capability === capability);
  return item ? { status: item.status, by: item.implemented_by } : null;
}

// ── Section 1, shorter ───────────────────────────────────────────────────

/** The candidate a row recommends: built, pickable, not blocked, the engine's
 *  runnable ones first; else the first candidate. */
export function recommended(row: PlanRow): Candidate | undefined {
  const usable = row.candidates.filter((c) => c.built === "built" && isPickable(c) && c.composable !== "blocked");
  return usable.find((c) => c.composable === "runs") ?? usable[0] ?? row.candidates[0];
}

/** The candidates a collapsed row shows -- the ones in the product and the
 *  recommended one -- and how many are folded away. */
export function rowShortlist(row: PlanRow, picks: readonly string[], expanded: boolean): { shown: Candidate[]; hidden: number } {
  if (expanded) return { shown: row.candidates, hidden: 0 };
  const best = recommended(row);
  const shown = row.candidates.filter((c) => picks.includes(c.name) || c === best);
  return { shown, hidden: row.candidates.length - shown.length };
}

/** For each candidate, the capabilities it is offered for, so a gear that
 *  answers three rows can say so instead of looking like three answers. */
export function alsoCovers(plan: readonly PlanRow[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const row of plan) {
    for (const c of row.candidates) {
      const list = (out[c.name] ??= []);
      if (!list.includes(row.capability)) list.push(row.capability);
    }
  }
  return out;
}

// ── The next step ────────────────────────────────────────────────────────

export type NextAction = "add-recommended" | "take-from-code" | "preview" | "fix" | "build" | "open";

export interface NextStep {
  text: string;
  action?: NextAction;
  /** `done`: nothing left to do; `warn`: it can go on, with a gap said out loud. */
  tone: "todo" | "warn" | "done";
}

export interface FlowState {
  /** Capabilities the specs ask for; null while they are read. */
  capabilities: number | null;
  /** Capabilities no gear in the product closes. */
  open: number;
  picks: number;
  /** Gears the code already depends on; null while it is read. */
  inCode: number | null;
  /** The engine's verdict on the current product; null when not asked yet. */
  resolves: boolean | null;
  /** Fixes the engine offers for a product that does not resolve. */
  fixes: number;
  /** product.gdl is in the repository for the current product. */
  written: boolean;
  composing: boolean;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function nextStep(s: FlowState): NextStep {
  if (s.capabilities === null) return { text: "Reading what the specs ask for…", tone: "todo" };
  if (!s.composing) {
    return {
      text: "Composing a product needs the Gearbox engine, which is off here; the specs and the code can still be compared below.",
      tone: "warn",
    };
  }
  if (s.picks === 0) {
    if (s.inCode && s.inCode > 0) {
      return {
        text: `Start the product from the code: it already depends on ${plural(s.inCode, "gear", "gears")}.`,
        action: "take-from-code",
        tone: "todo",
      };
    }
    return { text: "Start the product: add the recommended gear for each capability.", action: "add-recommended", tone: "todo" };
  }
  if (s.resolves === null) return { text: "Check the product: ask the Gearbox engine whether it resolves.", action: "preview", tone: "todo" };
  if (!s.resolves) {
    return s.fixes > 0
      ? { text: `The product does not resolve. ${plural(s.fixes, "fix", "fixes")} below make it resolve.`, action: "fix", tone: "todo" }
      : { text: "The product does not resolve, and the engine offers no fix: see the errors below.", tone: "todo" };
  }
  const gap =
    s.open > 0
      ? ` ${plural(s.open, "capability", "capabilities")} the specs ask for ${s.open === 1 ? "is" : "are"} not closed yet.`
      : "";
  if (!s.written) return { text: `The product resolves: build it in Studio-ide.${gap}`, action: "build", tone: gap ? "warn" : "todo" };
  return { text: `Built: product.gdl is in the repository. Open it in Studio-ide.${gap}`, action: "open", tone: gap ? "warn" : "done" };
}
