/**
 * What a kit's page draws (#1099), worked out from the kit's contents
 * (`GET /studio-kits/v1/catalog/{slug}`), the shell's registered tabs
 * (`AvailableScreens.tabs`) and the organization's model: where the kit's
 * screens appear on each level's tab bar, its model as a small graph, its
 * permissions grouped by gear, and what installing it changes.
 *
 * Pure: the page and its tests hand everything in.
 */

import type { ModelTab, ShellTab } from '@constructor-studio/mfe-shared';
import type { KitContents, KitField, KitScreen, KitTypeInfo, ScreenPreview } from '../api/KitsApiService';

/** The levels in the shell's order (ADR-0069). */
export const LEVEL_ORDER = ['platform', 'organization', 'workspace', 'project', 'admin'] as const;

const levelIndex = (level: string) => {
  const at = (LEVEL_ORDER as readonly string[]).indexOf(level);
  return at < 0 ? LEVEL_ORDER.length : at;
};

/* ── Where it appears ─────────────────────────────────────────────────── */

/** One tab of a level's bar as the kit's page draws it. */
export interface LevelTab {
  /** Unique on its bar. */
  key: string;
  label: string;
  /** The portal route; null for a tab the model adds or a screen not in this portal. */
  route: string | null;
  icon: string | null;
  /** The kit's own tab: highlighted and selectable. */
  mine: boolean;
  /** Where it comes from: a registered screen, the model's `shows` relation, or only the kit's manifest. */
  source: 'screen' | 'model' | 'manifest';
  /** The micro-frontend that draws it (its npm name), when known: where its pictures are kept. */
  component: string | null;
  /** For a model tab: the type it lists. */
  target: string | null;
  settings: boolean;
}

/** One level the kit puts screens on: its bar, and the kit's sections inside other screens. */
export interface LevelMap {
  level: string;
  tabs: LevelTab[];
  sections: KitScreen[];
}

/**
 * The micro-frontend a screen extension's entry belongs to, by Studio's naming
 * (`…~constructor_studio.<name>.mfe.<entry>.v1` is `@constructor-studio/<name>-mfe`,
 * underscores as hyphens): the `component` its pictures are kept under. `null`
 * for an entry of another namespace (an organization's own kit).
 */
export function componentOfEntry(entry: string | null | undefined): string | null {
  const m = /~constructor_studio\.([a-z0-9_]+)\.mfe\.[a-z0-9_]+\.v\d+$/.exec(entry ?? '');
  return m ? `@constructor-studio/${m[1].replace(/_/g, '-')}-mfe` : null;
}

/** The levels `contents` puts something on, in the shell's order. */
export function kitLevels(contents: KitContents): string[] {
  const levels = new Set<string>([
    ...contents.screens.map((s) => s.level),
    ...(contents.model?.tabs ?? []).map((t) => t.level),
  ]);
  return [...levels].sort((a, b) => levelIndex(a) - levelIndex(b) || a.localeCompare(b));
}

export interface LevelMapInput {
  slug: string;
  contents: KitContents;
  /** The shell's registered tabs; null outside the shell or from a shell that predates them. */
  shellTabs: readonly ShellTab[] | null;
  /** Routes that show where the person is (`AvailableScreens.routes`); null while unknown. */
  routes: readonly string[] | null;
  /** The `shows` relations of each level's type in the organization's model; null while unknown. */
  modelTabs: Readonly<Record<string, readonly ModelTab[]>> | null;
}

/**
 * Each level's bar with the kit's tabs among the shell's. A level's bar is
 * what the shell draws there: its registered main tabs by order, the model's
 * tabs no screen answers, then its settings tabs. Another kit's tab is on it
 * only where it shows now; this kit's always, highlighted. A tab the kit's
 * manifest names that the shell has not registered (its bundle not loaded, a
 * screen not in this portal yet) or a model tab not in the organization's
 * model yet comes after the main tabs, so installing it reads as adding it.
 */
