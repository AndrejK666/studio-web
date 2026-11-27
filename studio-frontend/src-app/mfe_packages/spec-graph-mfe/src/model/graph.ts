/** Pure helpers of Spec graph › Graph: labels from node keys, the map's layout, a finding's node. */

import type { Finding, JudgedEdge } from '../api/types';

/** A short label from a node's key (`doc:`, `sec:`, a CPT id, `finding:`, `fact:`, `concept:`). */
export function label(key: string): string {
  if (key.startsWith('doc:')) return key.slice(4).split('/').pop() ?? key;
  if (key.startsWith('sec:')) {
    const [path, anchor] = key.slice(4).split('#');
    return anchor ? `§ ${anchor}` : (path.split('/').pop() ?? key);
  }
  if (key.startsWith('finding:')) return `finding ${key.split(':')[1] ?? ''}`.trim();
  if (key.startsWith('concept:')) return key.split(':').slice(2).join(':') || key;
  if (key.startsWith('fact:')) return `fact ${key.split(':')[1]?.split('/').pop() ?? ''}`.trim();
  const cpt = /^cpt-cf-[a-z0-9]+(?:-[a-z0-9]+)*?-(fr|nfr|usecase|component|adr|algo|flow|feature|dod|principle|constraint|seq|actor|interface|contract|upreq|req|entity|state)-(.+)$/.exec(key);
  if (cpt) return `${cpt[1]} ${cpt[2]}`;
  return key.length > 48 ? `${key.slice(0, 45)}…` : key;
}

/** What kind of node a key is, for the map's legend and colour. */
export function kindOf(key: string): 'document' | 'section' | 'finding' | 'concept' | 'fact' | 'item' | 'path' {
  if (key.startsWith('doc:')) return 'document';
  if (key.startsWith('sec:')) return 'section';
  if (key.startsWith('finding:')) return 'finding';
  if (key.startsWith('concept:')) return 'concept';
  if (key.startsWith('fact:')) return 'fact';
  if (key.startsWith('cpt-')) return 'item';
  return 'path';
}

export interface Side {
  key: string;
  edge: string;
  /** A judge's conclusion rather than an edge the documents state. */
  judged: boolean;
}

/**
 * One side of the map: every neighbour once, judged edges first, then by edge type and key,
 * at most `max` shown and how many more there are.
 */
export function side(
  edges: Record<string, string[]>,
  judged: JudgedEdge[],
  direction: 'in' | 'out',
  max = 12
): { shown: Side[]; more: number } {
  const seen = new Set<string>();
  const all: Side[] = [];
  for (const j of judged) {
    const other = direction === 'in' ? j.from : j.to;
    if (other && !seen.has(`${j.edge}|${other}`)) {
      seen.add(`${j.edge}|${other}`);
      all.push({ key: other, edge: j.edge, judged: true });
    }
  }
  for (const edge of Object.keys(edges).sort()) {
    for (const key of [...edges[edge]].sort()) {
      if (!seen.has(`${edge}|${key}`)) {
        seen.add(`${edge}|${key}`);
        all.push({ key, edge, judged: false });
      }
    }
  }
  return { shown: all.slice(0, max), more: Math.max(0, all.length - max) };
}

/** The graph node a finding sits on: its section when the graph cites one, else its document. */
export function findingNode(path: string | null, f: Finding): string | null {
  if (!path) return null;
  return f.anchor.section ? `sec:${path}#${f.anchor.section}` : `doc:${path}`;
}
