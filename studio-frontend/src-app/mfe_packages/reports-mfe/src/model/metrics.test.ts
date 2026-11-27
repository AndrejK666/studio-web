import { describe, expect, it } from 'vitest';
import { metricRows } from './metrics';

describe('metricRows', () => {
  it('keeps measured zero, missing totals, and distinct contributors separate', () => {
    expect(metricRows({
      costs: 'hidden',
      spend: null,
      insight: {
        state: 'ok',
        truncated: false,
        measures: [
          { key: 'git.pr_merged', current: { total: 0, people: 2 }, previous: null },
          { key: 'git.contributors', current: { total: 20, people: 3 }, previous: { total: 8, people: 2 } },
        ],
      },
    })).toEqual([
      { label: 'metrics_merged', current: 0, previous: null },
      { label: 'metrics_bugs', current: null, previous: null },
      { label: 'metrics_contributors', current: 3, previous: 2 },
    ]);
  });
});
