/**
 * How the product map is laid out and which of its links are drawn, as pure
 * functions the canvas feeds with what it measured (#1100 follow-up: "the
 * diagram looks bad, everything crosses everything").
 *
 * - Order: the screens, the subsystems and the gears within each are ordered
 *   so links run as straight down as they can (a barycentre heuristic over the
 *   screen → gear graph, a few sweeps), infrastructure under what runs on it.
 * - What is drawn: at rest, one line per screen → subsystem (and subsystem →
 *   infrastructure group) with how many links it carries; for the node
 *   pointed at or selected, each of its own links to the node at the far end.
 * - Where a line goes: never over a box. It leaves a box sideways into the
 *   free channel beside it (the shell's margin, the gap left of a subsystem's
 *   column), runs along the gutter between the lanes and comes in the same
 *   way at the other end.
 */

import { MISSING_GROUP, type LinkKind, type MapLink, type MapNode } from './product-map';

export interface LaneGroup {
  group: string;
  nodes: MapNode[];
}

/* ── Order ─────────────────────────────────────────────────────────────── */

const mean = (xs: readonly number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * `items` sorted by `score`, stable; an item without a score keeps its place
 * relative to the others without one and goes after the scored ones.
 */
export function byScore<T>(items: readonly T[], score: (item: T) => number | null): T[] {
  const scored = items.map((item, i) => ({ item, i, s: score(item) }));
  return scored
    .sort((a, b) => {
      if (a.s === null && b.s === null) return a.i - b.i;
      if (a.s === null) return 1;
      if (b.s === null) return -1;
      return a.s - b.s || a.i - b.i;
    })
    .map((x) => x.item);
}

/** How many pairs of straight lines between two ordered rows cross: `edges` are `[top, bottom]` positions. */
export function bipartiteCrossings(edges: readonly (readonly [number, number])[]): number {
  let n = 0;
  for (let i = 0; i < edges.length; i += 1)
    for (let j = i + 1; j < edges.length; j += 1) {
      const [a1, b1] = edges[i];
      const [a2, b2] = edges[j];
      if ((a1 - a2) * (b1 - b2) < 0) n += 1;
    }
  return n;
}

export interface MapOrder {
  /** The frontend lane's node ids, in drawing order. */
  frontend: string[];
  backend: LaneGroup[];
  infrastructure: LaneGroup[];
}

/** A backend node's place along the lane: its column first, then its row in it. */
const COLUMN = 1000;

function positions(groups: readonly LaneGroup[]): Map<string, number> {
  const at = new Map<string, number>();
  groups.forEach((g, gi) => g.nodes.forEach((n, ni) => at.set(n.id, gi * COLUMN + ni)));
  return at;
}

/** The groups of a lane ordered by `place` of their nodes, and the nodes in each; the group of what is missing stays first. */
function orderGroups(groups: readonly LaneGroup[], place: (id: string) => number | null): LaneGroup[] {
  const nodes = groups.map((g) => ({ ...g, nodes: byScore(g.nodes, (n) => place(n.id)) }));
  const pinned = nodes.filter((g) => g.group === MISSING_GROUP);
  const rest = byScore(
    nodes.filter((g) => g.group !== MISSING_GROUP),
    (g) => mean(g.nodes.map((n) => place(n.id)).filter((x): x is number => x !== null))
  );
  return [...pinned, ...rest];
}

/**
 * The map's order with fewer crossings: the backend under the screens that
 * call it, the screens over what they call, a few sweeps each way, then the
 * infrastructure under the gears that run on it. Nodes nothing links keep
 * their given order after the linked ones.
 */
export function orderMap(
  input: { frontend: readonly string[]; backend: readonly LaneGroup[]; infrastructure: readonly LaneGroup[] },
  links: readonly MapLink[],
  sweeps = 4
): MapOrder {
  const front = new Set(input.frontend);
  const backIds = new Set(input.backend.flatMap((g) => g.nodes.map((n) => n.id)));
  const down = new Map<string, string[]>();
  const up = new Map<string, string[]>();
  for (const l of links) {
    const [f, b] = front.has(l.from) && backIds.has(l.to) ? [l.from, l.to] : front.has(l.to) && backIds.has(l.from) ? [l.to, l.from] : [];
    if (!f || !b) continue;
    down.set(f, [...(down.get(f) ?? []), b]);
    up.set(b, [...(up.get(b) ?? []), f]);
  }
  let frontend = [...input.frontend];
  let backend = input.backend.map((g) => ({ ...g, nodes: [...g.nodes] }));
  for (let s = 0; s < sweeps; s += 1) {
    const fAt = new Map(frontend.map((id, i) => [id, i]));
    backend = orderGroups(backend, (id) => mean((up.get(id) ?? []).map((f) => fAt.get(f)!)));
    const bAt = positions(backend);
    frontend = byScore(frontend, (id) => mean((down.get(id) ?? []).map((b) => bAt.get(b)!)));
  }
  const bAt = positions(backend);
  const infraIds = new Set(input.infrastructure.flatMap((g) => g.nodes.map((n) => n.id)));
  const over = new Map<string, number[]>();
  for (const l of links) {
    const [b, i] = bAt.has(l.from) && infraIds.has(l.to) ? [l.from, l.to] : bAt.has(l.to) && infraIds.has(l.from) ? [l.to, l.from] : [];
    if (!b || !i) continue;
    over.set(i, [...(over.get(i) ?? []), bAt.get(b)!]);
  }
  const infrastructure = orderGroups(input.infrastructure, (id) => mean(over.get(id) ?? []));
  return { frontend, backend, infrastructure };
}

/**
 * The straight-line crossings between the screens and the backend for an
 * order: what the order is chosen to lower, as a number a test (and the
 * report of a change) can hold.
 */
export function orderCrossings(order: MapOrder, links: readonly MapLink[]): number {
  const fAt = new Map(order.frontend.map((id, i) => [id, i]));
  const bAt = positions(order.backend);
  const edges: [number, number][] = [];
  for (const l of links) {
    if (fAt.has(l.from) && bAt.has(l.to)) edges.push([fAt.get(l.from)!, bAt.get(l.to)!]);
    else if (fAt.has(l.to) && bAt.has(l.from)) edges.push([fAt.get(l.to)!, bAt.get(l.from)!]);
  }
  return bipartiteCrossings(edges);
}

/* ── What is drawn ─────────────────────────────────────────────────────── */

/** One drawn line: every link between the same two drawn ends. */
export interface Bundle {
  key: string;
  /** The drawn ends: a node's id, or `group:<layer>:<group>` for a subsystem. */
  from: string;
  to: string;
  links: MapLink[];
  /** The kind it is drawn as: its links' when they agree, else `calls`. */
  kind: LinkKind;
  /** A line standing for a whole subsystem at rest, rather than one node's links. */
  aggregate: boolean;
}

/** The kinds drawn at rest; the others only for what is pointed at. */
const AT_REST: ReadonlySet<LinkKind> = new Set(['calls', 'signs-in', 'runs-on']);

/**
 * Which lines to draw. `lit` is the node pointed at or selected, `picked` a
 * link chosen on its own. `endOf` answers what is drawn for a node (a folded
 * group's header, or nothing when it is hidden); `groupOf` the subsystem a
 * node is drawn in (`group:<layer>:<group>`), or the node itself where a lane
 * has no subsystems.
 */
export function bundlesOf(
  links: readonly MapLink[],
  view: { lit: string | null; picked: MapLink | null },
  endOf: (id: string) => string | null,
  groupOf: (id: string) => string | null
): Bundle[] {
  const out = new Map<string, Bundle>();
  const add = (l: MapLink, from: string | null, to: string | null, aggregate: boolean) => {
    if (!from || !to || from === to) return;
    const key = `${from}>${to}`;
    const had = out.get(key);
    if (had) {
      had.links.push(l);
      if (had.kind !== l.kind) had.kind = 'calls';
    } else out.set(key, { key, from, to, links: [l], kind: l.kind, aggregate });
  };
  if (view.picked) {
    add(view.picked, endOf(view.picked.from), endOf(view.picked.to), false);
  } else if (view.lit) {
    for (const l of links) if (l.from === view.lit || l.to === view.lit) add(l, endOf(l.from), endOf(l.to), false);
  } else {
    for (const l of links) {
      if (!AT_REST.has(l.kind)) continue;
      // A screen keeps its own end; the backend and below are drawn by subsystem.
      const from = l.kind === 'runs-on' ? groupOf(l.from) : endOf(l.from);
      add(l, from && endOf(l.from) ? from : null, endOf(l.to) ? groupOf(l.to) : null, true);
    }
  }
  return [...out.values()];
}

/* ── Where a line goes ─────────────────────────────────────────────────── */

export type Point = readonly [number, number];

/**
 * One drawn end, measured: its lane (by rank, top first) and the way out of
 * its box into free space — `stub` runs from the box's edge to a point in the
 * vertical channel at x `channel` beside it, where nothing is drawn.
 */
export interface Port {
  lane: number;
  stub: Point[];
  channel: number;
}

/** A box's way out sideways: from the middle of its left edge to the channel left of it. */
export function leftPort(lane: number, box: { x: number; y: number; h: number }, channel: number): Port {
  const y = box.y + box.h / 2;
  return { lane, stub: [[box.x, y], [channel, y]], channel };
}

/**
 * A box's way out below, for a box in a grid of them: down into the gap
 * under its row (`gap` below the box), then along it to the channel.
 */
export function bottomPort(lane: number, box: { x: number; y: number; w: number; h: number }, gap: number, channel: number): Port {
  const x = box.x + box.w / 2;
  const y = box.y + box.h + gap;
  return { lane, stub: [[x, box.y + box.h], [x, y], [channel, y]], channel };
}

/** How far apart lines of different kinds run in a shared channel or gutter, so each kind reads as its own. */
const KIND_OFFSET: Record<LinkKind, number> = { calls: 0, 'signs-in': -3, 'runs-on': 0, depends: 3, 'stores-in': 3 };

/**
 * The line between two ports: out of the upper end, down its channel to the
 * gutter (`gutterAbove(lane)` is the y of the free band above that lane;
 * `gutterBelow(lane)` the band at the bottom of one, for two ends in the same
 * lane), along the gutter, up or down the other channel and in. Orthogonal,
 * so lines meet only where they share a channel or cross a gutter.
 */
export function route(
  a: Port,
  b: Port,
  kind: LinkKind,
  gutterAbove: (lane: number) => number,
  gutterBelow: (lane: number) => number
): Point[] {
  const [top, bottom] = a.lane <= b.lane ? [a, b] : [b, a];
  const off = KIND_OFFSET[kind];
  const y = top.lane === bottom.lane ? gutterBelow(top.lane) + off : gutterAbove(bottom.lane) + off;
  const ta = top.stub[top.stub.length - 1];
  const tb = bottom.stub[bottom.stub.length - 1];
  const pts: Point[] = [...top.stub, [ta[0] + off, ta[1]], [ta[0] + off, y], [tb[0] + off, y], [tb[0] + off, tb[1]], ...[...bottom.stub].reverse()];
  const ordered = a.lane <= b.lane ? pts : [...pts].reverse();
  return simplify(ordered);
}

/** The points without repeats and without middle points of straight runs. */
export function simplify(pts: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 0.01 && Math.abs(last[1] - p[1]) < 0.01) continue;
    const prev = out[out.length - 2];
    if (prev && last) {
      const straight =
        (Math.abs(prev[0] - last[0]) < 0.01 && Math.abs(last[0] - p[0]) < 0.01) ||
        (Math.abs(prev[1] - last[1]) < 0.01 && Math.abs(last[1] - p[1]) < 0.01);
      if (straight) out.pop();
    }
    out.push(p);
  }
  return out;
}

