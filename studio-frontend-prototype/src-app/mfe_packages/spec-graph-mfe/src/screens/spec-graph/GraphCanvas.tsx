/**
 * A picture of part of the spec graph, or all of it, drawn by sigma.js (WebGL):
 * nodes keep their size on screen at every zoom, labels are laid out on a grid
 * so they never pile up and more appear as one zooms in, and only the centre and
 * the best-linked nodes are labelled until then. Hovering a node shows what it is
 * at once and lights up its neighbours; dragging pans, and a click (a press that
 * did not drag) opens the node. Depth is laid out by ForceAtlas2 around the centre;
 * the whole graph as islands, one per Louvain community (model/picture).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type Sigma from 'sigma';
import { Button } from '@gears-frontx/ui-kit';
import type { Picture } from '../../api/types';
import {
  clusters as findClusters,
  colourBy,
  layoutAround,
  layoutIslands,
  leaders,
  toGraph,
  type Cluster,
  FAMILIES,
  SMALL,
  type EdgeAttrs,
  type NodeAttrs,
} from '../../model/picture';
import { colourOf } from '../../model/look';
import { useSpecGraphTranslations } from '../../i18n';
import styles from './SpecGraphScreen.module.css';

type Text = ReturnType<typeof useSpecGraphTranslations>['t'];

export type Colouring = 'type' | 'cluster' | 'finding';

interface Hovered {
  key: string;
  x: number;
  y: number;
}

/** The graph and its communities, laid out once per picture. */
function useLaidOut(picture: Picture, layout: 'around' | 'islands', centre?: string) {
  return useMemo(() => {
    const g = toGraph(picture);
    const found = findClusters(g);
    if (layout === 'islands') layoutIslands(g);
    else layoutAround(g, centre);
    return { g, found };
  }, [picture, layout, centre]);
}

