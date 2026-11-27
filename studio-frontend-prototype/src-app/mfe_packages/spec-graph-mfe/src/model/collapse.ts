/**
 * A graph picture with each section folded into its document: a document's
 * sections are most of the nodes (2,186 of insight's 2,921), and what they link
 * to is what their document links to. The edges keep their type; an edge
 * between two sections of one document disappears, and edges that become the
 * same are drawn once.
 */

import type { Picture, PictureEdge, PictureNode } from '../api/types';
import { documentOf } from './graph';

export function foldKey(key: string): string {
  return key.startsWith('sec:') ? `doc:${documentOf(key) ?? key.slice(4)}` : key;
}

export function foldSections(p: Picture): Picture {
  const nodes = new Map<string, PictureNode>();
  for (const n of p.nodes) {
    const key = foldKey(n.key);
    if (key === n.key) nodes.set(key, n);
    else if (!nodes.has(key)) nodes.set(key, { key, type: 'document', name: key.slice(4).split('/').pop(), path: key.slice(4) });
  }
  for (const n of p.nodes) if (n.key === foldKey(n.key)) nodes.set(n.key, n);   // a document's own node wins
  const seen = new Set<string>();
  const edges: PictureEdge[] = [];
  for (const e of p.edges) {
    const from = foldKey(e.from);
    const to = foldKey(e.to);
    const id = `${from}|${e.type}|${to}`;
    if (from === to || seen.has(id)) continue;
    seen.add(id);
    edges.push({ ...e, from, to });
  }
  const counts = p.counts ? { ...p.counts } : undefined;
  return { ...p, key: p.key ? foldKey(p.key) : p.key, nodes: [...nodes.values()], edges, counts };
}
