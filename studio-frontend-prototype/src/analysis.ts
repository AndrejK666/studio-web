/** Reading a spec-quality result as an answer about documents.
 *
 *  The detectors answer about text. `bloat` returns clusters of repeated
 *  passages and a bag of set-wide `metrics`; `purpose` returns one role
 *  mixture per file. Neither answers the question somebody opened the Analysis
 *  tab with — *which document do I go and fix*, and *what have we actually
 *  written* — so that fold happens here.
 *
 *  Kept out of the view for the same reason as `rollups`: this is arithmetic
 *  with edge cases, and arithmetic with edge cases belongs somewhere a test
 *  can reach it without rendering anything.
 */

/** One document's share of the duplication a bloat run found. */
export interface DocDuplication {
  path: string;
  /** Clusters this document takes part in. */
  clusters: number;
  /** Times its text turns up in one — more than `clusters` when a passage
   *  repeats inside the same document as well as across others. */
  occurrences: number;
  /** Words counted in those occurrences, from the tokens the service already
   *  split each occurrence into. Its unit, not a second one invented here. */
  words: number;
  /** The other documents it shares text with — the pair that has to be
   *  reconciled. Empty means the document only repeats itself, which is a
   *  different and lesser complaint. */
  partners: string[];
}

/** Fold a bloat result's clusters into one row per document, worst first.
 *
 *  Only documents that appear in a cluster get a row. Listing the clean ones
 *  as zeroes would bury four real findings under eleven blanks; how many were
 *  read is a separate number, and the caller states it separately.
 *
 *  Defensive about the payload throughout: this response shape is not in the
 *  service's OpenAPI, so an occurrence without a `file`, or a cluster without
 *  `occurrences`, is skipped rather than crashing the tab that was supposed to
 *  explain the run.
 */
export function duplicationByDocument(clusters: unknown): DocDuplication[] {
  const rows = new Map<string, DocDuplication>();
  for (const raw of Array.isArray(clusters) ? clusters : []) {
    const cluster = (raw ?? {}) as { occurrences?: unknown };
    const occurrences = Array.isArray(cluster.occurrences) ? cluster.occurrences : [];
    const files = [
      ...new Set(
        occurrences
          .map((o) => ((o as { file?: unknown })?.file))
          .filter((f): f is string => typeof f === "string" && f.length > 0),
      ),
    ];
    for (const raw of occurrences) {
      const occurrence = (raw ?? {}) as { file?: unknown; tokens?: unknown };
      if (typeof occurrence.file !== "string" || !occurrence.file) continue;
      const row = rows.get(occurrence.file) ?? {
        path: occurrence.file,
        clusters: 0,
        occurrences: 0,
        words: 0,
        partners: [],
      };
      row.occurrences += 1;
      row.words += Array.isArray(occurrence.tokens) ? occurrence.tokens.length : 0;
      rows.set(occurrence.file, row);
    }
    // Clusters and partners are per-cluster facts, so each is counted once per
    // file however many times that file occurs inside the cluster.
    for (const path of files) {
      const row = rows.get(path);
      if (!row) continue;
      row.clusters += 1;
      for (const other of files) {
        if (other !== path && !row.partners.includes(other)) row.partners.push(other);
      }
    }
  }
  for (const row of rows.values()) row.partners.sort();
  return [...rows.values()].sort(
    (a, b) => b.words - a.words || b.occurrences - a.occurrences || a.path.localeCompare(b.path),
  );
}

/** What a `purpose` run says one document is made of. Only the two fields this
 *  fold needs; the rest of the result is the view's business. */
export interface PurposeShare {
  mixture?: Record<string, number> | null;
  n_tokens?: number | null;
}

/** The role mixture of a whole set, weighted by how long each document is.
 *
 *  Averaging the per-file shares would let a forty-word stub count as much as
 *  a four-thousand-word specification, which is how a set that is nearly all
 *  requirements comes out looking evenly mixed. Weighting by `n_tokens` makes
 *  the bar say what share of the SET's words read as each role.
 *
 *  A result that carries a mixture but no token count is weighted 1 rather
 *  than dropped: it then shows up as a rounding difference instead of as a
 *  document that silently left the set.
 */
export function weightedMixture(results: (PurposeShare | null | undefined)[]): {
  mixture: Record<string, number>;
  tokens: number;
} {
  const totals: Record<string, number> = {};
  let tokens = 0;
  for (const result of results) {
    const mixture = result?.mixture;
    if (!mixture || typeof mixture !== "object") continue;
    const weight = typeof result?.n_tokens === "number" && result.n_tokens > 0 ? result.n_tokens : 1;
    tokens += weight;
    for (const [role, share] of Object.entries(mixture)) {
      if (typeof share !== "number" || !Number.isFinite(share)) continue;
      totals[role] = (totals[role] ?? 0) + share * weight;
    }
  }
  // No readable result is not the same as a set that is 0% everything, and a
  // caller that renders an empty mixture draws an empty bar rather than four
  // confident zeroes.
  if (tokens === 0) return { mixture: {}, tokens: 0 };
  const mixture: Record<string, number> = {};
  for (const [role, sum] of Object.entries(totals)) mixture[role] = sum / tokens;
  return { mixture, tokens };
}
