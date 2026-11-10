import { describe, expect, it } from 'vitest';

import { openedIssue, reviewIndex, withoutRejected } from './reviews';
import type { SpecModelFact } from './spec-model';
import type { SpecModelReview } from '../api/types';

const fact = (subject: string, fact_key?: string): SpecModelFact & { fact_key?: string } => ({
  kind: 'entity',
  subject,
  aspect: '',
  value: '',
  text: subject,
  status: 'active',
  status_because: '',
  source: { path: 'docs/a.md', line_start: 1 },
  ...(fact_key ? { fact_key } : {}),
});

const review = (fact_key: string, state: string, note: string | null = null): SpecModelReview => ({
  fact_key,
  state,
  path: '',
  revision: '',
  note,
  decided_by: 'u',
  decided_at: '2026-11-10T00:00:00Z',
});

describe('reviews by the server key', () => {
  it('drops a rejected reading and keeps one saved here that has no key yet', () => {
    const index = reviewIndex([review('k1', 'rejected'), review('k2', 'accepted'), review('iss:f:x', 'opened')]);
    expect([...index.keys()]).toEqual(['k1', 'k2']);
    const kept = withoutRejected([fact('A', 'k1'), fact('B', 'k2'), fact('C')], index);
    expect(kept.map((f) => f.subject)).toEqual(['B', 'C']);
  });

  it('reads the issue opened for a row from its iss: decision', () => {
    const reviews = [review('iss:f:x', 'opened', 'https://github.com/o/r/issues/7'), review('iss:q:FR-1', 'proposed')];
    expect(openedIssue(reviews, 'f:x')).toBe('https://github.com/o/r/issues/7');
    expect(openedIssue(reviews, 'q:FR-1')).toBeNull();
    expect(openedIssue(reviews, 'n:FR-2')).toBeNull();
  });
});
