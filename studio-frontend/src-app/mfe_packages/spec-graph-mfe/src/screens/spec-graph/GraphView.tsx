/**
 * Project › Spec graph › Graph: the project's spec graph around one node, drawn
 * as the Studio domain model's relations are (admin-mfe `DomainModelRelations`):
 * the node in the middle, what points at it on the left, what it points at on
 * the right, a judge's conclusion as a dashed line. Choosing a neighbour
 * centres on it; Back walks the way taken. A node is found by search, or opened
 * from a finding ("Show in graph"). Below the map: the node's own passage, and
 * each judge's conclusion with its quote and provenance.
 */

import React, { useEffect, useState } from 'react';
import { apiRegistry } from '@gears-frontx/react';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Skeleton } from '@gears-frontx/ui-kit';
import { SpecGraphApiService } from '../../api/SpecGraphApiService';
import type { GraphNode, Neighbors, SearchHit } from '../../api/types';
import { kindOf, label, side, type Side } from '../../model/graph';
import { useSpecGraphTranslations } from '../../i18n';
import styles from './SpecGraphScreen.module.css';
import { refusalText } from '@constructor-studio/mfe-shared';

type Text = ReturnType<typeof useSpecGraphTranslations>['t'];

// The gear's own sentence (a 503 names what to configure), not the transport's status line.
const message = (e: unknown) => refusalText(e) ?? (e instanceof Error ? e.message : String(e));
const fit = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const ROW = 34;
const WIDTH = 1040;
const BOX_W = 300;
const CENTER_W = 300;

interface Centred {
  key: string;
  node: GraphNode | null;
  neighbors: Neighbors;
}

export const GraphView: React.FC<{ projectId: string; start: string | null; t: Text }> = ({ projectId, start, t }) => {
  const api = apiRegistry.getService(SpecGraphApiService);
  const [trail, setTrail] = useState<string[]>(start ? [start] : []);
  const [centred, setCentred] = useState<Centred | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = trail.length ? trail[trail.length - 1] : null;

  useEffect(() => {
    if (!current) return undefined;
    let live = true;
    Promise.all([
      api
        .node({ projectId, key: current })
        .fetch({ staleTime: 0 })
        .then((r) => r.answer)
        .catch(() => null),
      api.neighbors({ projectId, key: current }).fetch({ staleTime: 0 }),
    ])
      .then(([node, n]) => {
        if (!live) return;
        setCentred({ key: current, node, neighbors: n.answer });
        setError(null);
      })
      .catch((e: unknown) => live && setError(message(e)));
    return () => {
      live = false;
    };
  }, [api, projectId, current]);

  const open = (key: string) => setTrail((tr) => (tr[tr.length - 1] === key ? tr : [...tr, key]));
  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    try {
      const r = await api.search(projectId).fetch({ query: query.trim(), limit: 10 });
      setHits(Array.isArray(r.answer) ? r.answer : (r.answer.hits ?? []));
      setError(null);
    } catch (err) {
      setError(message(err));
    }
  };

  const shown = centred && centred.key === current ? centred : null;
  return (
    <>
      <form className={styles.setup} onSubmit={(e) => void search(e)}>
        <label className={styles.baseField}>
          {t('graph_search')}
          <input className={styles.input} value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <Button type="submit" variant="outline" disabled={!query.trim()}>
          {t('graph_find')}
        </Button>
        {trail.length > 1 && (
          <Button type="button" variant="ghost" onClick={() => setTrail((tr) => tr.slice(0, -1))}>
            {t('graph_back')}
          </Button>
        )}
      </form>
      {hits && (
        <div className={styles.hits}>
          {hits.length === 0 && <span className={styles.muted}>{t('nothing')}</span>}
          {hits.map((h) => (
            <button key={h.key} type="button" className={styles.hit} onClick={() => open(h.key)} title={h.key}>
              <code>{label(h.key)}</code>
              {h.name && <span>{h.name}</span>}
            </button>
          ))}
        </div>
      )}
      {error && <p className={styles.error}>{error}</p>}
      {!current && <p className={styles.muted}>{t('graph_hint')}</p>}
      {current && !shown && !error && <Skeleton className={styles.skeleton} />}
      {shown && <GraphMap centred={shown} onOpen={open} t={t} />}
    </>
  );
};

