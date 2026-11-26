import { describe, expect, it } from 'vitest';
import type { Picture } from '../api/types';
import { areaOf, clusters, colourBy, layoutAround, layoutIslands, leaders, toGraph, CLUSTER_COLOURS } from './picture';

/** Two components of four documents each, linked once. */
function twoAreas(): Picture {
  const nodes = [];
  const edges = [];
  for (const area of ['auth', 'billing']) {
    for (let i = 0; i < 5; i += 1)
      nodes.push({
        key: `doc:docs/components/${area}/d${i}.md`,
        type: 'document',
        name: `${area} ${i}`,
        path: `docs/components/${area}/d${i}.md`,
      });
    for (let i = 1; i < 5; i += 1) {
      edges.push({
        from: `doc:docs/components/${area}/d0.md`,
        to: `doc:docs/components/${area}/d${i}.md`,
        type: 'links_to',
        kind: 'static' as const,
      });
      edges.push({
        from: `doc:docs/components/${area}/d${i}.md`,
        to: `doc:docs/components/${area}/d${(i % 4) + 1}.md`,
        type: 'links_to',
        kind: 'static' as const,
      });
    }
  }
  edges.push({
    from: 'doc:docs/components/auth/d0.md',
    to: 'doc:docs/components/billing/d0.md',
    type: 'links_to',
    kind: 'analysis' as const,
  });
  return { nodes, edges };
}

describe('graph pictures for sigma', () => {
  it("makes one undirected edge per pair, a judge's edge winning, sized by links", () => {
    const g = toGraph({
      nodes: [
        { key: 'a', type: 'document' },
        { key: 'b', type: 'requirement' },
      ],
      edges: [
        { from: 'a', to: 'b', type: 'defines', kind: 'static' },
        { from: 'b', to: 'a', type: 'judged_realizes', kind: 'analysis' },
        { from: 'a', to: 'missing', type: 'links_to', kind: 'static' },
      ],
    });
    expect(g.size).toBe(1);
    expect(g.getEdgeAttributes(g.edge('a', 'b')!).kind).toBe('analysis');
    expect(g.getNodeAttribute('a', 'color')).toBe('#2563eb');
  });

  it('names a component by its directory', () => {
    expect(areaOf('docs/components/backend/authenticator/specs/ADR/0001.md')).toBe('components/backend/authenticator');
    expect(areaOf('README.md')).toBe('');
  });

  it('finds the two components as two clusters, named and coloured, the same every time', () => {
    const g = toGraph(twoAreas());
    const found = clusters(g);
    expect(found.map((c) => c.size)).toEqual([5, 5]);
    expect(found.map((c) => c.name.split(' · ')[0]).sort()).toEqual(['components/auth', 'components/billing']);
    expect(found.every((c) => c.name.includes(' · '))).toBe(true);
    expect(found.map((c) => c.lead).sort()).toEqual([
      'doc:docs/components/auth/d0.md',
      'doc:docs/components/billing/d0.md',
    ]);
    expect(found[0].colour).toBe(CLUSTER_COLOURS[0]);
    const again = clusters(toGraph(twoAreas()));
    expect(again.map((c) => c.name)).toEqual(found.map((c) => c.name));
    colourBy(g, 'cluster', found);
    expect(new Set(g.mapNodes((_, a) => a.color)).size).toBe(2);
    colourBy(g, 'type', found);
    expect(new Set(g.mapNodes((_, a) => a.color))).toEqual(new Set(['#2563eb']));
  });

  it('packs each cluster on its own island', () => {
    const g = toGraph(twoAreas());
    clusters(g);
    layoutIslands(g);
    const centreOf = (area: string) => {
      const ks = g.filterNodes((k) => k.includes(`/${area}/`));
      return {
        x: ks.reduce((s, k) => s + g.getNodeAttribute(k, 'x'), 0) / ks.length,
        y: ks.reduce((s, k) => s + g.getNodeAttribute(k, 'y'), 0) / ks.length,
      };
    };
    const a = centreOf('auth');
    const b = centreOf('billing');
    const spread = Math.max(
      ...g
        .filterNodes((k) => k.includes('/auth/'))
        .map((k) => Math.hypot(g.getNodeAttribute(k, 'x') - a.x, g.getNodeAttribute(k, 'y') - a.y)),
    );
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(spread);
  });

  it('lays a depth picture out around a fixed centre, the same every time', () => {
    const centre = 'doc:docs/components/auth/d0.md';
    const one = toGraph(twoAreas());
    layoutAround(one, centre, 100);
    const two = toGraph(twoAreas());
    layoutAround(two, centre, 100);
    expect(one.getNodeAttribute(centre, 'x')).toBe(0);
    expect(one.getNodeAttribute(centre, 'y')).toBe(0);
    expect(one.mapNodes((_, a) => [a.x, a.y])).toEqual(two.mapNodes((_, a) => [a.x, a.y]));
    expect(leaders(one, 1, centre).has(centre)).toBe(true);
  });

  it('draws nothing for an empty picture', () => {
    const g = toGraph({ nodes: [], edges: [] });
    expect(clusters(g)).toEqual([]);
    layoutAround(g);
    layoutIslands(g);
    expect(g.order).toBe(0);
  });
});
