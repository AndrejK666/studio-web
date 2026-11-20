import { describe, expect, it } from 'vitest';
import type { DocumentFindings, Finding } from '../api/types';
import { counts, documentsInOrder, ordered, place, plainThread, without } from './findings';

const anchor = (start: number | null, end: number | null = start) => ({
  section: null,
  line_start: start,
  line_end: end,
  quote: null,
});
const f = (id: string, gate: 'block' | 'advise', rule = 'r'): Finding => ({
  id,
  rule,
  detector: 'spec_graph',
  severity: gate === 'block' ? 'high' : 'medium',
  gate,
  title: id,
  message: '',
  anchor: anchor(1),
  related: [],
  evidence: [],
  source: null,
  suggestion: null,
});

describe('spec graph findings', () => {
  it('names a place by path and lines', () => {
    expect(place('a.md', anchor(3))).toBe('a.md:3');
    expect(place('a.md', anchor(3, 9))).toBe('a.md:3–9');
    expect(place('a.md', anchor(null))).toBe('a.md');
    expect(place(null, null)).toBe('');
  });

  it('puts blocking findings and documents first', () => {
    expect(ordered([f('x', 'advise', 'a'), f('y', 'block', 'z')]).map((x) => x.id)).toEqual(['y', 'x']);
    const docs: DocumentFindings[] = [
      { path: 'b.md', detector: 'spec_graph', findings: [f('1', 'advise')] },
      { path: 'a.md', detector: 'spec_graph', findings: [] },
      { path: 'c.md', detector: 'spec_graph', findings: [f('2', 'block')] },
    ];
    expect(documentsInOrder(docs).map((d) => d.path)).toEqual(['c.md', 'b.md']);
    expect(counts(docs)).toEqual({ total: 2, blocking: 1, documents: 2 });
  });

  it('leaves a decided finding out', () => {
    const docs: DocumentFindings[] = [{ path: 'a.md', detector: 'spec_graph', findings: [f('1', 'block'), f('2', 'advise')] }];
    expect(without(docs, '1')[0].findings.map((x) => x.id)).toEqual(['2']);
  });
});

describe('a review thread on the screen', () => {
  it('reads without its markers, footer, HTML and link targets', () => {
    const body = [
      '**Advisory** · model judgment · **Two passages give different values** (`contradiction.value`)',
      '',
      'These lines disagree with 1 other place:',
      '- [`a.md:3`](https://example.org/a.md#L3) — 100MB',
      '',
      '<details><summary>Why the judges think so</summary>',
      '',
      '- 100MB vs 250MB',
      '',
      '</details>',
      '',
      '```suggestion',
      'Body size hard limit: 100MB.',
      '```',
      '<sub>specq · cloud-strong · `fp1`</sub>',
      '<!-- specq:fp1 -->',
    ].join('\n');
    const text = plainThread(body);
    expect(text).toContain('Advisory · model judgment · Two passages give different values (`contradiction.value`)');
    expect(text).toContain('- `a.md:3` — 100MB');
    expect(text).toContain('Why the judges think so:');
    expect(text).toContain('Body size hard limit: 100MB.');
    expect(text).not.toMatch(/<|specq:|\*\*|https:|```/);
  });
});
