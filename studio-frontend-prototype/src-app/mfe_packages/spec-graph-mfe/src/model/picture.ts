/**
 * A graph picture as graphology lays it out for sigma.js (GraphCanvas):
 * - **Depth** (a node's surroundings): ForceAtlas2 from a deterministic start,
 *   the centre fixed in the middle;
 * - **Whole graph**: Louvain communities, each packed in its own circle
 *   (circlepack). ForceAtlas2 alone drew insight's graph as one disc: a few hub
 *   documents link nearly everything, so the communities never separated; packed
 *   by community, the islands match the repository's components.
 *
 * Everything here is pure graphology, no WebGL, so it runs under tests. Node
 * size follows the number of links; colour follows the type or the community.
 */

import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import { circlepack } from 'graphology-layout';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import type { Picture } from '../api/types';
import { colourOf } from './look';

export interface NodeAttrs {
  label: string;
  /** The node type. Not `type`: sigma reads `type` as the program that draws it. */
  kind: string;
  path: string;
  line?: number;
  x: number;
  y: number;
  size: number;
  color: string;
  cluster?: number;
}

export interface EdgeAttrs {
  kind: 'static' | 'analysis';
  /** The edge type (`links_to`, …). Not `type`: sigma reads `type` as the program that draws it. */
  relation: string;
  /** Shown on the edge where edge labels are drawn (the ontology). */
  label: string;
  color: string;
  size: number;
}

export type PictureGraph = Graph<NodeAttrs, EdgeAttrs>;

export interface Cluster {
  id: number;
  /** Its best-linked document (or node): the one labelled when the whole graph is shown. */
  lead: string;
  /** The commonest document directory among its nodes, and its best-linked document. */
  name: string;
  size: number;
  colour: string;
}

/** Twelve hues told apart without red/green or amber/orange pairs, then greys. */
export const CLUSTER_COLOURS = [
  '#2563eb',
  '#d97706',
  '#db2777',
  '#7c3aed',
  '#0891b2',
  '#a16207',
  '#be185d',
  '#4f46e5',
  '#0e7490',
  '#9333ea',
  '#1e40af',
  '#b45309',
];
const SMALL = '#94a3b8';

const sizeFor = (degree: number) => Math.min(16, 3 + Math.sqrt(degree) * 1.5);

/** The picture as an undirected graph, one edge per pair (a judge's edge wins over a stated one). */
export function toGraph(p: Picture): PictureGraph {
  const g = new Graph<NodeAttrs, EdgeAttrs>({ type: 'undirected', multi: false, allowSelfLoops: false });
  for (const n of p.nodes) {
    if (g.hasNode(n.key)) continue;
    g.addNode(n.key, {
      label: n.name ?? n.key,
      kind: n.type,
      path: n.path ?? '',
      line: n.line,
      x: 0,
      y: 0,
      size: 4,
      color: colourOf(n.type),
    });
  }
  for (const e of p.edges) {
    if (e.from === e.to || !g.hasNode(e.from) || !g.hasNode(e.to)) continue;
    const analysis = e.kind === 'analysis';
    const attrs: EdgeAttrs = {
      kind: e.kind,
      relation: e.type,
      label: e.type,
      color: analysis ? '#7c3aed' : '#cbd5e1',
      size: analysis ? 1.2 : 0.6,
    };
    const at = g.edge(e.from, e.to);
    if (at === undefined) {
      g.addEdge(e.from, e.to, attrs);
      continue;
    }
    // one edge per pair: its relations listed, a judge's edge drawn as one
    const had = g.getEdgeAttributes(at);
    const relation = had.relation.split(', ').includes(e.type) ? had.relation : `${had.relation}, ${e.type}`;
    g.replaceEdgeAttributes(
      at,
      analysis || had.kind === 'analysis'
        ? { ...attrs, kind: 'analysis', color: '#7c3aed', size: 1.2, relation, label: relation }
        : { ...had, relation, label: relation },
    );
  }
  const weights = new Map(p.nodes.filter((n) => n.weight != null).map((n) => [n.key, n.weight as number]));
  g.forEachNode((k) =>
    g.setNodeAttribute(
      k,
      'size',
      weights.has(k) ? Math.min(24, 4 + Math.sqrt(weights.get(k) ?? 0) * 0.45) : sizeFor(g.degree(k)),
    ),
  );
  return g;
}

/** The directory a path names its component by: `docs/components/backend/authenticator/…` -> `components/backend/authenticator`. */
export function areaOf(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 2) return '';
  const dirs = parts.slice(0, -1);
  const start = dirs[0] === 'docs' || dirs[0] === 'src' ? 1 : 0;
  return dirs.slice(start, start + 3).join('/');
}

