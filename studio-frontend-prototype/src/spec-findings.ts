// How a row of the Specs list reads in its review column.
//
// The count is the server's: `spec-rows` folds every recorded `spec_finding`
// into `findings` and `checked_at` per row (studio-documents `spec_rows.rs`,
// rule in artifact-ingest `placed_findings`). This page used to page every
// verdict of the project and count them itself, which is how it came to
// disagree with the projects table about what a failing verdict is. What is
// left here is only the wording, the same four states the FrontX portal shows.

import type { SpecRow } from "./api";

export interface RowReview {
  label: string;
  /** The dot beside the label. */
  tone: string;
}

const MUTED = "var(--muted-foreground)";

/** Needs type · Check needed · N findings · 0 findings.
 *
 *  `reviewsKnown` false means the verdicts could not be read: a typed row then
 *  says nothing rather than "Check needed", which would claim nobody looked. */
export function rowReview(
  row: Pick<SpecRow, "type_key" | "state" | "checked_at" | "findings">,
  reviewsKnown = true,
): RowReview {
  if (row.state === "not_a_document") return { label: "Not a document", tone: MUTED };
  if (!row.type_key) return { label: "Needs type", tone: MUTED };
  if (!reviewsKnown) return { label: "—", tone: MUTED };
  // Findings first: a verdict recorded before verdicts were dated counts but
  // leaves `checked_at` null, and it is still something to fix.
  const n = row.findings ?? 0;
  if (n > 0) return { label: `${n} finding${n === 1 ? "" : "s"}`, tone: "var(--destructive)" };
  // No dated verdict from any detector.
  if (!row.checked_at) return { label: "Check needed", tone: "var(--warning)" };
  return { label: "0 findings", tone: "var(--success)" };
}