export function levelMaps({ slug, contents, shellTabs, routes, modelTabs }: LevelMapInput): LevelMap[] {
  return kitLevels(contents).map((level) => {
    const declared = contents.screens.filter((s) => s.level === level && s.kind === 'tab');
    const declaredRoutes = new Set(declared.map((s) => s.route).filter((r): r is string => !!r));
    const kitModelTabs = (contents.model?.tabs ?? []).filter((t) => t.level === level);
    const kitModelNames = new Set(kitModelTabs.map((t) => t.name));
    const registered = (shellTabs ?? []).filter((t) => t.level === level);
    const isMine = (t: ShellTab) => t.kit === slug || declaredRoutes.has(t.route) || kitModelNames.has(t.modelTab);
    const shows = (t: ShellTab) => isMine(t) || !t.kit || routes === null || routes.includes(t.route);
    const fromScreen = (t: ShellTab): LevelTab => ({
      key: `screen:${t.route}`,
      label: t.label,
      route: t.route,
      icon: t.icon,
      mine: isMine(t),
      source: 'screen',
      component: componentOfEntry(t.entry),
      target: null,
      settings: t.placement === 'settings',
    });
    const main = registered.filter((t) => t.placement !== 'settings' && shows(t)).map(fromScreen);
    const settings = registered.filter((t) => t.placement === 'settings' && shows(t)).map(fromScreen);

    // The model's tabs no registered screen of the level answers: the generic screen draws them.
    const answered = new Set(registered.map((t) => t.modelTab));
    const generic: LevelTab[] = (modelTabs?.[level] ?? [])
      .filter((t) => t.target && !answered.has(t.name))
      .map((t) => ({
        key: `model:${t.name}`,
        label: t.label,
        route: null,
        icon: null,
        mine: kitModelNames.has(t.name),
        source: 'model',
        component: null,
        target: t.target,
        settings: false,
      }));

    // What the kit names that the bar does not have yet.
    const onBar = new Set([...main, ...settings].map((t) => t.route));
    const labels = new Set([...main, ...generic, ...settings].map((t) => t.label.toLowerCase()));
    const missing: LevelTab[] = [];
    for (const s of declared) {
      if ((s.route && onBar.has(s.route)) || (!s.route && labels.has(s.label.toLowerCase()))) continue;
      missing.push({
        key: `manifest:${s.route ?? s.label}`,
        label: s.label,
        route: s.route,
        icon: null,
        mine: true,
        source: 'manifest',
        component: null,
        target: null,
        settings: false,
      });
      labels.add(s.label.toLowerCase());
    }
    const inModel = new Set((modelTabs?.[level] ?? []).map((t) => t.name));
    for (const t of kitModelTabs) {
      if (answered.has(t.name) || inModel.has(t.name) || labels.has(t.label.toLowerCase())) continue;
      missing.push({
        key: `model:${t.name}`,
        label: t.label,
        route: null,
        icon: null,
        mine: true,
        source: 'model',
        component: null,
        target: t.target,
        settings: false,
      });
      labels.add(t.label.toLowerCase());
    }
    return {
      level,
      tabs: [...main, ...generic, ...missing, ...settings],
      sections: contents.screens.filter((s) => s.level === level && s.kind === 'section'),
    };
  });
}

/**
 * The newest build's picture of a screen: by route, else by label. `items`
 * come the newest build first (`GET /screen-previews`); a picture of an
 * older build is not taken when the newest has none of the screen.
 */
export function pictureFor(
  items: readonly ScreenPreview[] | null | undefined,
  place: { route: string | null; label: string }
): ScreenPreview | null {
  const usable = (items ?? []).filter((p) => p.image.startsWith('data:image/'));
  const newest = usable[0]?.commit;
  if (!newest) return null;
  const build = usable.filter((p) => p.commit === newest);
  if (place.route) {
    const byRoute = build.find((p) => p.route === place.route);
    if (byRoute) return byRoute;
  }
  const label = place.label.trim().toLowerCase();
  return build.find((p) => p.label?.trim().toLowerCase() === label) ?? null;
}

/* ── What it adds to the model ────────────────────────────────────────── */

/** A type on the diagram: the kit's own, or a type of the model it relates to. */
export interface ModelNode {
  id: string;
  label: string;
  /** The kit brings it. */
  kit: boolean;
  /** The kit adopts it from the core (only for `kit`). */
  adopts: boolean;
  description: string | null;
  /** Its fields with where each comes from: the kit's type's own, or what the kit adds to another type. */
  fields: KitField[];
}

/** An edge, one per pair of types, every relation name on it. */
export interface ModelEdge {
  from: string;
  to: string;
  labels: string[];
}

export interface ModelGraph {
  nodes: ModelNode[];
  edges: ModelEdge[];
}