/** An SVG path through the points, its corners slightly rounded. */
export function pathOf(pts: readonly Point[], radius = 4): string {
  if (pts.length === 0) return '';
  const r1 = (n: number) => Math.round(n * 10) / 10;
  let d = `M${r1(pts[0][0])},${r1(pts[0][1])}`;
  for (let i = 1; i < pts.length; i += 1) {
    const p = pts[i];
    const next = pts[i + 1];
    if (!next) {
      d += ` L${r1(p[0])},${r1(p[1])}`;
      break;
    }
    const prev = pts[i - 1];
    const lin = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    const lout = Math.hypot(next[0] - p[0], next[1] - p[1]);
    const r = Math.min(radius, lin / 2, lout / 2);
    const bx = p[0] - ((p[0] - prev[0]) / (lin || 1)) * r;
    const by = p[1] - ((p[1] - prev[1]) / (lin || 1)) * r;
    const ax = p[0] + ((next[0] - p[0]) / (lout || 1)) * r;
    const ay = p[1] + ((next[1] - p[1]) / (lout || 1)) * r;
    d += ` L${r1(bx)},${r1(by)} Q${r1(p[0])},${r1(p[1])} ${r1(ax)},${r1(ay)}`;
  }
  return d;
}

/** Where a line's count is written: on its last run into the far end, just before it arrives. */
export function labelAt(pts: readonly Point[]): Point {
  if (pts.length < 2) return pts[0] ?? [0, 0];
  // The vertical run into the end's channel: the last one that is vertical.
  for (let i = pts.length - 1; i > 0; i -= 1) {
    const [x1, y1] = pts[i - 1];
    const [x2, y2] = pts[i];
    if (Math.abs(x1 - x2) < 0.01 && Math.abs(y1 - y2) > 12) return [x2, y2 + (y1 < y2 ? -8 : 8)];
  }
  const [x, y] = pts[pts.length - 1];
  return [x, y];
}

/**
 * How many times the drawn lines cross one another: proper crossings of
 * their segments, not a shared stretch of channel, not a touch at a corner
 * and not at an end. What the map is measured by.
 */
export function crossingsOf(lines: readonly (readonly Point[])[]): number {
  const eps = 1e-6;
  let n = 0;
  for (let i = 0; i < lines.length; i += 1)
    for (let j = i + 1; j < lines.length; j += 1) {
      const A = lines[i];
      const B = lines[j];
      for (let x = 0; x < A.length - 1; x += 1)
        for (let y = 0; y < B.length - 1; y += 1) {
          const [a, b, c, d] = [A[x], A[x + 1], B[y], B[y + 1]];
          const den = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
          if (Math.abs(den) < eps) continue;
          const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / den;
          const u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / den;
          if (t > eps && t < 1 - eps && u > eps && u < 1 - eps) n += 1;
        }
    }
  return n;
}
