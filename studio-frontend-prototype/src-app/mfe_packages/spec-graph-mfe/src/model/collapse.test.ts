import { describe, expect, it } from 'vitest';
import type { Picture } from '../api/types';
import { foldKey, foldSections } from './collapse';

describe('folding sections into their documents', () => {
  const p: Picture = {
    key: 'sec:docs/a.md#x',
    nodes: [
      { key: 'doc:docs/a.md', type: 'document', name: 'A' },
      { key: 'sec:docs/a.md#x', type: 'section' },
      { key: 'sec:docs/a.md#y', type: 'section' },
      { key: 'sec:docs/b.md#z', type: 'section' },
      { key: 'cpt-r', type: 'requirement' },
    ],
    edges: [
      { from: 'doc:docs/a.md', to: 'sec:docs/a.md#x', type: 'has_section', kind: 'static' },
      { from: 'sec:docs/a.md#x', to: 'sec:docs/a.md#y', type: 'links_to', kind: 'static' },
      { from: 'sec:docs/a.md#x', to: 'cpt-r', type: 'references', kind: 'static' },
      { from: 'sec:docs/a.md#y', to: 'cpt-r', type: 'references', kind: 'static' },
      { from: 'sec:docs/b.md#z', to: 'cpt-r', type: 'references', kind: 'static' },
    ],
  };

  it('keeps documents and items, drawing each folded edge once', () => {
    const f = foldSections(p);
    expect(f.key).toBe('doc:docs/a.md');
    expect(f.nodes.map((n) => n.key).sort()).toEqual(['cpt-r', 'doc:docs/a.md', 'doc:docs/b.md']);
    expect(f.nodes.find((n) => n.key === 'doc:docs/a.md')?.name).toBe('A');
    expect(f.nodes.find((n) => n.key === 'doc:docs/b.md')?.name).toBe('b.md');
    expect(f.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual(['doc:docs/a.md>cpt-r', 'doc:docs/b.md>cpt-r']);
  });

  it('leaves other keys alone', () => {
    expect(foldKey('cpt-r')).toBe('cpt-r');
    expect(foldKey('sec:docs/a.md#x')).toBe('doc:docs/a.md');
  });
});
