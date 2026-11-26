import { describe, expect, it } from 'vitest';
import { ruleRows } from './QualityView';

describe('rule rows', () => {
  it('joins findings per rule and gate with the calibration, most findings first', () => {
    const rows = ruleRows(
      { findings: { total: 3, block: 2, advise: 1, by_rule: { 'link.resolves (block)': 2, 'contradiction.value (advise)': 1 } } },
      {
        rules: {
          'contradiction.value': { real: 10, not: 0, unsure: 0, decided: 10, precision: 1, precision_lower_95: 0.72, may_block: true },
          'stale.superseded': { real: 1, not: 1, unsure: 0, decided: 2, precision: 0.5, precision_lower_95: 0.09, may_block: false },
        },
        threshold: { min_labels: 10, min_precision_lower: 0.7 },
      }
    );
    expect(rows.map((r) => [r.rule, r.gate, r.findings, r.mayBlock])).toEqual([
      ['link.resolves', 'block', 2, false],
      ['contradiction.value', 'advise', 1, true],
      ['stale.superseded', '', 0, false],      // labelled, no finding now
    ]);
  });
});
