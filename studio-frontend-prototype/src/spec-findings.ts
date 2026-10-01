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
