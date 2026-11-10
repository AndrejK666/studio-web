// Ported unchanged from the prototype: the "Model map" section of src/domain-model-views.ts at 00828880,
// which domain-layers.ts (and through it doc-quality.ts) builds on. The file's "To resolve" section (the
// queue and readiness) is the server's now (GET /project-domain-model/issues and /project-domain-model/readiness), and its
// "Requirements" section belongs to the Domain model screen; neither is carried here.

import { relatedEntities, type Entity } from "./spec-model";

// ── Model map ───────────────────────────────────────────────────────────────

/** Where an entity is described most: the folder of most of its facts, two
 *  levels deep where there are three (`docs/adr`, `.github/agents`). */
export function entityArea(e: Pick<Entity, "facts">): string {
  const count = new Map<string, number>();
  for (const f of e.facts) {
    const parts = f.source.path.split("/");
    const area = parts.length > 2 ? parts.slice(0, 2).join("/") : parts.length > 1 ? parts[0] : "(root)";
    count.set(area, (count.get(area) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "(root)";
}

export interface MapEdge {
  from: string;
  to: string;
  /** A relation a document declares, or one entity's facts naming another. */
  kind: "relation" | "mentions";
  /** How many times. */
  n: number;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The map's lines: every declared relation, then every time one entity's
 *  facts name another (a name of four letters or more, as a whole word). One
 *  line per pair; a relation wins over a mention. */
export function mapEdges(entities: Entity[]): MapEdge[] {
  const edges = new Map<string, MapEdge>();
  const pair = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const add = (from: string, to: string, kind: MapEdge["kind"]) => {
    if (from === to) return;
    const id = pair(from, to);
    const had = edges.get(id);
    if (!had) edges.set(id, { from, to, kind, n: 1 });
    else {
      had.n++;
      if (kind === "relation") had.kind = "relation";
    }
  };
  for (const e of entities) for (const to of relatedEntities(e, entities)) add(e.key, to, "relation");
  const named = entities
    .filter((o) => o.name.length >= 4)
    .map((o) => ({ key: o.key, re: new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(o.name.toLowerCase())}s?(?=[^\\p{L}\\p{N}]|$)`, "u") }));
  for (const e of entities) {
    const text = e.facts.map((f) => `${f.text}\n${f.value}`).join("\n").toLowerCase();
    for (const o of named) if (o.key !== e.key && o.re.test(text)) add(e.key, o.key, "mentions");
  }
  return [...edges.values()];
}

/** The keys an entity connects to on the map. */
export function neighbours(key: string, edges: MapEdge[]): Set<string> {
  const out = new Set<string>();
  for (const e of edges) {
    if (e.from === key) out.add(e.to);
    if (e.to === key) out.add(e.from);
  }
  return out;
}

export interface Placed {
  key: string;
  x: number;
  y: number;
}

/** A force layout (Fruchterman–Reingold) of the nodes inside `width` ×
 *  `height`: connected ones pulled together, all pushed apart, the start
 *  seeded so the same model is drawn the same way every time. */
export function layout(keys: string[], edges: MapEdge[], width: number, height: number, rounds = 220, pull = 0.25): Placed[] {
  const n = keys.length;
  if (n === 0) return [];
  const index = new Map(keys.map((k, i) => [k, i]));
  // A deterministic start: a sunflower spiral.
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt((i + 0.5) / n) * Math.min(width, height) * 0.45;
    x[i] = width / 2 + r * Math.cos(i * golden);
    y[i] = height / 2 + r * Math.sin(i * golden);
  }
  const links: [number, number, number][] = [];
  for (const e of edges) {
    const a = index.get(e.from);
    const b = index.get(e.to);
    if (a !== undefined && b !== undefined) links.push([a, b, e.kind === "relation" ? 2 : 1]);
  }
  const k = Math.sqrt((width * height) / n) * 0.6;
  let temp = Math.min(width, height) / 8;
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  for (let round = 0; round < rounds; round++) {
    dx.fill(0);
    dy.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ddx = x[i] - x[j];
        let ddy = y[i] - y[j];
        let d2 = ddx * ddx + ddy * ddy;
        if (d2 < 0.01) {
          ddx = 0.1 * ((i % 7) - 3);
          ddy = 0.1 * ((j % 5) - 2);
          d2 = ddx * ddx + ddy * ddy + 0.01;
        }
        const f = (k * k) / d2;
        dx[i] += ddx * f;
        dy[i] += ddy * f;
        dx[j] -= ddx * f;
        dy[j] -= ddy * f;
      }
    }
    for (const [a, b, w] of links) {
      const ddx = x[a] - x[b];
      const ddy = y[a] - y[b];
      const d = Math.sqrt(ddx * ddx + ddy * ddy) || 0.01;
      // d²/k along the line: a link pulls as hard as two nodes push at k.
      const f = (d * w) / k;
      dx[a] -= ddx * f;
      dy[a] -= ddy * f;
      dx[b] += ddx * f;
      dy[b] += ddy * f;
    }
    for (let i = 0; i < n; i++) {
      // A pull to the middle, growing with the distance, keeps the loose
      // nodes (no link to hold them) on the page instead of on its edge.
      const gx = width / 2 - x[i];
      const gy = height / 2 - y[i];
      const g = (Math.sqrt(gx * gx + gy * gy) / k) * pull;
      dx[i] += gx * g;
      dy[i] += gy * g;
      const d = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 1;
      const step = Math.min(d, temp);
      x[i] = Math.min(width - 12, Math.max(12, x[i] + (dx[i] / d) * step));
      y[i] = Math.min(height - 12, Math.max(12, y[i] + (dy[i] / d) * step));
    }
    temp *= 0.985;
  }
  return keys.map((key, i) => ({ key, x: x[i], y: y[i] }));
}
