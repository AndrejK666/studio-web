import { describe, expect, it } from 'vitest';
import type { PictureEdge, PictureNode } from '../api/types';
import { hopsFrom, layout } from './layout';

const node = (key: string, type = 'section'): PictureNode => ({ key, type });
const edge = (from: string, to: string): PictureEdge => ({ from, to, type: 'links_to', kind: 'static' });

describe('the graph layout', () => {
  const nodes = ['c', 'a', 'b', 'd', 'e'].map((k) => node(k));
  const edges = [edge('c', 'a'), edge('b', 'c'), edge('a', 'd')];

  it('counts hops from the centre both ways, and leaves the unreachable out', () => {
    const h = hopsFrom('c', nodes, edges);
    expect([...h.entries()].sort()).toEqual([['a', 1], ['b', 1], ['c', 0], ['d', 2]]);
  });

  it('places every node apart, the same way every time', () => {
    const one = layout(nodes, edges, { centre: 'c' });
    const two = layout(nodes, edges, { centre: 'c' });
    expect([...one.at.keys()].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect([...one.at.entries()]).toEqual([...two.at.entries()]);
    const pts = [...one.at.values()];
    for (let i = 0; i < pts.length; i += 1)
      for (let j = i + 1; j < pts.length; j += 1)
        expect(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y)).toBeGreaterThan(5);
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(one.width);
      expect(p.y).toBeLessThanOrEqual(one.height);
    }
  });

  it('keeps linked nodes nearer than unlinked ones', () => {
    const l = layout(nodes, edges, { centre: 'c' });
    const d = (a: string, b: string) => Math.hypot(l.at.get(a)!.x - l.at.get(b)!.x, l.at.get(a)!.y - l.at.get(b)!.y);
    expect(d('c', 'a')).toBeLessThan(d('c', 'e'));
  });

  it('lays out a thousand nodes quickly', () => {
    const many = Array.from({ length: 1000 }, (_, i) => node(`n${i}`, i % 3 ? 'section' : 'document'));
    const links = many.slice(1).map((v, i) => edge(many[Math.floor(i / 4)].key, v.key));
    const t0 = performance.now();
    const l = layout(many, links);
    expect(l.at.size).toBe(1000);
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it('draws an empty graph', () => {
    expect(layout([], []).at.size).toBe(0);
  });
});
