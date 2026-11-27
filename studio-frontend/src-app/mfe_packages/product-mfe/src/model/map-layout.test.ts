import { describe, expect, it } from 'vitest';
import {
  bipartiteCrossings,
  bottomPort,
  bundlesOf,
  byScore,
  crossingsOf,
  labelAt,
  leftPort,
  orderCrossings,
  orderMap,
  pathOf,
  route,
  simplify,
  type LaneGroup,
  type Point,
} from './map-layout';
import { MISSING_GROUP, type MapLink, type MapNode } from './product-map';

const node = (id: string, layer: MapNode['layer'], group: string): MapNode => ({
  id,
  layer,
  label: id,
  state: 'ok',
  group,
  detail: { kind: layer === 'frontend' ? 'mfe' : layer === 'backend' ? 'gear' : 'technology', what: '', facts: [], problem: null, section: layer },
});
const calls = (from: string, to: string): MapLink => ({ from, to, kind: 'calls', state: 'ok', why: `${from} calls ${to}` });
const runsOn = (from: string, to: string): MapLink => ({ from, to, kind: 'runs-on', state: 'ok', why: '' });
const lane = (layer: MapNode['layer'], groups: Record<string, string[]>): LaneGroup[] =>
  Object.entries(groups).map(([group, ids]) => ({ group, nodes: ids.map((id) => node(id, layer, group)) }));

describe('byScore', () => {
  it('sorts by score, stable, with unscored items after in their order', () => {
    expect(byScore(['a', 'b', 'c', 'd'], (x) => ({ a: null, b: 2, c: 1, d: null })[x] ?? null)).toEqual(['c', 'b', 'a', 'd']);
  });
});

describe('bipartiteCrossings', () => {
  it('counts the pairs of straight lines that cross', () => {
    expect(bipartiteCrossings([[0, 0], [1, 1]])).toBe(0);
    expect(bipartiteCrossings([[0, 1], [1, 0]])).toBe(1);
    // A shared end is not a crossing.
    expect(bipartiteCrossings([[0, 0], [0, 1], [1, 1]])).toBe(0);
  });
});

describe('orderMap', () => {
  // Two screens each calling their own subsystem, drawn crossed.
  const backend = lane('backend', { Core: ['core-a', 'core-b'], AI: ['chat'] });
  const links = [calls('ui-chat', 'chat'), calls('ui-core', 'core-b'), calls('ui-core', 'core-a')];
  const input = { frontend: ['ui-core', 'ui-chat'], backend, infrastructure: [] };

  it('uncrosses screens and subsystems', () => {
    const crossed = { frontend: ['ui-chat', 'ui-core'], backend, infrastructure: [] };
    expect(orderCrossings(crossed, links)).toBeGreaterThan(0);
    const order = orderMap(crossed, links);
    expect(orderCrossings(order, links)).toBe(0);
  });

  it('keeps an order that crosses nothing', () => {
    const order = orderMap(input, links);
    expect(order.frontend).toEqual(['ui-core', 'ui-chat']);
    expect(order.backend.map((g) => g.group)).toEqual(['Core', 'AI']);
  });

  it('keeps the group of what is missing first', () => {
    const withMissing = { ...input, backend: [...backend, ...lane('backend', { [MISSING_GROUP]: ['gone'] })] };
    const order = orderMap(withMissing, [...links, calls('ui-chat', 'gone')]);
    expect(order.backend[0].group).toBe(MISSING_GROUP);
  });

  it('puts what the screens call at the top of a column, and what nothing links after it', () => {
    const order = orderMap({ ...input, backend: lane('backend', { Core: ['idle', 'core-b', 'core-a'] }) }, links);
    expect(order.backend[0].nodes.map((n) => n.id)).toEqual(['core-b', 'core-a', 'idle']);
  });

  it('puts infrastructure under the gears that run on it', () => {
    const order = orderMap(
      { ...input, infrastructure: lane('infrastructure', { Runs: ['pg', 'kc'] }) },
      [...links, runsOn('chat', 'kc'), runsOn('core-a', 'pg'), runsOn('chat', 'pg')]
    );
    // pg: under core-a and chat; kc: under chat only, the rightmost.
    expect(order.infrastructure[0].nodes.map((n) => n.id)).toEqual(['pg', 'kc']);
  });

  it('lowers the crossings of a tangle', () => {
    const fr = ['s0', 's1', 's2', 's3', 's4'];
    const be = lane('backend', { A: ['a0', 'a1'], B: ['b0', 'b1'], C: ['c0', 'c1'] });
    const ls = [
      calls('s0', 'c1'),
      calls('s0', 'c0'),
      calls('s1', 'a0'),
      calls('s2', 'b1'),
      calls('s2', 'c0'),
      calls('s3', 'a1'),
      calls('s4', 'b0'),
      calls('s4', 'a0'),
    ];
    const before = orderCrossings({ frontend: fr, backend: be, infrastructure: [] }, ls);
    const after = orderCrossings(orderMap({ frontend: fr, backend: be, infrastructure: [] }, ls), ls);
    expect(after).toBeLessThan(before);
  });
});