/**
 * Louvain communities, deterministic (a seeded random), each named by its commonest
 * directory and best-linked document. Communities of fewer than `minSize` nodes share
 * one grey.
 */
export function clusters(g: PictureGraph, resolution = 0.6, minSize = 4): Cluster[] {
  if (g.order === 0) return [];
  let seed = 1;
  const rng = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const of = louvain(g, { resolution, rng });
  const members = new Map<number, string[]>();
  for (const [k, c] of Object.entries(of)) members.set(c, [...(members.get(c) ?? []), k]);
  const ordered = [...members.entries()].sort((a, b) => b[1].length - a[1].length);
  const out: Cluster[] = [];
  ordered.forEach(([c, keys], i) => {
    const areas = new Map<string, number>();
    let lead = keys[0];
    for (const k of keys) {
      const a = areaOf(g.getNodeAttribute(k, 'path'));
      if (a) areas.set(a, (areas.get(a) ?? 0) + 1);
      if (
        g.getNodeAttribute(k, 'kind') === 'document' &&
        (g.getNodeAttribute(lead, 'kind') !== 'document' || g.degree(k) > g.degree(lead))
      )
        lead = k;
    }
    const area = [...areas.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const leadLabel = g.getNodeAttribute(lead, 'label');
    const colour = keys.length >= minSize ? CLUSTER_COLOURS[i % CLUSTER_COLOURS.length] : SMALL;
    for (const k of keys) g.setNodeAttribute(k, 'cluster', i);
    out.push({ id: i, lead, name: area ? `${area} · ${leadLabel}` : leadLabel, size: keys.length, colour });
    void c;
  });
  return out;
}

/** Whole graph: each community packed in its own circle. */
export function layoutIslands(g: PictureGraph): void {
  circlepack.assign(g, { hierarchyAttributes: ['cluster'], scale: 1 });
}

/** Depth: ForceAtlas2 from a deterministic spiral, the centre fixed in the middle. */
export function layoutAround(g: PictureGraph, centre?: string, iterations = 400): void {
  let i = 0;
  g.forEachNode((k, a) => {
    i += 1;
    const t = i * 2.399963;
    const r = Math.sqrt(i) * 10;
    g.mergeNodeAttributes(k, k === centre ? { x: 0, y: 0 } : { x: Math.cos(t) * r, y: Math.sin(t) * r });
    void a;
  });
  if (centre && g.hasNode(centre)) {
    g.setNodeAttribute(centre, 'size', g.getNodeAttribute(centre, 'size') * 1.6);
    g.mergeNodeAttributes(centre, { fixed: true } as Partial<NodeAttrs>);
  }
  if (g.order < 2) return;
  const inferred = forceAtlas2.inferSettings(g);
  forceAtlas2.assign(g, {
    iterations,
    settings: {
      ...inferred,
      linLogMode: true,
      outboundAttractionDistribution: true,
      gravity: 1,
      scalingRatio: 4,
      barnesHutOptimize: g.order > 300,
    },
  });
}

/** Colour every node by its type, or by its community (`clusters` first). */
export function colourBy(g: PictureGraph, by: 'type' | 'cluster', found: Cluster[]): void {
  g.forEachNode((k, a) =>
    g.setNodeAttribute(
      k,
      'color',
      by === 'cluster' && a.cluster != null ? (found[a.cluster]?.colour ?? SMALL) : colourOf(a.kind),
    ),
  );
}

/** The nodes whose labels always show: the centre, and the best-linked few. */
export function leaders(g: PictureGraph, count: number, centre?: string): Set<string> {
  const ranked = g.nodes().sort((a, b) => g.degree(b) - g.degree(a));
  return new Set([...(centre ? [centre] : []), ...ranked.slice(0, count)]);
}

/** The ontology as a picture: each node type a node (sized by this project's count), each edge type an edge. */
export function ontologyPicture(o: {
  nodes: Record<string, string>;
  edges: Record<string, { from: string[]; to: string[]; kind: string }>;
  counts?: Record<string, number>;
}): Picture {
  const counts = o.counts ?? {};
  const types = [...new Set([...Object.keys(o.nodes), ...Object.keys(counts)])];
  return {
    nodes: types.map((type) => ({
      key: type,
      type,
      name: `${type} (${counts[type] ?? 0})`,
      weight: counts[type] ?? 0,
    })),
    edges: Object.entries(o.edges).flatMap(([name, e]) =>
      e.from.flatMap((from) =>
        e.to.map((to) => ({
          from,
          to,
          type: name,
          kind: (e.kind.startsWith('analysis') ? 'analysis' : 'static') as 'analysis' | 'static',
        })),
      ),
    ),
  };
}
