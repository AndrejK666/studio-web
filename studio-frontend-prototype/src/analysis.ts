/** What a whole document SET is made of, as the purpose detector sees it.
 *
 *  The other half of this file — reading a `bloat` result as one row per
 *  document — moved to `spec_quality/analysis.rs`, where it now runs once when
 *  the analysis does rather than on every render.
 *
 *  This half stayed, for a reason worth stating rather than assuming: its only
 *  caller aggregates results THIS PAGE gathered, one document at a time, in a
 *  loop it drives itself. A copy on the server would be a field nobody reads.
 *  When a batch run is read back from the server instead of driven from here,
 *  this belongs beside the other half.
 */

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
