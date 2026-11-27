import { describe, expect, it } from 'vitest';
import type { Picture } from '../api/types';
import {
  areaOf,
  clusters,
  ontologyPicture,
  familyColour,
  familyOf,
  findingsPicture,
  ruleOf,
  colourBy,
  layoutAround,
  layoutIslands,
  leaders,
  toGraph,
  CLUSTER_COLOURS,
} from './picture';

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

  it('lists every relation of a pair on its one edge', () => {
    const g = toGraph({
      nodes: [
        { key: 'a', type: 'document' },
        { key: 'b', type: 'section' },
      ],
      edges: [
        { from: 'a', to: 'b', type: 'has_section', kind: 'static' },
        { from: 'a', to: 'b', type: 'links_to', kind: 'static' },
        { from: 'a', to: 'b', type: 'links_to', kind: 'static' },
      ],
    });
    expect(g.getEdgeAttribute(g.edge('a', 'b')!, 'label')).toBe('has_section, links_to');
  });

  it('draws the ontology: types sized by count, edge types between the types they connect', () => {
    const p = ontologyPicture({
      nodes: { document: 'A file', requirement: 'A requirement', design_element: 'An element' },
      edges: {
        defines: { from: ['document'], to: ['requirement', 'design_element'], kind: 'static (from the documents)' },
        judged_realizes: { from: ['design_element'], to: ['requirement'], kind: "analysis (a judge's conclusion)" },
      },
      counts: { requirement: 225, document: 83, phantom_node: 49 },
    });
    expect(p.nodes.map((n) => n.name).sort()).toEqual([
      'design_element (0)',
      'document (83)',
      'phantom_node (49)',
      'requirement (225)',
    ]);
    expect(p.edges).toHaveLength(3);
    const g = toGraph(p);
    expect(g.getNodeAttribute('requirement', 'size')).toBeGreaterThan(g.getNodeAttribute('document', 'size'));
    expect(g.getEdgeAttribute(g.edge('design_element', 'requirement')!, 'kind')).toBe('analysis');
  });

  it('sorts rules into families, each with its own validated colour', () => {
    expect(
      [
        'contradiction.value',
        'coverage.requirement-realized',
        'anchor.resolves',
        'document.reachable',
        'stale.superseded-link',
        'decision.status-superseded',
        'reference.misattributed',
        'bloat.near-duplicate',
      ].map(familyOf),
    ).toEqual(['contradiction', 'coverage', 'links', 'reach', 'stale', 'status', 'reference', 'other']);
    expect(
      new Set(
        ['contradiction', 'coverage', 'links', 'reach', 'stale', 'status', 'reference', 'other'].map(familyColour),
      ).size,
    ).toBe(8);
    expect(ruleOf('link.resolves: docs/a.md -> docs/b.md')).toBe('link.resolves');
  });

  it('draws the findings with the documents they cite, one rule when asked', () => {
    const p = findingsPicture({
      nodes: [
        { key: 'finding:1', type: 'finding', name: 'link.resolves: a' },
        { key: 'finding:2', type: 'finding', name: 'contradiction.value: b' },
        { key: 'sec:docs/a.md#x', type: 'section' },
        { key: 'doc:docs/a.md', type: 'document', name: 'A' },
        { key: 'doc:docs/b.md', type: 'document', name: 'B' },
      ],
      edges: [
        { from: 'finding:1', to: 'sec:docs/a.md#x', type: 'finding_cites', kind: 'analysis' },
        { from: 'finding:2', to: 'sec:docs/a.md#x', type: 'finding_cites', kind: 'analysis' },
        { from: 'finding:2', to: 'doc:docs/b.md', type: 'finding_cites', kind: 'analysis' },
        { from: 'doc:docs/a.md', to: 'doc:docs/b.md', type: 'links_to', kind: 'static' },
      ],
    });
    expect(p.nodes.map((n) => n.key).sort()).toEqual(['doc:docs/a.md', 'doc:docs/b.md', 'finding:1', 'finding:2']);
    expect(p.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual([
      'finding:1>doc:docs/a.md',
      'finding:2>doc:docs/a.md',
      'finding:2>doc:docs/b.md',
    ]);
    expect(p.nodes.find((n) => n.key === 'doc:docs/a.md')?.name).toBe('A');
    const one = findingsPicture({ nodes: p.nodes, edges: p.edges }, 'link.resolves');
    expect(one.nodes.map((n) => n.key).sort()).toEqual(['doc:docs/a.md', 'finding:1']);
    const g = toGraph(p);
    colourBy(g, 'finding', []);
    expect(g.getNodeAttribute('finding:1', 'cat')).toBe('links');
    expect(g.getNodeAttribute('finding:1', 'color')).toBe(familyColour('links'));
    expect(g.getNodeAttribute('doc:docs/a.md', 'cat')).toBe('document');
  });
});
