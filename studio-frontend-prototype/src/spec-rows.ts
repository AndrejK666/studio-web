/** One list for every spec a project has, however it got there.
 *
 *  A project's documents arrive two ways and used to be shown two ways, on
 *  tabs called "In the repository" and "Authored". That split is about *where
 *  the bytes live*, which is an implementation detail of ours, and it made the
 *  one question a reader actually has — "what specs do we have, and are they
 *  any good" — unanswerable without reading two lists and merging them by eye.
 *
 *  **Where the bytes live, since the split was hiding it:**
 *
 *  | origin | content lives in | row in |
 *  |---|---|---|
 *  | `repository` | the artifact graph's file node, written by a sync | `studio_document_bindings` |
 *  | `authored` | `studio_documents.content`, a Postgres column | `studio_documents` |
 *
 *  Neither is S3. Object storage holds *uploaded binaries* — a PDF somebody
 *  attached — and even then the graph node carries a reference, never the
 *  bytes. And an authored document reaches the repository only when somebody
 *  presses Commit, which writes it through the connector; until then it exists
 *  in Studio and nowhere else.
 *
 *  Keeping both in one list means keeping the difference visible rather than
 *  keeping it in separate tabs: the Origin column says which, and the actions
 *  a row offers differ because the two really are different things.
 */

import type { Doc, DocBinding, DocBindingState } from "./api";

export type SpecOrigin = "repository" | "authored";

export interface SpecRow {
  /** Unique across both kinds: the binding id or the document id. */
  id: string;
  origin: SpecOrigin;
  /** What to show in the Name column. */
  name: string;
  /** Repo-relative path for a repository file; empty for an authored one,
   *  which has no path until it is committed. */
  path: string;
  /** `null` when nothing has decided a type yet. */
  typeKey: string | null;
  /** Graph node id, for a repository row — what findings are keyed on. */
  nodeId: string | null;
  /** The binding's state. Authored documents have none: nobody has to decide
   *  what an authored document is, because somebody chose its type to write it. */
  state: DocBindingState | null;
  /** `draft` | `review` | `approved` for an authored one; `null` otherwise —
   *  a repository file has no editorial status, only a type decision. */
  status: Doc["status"] | null;
  /** The last validation verdict, from whichever record holds it. */
  conforms: boolean | null;
  updatedAt: string;
  /** The record this row came from, for the actions that need it. */
  binding: DocBinding | null;
  doc: Doc | null;
}

/** The last path segment — what a reader recognises. */
function leaf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** A file the sync ingested that nothing has classified yet.
 *
 *  These exist the moment a repository is synced, long before anyone presses
 *  Scan. Showing them is the difference between "this project has 5785 files,
 *  none analysed" and an empty screen that reads as "there is nothing here" —
 *  and the analysis, when it runs, fills in what each one turned out to be
 *  rather than deciding which of them were worth showing.
 */
export interface SpecCandidate {
  /** Graph node id — how a later scan matches its result back to this file. */
  nodeId: string;
  path: string;
}

/** Merge every source into one list.
 *
 *  Authored documents come first within the same instant, because they are the
 *  ones this project decided to write; beyond that it is newest first, which
 *  is the order somebody scanning for "what moved" wants.
 *
 *  A candidate is dropped as soon as a binding exists for the same node: the
 *  binding is the same file, one step further along, and listing both would
 *  count one file twice.
 */
export function specRows(
  bindings: DocBinding[],
  docs: Doc[],
  candidates: SpecCandidate[] = [],
): SpecRow[] {
  const rows: SpecRow[] = [];
  const bound = new Set(bindings.map((b) => b.node_id));

  for (const b of bindings) {
    rows.push({
      id: b.id,
      origin: "repository",
      name: leaf(b.path),
      path: b.path,
      typeKey: b.type_key ?? null,
      nodeId: b.node_id,
      state: b.state,
      status: null,
      conforms: b.conforms ?? null,
      updatedAt: b.updated_at,
      binding: b,
      doc: null,
    });
  }

  for (const d of docs) {
    rows.push({
      id: d.id,
      origin: "authored",
      name: d.title,
      path: "",
      typeKey: d.type_key,
      nodeId: null,
      state: null,
      status: d.status,
      conforms: d.conforms ?? null,
      updatedAt: d.updated_at,
      binding: null,
      doc: d,
    });
  }

  for (const c of candidates) {
    if (bound.has(c.nodeId)) continue;
    rows.push({
      id: `candidate:${c.nodeId}`,
      // It IS a repository file — the only thing it lacks is a decision. Giving
      // it a third origin would say the bytes live somewhere else, which is the
      // question Origin answers.
      origin: "repository",
      name: leaf(c.path),
      path: c.path,
      typeKey: null,
      nodeId: c.nodeId,
      // No binding, so no state: nothing has judged this file yet. That is what
      // puts it in the "not scanned" queue and keeps it out of "needs review",
      // which is for files a detector already had an opinion about.
      state: null,
      status: null,
      conforms: null,
      updatedAt: "",
      binding: null,
      doc: null,
    });
  }

  return rows.sort((a, b) => {
    const at = Date.parse(a.updatedAt);
    const bt = Date.parse(b.updatedAt);
    // An unreadable date sorts last rather than first, for the same reason it
    // does in the activity feed: the least informative rows must not take the
    // place where the most recent ones belong.
    const av = Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
    const bv = Number.isNaN(bt) ? Number.NEGATIVE_INFINITY : bt;
    if (av !== bv) return bv - av;
    if (a.origin !== b.origin) return a.origin === "authored" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** The queues the filter chips offer.
 *
 *  `needs-review` is the one that has to be right: it is a queue, and a queue
 *  that lists things nobody can act on stops being read. Only an undecided
 *  repository file belongs in it — an authored document was written *as* a
 *  type, so there is nothing to review about what it is.
 */
export type SpecFilter = "not-scanned" | "needs-review" | "bound" | "not-documents" | "all";

export function inFilter(row: SpecRow, filter: SpecFilter): boolean {
  switch (filter) {
    case "not-scanned":
      // Ingested and never analysed. Distinct from `needs-review` on purpose:
      // that queue is for a decision a detector already proposed, this one is
      // for files nothing has looked at yet.
      return row.origin === "repository" && row.binding === null;
    case "needs-review":
      return row.origin === "repository" && (row.state === "detected" || row.state === "unknown");
    case "bound":
      // Authored documents are bound by construction: somebody picked the type
      // before writing a word.
      return (
        row.origin === "authored" || row.state === "confirmed" || row.state === "manual"
      );
    case "not-documents":
      return row.state === "not_a_document";
    case "all":
      return true;
  }
}

/** Count each queue once, so the chips and the list cannot disagree. */
export function specCounts(rows: SpecRow[]): Record<SpecFilter, number> {
  const counts: Record<SpecFilter, number> = {
    "not-scanned": 0,
    "needs-review": 0,
    bound: 0,
    "not-documents": 0,
    all: rows.length,
  };
  for (const row of rows) {
    for (const filter of ["not-scanned", "needs-review", "bound", "not-documents"] as const) {
      if (inFilter(row, filter)) counts[filter] += 1;
    }
  }
  return counts;
}
