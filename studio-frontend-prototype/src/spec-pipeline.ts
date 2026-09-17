/** The Spec pipeline's rows: what the project has of each document type.
 *
 *  A project gets documents two ways, and for a long time this screen only
 *  counted one of them. Somebody writes one in Studio — an authored `Doc` —
 *  or the repository already had one and a scan bound the file to a type. The
 *  Specs table shows fourteen bound documents with types on them while the
 *  pipeline said "not started" for every one of those types, because it was
 *  reading authored documents alone. Both are documents of that type, so both
 *  count here.
 *
 *  What stays separate is how sure we are. A binding in `confirmed` or
 *  `manual` state is a decision somebody made; `detected` is the scanner's
 *  guess, still sitting in the Needs review queue. Folding the guesses in
 *  would let the pipeline report coverage the project has not agreed to, so
 *  they are counted, shown, and kept out of the total.
 */

import type { DocBinding } from "./api";

/** The one field the fold reads off an authored document. Everything else on
 *  it belongs to whoever renders the row, so the fold is generic over the
 *  document rather than narrowing it to this — a caller that passes `Doc[]`
 *  gets `Doc[]` back, with its status and title intact. */
export interface AuthoredDoc {
  type_key: string;
}

/** A document type as the workspace defines it. */
export interface PipelineType {
  key: string;
  name: string;
  description?: string;
}

export interface PipelineRow<D extends AuthoredDoc = AuthoredDoc> {
  type: PipelineType;
  /** Documents written in Studio. */
  authored: D[];
  /** Repository files bound to this type by a decision — `confirmed` or
   *  `manual`. These are documents of this type as much as authored ones. */
  bound: DocBinding[];
  /** Repository files the scanner *thinks* are this type, still unconfirmed.
   *  Counted apart: a guess is not coverage. */
  proposed: DocBinding[];
  /** Nothing of this type exists and nothing has been proposed — the only
   *  state that honestly reads "not started". */
  untouched: boolean;
}

/** States in which a binding names a type somebody actually decided on. */
const SETTLED: ReadonlySet<string> = new Set(["confirmed", "manual"]);

/** Group every document a project has under the type it belongs to.
 *
 *  Returns one row per declared type, in the order the types were given — the
 *  workspace decides that order and this must not reshuffle it. Bindings
 *  naming a type the workspace no longer declares are dropped rather than
 *  invented into a row: the type list is the authority on what types exist.
 */
export function pipelineRows<D extends AuthoredDoc>(
  types: PipelineType[],
  docs: D[],
  bindings: DocBinding[],
): PipelineRow<D>[] {
  const authoredBy = new Map<string, D[]>();
  for (const doc of docs) {
    if (!doc?.type_key) continue;
    const list = authoredBy.get(doc.type_key) ?? [];
    list.push(doc);
    authoredBy.set(doc.type_key, list);
  }

  const boundBy = new Map<string, DocBinding[]>();
  const proposedBy = new Map<string, DocBinding[]>();
  for (const binding of bindings) {
    // `not_a_document` is a decision that this file is not one, and `unknown`
    // is the absence of any decision. Neither names a type worth counting,
    // whatever `type_key` happens to be left on the record.
    if (!binding?.type_key) continue;
    if (binding.state === "not_a_document" || binding.state === "unknown") continue;
    const into = SETTLED.has(binding.state) ? boundBy : proposedBy;
    const list = into.get(binding.type_key) ?? [];
    list.push(binding);
    into.set(binding.type_key, list);
  }

  return types.map((type) => {
    const authored = authoredBy.get(type.key) ?? [];
    const bound = boundBy.get(type.key) ?? [];
    const proposed = proposedBy.get(type.key) ?? [];
    return {
      type,
      authored,
      bound,
      proposed,
      untouched: authored.length === 0 && bound.length === 0 && proposed.length === 0,
    };
  });
}

/** How many documents of a type there are, and how many pass their type's
 *  checks.
 *
 *  `conformsOf` is injected because the screen may hold a fresher verdict than
 *  the record does: a "Validate all" run supersedes the `conforms` written at
 *  the document's last save. Bindings have no such re-check here, so their own
 *  `conforms` is used — and `null` counts as not-valid rather than as valid,
 *  because a document nobody has checked has not passed anything.
 */
export function coverage<D extends AuthoredDoc>(
  row: PipelineRow<D>,
  conformsOf: (doc: D) => boolean | null | undefined,
): { valid: number; total: number } {
  const valid =
    row.authored.filter((d) => conformsOf(d) === true).length +
    row.bound.filter((b) => b.conforms === true).length;
  return { valid, total: row.authored.length + row.bound.length };
}
