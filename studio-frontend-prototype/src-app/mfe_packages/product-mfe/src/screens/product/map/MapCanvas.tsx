/**
 * The map drawn (the prototype's `Canvas` and `ScreenPreview`,
 * product-map-view.tsx): one lane per layer, groups as columns in their
 * subsystem's hue, the shell drawn as the app it is with its menu of screens,
 * and the links as lines over the lanes, measured off the drawn nodes.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import type { ScreenPreview as ScreenPicture } from '../../../api/types';
import {
  MAP_LAYERS,
  SHELL_NODE,
  groupsOf,
  linksOf,
  type MapLayer,
  type MapLink,
  type MapNode,
  type MapOverlay,
  type ProductMap as Map_,
} from '../../../model/product-map';
import { bottomPort, bundlesOf, labelAt, leftPort, orderMap, pathOf, route, type Point, type Port } from '../../../model/map-layout';
import { loadScreenPreviews, newestBuild } from '@constructor-studio/mfe-shared';
import { shortCommit } from '../../../model/screen-previews';
import { useMapTranslations } from '../../../i18n';
import { DRAG_GEAR, DRAG_MFE, KIND_GLYPH, hueOf, kindWord, screensOf, stateWord, type MapLook, type Text } from './words';
import styles from './ProductMap.module.css';
import { useProductApi, useScope } from '../../common';

const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ');

/* ── A micro-frontend's screens, drawn ── */

/** Each component's pictures, read once per page: a build adds them, and a
 *  reload is when a reader expects to see a new one. Read as a kit's page
 *  reads them (mfe-shared `loadScreenPreviews`): the catalogue's, else the
 *  ones the portal's own build took. */
const pictures = new Map<string, Promise<ScreenPicture[]>>();

function usePictures(component: string | null): ScreenPicture[] | null {
  const { orgId } = useScope();
  const productApi = useProductApi();
  const [items, setItems] = useState<{ component: string; items: ScreenPicture[] } | null>(null);
  useEffect(() => {
    if (!component) return;
    let live = true;
    // Each organization's catalogue keeps its own pictures.
    const key = `${orgId ?? ''} ${component}`;
    let read = pictures.get(key);
    if (!read) {
      read = loadScreenPreviews(component, () => productApi.screenPreviews(component).then((r) => r.items ?? []));
      pictures.set(key, read);
    }
    void read.then((r) => {
      if (live) setItems({ component, items: r });
    });
    return () => {
      live = false;
    };
  }, [component, orgId, productApi]);
  return component && items?.component === component ? items.items : null;
}

/** What a micro-frontend puts in the shell, as a small window: the newest
 *  build's picture of each screen (the rule a kit's page uses), otherwise
 *  drawn from what its manifest declares and labelled as having no picture.
 *  `bare` leaves out the menu, for a page drawn inside the shell's window. */
export function ScreenPreview({
  name,
  screens,
  pictured,
  screen,
  bare = false,
}: {
  name: string;
  screens: string[];
  pictured: { component: string; version: string | null } | null;
  screen?: string | null;
  bare?: boolean;
}) {
  const items = usePictures(pictured?.component ?? null);
  const build = newestBuild(items);
  if (build.length) return <BuiltPreview key={screen ?? ''} name={name} build={build} screen={screen ?? null} bare={bare} />;
  return <SchematicPreview name={name} screens={screens} screen={screen ?? null} bare={bare} />;
}