export const GraphCanvas: React.FC<{
  picture: Picture;
  layout: 'around' | 'islands';
  centre?: string;
  colouring: Colouring;
  onOpen: (key: string) => void;
  t: Text;
  /** Label every node and every edge (a small picture: the ontology). */
  labelAll?: boolean;
  /** A node chosen outside the picture (the findings panel's): ringed and labelled. */
  selected?: string | null;
}> = ({ picture, layout, centre, colouring, onOpen, t, labelAll = false, selected = null }) => {
  const selectedRef = useRef(selected);
  const { g, found } = useLaidOut(picture, layout, centre);
  const box = useRef<HTMLDivElement | null>(null);
  const frame = useRef<HTMLDivElement | null>(null);
  const sigma = useRef<Sigma<NodeAttrs, EdgeAttrs> | null>(null);
  const hoverRef = useRef<string | null>(null);
  // zoomed out (ratio near 1) the best-linked nodes are always labelled; zoomed in, the label grid decides
  const ratioRef = useRef(1);
  // the node types the person chose to hide (the legend's switches); every type shows at first
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const hiddenRef = useRef(hidden);
  const [hovered, setHovered] = useState<Hovered | null>(null);
  const open = useRef(onOpen);
  useEffect(() => {
    open.current = onOpen;
  }, [onOpen]);

  // colours and legend categories, set before the legend reads them; sigma redraws after
  const coloured = useMemo(() => {
    colourBy(g, colouring, found);
    return colouring;
  }, [g, found, colouring]);
  useEffect(() => {
    sigma.current?.refresh();
  }, [coloured]);

  useEffect(() => {
    selectedRef.current = selected;
    sigma.current?.refresh({ skipIndexation: true });
  }, [selected]);

  useEffect(() => {
    hiddenRef.current = hidden;
    sigma.current?.refresh({ skipIndexation: true });
  }, [hidden]);

  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    colourBy(g, colouring, found);
    // labelled while zoomed out: each cluster's lead document (whole graph), or the best-linked few (depth)
    const shown = labelAll
      ? new Set(g.nodes())
      : layout === 'islands'
        ? new Set(found.filter((c) => c.size >= 4).map((c) => c.lead))
        : leaders(g, 8, centre);
    const ink = getComputedStyle(el).color || '#0f172a';
    let r: Sigma<NodeAttrs, EdgeAttrs> | null = null;
    let live = true;
    // loaded when a picture is drawn: the tab opens without it, and it touches WebGL as it loads
    void import('sigma')
      .then(({ default: SigmaClass }) => {
        if (!live) return;
        try {
          r = new SigmaClass<NodeAttrs, EdgeAttrs>(g, el, {
            labelDensity: 0.35,
            labelGridCellSize: 160,
            labelRenderedSizeThreshold: 10,
            labelSize: 12,
            labelFont: 'Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif',
            labelColor: { color: ink },
            zIndex: true,
            renderEdgeLabels: labelAll,
            edgeLabelSize: 11,
            edgeLabelColor: { color: '#64748b' },
            minCameraRatio: 0.03,
            maxCameraRatio: 3,
            defaultEdgeColor: '#cbd5e1',
            nodeReducer: (key, a) => {
              if (hiddenRef.current.has(a.cat ?? a.kind)) return { ...a, hidden: true };
              if (key === selectedRef.current) return { ...a, highlighted: true, forceLabel: true, zIndex: 3 };
              const hover = hoverRef.current;
              const lead = shown.has(key) && (labelAll || key === centre || ratioRef.current > 0.5);
              if (!hover) return { ...a, forceLabel: lead, zIndex: lead ? 1 : 0 };
              if (key === hover || g.areNeighbors(key, hover))
                return {
                  ...a,
                  forceLabel: true,
                  zIndex: 2,
                  highlighted: key === hover,
                };
              return { ...a, color: '#e2e8f0', label: '', zIndex: 0 };
            },
            edgeReducer: (key, a) => {
              const hover = hoverRef.current;
              if (hover && !g.hasExtremity(key, hover)) return { ...a, hidden: true };
              return a;
            },
          });
        } catch {
          return; // no WebGL here (an old browser): nothing drawn
        }
        const s = r;
        const where = (node: string) => {
          const d = s.getNodeDisplayData(node);
          return d ? s.framedGraphToViewport({ x: d.x, y: d.y }) : { x: 0, y: 0 };
        };
        s.on('enterNode', ({ node }) => {
          hoverRef.current = node;
          setHovered({ key: node, ...where(node) });
          s.refresh({ skipIndexation: true });
          el.style.cursor = 'pointer';
        });
        s.on('leaveNode', () => {
          hoverRef.current = null;
          setHovered(null);
          s.refresh({ skipIndexation: true });
          el.style.cursor = '';
        });
        s.on('clickNode', ({ node }) => open.current(node));
        s.getCamera().on('updated', (state) => {
          ratioRef.current = state.ratio;
          const h = hoverRef.current;
          if (h) setHovered({ key: h, ...where(h) });
        });
        sigma.current = s;
      })
      .catch(() => undefined);
    return () => {
      live = false;
      sigma.current = null;
      hoverRef.current = null;
      r?.kill();
    };
  }, [g, found, layout, centre, labelAll]); // eslint-disable-line react-hooks/exhaustive-deps

  const zoom = (k: number) => {
    const cam = sigma.current?.getCamera();
    if (cam) void cam.animate({ ratio: cam.getState().ratio / k }, { duration: 200 });
  };
  const fit = () => void sigma.current?.getCamera().animatedReset({ duration: 200 });
  const full = () => {
    const f = frame.current;
    if (!f) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void f.requestFullscreen?.();
  };

  const h = hovered && g.hasNode(hovered.key) ? g.getNodeAttributes(hovered.key) : null;
  // the legend's switches: node types, or (colouring by finding) the findings' rule families first
  const catCounts = new Map<string, { colour: string; count: number }>();
  g.forEachNode((_, a) => {
    const key = a.cat ?? a.kind;
    const had = catCounts.get(key);
    catCounts.set(key, { colour: had?.colour ?? a.color, count: (had?.count ?? 0) + 1 });
  });
  const familyRank = (k: string) => FAMILIES.findIndex((f) => f.key === k);
  const cats = [...catCounts.entries()]
    .map(([key, v]) => ({ key, ...v, family: colouring === 'finding' && familyRank(key) >= 0 }))
    .sort(
      (x, y) =>
        Number(y.family) - Number(x.family) || familyRank(x.key) - familyRank(y.key) || x.key.localeCompare(y.key),
    );
  const showing = hidden.size ? g.filterNodes((_, a) => !hidden.has(a.cat ?? a.kind)).length : g.order;
  const toggle = (type: string) =>
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  return (
    <div className={styles.picture} ref={frame}>
      <div className={styles.chips}>
        <Button size="sm" variant="outline" onClick={() => zoom(1.5)} aria-label={t('graph_zoom_in')}>
          +
        </Button>
        <Button size="sm" variant="outline" onClick={() => zoom(1 / 1.5)} aria-label={t('graph_zoom_out')}>
          −
        </Button>
        <Button size="sm" variant="ghost" onClick={fit}>
          {t('graph_fit')}
        </Button>
        <Button size="sm" variant="ghost" onClick={full}>
          {t('graph_full_screen')}
        </Button>
        <span className={styles.muted}>
          {hidden.size
            ? t('graph_showing', { shown: showing, nodes: g.order })
            : t('graph_size', { nodes: g.order, edges: g.size })}
          {layout === 'islands' ? ` · ${t('graph_clusters', { count: found.filter((c) => c.size >= 4).length })}` : ''}
        </span>
      </div>
      <div className={styles.canvasWrap}>
        <div ref={box} className={styles.canvas} role="img" aria-label={t('graph_map')} data-nodes={g.order} />
        {h && hovered && (
          <div className={styles.tooltip} style={{ left: hovered.x + 14, top: hovered.y + 14 }} role="tooltip">
            <strong>{h.label}</strong>
            <span>
              {h.kind} · {t('graph_links', { count: g.degree(hovered.key) })}
            </span>
            {h.path && (
              <code>
                {h.path}
                {h.line ? `:${h.line}` : ''}
              </code>
            )}
            {h.cluster != null && found[h.cluster] && <span className={styles.muted}>{found[h.cluster].name}</span>}
          </div>
        )}
      </div>
      <TypeFilter
        cats={cats.map((c) => ({
          key: c.key,
          label: c.family ? t(`family_${c.key}`) : c.key,
          colour: colouring === 'finding' ? c.colour : colourOf(c.key),
          count: colouring === 'type' ? (picture.counts?.[c.key] ?? c.count) : c.count,
        }))}
        hidden={hidden}
        onToggle={toggle}
        onAll={() => setHidden(new Set())}
        t={t}
      />
      {colouring === 'cluster' && <ClusterLegend found={found} t={t} />}
    </div>
  );
};