const GraphMap: React.FC<{ centred: Centred; onOpen: (key: string) => void; t: Text }> = ({ centred, onOpen, t }) => {
  const { key, node, neighbors } = centred;
  const left = side(neighbors.in ?? {}, neighbors.judged.filter((j) => j.from && j.from !== key), 'in');
  const right = side(neighbors.out ?? {}, neighbors.judged.filter((j) => j.to && j.to !== key), 'out');
  const rows = Math.max(left.shown.length + (left.more ? 1 : 0), right.shown.length + (right.more ? 1 : 0), 1);
  const height = rows * ROW + 40;
  const cy = height / 2;
  const cx = WIDTH / 2;
  const yOf = (i: number, n: number) => cy - ((n - 1) * ROW) / 2 + i * ROW;
  const p = node?.payload ?? {};
  const where = p.path ? `${p.path}${p.line ? `:${p.line}` : ''}` : null;

  const row = (s: Side, i: number, n: number, x: number, anchorX: number) => {
    const y = yOf(i, n);
    return (
      <g
        key={`${s.edge}|${s.key}`}
        className={styles.graphNode}
        data-kind={kindOf(s.key)}
        onClick={() => onOpen(s.key)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && onOpen(s.key)}
      >
        <title>{`${s.edge}: ${s.key}`}</title>
        <line
          x1={anchorX}
          y1={y}
          x2={x < cx ? cx - CENTER_W / 2 : cx + CENTER_W / 2}
          y2={cy}
          className={s.judged ? styles.graphJudged : styles.graphEdge}
        />
        <rect x={x} y={y - 13} width={BOX_W} height={26} rx={6} />
        <text x={x + 8} y={y + 4}>
          {fit(label(s.key), 28)}
        </text>
        {/* the edge's type inside the box, so it never crosses a line */}
        <text x={x + BOX_W - 6} y={y + 4} className={styles.graphEdgeLabel} textAnchor="end">
          {fit(s.edge, 18)}
        </text>
      </g>
    );
  };

  return (
    <Card className={styles.document}>
      <CardHeader>
        <CardTitle className={styles.path} title={key}>
          {node?.name ?? label(key)}
        </CardTitle>
      </CardHeader>
      <CardContent className={styles.list}>
        <div className={styles.chips}>
          <Badge variant="outline">{kindOf(key)}</Badge>
          {p.kind && <Badge variant="secondary">{p.kind}</Badge>}
          {where && <code>{where}</code>}
          {neighbors.truncated && <Badge variant="warning">{t('graph_truncated')}</Badge>}
        </div>
        <div className={styles.graphScroll}>
          <svg
            className={styles.graph}
            viewBox={`0 0 ${WIDTH} ${height}`}
            width={WIDTH}
            height={height}
            role="img"
            aria-label={t('graph_map')}
          >
            {left.shown.map((s, i, a) => row(s, i, a.length + (left.more ? 1 : 0), 10, 10 + BOX_W))}
            {left.more > 0 && (
              <text x={18} y={yOf(left.shown.length, left.shown.length + 1) + 4} className={styles.graphEdgeLabel}>
                {t('graph_more', { count: left.more })}
              </text>
            )}
            {right.shown.map((s, i, a) => row(s, i, a.length + (right.more ? 1 : 0), WIDTH - 10 - BOX_W, WIDTH - 10 - BOX_W))}
            {right.more > 0 && (
              <text x={WIDTH - BOX_W} y={yOf(right.shown.length, right.shown.length + 1) + 4} className={styles.graphEdgeLabel}>
                {t('graph_more', { count: right.more })}
              </text>
            )}
            <g className={styles.graphCenter}>
              <rect x={cx - CENTER_W / 2} y={cy - 20} width={CENTER_W} height={40} rx={8} />
              <text x={cx} y={cy + 5} textAnchor="middle">
                {label(key)}
              </text>
            </g>
          </svg>
        </div>
        <p className={styles.muted}>{t('graph_legend')}</p>
        {(p.quote || p.text) && <pre className={styles.thread}>{p.text ?? p.quote}</pre>}
        {neighbors.judged.length > 0 && (
          <>
            <strong>{t('graph_judged')}</strong>
            <ul className={styles.related}>
              {neighbors.judged.map((j, i) => (
                <li key={`${j.edge}|${j.from ?? ''}|${j.to ?? ''}|${i}`}>
                  <code>{j.edge}</code> {label(j.from ?? key)} → {label(j.to ?? key)}
                  {(j.realized || j.built) && <Badge variant="info">{j.realized ?? j.built}</Badge>}
                  {j.quote && (
                    <span className={styles.quote}>
                      {' '}— {j.path ? `${j.path}${j.lines ? `:${j.lines}` : ''} ` : ''}«{j.quote}»
                    </span>
                  )}
                  {j.by?.model && <span className={styles.rule}> · {j.by.model}</span>}
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
};
