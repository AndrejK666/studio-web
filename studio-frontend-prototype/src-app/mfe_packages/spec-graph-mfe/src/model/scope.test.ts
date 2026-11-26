import { describe, expect, it } from 'vitest';
import { documentsOf, gearList, invalid, labelOf, scopeOf } from './scope';

describe('the documents a graph reads', () => {
  it('turns one documentation tree into --docs-root and --name', () => {
    expect(scopeOf({ layout: 'docs', root: './docs/', name: 'My Insight', gears: '' })).toBe(
      '--docs-root docs --name my-insight .'
    );
  });

  it('turns gear directories into a list, once each', () => {
    expect(gearList('gears/a\n gears/b, gears/a /gears/c/')).toEqual(['gears/a', 'gears/b', 'gears/c']);
    expect(scopeOf({ layout: 'gears', root: '', name: '', gears: 'gears/a\ngears/b' })).toBe('gears/a gears/b');
  });

  it('says what is missing', () => {
    expect(invalid({ layout: 'docs', root: ' ', name: 'x', gears: '' })).toBe('setup_need_root');
    expect(invalid({ layout: 'docs', root: 'docs', name: '***', gears: '' })).toBe('setup_need_name');
    expect(invalid({ layout: 'gears', root: '', name: '', gears: ' ' })).toBe('setup_need_gears');
    expect(invalid({ layout: 'docs', root: 'docs', name: 'insight', gears: '' })).toBeNull();
    expect(labelOf('  Insight  Front ')).toBe('insight-front');
  });

  it('reads a scope string back', () => {
    expect(documentsOf('--docs-root docs --name insight .')).toEqual({ layout: 'docs', root: 'docs', name: 'insight', gears: '' });
    expect(documentsOf('gears/a gears/b').gears).toBe('gears/a\ngears/b');
    expect(documentsOf(undefined, 'insight')).toEqual({ layout: 'docs', root: 'docs', name: 'insight', gears: '' });
  });
});
