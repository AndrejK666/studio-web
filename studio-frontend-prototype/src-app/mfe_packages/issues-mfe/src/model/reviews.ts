/*
 * Members' reviews laid over the model, keyed the server's way. The prototype
 * keyed a fact in the browser (`review-state.ts`, `factKey`); the server
 * returns that key on every fact now (`fact_key` on GET /spec-model), so only
 * the lookups are left here. A fact saved on this screen and not read by a
 * build yet (saved-entities.ts) has no key: nobody can have rejected it.
 */

import type { SpecModelFact } from './spec-model';
import type { SpecModelReview } from '../api/types';

export type ReviewState = 'accepted' | 'rejected';

/** Each fact's accept or reject, by its key. */
export function reviewIndex(reviews: SpecModelReview[]): Map<string, ReviewState> {
  return new Map(
    reviews
      .filter((r) => r.state === 'accepted' || r.state === 'rejected')
      .map((r) => [r.fact_key, r.state as ReviewState])
  );
}

/** The facts the model is built from: everything not rejected. */
export function withoutRejected<F extends SpecModelFact & { fact_key?: string }>(
  facts: F[],
  index: Map<string, ReviewState>
): F[] {
  return index.size === 0 ? facts : facts.filter((f) => !f.fact_key || index.get(f.fact_key) !== 'rejected');
}

/** The issue opened for a row, as recorded under `iss:<row key>`; null when none was. */
export function openedIssue(reviews: SpecModelReview[], key: string): string | null {
  const r = reviews.find((x) => x.fact_key === `iss:${key}`);
  return r?.state === 'opened' ? (r.note ?? null) : null;
}