/** The pictures of one build: one screen large, every screen as a tab that shows it on hover. */
function BuiltPreview({ name, build, screen, bare }: { name: string; build: ScreenPicture[]; screen: string | null; bare: boolean }) {
  const { t } = useMapTranslations();
  const [on, setOn] = useState(() =>
    Math.max(
      0,
      build.findIndex((s) => s.label === screen || s.route === screen)
    )
  );
  const shot = build[Math.min(on, build.length - 1)];
  const capturedAt = build.reduce((at, p) => (p.captured_at > at ? p.captured_at : at), '');
  return (
    <span className={styles.previewHold} onClick={(e) => e.stopPropagation()}>
      <span
        className={styles.preview}
        role="img"
        aria-label={`${name}: ${build.map((s) => s.label ?? s.route).join(', ')}, built at ${shot.commit}`}
        data-pmap-preview="built"
      >
        <span className={styles.previewBar}>
          <span className={styles.previewUrl}>{shot.route}</span>
          <span
            className={styles.previewTag}
            title={t('preview_built_title', {
              commit: shot.commit,
              version: shot.version ?? '—',
              at: capturedAt || '—',
            })}
          >
            {t('preview_built', { commit: shortCommit(shot.commit) })}
          </span>
        </span>
        <img className={styles.previewShot} src={shot.image} alt={shot.label ?? shot.route} />
        {build.length > 1 && !bare && (
          <span className={styles.previewThumbs}>
            {build.map((s, i) => (
              <span
                key={s.route}
                className={cx(styles.previewThumb, s === shot && styles.on)}
                onMouseEnter={() => setOn(i)}
                title={s.route}
              >
                <img src={s.image} alt="" />
                <span>{s.label ?? s.route}</span>
              </span>
            ))}
          </span>
        )}
      </span>
    </span>
  );
}

/** Drawn from what the manifest declares: the screens in the shell's
 *  navigation, the first one open. Not a picture of the running screen. */
