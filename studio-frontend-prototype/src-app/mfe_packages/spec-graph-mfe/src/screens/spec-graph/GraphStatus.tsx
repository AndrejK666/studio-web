/**
 * The project's graph at a glance, above every view: how many nodes it holds,
 * the index run that built it (or the one going on, with its stage and count),
 * and the two runs a person starts from here: **Build graph** (an index run of
 * the structure, no model) and **Prepare model reviews** (the facts and
 * embeddings every review with the model reads, made once ahead of the first,
 * so a review then takes a minute rather than a quarter of an hour). A run
 * started elsewhere, or before a reload, is picked up and followed.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { apiRegistry } from '@gears-frontx/react';
import { Badge, Button } from '@gears-frontx/ui-kit';
import { refusalText } from '@constructor-studio/mfe-shared';
import { SpecGraphApiService } from '../../api/SpecGraphApiService';
import type { Run } from '../../api/types';
import { elapsed, ended, lastSucceeded, progressOf } from '../../model/runs';
import { useSpecGraphTranslations } from '../../i18n';
import styles from './SpecGraphScreen.module.css';

type Text = ReturnType<typeof useSpecGraphTranslations>['t'];
type Job = 'index' | 'prepare';

const message = (e: unknown) => refusalText(e) ?? (e instanceof Error ? e.message : String(e));

/** How a run reads: `facts 40/85 · 3:07`. */
export function runLine(r: Run, t: Text): string {
  const p = progressOf(r);
  const counter = p
    ? `${t(`stage_${p.stage}`)}${p.total ? ` ${p.done ?? 0}/${p.total}` : p.total === 0 ? ` ${t('stage_cached')}` : ''}`
    : t(`state_${r.state}`);
  const time = elapsed(r.started ?? r.created);
  return time ? `${counter} · ${time}` : counter;
}

export const GraphStatus: React.FC<{
  projectId: string;
  /** The node count of the project's graph; null while unknown. */
  nodes: number | null;
  /** A run of this bar ended: read the graph again. */
  onChanged: () => void;
  t: Text;
}> = ({ projectId, nodes, onChanged, t }) => {
  const api = apiRegistry.getService(SpecGraphApiService);
  const [runs, setRuns] = useState<Record<Job, Run[]>>({ index: [], prepare: [] });
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const fetchRuns = useCallback(async () => {
    const [index, prepare] = await Promise.all(
      (['index', 'prepare'] as const).map((job) =>
        api
          .runs({ projectId, job })
          .fetch({ staleTime: 0 })
          .then((r) => r.items)
          .catch(() => [] as Run[])
      )
    );
    return { index, prepare };
  }, [api, projectId]);
  const read = useCallback(async () => {
    const now = await fetchRuns();
    setRuns(now);
    return now;
  }, [fetchRuns]);

  useEffect(() => {
    let live = true;
    fetchRuns().then((now) => live && setRuns(now));
    return () => {
      live = false;
    };
  }, [fetchRuns]);

  // While a run goes on, read it every few seconds; when it ends, the graph changed.
  const going = [...runs.index, ...runs.prepare].find((r) => !ended(r));
  useEffect(() => {
    if (!going) return undefined;
    const id = window.setTimeout(() => {
      void read().then((now) => {
        const still = [...now.index, ...now.prepare].find((r) => r.id === going.id);
        if (still && ended(still)) onChanged();
        setTick((n) => n + 1);
      });
    }, 4000);
    return () => window.clearTimeout(id);
  }, [going, read, onChanged, tick]);

  const start = async (job: Job) => {
    setError(null);
    try {
      await api.startRun(projectId).fetch(job === 'index' ? { job, params: { facts: false } } : { job });
      await read();
    } catch (e) {
      setError(message(e));
    }
  };

  const built = lastSucceeded(runs.index);
  const prepared = lastSucceeded(runs.prepare);
  const indexing = runs.index.find((r) => !ended(r));
  const preparing = runs.prepare.find((r) => !ended(r));
  const failed = runs.index[0]?.state === 'failed' ? runs.index[0] : null;
  const prepareFailed = runs.prepare[0]?.state === 'failed' ? runs.prepare[0] : null;
  return (
    <div className={styles.status} aria-label={t('status_label')}>
      {nodes === null ? (
        <Badge variant="outline">{t('status_reading')}</Badge>
      ) : nodes === 0 ? (
        <Badge variant="warning">{t('status_empty')}</Badge>
      ) : (
        <Badge variant="secondary">{t('status_nodes', { count: nodes })}</Badge>
      )}
      {built?.revision && <span className={styles.muted}>{t('status_built', { revision: built.revision.slice(0, 12) })}</span>}
      {indexing ? (
        <span className={styles.muted}>{t('status_indexing', { line: runLine(indexing, t) })}</span>
      ) : (
        <Button size="sm" variant={nodes === 0 ? undefined : 'outline'} onClick={() => void start('index')}>
          {nodes ? t('status_rebuild') : t('status_build')}
        </Button>
      )}
      {failed && !indexing && <span className={styles.error}>{t('status_failed', { error: failed.error ?? '' })}</span>}
      {preparing ? (
        <span className={styles.muted}>{t('status_preparing', { line: runLine(preparing, t) })}</span>
      ) : prepared ? (
        <span className={styles.muted}>
          {t('status_prepared', { revision: (prepared.revision ?? '').slice(0, 12) })}{' '}
          <Button size="sm" variant="link" onClick={() => void start('prepare')}>
            {t('status_prepare_again')}
          </Button>
        </span>
      ) : (
        <Button size="sm" variant="outline" onClick={() => void start('prepare')} title={t('status_prepare_hint')}>
          {t('status_prepare')}
        </Button>
      )}
      {prepareFailed && !preparing && (
        <span className={styles.error}>{t('status_prepare_failed', { error: prepareFailed.error ?? '' })}</span>
      )}
      {error && <span className={styles.error}>{error}</span>}
    </div>
  );
};