const words = (id: string) => id.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** The kit's types, the types it relates them to or adds fields to, and the edges between them. */
export function modelGraph(contents: KitContents, slug: string): ModelGraph {
  const idOf = (t: KitTypeInfo) => t.id ?? `${slug}-${t.name.toLowerCase().replace(/\s+/g, '-')}`;
  const nodes = new Map<string, ModelNode>();
  for (const t of contents.types) {
    nodes.set(idOf(t), {
      id: idOf(t),
      label: t.name,
      kit: true,
      adopts: !!t.adopts,
      description: t.description,
      fields: [...(t.fields ?? [])],
    });
  }
  const other = (id: string) => {
    let node = nodes.get(id);
    if (!node) {
      node = { id, label: words(id), kit: false, adopts: false, description: null, fields: [] };
      nodes.set(id, node);
    }
    return node;
  };
  for (const f of contents.model?.fields ?? []) {
    if (f.on) other(f.on).fields.push(f);
  }
  const edges = new Map<string, ModelEdge>();
  for (const r of contents.model?.relations ?? []) {
    other(r.on);
    other(r.target);
    const key = `${r.on}→${r.target}`;
    const edge = edges.get(key) ?? { from: r.on, to: r.target, labels: [] };
    const label = (r.label ?? r.name).replace(/_/g, ' ');
    if (!edge.labels.includes(label)) edge.labels.push(label);
    edges.set(key, edge);
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/** How many of each column the diagram draws before it says "more" and offers the list. */
export const DIAGRAM_CAP = { kit: 6, other: 8 } as const;

export interface DiagramLayout {
  width: number;
  height: number;
  nodes: (ModelNode & { x: number; y: number; w: number; h: number })[];
  edges: (ModelEdge & { path: string; lx: number; ly: number })[];
  /** Nodes left out by the cap. */
  hidden: number;
}

const NODE_H = 30;
const GAP = 14;
const NODE_W = 168;
const WIDTH = 640;

/**
 * The diagram's layout: the kit's types on the left, the types they relate to
 * on the right, each column capped (most connected first), edges as curves
 * with their label where it does not collide with the one above.
 */
export function layoutDiagram(graph: ModelGraph): DiagramLayout {
  const degree = (id: string) => graph.edges.filter((e) => e.from === id || e.to === id).length;
  const byDegree = (a: ModelNode, b: ModelNode) => degree(b.id) - degree(a.id) || a.label.localeCompare(b.label);
  const kit = graph.nodes.filter((n) => n.kit).sort(byDegree);
  const others = graph.nodes.filter((n) => !n.kit).sort(byDegree);
  const left = kit.slice(0, DIAGRAM_CAP.kit);
  const right = others.slice(0, DIAGRAM_CAP.other);
  const hidden = kit.length - left.length + (others.length - right.length);
  const rows = Math.max(left.length, right.length, 1);
  const height = rows * (NODE_H + GAP) + GAP;
  const column = (list: ModelNode[], x: number) => {
    const offset = (height - list.length * (NODE_H + GAP) + GAP) / 2;
    return list.map((n, i) => ({ ...n, x, y: offset + i * (NODE_H + GAP), w: NODE_W, h: NODE_H }));
  };
  const placed = [...column(left, 8), ...column(right, WIDTH - NODE_W - 8)];
  const at = new Map(placed.map((n) => [n.id, n]));
  const edges: DiagramLayout['edges'] = [];
  for (const e of graph.edges) {
    const a = at.get(e.from);
    const b = at.get(e.to);
    if (!a || !b || a === b) continue;
    const ay = a.y + a.h / 2;
    const by = b.y + b.h / 2;
    let path: string;
    let lx: number;
    let ly: number;
    if (a.x === b.x) {
      // Within a column: an arc out to the side.
      const x = a.x + a.w;
      const bulge = x + 40 + Math.abs(by - ay) / 4;
      path = `M ${x} ${ay} C ${bulge} ${ay}, ${bulge} ${by}, ${x} ${by}`;
      lx = bulge - 10;
      ly = (ay + by) / 2;
    } else {
      const [from, to] = a.x < b.x ? [a, b] : [b, a];
      const x1 = from.x + from.w;
      const x2 = to.x;
      const y1 = from === a ? ay : by;
      const y2 = from === a ? by : ay;
      const mid = (x1 + x2) / 2;
      path = `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
      lx = mid;
      ly = (y1 + y2) / 2;
    }
    edges.push({ ...e, path, lx, ly });
  }
  // Labels one above another are pushed apart, so none hides the other.
  const sorted = [...edges].sort((p, q) => p.ly - q.ly);
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (Math.abs(cur.lx - prev.lx) < 120 && cur.ly - prev.ly < 14) cur.ly = prev.ly + 14;
  }
  return { width: WIDTH, height: Math.max(height, ...edges.map((e) => e.ly + 10)), nodes: placed, edges, hidden };
}

/* ── What it lets people and agents do ────────────────────────────────── */

/** One path of a gear with the methods the kit may call it with. */
export interface GrantedPath {
  /** After the gear's prefix (`/studio-documents/v1`); `/` for the prefix itself. */
  path: string;
  methods: string[];
}

export interface GearGrants {
  /** The route's first segment (`studio-documents`); empty for what is not a route (a GTS type, an event). */
  gear: string;
  reads: GrantedPath[];
  writes: GrantedPath[];
}

const HTTP = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S*)$/;

/** `METHOD /gear/vN/rest` split; null for an entry that is not a route. */
export function parseRoute(entry: string): { method: string; gear: string; path: string } | null {
  const m = HTTP.exec(entry.trim());
  if (!m) return null;
  const segments = m[2].split('/').filter(Boolean);
  const gear = segments[0] ?? '';
  const rest = /^v\d+$/.test(segments[1] ?? '') ? segments.slice(2) : segments.slice(1);
  return { method: m[1], gear, path: `/${rest.join('/')}` };
}

/**
 * The permissions grouped by gear (the route's first segment), each into what
 * it reads and what it writes, a path once with every method as a chip. What
 * is not a route (a GTS type a kit reads) goes under the empty gear, as it is.
 */
export function groupPermissions(permissions: KitContents['permissions']): GearGrants[] {
  const gears = new Map<string, GearGrants>();
  const add = (entry: string, side: 'reads' | 'writes') => {
    const route = parseRoute(entry);
    const gear = route?.gear ?? '';
    const group = gears.get(gear) ?? { gear, reads: [], writes: [] };
    gears.set(gear, group);
    const path = route?.path ?? entry;
    const found = group[side].find((p) => p.path === path);
    if (!found) group[side].push({ path, methods: route ? [route.method] : [] });
    else if (route && !found.methods.includes(route.method)) found.methods.push(route.method);
  };
  permissions.reads.forEach((e) => add(e, 'reads'));
  permissions.writes.forEach((e) => add(e, 'writes'));
  // Routes first by gear, then what is not a route.
  return [...gears.values()].sort((a, b) => Number(!a.gear) - Number(!b.gear) || a.gear.localeCompare(b.gear));
}

/* ── Only what it has ─────────────────────────────────────────────────── */

/** The sections of a kit's page that list something; the rest collapse into one line. */
export const SECTION_KEYS = ['screens', 'model', 'handlers', 'services', 'agents', 'permissions', 'material', 'kinds'] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

/** Which sections `contents` has nothing for, in the page's order. */
export function emptySections(contents: KitContents): SectionKey[] {
  const p = contents.permissions;
  const count: Record<SectionKey, number> = {
    screens: contents.screens.length + (contents.model?.tabs.length ?? 0),
    model: contents.types.length + (contents.model?.fields.length ?? 0) + (contents.model?.relations.length ?? 0),
    handlers: contents.rules.length + contents.functions.length,
    services: contents.services.length,
    agents: contents.inbox.length + contents.mcp_tools.length,
    permissions: p.reads.length + p.writes.length + p.listens.length,
    material: contents.material.length,
    kinds: contents.kinds.length + contents.docs.length,
  };
  return SECTION_KEYS.filter((k) => count[k] === 0);
}

/* ── What installing changes ──────────────────────────────────────────── */

export interface InstallChanges {
  /** Tabs that appear, with their level. */
  tabs: { level: string; label: string }[];
  /** The kit's own new types: active from the install. */
  types: string[];
  /** Types Studio's core has that it takes over: an organization's own, or a dormant one, becomes the kit's. */
  adopts: string[];
  /** Types of the model it adds fields to. */
  extends: string[];
}

export function installChanges(contents: KitContents): InstallChanges {
  const tabs: InstallChanges['tabs'] = [];
  const seen = new Set<string>();
  const add = (level: string, label: string) => {
    const key = `${level}:${label.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    tabs.push({ level, label });
  };
  contents.screens.filter((s) => s.kind === 'tab').forEach((s) => add(s.level, s.label));
  (contents.model?.tabs ?? []).forEach((t) => add(t.level, t.label));
  tabs.sort((a, b) => levelIndex(a.level) - levelIndex(b.level));
  const own = new Set(contents.types.map((t) => t.id));
  const extended = new Set(
    (contents.model?.fields ?? []).map((f) => f.on).filter((on): on is string => !!on && !own.has(on))
  );
  return {
    tabs,
    types: contents.types.filter((t) => !t.adopts).map((t) => t.name),
    adopts: contents.types.filter((t) => t.adopts).map((t) => t.name),
    extends: [...extended].map(words),
  };
}
