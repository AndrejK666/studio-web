/**
 * A picture of part of the spec graph, or all of it: nodes laid out by force
 * (`model/layout`), coloured and shaped by type so a type is never told by
 * colour alone, edges as lines (a judge's conclusion dashed). The wheel zooms,
 * dragging pans, a node's tooltip names it and its file, and choosing a node
 * opens it.
 */

import React, { useMemo, useRef, useState } from 'react';
import { Button } from '@gears-frontx/ui-kit';
import type { Picture, PictureNode } from '../../api/types';
import { label } from '../../model/graph';
import { layout } from '../../model/layout';
import { useSpecGraphTranslations } from '../../i18n';
import styles from './SpecGraphScreen.module.css';

type Text = ReturnType<typeof useSpecGraphTranslations>['t'];

/** A type's look: blue, amber, pink, purple and greys, each with its own shape. */
export const LOOK: Record<string, { shape: 'square' | 'circle' | 'diamond' | 'triangle' | 'dot'; colour: string }> = {
  document: { shape: 'square', colour: '#2563eb' },
  requirement: { shape: 'circle', colour: '#d97706' },
  design_element: { shape: 'diamond', colour: '#db2777' },
  decision: { shape: 'triangle', colour: '#7c3aed' },
  section: { shape: 'dot', colour: '#94a3b8' },
};
const OTHER = { shape: 'circle' as const, colour: '#64748b' };
export const lookOf = (type: string) => LOOK[type] ?? OTHER;

const VIEW_H = 560;

function Shape({ type, r }: { type: string; r: number }) {
  const { shape, colour } = lookOf(type);
  if (shape === 'square') return <rect x={-r} y={-r} width={r * 2} height={r * 2} rx={2} fill={colour} />;
  if (shape === 'diamond') return <polygon points={`0,${-r * 1.2} ${r * 1.2},0 0,${r * 1.2} ${-r * 1.2},0`} fill={colour} />;
  if (shape === 'triangle') return <polygon points={`0,${-r * 1.2} ${r * 1.1},${r * 0.9} ${-r * 1.1},${r * 0.9}`} fill={colour} />;
  if (shape === 'dot') return <circle r={r * 0.6} fill={colour} />;
  return <circle r={r} fill={colour} />;
}

const tip = (n: PictureNode) =>
  [n.name ?? label(n.key), n.type, n.path ? `${n.path}${n.line ? `:${n.line}` : ''}` : null, n.key].filter(Boolean).join('\n');

