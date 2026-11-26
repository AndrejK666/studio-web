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
  type EdgeAttrs,
  type NodeAttrs,
} from '../../model/picture';
import { colourOf } from '../../model/look';
import { useSpecGraphTranslations } from '../../i18n';
import styles from './SpecGraphScreen.module.css';

type Text = ReturnType<typeof useSpecGraphTranslations>['t'];

export type Colouring = 'type' | 'cluster';

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
}> = ({ picture, layout, centre, colouring, onOpen, t }) => {
  const { g, found } = useLaidOut(picture, layout, centre);
  const box = useRef<HTMLDivElement | null>(null);
  const frame = useRef<HTMLDivElement | null>(null);
  const sigma = useRef<Sigma<NodeAttrs, EdgeAttrs> | null>(null);
  const hoverRef = useRef<string | null>(null);
  // zoomed out (ratio near 1) the best-linked nodes are always labelled; zoomed in, the label grid decides
  const ratioRef = useRef(1);
  const [hovered, setHovered] = useState<Hovered | null>(null);
  const open = useRef(onOpen);
  useEffect(() => {
    open.current = onOpen;
  }, [onOpen]);

  useEffect(() => {
    colourBy(g, colouring, found);
    sigma.current?.refresh();
  }, [g, found, colouring]);

  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    colourBy(g, colouring, found);
    // labelled while zoomed out: each cluster's lead document (whole graph), or the best-linked few (depth)
    const shown =
      layout === 'islands' ? new Set(found.filter((c) => c.size >= 4).map((c) => c.lead)) : leaders(g, 8, centre);
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
            minCameraRatio: 0.03,
            maxCameraRatio: 3,
            defaultEdgeColor: '#cbd5e1',
            nodeReducer: (key, a) => {
              const hover = hoverRef.current;
              const lead = shown.has(key) && (key === centre || ratioRef.current > 0.5);
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
  }, [g, found, layout, centre]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const types = [...new Set(g.mapNodes((_, a) => a.kind))].sort();
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
          {t('graph_size', { nodes: g.order, edges: g.size })}
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
      <Legend colouring={colouring} types={types} counts={picture.counts} found={found} t={t} />
    </div>
  );
};

const Legend: React.FC<{
  colouring: Colouring;
  types: string[];
  counts?: Record<string, number>;
  found: Cluster[];
  t: Text;
}> = ({ colouring, types, counts, found, t }) => (
  <div className={styles.legend}>
    {colouring === 'cluster'
      ? found
          .filter((c) => c.size >= 4)
          .slice(0, 12)
          .map((c) => (
            <span key={c.id} className={styles.legendItem} title={c.name}>
              <span className={styles.swatch} style={{ background: c.colour }} />
              {c.name.length > 60 ? `${c.name.slice(0, 59)}…` : c.name} <span className={styles.muted}>({c.size})</span>
            </span>
          ))
      : types.map((type) => (
          <span key={type} className={styles.legendItem}>
            <span className={styles.swatch} style={{ background: colourOf(type) }} />
            {type} {counts?.[type] != null && <span className={styles.muted}>({counts[type]})</span>}
          </span>
        ))}
    <span className={styles.legendItem}>
      <span className={styles.swatch} style={{ background: '#7c3aed', height: 2 }} />
      {t('graph_judged_edge')}
    </span>
  </div>
);
