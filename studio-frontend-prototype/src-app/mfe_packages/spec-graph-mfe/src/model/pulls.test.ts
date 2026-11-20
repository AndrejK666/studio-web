import { describe, expect, it } from 'vitest';
import { pullsOf } from './pulls';

const pr = (id: string, repo: string | null, branch: string) => ({
  id,
  repo,
  number: 1,
  title: id,
  url: null,
  source_branch: branch,
});

describe('pullsOf', () => {
  it('keeps the configured repository only, even with the same branch elsewhere', () => {
    const pulls = [pr('a', 'vasylcf/gears-rust', 'fix'), pr('b', 'acme/other', 'fix'), pr('c', null, 'fix')];
    const { mine, others } = pullsOf(pulls, 'VasylCF/Gears-Rust.git');
    expect(mine.map((p) => p.id)).toEqual(['a']);
    expect(others).toBe(2);
  });

  it('keeps none when the repository is not known', () => {
    expect(pullsOf([pr('a', 'o/r', 'x')], null)).toEqual({ mine: [], others: 1 });
  });
});