export const GraphPicture: React.FC<{
  picture: Picture;
  centre?: string;
  onOpen: (key: string) => void;
  t: Text;
}> = ({ picture, centre, onOpen, t }) => {
  const laid = useMemo(() => layout(picture.nodes, picture.edges, { centre }), [picture, centre]);
  const fit = useMemo(() => {
    const w = Math.max(laid.width, 200);
    const h = Math.max(laid.height, 200);
    return { x: 0, y: 0, w, h };
  }, [laid]);
  const [box, setBox] = useState(fit);
  const [lastFit, setLastFit] = useState(fit);
  if (lastFit !== fit) {
    setLastFit(fit);
    setBox(fit);
  }
  const drag = useRef<{ x: number; y: number; box: typeof box } | null>(null);
  const svg = useRef<SVGSVGElement | null>(null);
  const zoom = fit.w / box.w;
  const count = picture.nodes.length;
  const many = count > 80;
  // sizes in the layout's units, which the picture shows about 1:1 when it fits
  const r = count > 300 ? 6 : many ? 8 : 10;
  const showLabel = (n: PictureNode) =>
    n.key === centre ||
    !many ||
    zoom > 2.2 ||
    (zoom > 1.2 && n.type !== 'section') ||
    (count <= 60 && (laid.hops.get(n.key) ?? 9) <= 1) ||
    (count > 60 && n.type === 'document');

  const scaleBy = (k: number, cx = box.x + box.w / 2, cy = box.y + box.h / 2) => {
    const w = Math.min(fit.w * 2, Math.max(fit.w / 20, box.w / k));
    const h = (w / box.w) * box.h;
    setBox({ x: cx - ((cx - box.x) * w) / box.w, y: cy - ((cy - box.y) * h) / box.h, w, h });
  };
  const toWorld = (e: { clientX: number; clientY: number }) => {
    const rect = svg.current?.getBoundingClientRect();
    if (!rect || !rect.width) return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    return { x: box.x + ((e.clientX - rect.left) / rect.width) * box.w, y: box.y + ((e.clientY - rect.top) / rect.height) * box.h };
  };

  const types = [...new Set(picture.nodes.map((n) => n.type))].sort();
  return (
    <div className={styles.picture}>
      <div className={styles.chips}>
        <Button size="sm" variant="outline" onClick={() => scaleBy(1.5)} aria-label={t('graph_zoom_in')}>
          +
        </Button>
        <Button size="sm" variant="outline" onClick={() => scaleBy(1 / 1.5)} aria-label={t('graph_zoom_out')}>
          −
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setBox(fit)}>
          {t('graph_fit')}
        </Button>
        <span className={styles.muted}>
          {t('graph_size', { nodes: picture.nodes.length, edges: picture.edges.length })}
        </span>
      </div>
      <svg
        ref={svg}
        className={styles.pictureSvg}
        viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
        preserveAspectRatio="xMidYMid meet"
        height={VIEW_H}
        role="img"
        aria-label={t('graph_map')}
        onWheel={(e) => {
          const p = toWorld(e);
          scaleBy(e.deltaY < 0 ? 1.2 : 1 / 1.2, p.x, p.y);
        }}
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, y: e.clientY, box };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          const rect = svg.current?.getBoundingClientRect();
          if (!d || !rect?.width) return;
          const k = d.box.w / rect.width;
          setBox({ ...d.box, x: d.box.x - (e.clientX - d.x) * k, y: d.box.y - (e.clientY - d.y) * k });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerLeave={() => {
          drag.current = null;
        }}
      >
        <g>
          {picture.edges.map((e, i) => {
            const a = laid.at.get(e.from);
            const b = laid.at.get(e.to);
            if (!a || !b) return null;
            return (
              <line
                key={`${e.from}|${e.type}|${e.to}|${i}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                className={e.kind === 'analysis' ? styles.graphJudged : styles.pictureEdge}
              >
                <title>{e.type}</title>
              </line>
            );
          })}
        </g>
        <g>
          {picture.nodes.map((n) => {
            const p = laid.at.get(n.key);
            if (!p) return null;
            const isCentre = n.key === centre;
            return (
              <g
                key={n.key}
                transform={`translate(${p.x},${p.y})`}
                className={styles.pictureNode}
                data-centre={isCentre || undefined}
                role="button"
                tabIndex={0}
                aria-label={n.name ?? label(n.key)}
                onClick={() => onOpen(n.key)}
                onKeyDown={(e) => e.key === 'Enter' && onOpen(n.key)}
              >
                <title>{tip(n)}</title>
                {isCentre && <circle r={r * 2.2} className={styles.pictureHalo} />}
                <Shape type={n.type} r={isCentre ? r * 1.4 : r} />
                {showLabel(n) && (
                  <text x={r + 4} y={4} className={styles.pictureLabel}>
                    {(n.name ?? label(n.key)).slice(0, 40)}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      <div className={styles.legend}>
        {types.map((type) => (
          <span key={type} className={styles.legendItem}>
            <svg width={16} height={16} viewBox="-8 -8 16 16" aria-hidden>
              <Shape type={type} r={5} />
            </svg>
            {type} {picture.counts?.[type] != null && <span className={styles.muted}>({picture.counts[type]})</span>}
          </span>
        ))}
        <span className={styles.legendItem}>
          <svg width={28} height={8} aria-hidden>
            <line x1={0} y1={4} x2={28} y2={4} className={styles.graphJudged} />
          </svg>
          {t('graph_judged_edge')}
        </span>
      </div>
    </div>
  );
};
