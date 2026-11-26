/**
 * Where each node of a graph picture goes: a force-directed layout (nodes push
 * each other apart, edges pull their ends together, everything drifts to the
 * middle), with no dependency and no randomness, so one graph is drawn the same
 * way every time.
 *
 * Around a centre node the start is radial (ring by hops from the centre) and
 * the centre stays fixed; for the whole graph each type starts on its own ring.
 * Repulsion is computed only between nodes in neighbouring cells of a grid, so a
 * picture of a thousand nodes lays out in well under a second.
 */

import type { PictureEdge, PictureNode } from '../api/types';

export interface Point {
  x: number;
  y: number;
}

export interface Laid {
  at: Map<string, Point>;
  /** Hops from the centre, when there is one. */
  hops: Map<string, number>;
  width: number;
  height: number;
}

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
};

/** Hops from `centre` over the edges, both directions. */
export function hopsFrom(centre: string, nodes: readonly PictureNode[], edges: readonly PictureEdge[]): Map<string, number> {
  const next = new Map<string, string[]>();
  for (const n of nodes) next.set(n.key, []);
  for (const e of edges) {
    next.get(e.from)?.push(e.to);
    next.get(e.to)?.push(e.from);
  }
  const hops = new Map<string, number>([[centre, 0]]);
  let ring = [centre];
  while (ring.length) {
    const out: string[] = [];
    for (const k of ring) {
      for (const m of next.get(k) ?? []) {
        if (!hops.has(m)) {
          hops.set(m, (hops.get(k) ?? 0) + 1);
          out.push(m);
        }
      }
    }
    ring = out;
  }
  return hops;
}

export function layout(
  nodes: readonly PictureNode[],
  edges: readonly PictureEdge[],
  opts: { centre?: string; iterations?: number; spacing?: number } = {}
): Laid {
  const n = nodes.length;
  const spacing = opts.spacing ?? (n > 400 ? 26 : n > 120 ? 34 : 48);
  const iterations = opts.iterations ?? (n > 600 ? 160 : 260);
  const index = new Map(nodes.map((v, i) => [v.key, i]));
  const hops = opts.centre ? hopsFrom(opts.centre, nodes, edges) : new Map<string, number>();
  const types = [...new Set(nodes.map((v) => v.type))].sort();
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const ring = Math.max(spacing * 3, Math.sqrt(n) * spacing * 0.35);
  nodes.forEach((v, i) => {
    const r = opts.centre ? (hops.get(v.key) ?? 3) * ring : (1 + types.indexOf(v.type)) * ring * 0.6;
    const a = hash(v.key) * Math.PI * 2;
    x[i] = v.key === opts.centre ? 0 : Math.cos(a) * r;
    y[i] = v.key === opts.centre ? 0 : Math.sin(a) * r;
  });
  const links = edges
    .map((e) => [index.get(e.from), index.get(e.to)] as const)
    .filter((p): p is readonly [number, number] => p[0] != null && p[1] != null && p[0] !== p[1]);
  const fixed = opts.centre != null ? index.get(opts.centre) : undefined;
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  const cell = spacing * 3;
  for (let it = 0; it < iterations; it += 1) {
    const cool = 1 - it / iterations;
    dx.fill(0);
    dy.fill(0);
    // repulsion, between nodes of neighbouring cells only
    const grid = new Map<string, number[]>();
    for (let i = 0; i < n; i += 1) {
      const c = `${Math.floor(x[i] / cell)},${Math.floor(y[i] / cell)}`;
      const g = grid.get(c);
      if (g) g.push(i);
      else grid.set(c, [i]);
    }
    for (let i = 0; i < n; i += 1) {
      const cx = Math.floor(x[i] / cell);
      const cy = Math.floor(y[i] / cell);
      for (let gx = cx - 1; gx <= cx + 1; gx += 1) {
        for (let gy = cy - 1; gy <= cy + 1; gy += 1) {
          for (const j of grid.get(`${gx},${gy}`) ?? []) {
            if (j <= i) continue;
            let ex = x[i] - x[j];
            let ey = y[i] - y[j];
            let d2 = ex * ex + ey * ey;
            if (d2 < 0.01) {
              ex = hash(`${i}|${j}`) - 0.5;
              ey = hash(`${j}|${i}`) - 0.5;
              d2 = 0.25;
            }
            const f = (spacing * spacing) / d2;
            dx[i] += ex * f;
            dy[i] += ey * f;
            dx[j] -= ex * f;
            dy[j] -= ey * f;
          }
        }
      }
    }
    // springs
    for (const [a, b] of links) {
      const ex = x[b] - x[a];
      const ey = y[b] - y[a];
      const d = Math.sqrt(ex * ex + ey * ey) || 1;
      const f = (d - spacing * 1.6) / d / 2;
      dx[a] += ex * f;
      dy[a] += ey * f;
      dx[b] -= ex * f;
      dy[b] -= ey * f;
    }
    // gravity, and the move, capped
    const cap = spacing * 2 * cool + 1;
    for (let i = 0; i < n; i += 1) {
      if (i === fixed) continue;
      dx[i] -= x[i] * 0.01;
      dy[i] -= y[i] * 0.01;
      const d = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]);
      const k = d > cap ? cap / d : 1;
      x[i] += dx[i] * k;
      y[i] += dy[i] * k;
    }
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i += 1) {
    minX = Math.min(minX, x[i]);
    minY = Math.min(minY, y[i]);
    maxX = Math.max(maxX, x[i]);
    maxY = Math.max(maxY, y[i]);
  }
  if (!n) [minX, minY, maxX, maxY] = [0, 0, 0, 0];
  const pad = spacing * 2;
  const at = new Map<string, Point>();
  nodes.forEach((v, i) => at.set(v.key, { x: x[i] - minX + pad, y: y[i] - minY + pad }));
  return { at, hops, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 };
}