function SchematicPreview({ name, screens, screen, bare }: { name: string; screens: string[]; screen: string | null; bare: boolean }) {
  const { t } = useMapTranslations();
  const shown = screens.slice(0, 8);
  const open = screen && screens.includes(screen) ? screen : (shown[0] ?? null);
  return (
    <span
      className={styles.preview}
      role="img"
      aria-label={`${name}: ${screens.length ? screens.join(', ') : t('no_screens')}`}
      data-pmap-preview="schematic"
    >
      <span className={styles.previewBar}>
        <span className={styles.previewUrl}>/{(open ?? name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}</span>
        <span className={styles.previewTag} title={t('preview_schematic_title')}>
          {t('preview_schematic')}
        </span>
      </span>
      <span className={styles.previewBody}>
        {!bare && (
          <span className={styles.previewNav}>
            {shown.length === 0 && <span className={styles.muted}>{t('no_screens')}</span>}
            {shown.map((s) => (
              <span key={s} className={cx(styles.previewItem, s === open && styles.on)}>
                {s}
              </span>
            ))}
            {screens.length > shown.length && (
              <span className={styles.muted}>{t('more', { count: String(screens.length - shown.length) })}</span>
            )}
          </span>
        )}
        <span className={styles.previewPage}>
          <span className={styles.previewTitle}>{open ?? name}</span>
          <span className={styles.previewLine} style={{ width: '80%' }} />
          <span className={styles.previewLine} style={{ width: '95%' }} />
          <span className={styles.previewLine} style={{ width: '60%' }} />
        </span>
      </span>
    </span>
  );
}

/* ── The lanes and the links ── */

/** One drawn line (`bundlesOf`), routed (`route`). */
type Path = {
  key: string;
  d: string;
  points: Point[];
  /** The link it speaks for: its worst. */
  link: MapLink;
  links: MapLink[];
  count: number;
  kind: MapLink['kind'];
  aggregate: boolean;
  to: string;
};

/** A count written where a line arrives: for every line into the same end at rest, their sum. */
type Label = { key: string; x: number; y: number; count: number; title: string };

const LINK_CLASS: Record<MapLink['kind'], string> = {
  calls: styles.linkCalls,
  'runs-on': styles.linkRunsOn,
  'signs-in': styles.linkSignsIn,
  depends: styles.linkDepends,
  'stores-in': styles.linkStoresIn,
};

/** The legend under the map: each kind drawn with the class its lines are drawn with. */
const LEGEND: [MapLink['kind'] | 'bad', string][] = [
  ['calls', styles.linkCalls],
  ['signs-in', styles.linkSignsIn],
  ['runs-on', styles.linkRunsOn],
  ['depends', styles.linkDepends],
  ['stores-in', styles.linkStoresIn],
  ['bad', styles.linkBad],
];

const STATE_CLASS: Record<MapNode['state'], string> = {
  ok: styles.ok,
  missing: styles.missing,
  bad: styles.bad,
  warn: styles.warn,
  unused: styles.unused,
};

export function MapCanvas({
  find,
  look,
  map,
  nodeById,
  layers,
  selected,
  link,
  collapsed,
  overlay,
  hasFrontend,
  absence,
  onFrontend,
  pictured,
  onSelect,
  onLink,
  onToggleGroup,
  onDropScreen,
  onDropGear,
}: {
  find: string;
  look: MapLook;
  map: Map_;
  nodeById: Map<string, MapNode>;
  layers: Set<MapLayer>;
  selected: string | null;
  link: MapLink | null;
  collapsed: Set<string>;
  overlay?: MapOverlay;
  hasFrontend: boolean;
  absence: { text: string; tone: 'none' | 'warn' };
  onFrontend: () => void;
  pictured: Map<string, { component: string; version: string | null }>;
  onSelect: (id: string | null) => void;
  onLink: (l: MapLink) => void;
  onToggleGroup: (key: string) => void;
  onDropScreen: (name: string) => void;
  onDropGear: (name: string) => void;
}) {
  const { t } = useMapTranslations();
  const box = useRef<HTMLDivElement | null>(null);
  const refs = useRef(new Map<string, HTMLElement>());
  const [paths, setPaths] = useState<Path[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [over, setOver] = useState<MapLayer | null>(null);
  /** The node the pointer is on: its links show as if it were selected. */
  const [hover, setHover] = useState<string | null>(null);
  // The screen hovered in the app window's menu, which its page shows.
  const [screenOn, setScreenOn] = useState<{ node: string; screen: string } | null>(null);
  const lanes = MAP_LAYERS.filter((l) => layers.has(l.id));

  // What is lit: the selection, else what the pointer is on.
  const lit = selected ?? (link ? null : hover);

  // The screens, the subsystems and the gears in each ordered so the links
  // run as straight down as they can (map-layout.ts).
  const order = useMemo(() => {
    const frontend = groupsOf(map.nodes, 'frontend').flatMap((g) => g.nodes.map((n) => n.id));
    return orderMap(
      { frontend, backend: groupsOf(map.nodes, 'backend'), infrastructure: groupsOf(map.nodes, 'infrastructure') },
      map.links
    );
  }, [map]);
  const laneGroups = useMemo(
    () =>
      new Map<MapLayer, { group: string; nodes: MapNode[] }[]>([
        ['frontend', groupsOf(map.nodes, 'frontend')],
        ['backend', order.backend],
        ['infrastructure', order.infrastructure],
      ]),
    [map, order]
  );
  const frontRank = useMemo(() => new Map(order.frontend.map((id, i) => [id, i])), [order]);

  const measure = useCallback(() => {
    const el = box.current;
    if (!el) return;
    const at = el.getBoundingClientRect();
    const rel = (r: DOMRect) => ({ x: r.left - at.left, y: r.top - at.top, w: r.width, h: r.height });
    const rank = (layer: MapLayer) => MAP_LAYERS.findIndex((l) => l.id === layer);
    const key = (n: MapNode) => `${n.layer}:${n.group}`;
    // What is drawn for a node: its group's header while the group is
    // folded, nothing while it is hidden.
    const endOf = (id: string): string | null => {
      const n = nodeById.get(id);
      if (!n || !layers.has(n.layer)) return null;
      // A database is drawn only while its PostgreSQL is open.
      if (n.parent && (collapsed.has(key(n)) || collapsed.has(`dbs:${n.parent}`))) return null;
      const end = n.layer !== 'frontend' && collapsed.has(key(n)) ? `group:${key(n)}` : id;
      return refs.current.has(end) ? end : null;
    };
    const groupOf = (id: string): string | null => {
      const n = nodeById.get(id);
      if (!n || !layers.has(n.layer)) return null;
      if (n.layer === 'frontend') return id;
      const end = `group:${key(n)}`;
      return refs.current.has(end) ? end : null;
    };
    const lanesAt = new Map<number, ReturnType<typeof rel>>();
    for (const lane of el.querySelectorAll<HTMLElement>('[data-pmap-lane]')) {
      lanesAt.set(rank(lane.dataset.pmapLane as MapLayer), rel(lane.getBoundingClientRect()));
    }
    const ranks = [...lanesAt.keys()].sort((a, b) => a - b);
    const gutterAbove = (r: number) => {
      const lane = lanesAt.get(r)!;
      const prev = ranks.filter((x) => x < r).pop();
      if (prev === undefined) return lane.y - 4;
      const p = lanesAt.get(prev)!;
      return (p.y + p.h + lane.y) / 2;
    };
    const gutterBelow = (r: number) => {
      const lane = lanesAt.get(r)!;
      return lane.y + lane.h - 5;
    };
    // The shell's margin, where lines from its screens run down.
    const shellEl = el.querySelector<HTMLElement>('[data-pmap-shell]');
    const frontLane = lanesAt.get(rank('frontend'));
    const trunk = shellEl && frontLane ? (frontLane.x + rel(shellEl.getBoundingClientRect()).x) / 2 : 4;
    const portOf = (end: string): Port | null => {
      const node = refs.current.get(end);
      if (!node) return null;
      const r = rel(node.getBoundingClientRect());
      const layer = (end.startsWith('group:') ? end.split(':')[1] : nodeById.get(end)?.layer) as MapLayer | undefined;
      if (!layer) return null;
      const lane = rank(layer);
      if (layer === 'frontend') {
        // A screen in the shell's menu goes out left; a micro-frontend in the
        // grid of shared ones goes under its row first.
        if (node.closest('[data-pmap-shared]')) return bottomPort(lane, r, 4, trunk);
        if (end === SHELL_NODE) {
          const head = node.querySelector<HTMLElement>('button');
          return leftPort(lane, head ? rel(head.getBoundingClientRect()) : { ...r, h: 28 }, trunk);
        }
        return leftPort(lane, r, trunk);
      }
      // Into the gap left of its subsystem's column; a node scrolled out of
      // its row is drawn at the row's edge.
      const group = node.closest('[data-pmap-group]');
      const row = node.closest('[data-pmap-row]');
      const g = group ? rel(group.getBoundingClientRect()) : r;
      let channel = g.x - 6;
      let x = r.x;
      if (row) {
        const rr = rel(row.getBoundingClientRect());
        channel = Math.min(Math.max(channel, rr.x - 4), rr.x + rr.w);
        x = Math.min(Math.max(x, rr.x), rr.x + rr.w);
      }
      return leftPort(lane, { x, y: r.y, h: r.h }, channel);
    };
    const bundles = bundlesOf(map.links, { lit, picked: link }, endOf, groupOf);
    // At rest, the screens' lines leave the shell in the order of the menu.
    bundles.sort((a, b) => (frontRank.get(a.from) ?? 1e9) - (frontRank.get(b.from) ?? 1e9));
    const out: Path[] = [];
    const arrive = new Map<string, Label>();
    for (const b of bundles) {
      const pa = portOf(b.from);
      const pb = portOf(b.to);
      if (!pa || !pb) continue;
      const points = route(pa, pb, b.kind, gutterAbove, gutterBelow);
      // The line speaks for its worst link: a bad one is never hidden in a bundle.
      const worst = b.links.find((l) => l.state === 'bad') ?? b.links[0];
      out.push({
        key: b.key,
        d: pathOf(points),
        points,
        link: worst,
        links: b.links,
        count: b.links.length,
        kind: b.kind,
        aggregate: b.aggregate,
        to: b.to,
      });
      if (b.links.length > 1 || b.aggregate) {
        // Lines into one end at rest share its last run: one count for all of them.
        const where = labelAt(points);
        const k = b.aggregate ? b.to : b.key;
        const had = arrive.get(k);
        const title = b.links.map((l) => l.why);
        if (had) {
          had.count += b.links.length;
          had.title = `${had.title}; ${title.slice(0, 2).join('; ')}`;
        } else arrive.set(k, { key: k, x: where[0], y: where[1], count: b.links.length, title: title.slice(0, 4).join('; ') });
      }
    }
    setPaths(out);
    setLabels([...arrive.values()].filter((l) => l.count > 1));
    setSize({ w: el.scrollWidth, h: el.scrollHeight });
    // `look` and `find` change what is drawn, so where the lines go.
  }, [map, nodeById, layers, collapsed, look, find, lit, link, frontRank]); // eslint-disable-line react-hooks/exhaustive-deps

  // Measured once the lanes are laid out, and again whenever they resize.
  useEffect(() => {
    const frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, [measure]);

  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  const setRef = (id: string) => (el: HTMLElement | null) => {
    if (el) refs.current.set(id, el);
    else refs.current.delete(id);
  };
  const touches = (l: MapLink) => (lit ? l.from === lit || l.to === lit : link ? l === link : false);
  const linked = new Set<string>();
  if (lit) for (const l of linksOf(map, lit)) linked.add(l.from === lit ? l.to : l.from);
  if (link) {
    linked.add(link.from);
    linked.add(link.to);
  }
  const q = find.trim().toLowerCase();
  const found = new Set(
    q ? map.nodes.filter((n) => n.label.toLowerCase().includes(q) || n.group.toLowerCase().includes(q)).map((n) => n.id) : []
  );
  if (!lit && !link) for (const id of found) linked.add(id);
  const focus = !!lit || !!link || !!q;
  const dim = (id: string) => focus && !linked.has(id) && lit !== id;

  const accepts = (layer: MapLayer, e: DragEvent) =>
    (layer === 'frontend' && e.dataTransfer.types.includes(DRAG_MFE)) ||
    (layer === 'backend' && e.dataTransfer.types.includes(DRAG_GEAR));

  const chip = (n: MapNode) => {
    const run = overlay?.get(n.id);
    const shows = n.detail.kind === 'mfe' ? screensOf(n) : [];
    const calls = map.links.filter((l) => l.from === n.id && l.kind === 'calls').length;
    return (
      <button
        key={n.id}
        ref={setRef(n.id)}
        type="button"
        className={cx(
          styles.node,
          STATE_CLASS[n.state],
          selected === n.id && styles.on,
          found.has(n.id) && styles.found,
          linked.has(n.id) && styles.linked,
          dim(n.id) && styles.dim
        )}
        onMouseEnter={() => setHover(n.id)}
        onMouseLeave={() => setHover((h) => (h === n.id ? null : h))}
        // A screen card shows its own preview; a tooltip would cover it.
        title={
          n.detail.kind === 'mfe'
            ? undefined
            : `${kindWord(t, n.detail.kind)}: ${n.label}${n.state !== 'ok' ? ` (${stateWord(t, n.state)})` : ''}`
        }
        onClick={(e) => {
          e.stopPropagation();
          onSelect(selected === n.id ? null : n.id);
        }}
        aria-expanded={selected === n.id}
        aria-controls="pmap-detail"
        data-pmap-node={n.id}
        data-pmap-state={n.state}
      >
        <span className={styles.nodeLabel}>
          <span className={cx(styles.stateDot, STATE_CLASS[n.state])} aria-hidden />
          <span className={styles.glyph} aria-hidden>
            {KIND_GLYPH[n.detail.kind]}
          </span>
          {n.label}
        </span>
        {n.state !== 'ok' && <span className={styles.nodeState}>{stateWord(t, n.state)}</span>}
        {look === 'subsystems' && n.detail.kind !== 'mfe' && n.detail.kind !== 'database' && (
          <span className={styles.nodeWhat}>{n.detail.what}</span>
        )}
        {look === 'subsystems' && n.detail.kind === 'mfe' && (
          <>
            <span className={styles.nodeWhat}>{shows.length ? shows.join(', ') : n.detail.what}</span>
            <span className={styles.nodeMeta}>
              {shows.length ? `${t.count('screens_count', shows.length)} · ` : ''}
              {t.count('calls_gears', calls)}
            </span>
          </>
        )}
        {n.detail.kind === 'mfe' && hover === n.id && (
          <ScreenPreview name={n.label} screens={shows} pictured={pictured.get(n.id) ?? null} />
        )}
        {(n.badges ?? []).map((b) => (
          <span key={b.text} className={cx(styles.badge, styles[`badge_${b.tone}`])}>
            {b.text}
          </span>
        ))}
        {run && (
          <span className={cx(styles.badge, run.health === 'failing' ? styles.badge_bad : styles.badge_info)}>
            {run.version ?? '?'} {run.health ?? ''}
          </span>
        )}
      </button>
    );
  };

  /** A node and what is drawn under it: PostgreSQL and its databases, which fold under it on their own. */
  const withChildren = (n: MapNode, all: readonly MapNode[]) => {
    const kids = all.filter((k) => k.parent === n.id);
    if (kids.length === 0) return chip(n);
    const key = `dbs:${n.id}`;
    const folded = collapsed.has(key) && !kids.some((k) => found.has(k.id));
    return (
      <div key={n.id} className={styles.parent} data-pmap-parent={n.id}>
        {chip(n)}
        <button
          type="button"
          className={cx(styles.kidsHead, kids.some((k) => linked.has(k.id) || k.id === selected) && folded && styles.linked)}
          aria-expanded={!folded}
          onClick={(e) => {
            e.stopPropagation();
            onToggleGroup(key);
          }}
          title={folded ? t('kids_unfold') : t('kids_fold')}
          data-pmap-kids-toggle={n.id}
        >
          {folded ? '▸' : '▾'} {t.count('databases', kids.length)}
        </button>
        {!folded && <div className={styles.kids}>{kids.map((k) => chip(k))}</div>}
      </div>
    );
  };

  const app = (shell: MapNode, groups: { group: string; nodes: MapNode[] }[], tx: Text) => {
    // The shell drawn as the app it is. Its menu is the screens, each group
    // of them a micro-frontend; the page shows the screen hovered.
    // In the order that crosses fewest lines (map-layout.ts).
    const mounted = groups
      .flatMap((g) => g.nodes)
      .filter((n) => n.id !== shell.id)
      .sort((a, b) => (frontRank.get(a.id) ?? 0) - (frontRank.get(b.id) ?? 0));
    if (mounted.length === 0) return <p className={styles.muted}>{tx('app_empty')}</p>;
    const pages = mounted.filter((n) => screensOf(n).length > 0);
    const shared = mounted.filter((n) => screensOf(n).length === 0);
    const shown = pages.find((n) => n.id === lit) ?? pages[0];
    const screen = screenOn && screenOn.node === shown?.id ? screenOn.screen : null;
    const MENU = 4;
    return (
      <>
        <div className={styles.appBody}>
          <nav className={styles.appNav} aria-label={tx('app_menu', { name: shell.label })}>
            {pages.map((n) => (
              <div
                key={n.id}
                ref={setRef(n.id)}
                role="button"
                tabIndex={0}
                className={cx(
                  styles.appMenu,
                  STATE_CLASS[n.state],
                  shown?.id === n.id && styles.on,
                  selected === n.id && styles.picked,
                  dim(n.id) && styles.dim
                )}
                data-pmap-node={n.id}
                data-pmap-state={n.state}
                aria-expanded={selected === n.id}
                aria-controls="pmap-detail"
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover((h) => (h === n.id ? null : h))}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(selected === n.id ? null : n.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(selected === n.id ? null : n.id);
                  }
                }}
              >
                <span className={styles.appMfe}>
                  {n.label}
                  {n.state !== 'ok' && ` · ${stateWord(tx, n.state)}`}
                </span>
                {screensOf(n)
                  .slice(0, MENU)
                  .map((s) => (
                    <span
                      key={s}
                      className={cx(styles.appItem, screen === s && shown?.id === n.id && styles.on)}
                      onMouseEnter={() => setScreenOn({ node: n.id, screen: s })}
                    >
                      {s}
                    </span>
                  ))}
                {screensOf(n).length > MENU && (
                  <span className={cx(styles.appItem, styles.muted)}>
                    {tx('more', { count: String(screensOf(n).length - MENU) })}
                  </span>
                )}
              </div>
            ))}
          </nav>
          {shown && (
            <div className={styles.appStage} data-pmap-stage={shown.id}>
              <span className={styles.appDrawn}>{shown.label}</span>
              <ScreenPreview
                name={shown.label}
                screens={screensOf(shown)}
                pictured={pictured.get(shown.id) ?? null}
                screen={screen}
                bare
              />
            </div>
          )}
        </div>
        {shared.length > 0 && (
          <div className={styles.appShared} data-pmap-shared>
            <span className={styles.muted}>{tx('app_shared')}</span>
            {shared.map((n) => chip(n))}
          </div>
        )}
      </>
    );
  };

  return (
    <div className={cx(styles.canvas, look === 'compact' && styles.compact)} ref={box} onClick={() => onSelect(null)} data-pmap-canvas>
      <svg className={styles.links} width={size.w} height={size.h} aria-hidden>
        {paths.map((p) => {
          const on = p.links.some(touches);
          const cls = cx(
            styles.link,
            LINK_CLASS[p.kind],
            p.aggregate && styles.linkRest,
            p.link.state === 'bad' && styles.linkBad,
            on ? styles.linkOn : focus && styles.dim
          );
          return (
            <g key={p.key}>
              <path
                className={cls}
                d={p.d}
                style={p.count > 1 && !p.aggregate ? { strokeWidth: `${Math.min(4, 1.2 + Math.log2(p.count))}px` } : undefined}
                data-pmap-link={p.key}
                data-pmap-link-kind={p.kind}
              />
              <path
                className={styles.linkHit}
                d={p.d}
                onClick={(e) => {
                  e.stopPropagation();
                  onLink(p.link);
                }}
              >
                <title>
                  {p.count > 1
                    ? `${p.count}: ${p.links
                        .slice(0, 4)
                        .map((l) => l.why)
                        .join('; ')}${p.count > 4 ? '; …' : ''}`
                    : p.link.why}
                </title>
              </path>
            </g>
          );
        })}
        {labels.map((l) => (
          <g key={`n:${l.key}`} className={cx(styles.linkCount, focus && !lit && !link && styles.dim)} data-pmap-link-count={l.key}>
            <rect x={l.x - 9} y={l.y - 7} width={18} height={14} rx={7} />
            <text x={l.x} y={l.y} textAnchor="middle" dominantBaseline="central">
              {l.count}
            </text>
            <title>{l.title}</title>
          </g>
        ))}
      </svg>
      {lanes.length === 0 && <p className={styles.muted}>{t('no_layers')}</p>}
      {lanes.map((lane) => {
        const groups = laneGroups.get(lane.id) ?? [];
        const shell = map.nodes.find((n) => n.detail.kind === 'shell');
        return (
          <div
            key={lane.id}
            className={cx(styles.lane, over === lane.id && styles.drop)}
            data-pmap-lane={lane.id}
            onDragOver={(e) => {
              if (!accepts(lane.id, e)) return;
              e.preventDefault();
              setOver(lane.id);
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => {
              setOver(null);
              const mfe = e.dataTransfer.getData(DRAG_MFE);
              const gear = e.dataTransfer.getData(DRAG_GEAR);
              if (lane.id === 'frontend' && mfe) onDropScreen(mfe);
              if (lane.id === 'backend' && gear) onDropGear(gear);
            }}
          >
            <div className={styles.laneHead} title={lane.hint}>
              {t(`layer_${lane.id}`)}
            </div>
            <div
              className={cx(styles.laneBody, lane.id !== 'frontend' && styles.laneRow)}
              {...(lane.id !== 'frontend' ? { 'data-pmap-row': '' } : {})}
              onScroll={measure}
            >
              {lane.id === 'frontend' ? (
                shell ? (
                  <div
                    ref={setRef(shell.id)}
                    data-pmap-shell
                    className={cx(styles.shell, STATE_CLASS[shell.state], selected === shell.id && styles.on, linked.has(shell.id) && styles.linked)}
                    data-pmap-node={shell.id}
                    data-pmap-state={shell.state}
                  >
                    <button
                      type="button"
                      className={styles.shellHead}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelect(selected === shell.id ? null : shell.id);
                      }}
                      aria-expanded={selected === shell.id}
                      aria-controls="pmap-detail"
                    >
                      <b>{shell.label}</b>
                      {shell.detail.facts[1]?.startsWith('It signs') && <span className={styles.muted}> · {t('signs_in')}</span>}
                      {shell.state !== 'ok' && <span className={styles.nodeState}> {stateWord(t, shell.state)}</span>}
                    </button>
                    {app(shell, groups, t)}
                  </div>
                ) : (
                  <p
                    className={absence.tone === 'warn' && !hasFrontend ? styles.warnText : styles.muted}
                    data-pmap-frontend-absence={hasFrontend ? 'reading' : absence.tone}
                  >
                    {hasFrontend ? t('reading_frontend') : absence.text}
                    {!hasFrontend && absence.tone === 'warn' && (
                      <>
                        {' '}
                        <button
                          type="button"
                          className={styles.linklike}
                          onClick={(e) => {
                            e.stopPropagation();
                            onFrontend();
                          }}
                        >
                          {t('open_frontend')}
                        </button>
                      </>
                    )}
                  </p>
                )
              ) : groups.length === 0 ? (
                <p className={styles.muted}>{lane.id === 'backend' ? t('backend_empty') : t('infrastructure_empty')}</p>
              ) : (
                groups.map((g) => {
                  const key = `${lane.id}:${g.group}`;
                  const folded = collapsed.has(key) && !g.nodes.some((n) => found.has(n.id));
                  const worst = g.nodes.find((n) => n.state === 'bad' || n.state === 'missing');
                  return (
                    <div
                      key={key}
                      className={cx(styles.group, folded && styles.folded)}
                      data-pmap-group={g.group}
                      style={{ '--g-h': hueOf(g.group) } as CSSProperties}
                    >
                      <button
                        type="button"
                        ref={setRef(`group:${key}`)}
                        className={cx(
                          styles.groupHead,
                          worst && styles.bad,
                          folded && g.nodes.some((n) => linked.has(n.id) || n.id === selected) && styles.linked
                        )}
                        aria-expanded={!folded}
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleGroup(key);
                        }}
                        title={folded ? t('group_unfold') : t('group_fold')}
                      >
                        {folded ? '▸' : '▾'} {g.group} <span className={styles.muted}>{g.nodes.filter((n) => !n.parent).length}</span>
                      </button>
                      {!folded && (
                        <div className={styles.chips}>{g.nodes.filter((n) => !n.parent).map((n) => withChildren(n, g.nodes))}</div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        );
      })}
      {lanes.length > 0 && (
        <ul className={styles.linkLegend} data-pmap-link-legend>
          {LEGEND.map(([kind, cls]) => (
            <li key={kind} data-pmap-legend-kind={kind}>
              <svg aria-hidden>
                <path className={cx(styles.link, cls, styles.linkOn)} d="M0,6 L28,6" />
              </svg>
              {t(`link_legend_${kind.replace('-', '_')}`)}
            </li>
          ))}
          <li>{t(lit || link ? 'link_legend_lit' : 'link_legend_rest')}</li>
        </ul>
      )}
    </div>
  );
}

/** The key a node's group is folded under (exported for the bar's Fold all). */
export const groupKeyOf = (n: MapNode): string => `${n.layer}:${n.group}`;
