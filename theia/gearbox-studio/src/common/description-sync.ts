// Constructor Studio: keeping a product.gdl in the checkout and the revision
// Studio keeps in step (ADR-0053 §1, §2) -- the rules, without a file system
// or a server, so they can be tested.
//
// The desktop opens a product from Studio and writes the latest revision into
// the checkout; every change of the file after that (a save in the editor, an
// Apply in Gearbox) is handed to Studio as a new revision, made against the
// revision the file was last in step with. A conflict -- someone saved a
// newer one meanwhile -- is the person's to settle: keep theirs (save again
// against the newer one) or take the newer one into the file.

import type { DescriptionSave, StudioDescriptionRevision } from "./protocol";

/** What the checkout and Studio last agreed on, per file. */
export interface InStep {
  /** The revision the file holds; undefined before Studio held any. */
  readonly revision: number | undefined;
  /** Its text, as last written or saved: a change is a text that differs. */
  readonly text: string | undefined;
}

/** On open: what to write into the file (if anything), and what the file is then in step with. */
export function onOpen(
  fileText: string | undefined,
  latest: StudioDescriptionRevision | undefined,
): { readonly write: string | undefined; readonly inStep: InStep } {
  if (latest === undefined) return { write: undefined, inStep: { revision: undefined, text: fileText } };
  return {
    write: latest.text === fileText ? undefined : latest.text,
    inStep: { revision: latest.revision, text: latest.text },
  };
}

/** Whether the file's text is a change to hand to Studio. */
export function isChange(text: string, inStep: InStep): boolean {
  return text.trim() !== "" && text !== inStep.text;
}

/** What the file is in step with after a save answered `answer`; unchanged on a conflict or none. */
export function afterSave(text: string, answer: DescriptionSave, before: InStep): InStep {
  return answer.kind === "saved" ? { revision: answer.revision, text } : before;
}

/** The person's choice in a conflict. */
export type ConflictChoice = "mine" | "theirs" | "later";

/**
 * What a conflict choice does: `mine` saves the file's text again against the
 * newer revision; `theirs` writes the newer revision into the file; `later`
 * leaves both, and the next change of the file asks again.
 */
export function onConflict(
  choice: ConflictChoice,
  latest: StudioDescriptionRevision,
  before: InStep,
): { readonly saveAgainst: number | undefined; readonly write: string | undefined; readonly inStep: InStep } {
  switch (choice) {
    case "mine":
      return { saveAgainst: latest.revision, write: undefined, inStep: before };
    case "theirs":
      return { saveAgainst: undefined, write: latest.text, inStep: { revision: latest.revision, text: latest.text } };
    default:
      return { saveAgainst: undefined, write: undefined, inStep: before };
  }
}