describe('bundlesOf', () => {
  const links = [calls('ui-a', 'g1'), calls('ui-a', 'g2'), calls('ui-b', 'g1'), runsOn('g1', 'pg'), { ...calls('g1', 'g2'), kind: 'depends' as const }];
  const groupOf = (id: string) => ({ g1: 'group:backend:Core', g2: 'group:backend:Core', pg: 'group:infrastructure:Runs' })[id] ?? id;
  const endOf = (id: string) => id;

  it('draws one line per screen and subsystem at rest, with its links, and hides gear-to-gear links', () => {
    const b = bundlesOf(links, { lit: null, picked: null }, endOf, groupOf);
    expect(b.map((x) => [x.from, x.to, x.links.length, x.aggregate])).toEqual([
      ['ui-a', 'group:backend:Core', 2, true],
      ['ui-b', 'group:backend:Core', 1, true],
      ['group:backend:Core', 'group:infrastructure:Runs', 1, true],
    ]);
  });

  it('draws only the links of what is pointed at, to the nodes themselves', () => {
    const b = bundlesOf(links, { lit: 'g1', picked: null }, endOf, groupOf);
    expect(b.map((x) => x.key).sort()).toEqual(['g1>g2', 'g1>pg', 'ui-a>g1', 'ui-b>g1']);
    expect(b.every((x) => !x.aggregate)).toBe(true);
  });

  it('draws a picked link alone', () => {
    const b = bundlesOf(links, { lit: null, picked: links[3] }, endOf, groupOf);
    expect(b.map((x) => x.key)).toEqual(['g1>pg']);
  });

  it('leaves out a link whose end is not drawn', () => {
    const b = bundlesOf(links, { lit: 'ui-a', picked: null }, (id) => (id === 'g2' ? null : id), groupOf);
    expect(b.map((x) => x.key)).toEqual(['ui-a>g1']);
  });
});

describe('route', () => {
  const gutterAbove = (l: number) => [0, 100, 300][l];
  const gutterBelow = (l: number) => [90, 290, 490][l];

  it('runs out of the box, down its channel, along the gutter and into the other box', () => {
    const a = leftPort(0, { x: 20, y: 10, h: 20 }, 10);
    const b = leftPort(1, { x: 220, y: 150, h: 20 }, 210);
    const pts = route(a, b, 'calls', gutterAbove, gutterBelow);
    expect(pts).toEqual([
      [20, 20],
      [10, 20],
      [10, 100],
      [210, 100],
      [210, 160],
      [220, 160],
    ]);
  });

  it('goes the same way whichever end is first', () => {
    const a = leftPort(0, { x: 20, y: 10, h: 20 }, 10);
    const b = leftPort(1, { x: 220, y: 150, h: 20 }, 210);
    expect(route(b, a, 'calls', gutterAbove, gutterBelow)).toEqual([...route(a, b, 'calls', gutterAbove, gutterBelow)].reverse());
  });

  it('keeps two ends in one lane to the gutter at its bottom', () => {
    const a = leftPort(1, { x: 20, y: 150, h: 20 }, 10);
    const b = leftPort(1, { x: 220, y: 200, h: 20 }, 210);
    const pts = route(a, b, 'depends', gutterAbove, gutterBelow);
    expect(pts.some(([, y]) => y === 293)).toBe(true);
  });

  it('leaves a box in a grid under it, along the gap under its row', () => {
    const p = bottomPort(0, { x: 100, y: 10, w: 40, h: 20 }, 4, 5);
    expect(p.stub).toEqual([
      [120, 30],
      [120, 34],
      [5, 34],
    ]);
  });

  it('crosses nothing when lines from stacked boxes share a channel to the subsystems', () => {
    // Three screens stacked in the shell's menu, each to a column of its own.
    const screens = [0, 1, 2].map((i) => leftPort(0, { x: 20, y: 10 + i * 30, h: 20 }, 10));
    const columns = [0, 1, 2].map((i) => leftPort(1, { x: 110 + i * 100, y: 120, h: 20 }, 104 + i * 100));
    const lines = [
      route(screens[0], columns[2], 'calls', gutterAbove, gutterBelow),
      route(screens[1], columns[0], 'calls', gutterAbove, gutterBelow),
      route(screens[2], columns[1], 'calls', gutterAbove, gutterBelow),
      route(screens[0], columns[0], 'calls', gutterAbove, gutterBelow),
    ];
    expect(crossingsOf(lines)).toBe(0);
  });
});

describe('crossingsOf', () => {
  it('counts proper crossings, not shared runs or touches', () => {
    const h: Point[] = [[0, 10], [100, 10]];
    const v: Point[] = [[50, 0], [50, 20]];
    expect(crossingsOf([h, v])).toBe(1);
    expect(crossingsOf([h, [[0, 10], [60, 10]]])).toBe(0);
    expect(crossingsOf([h, [[50, 10], [50, 30]]])).toBe(0);
  });
});

describe('simplify, pathOf and labelAt', () => {
  it('drops repeats and middle points of straight runs', () => {
    expect(simplify([[0, 0], [0, 0], [0, 5], [0, 10], [5, 10]])).toEqual([
      [0, 0],
      [0, 10],
      [5, 10],
    ]);
  });

  it('draws a path through the points with rounded corners', () => {
    expect(pathOf([[0, 0], [0, 10], [10, 10]])).toBe('M0,0 L0,6 Q0,10 4,10 L10,10');
  });

  it('writes a count on the last vertical run, just before it arrives', () => {
    expect(labelAt([[0, 0], [0, 50], [100, 50], [100, 200], [110, 200]])).toEqual([100, 192]);
  });
});
