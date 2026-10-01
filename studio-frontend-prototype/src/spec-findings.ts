// How a document's recorded Spec Quality verdicts read on the Specs list.
//
// A verdict is one `spec_finding` node per detector per document. Since the
// server started recording runs itself, each carries the individual findings
// under `details.findings`, and THOSE are what a row counts: "3 findings"
// means three places in the text, not three detectors that looked.

import { findingItems, type SpecFinding } from "./api";

/** A detector verdict that is itself a complaint — the only thing a verdict
 *  recorded before the server kept findings can say. */
export const failingVerdict = (f: SpecFinding) =>
  f.severity === "high" || f.severity === "gate-failed";

/** How many things are wrong with a document: every finding a detector placed
 *  in it. A verdict recorded before findings were kept counts as one when it
 *  failed, so an old row does not read as clean. */
export function findingCount(found: SpecFinding[] | undefined): number {
  return (found ?? []).reduce((n, f) => {
    const items = findingItems(f);
    return n + (items.length > 0 ? items.length : failingVerdict(f) ? 1 : 0);
  }, 0);
}

export function findingLabel(found: SpecFinding[] | undefined): string {
  const n = findingCount(found);
  if (n === 0) return "No findings";
  return `${n} finding${n === 1 ? "" : "s"}`;
}

/** The dot beside that count. Findings outrank conformance: a document can
 *  satisfy its template exactly and still be the one with a section that
 *  belongs in another document, and that is the more useful thing to colour
 *  for. Red when anything is high, amber for the rest, green when the
 *  detectors looked and placed nothing. */
export function findingDotTone(found: SpecFinding[] | undefined, conforms?: boolean | null): string {
  if (found?.length) {
    if (findingCount(found) === 0) return "var(--success)";
    const worst = found.some(
      (f) => failingVerdict(f) || findingItems(f).some((i) => i.severity === "high"),
    );
    return worst ? "var(--destructive)" : "var(--warning)";
  }
  if (conforms === false) return "var(--warning)";
  if (conforms === true) return "var(--success)";
  return "var(--muted-foreground)";
}

/** What each kind of finding is called on the list, singular and plural. */
const RULE_LABEL: Record<string, [string, string]> = {
  "purpose.foreign_section": ["section of another kind", "sections of another kind"],
  "leak.foreign_content": ["foreign passage", "foreign passages"],
  "purpose.not_a_spec": ["not a specification", "not a specification"],
  "bloat.cross_document": ["duplicate of another doc", "duplicates of other docs"],
  "bloat.self_repeat": ["repeat within the doc", "repeats within the doc"],
};

export interface FindingKind {
  rule: string;
  label: string;
  count: number;
  /** Any of them high — what the row is coloured red for. */
  high: boolean;
}

/** A document's findings counted by kind, most first. A failed verdict
 *  recorded before findings were kept is its detector's kind, once. */
export function findingsByKind(found: SpecFinding[] | undefined): FindingKind[] {
  const kinds = new Map<string, { count: number; high: boolean }>();
  const add = (rule: string, high: boolean) => {
    const k = kinds.get(rule) ?? { count: 0, high: false };
    k.count += 1;
    k.high = k.high || high;
    kinds.set(rule, k);
  };
  for (const f of found ?? []) {
    const items = findingItems(f);
    if (items.length > 0) for (const i of items) add(i.rule, i.severity === "high");
    else if (failingVerdict(f)) add(f.detector, true);
  }
  return [...kinds.entries()]
    .map(([rule, k]) => {
      const [one, many] = RULE_LABEL[rule] ?? [rule, rule];
      return { rule, label: k.count === 1 ? one : many, count: k.count, high: k.high };
    })
    .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule));
}

/** "3 sections of another kind · 2 duplicates of other docs" — the row's
 *  breakdown of its count. Empty when there is nothing to break down. */
export function findingBreakdown(found: SpecFinding[] | undefined): string {
  return findingsByKind(found)
    .map((k) => `${k.count} ${k.label}`)
    .join(" · ");
}