/**
 * The legend is the filter: one switch per node type, its colour square filled while the type
 * shows and hollow once hidden; every type shows at first. A judge's edge is explained, not a switch.
 */
const TypeFilter: React.FC<{
  cats: { key: string; label: string; colour: string; count: number }[];
  hidden: Set<string>;
  onToggle: (type: string) => void;
  onAll: () => void;
  t: Text;
}> = ({ cats, hidden, onToggle, onAll, t }) => (
  <div className={styles.legend} role="group" aria-label={t('graph_filter')}>
    {cats.map(({ key: type, label, colour, count }) => {
      const on = !hidden.has(type);
      return (
        <button
          key={type}
          type="button"
          className={styles.typeSwitch}
          aria-pressed={on}
          title={on ? t('graph_filter_hide', { type: label }) : t('graph_filter_show', { type: label })}
          onClick={() => onToggle(type)}
        >
          <span
            className={styles.swatch}
            style={on ? { background: colour, borderColor: colour } : { borderColor: colour }}
            aria-hidden
          />
          <span className={on ? undefined : styles.off}>{label}</span>
          <span className={styles.muted}>({count})</span>
        </button>
      );
    })}
    {hidden.size > 0 && (
      <button type="button" className={styles.typeSwitch} onClick={onAll}>
        {t('graph_filter_all')}
      </button>
    )}
    <span className={styles.legendItem}>
      <span className={styles.swatch} style={{ background: '#7c3aed', height: 2, borderColor: '#7c3aed' }} />
      {t('graph_judged_edge')}
    </span>
  </div>
);

/** In cluster colours: which colour is which community, and the rest in grey. */
const ClusterLegend: React.FC<{ found: Cluster[]; t: Text }> = ({ found, t }) => (
  <div className={styles.legend}>
    {found
      .filter((c) => c.colour !== SMALL)
      .map((c) => (
        <span key={c.id} className={styles.legendItem} title={c.name}>
          <span className={styles.swatch} style={{ background: c.colour, borderColor: c.colour }} />
          {c.name.length > 60 ? `${c.name.slice(0, 59)}…` : c.name} <span className={styles.muted}>({c.size})</span>
        </span>
      ))}
    {found.some((c) => c.colour === SMALL) && (
      <span className={styles.legendItem}>
        <span className={styles.swatch} style={{ background: SMALL, borderColor: SMALL }} />
        {t('graph_other_clusters', { count: found.filter((c) => c.colour === SMALL).length })}
      </span>
    )}
  </div>
);
