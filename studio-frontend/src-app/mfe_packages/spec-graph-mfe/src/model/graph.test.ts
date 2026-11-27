import { describe, expect, it } from 'vitest';
import type { Finding } from '../api/types';
import { findingNode, kindOf, label, side } from './graph';

describe('graph labels', () => {
  it('shortens keys by their kind', () => {
    expect(label('doc:gears/mini-chat/docs/PRD.md')).toBe('PRD.md');
    expect(label('sec:gears/mini-chat/docs/PRD.md#streaming-cancellation')).toBe('§ streaming-cancellation');
    expect(label('cpt-cf-mini-chat-fr-streaming-cancellation')).toBe('fr streaming-cancellation');
    expect(label('cpt-cf-mini-chat-component-chat-service')).toBe('component chat-service');
    expect(kindOf('sec:a.md#x')).toBe('section');
    expect(kindOf('cpt-cf-x-fr-y')).toBe('item');
  });
});

describe('a side of the map', () => {
  it('puts judged edges first, lists each neighbour once, and counts the rest', () => {
    const s = side(
      { defines: ['doc:p.md'], references: ['b', 'a'] },
      [{ edge: 'judged_realizes', from: 'cpt-cf-x-component-svc', to: 'r' }],
      'in',
      3
    );
    expect(s.shown.map((x) => [x.edge, x.key, x.judged])).toEqual([
      ['judged_realizes', 'cpt-cf-x-component-svc', true],
      ['defines', 'doc:p.md', false],
      ['references', 'a', false],
    ]);
    expect(s.more).toBe(1);
  });
});

describe("a finding's node", () => {
  const f = (section: string | null) => ({ anchor: { section, line_start: 1, line_end: 1, quote: null } }) as unknown as Finding;
  it('is its section when the graph cites one, else its document', () => {
    expect(findingNode('a.md', f('limits'))).toBe('sec:a.md#limits');
    expect(findingNode('a.md', f(null))).toBe('doc:a.md');
    expect(findingNode(null, f(null))).toBeNull();
  });
});
