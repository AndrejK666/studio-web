/**
 * The project's graph at a glance, above every view: how many nodes it holds,
 * the index run that built it (or the one going on, with its stage and count),
 * and the runs a person starts from here: **Build graph** (an index run: the
 * structure and every deterministic finding, no model; optionally the facts a
 * model extracts, and then a contradictions run over the whole corpus, whose
 * confirmed conflicts are stored as findings) and **Prepare model reviews** (the facts and
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
type Job = 'index' | 'prepare' | 'contradictions';
const JOBS: Job[] = ['index', 'prepare', 'contradictions'];

/** What Build graph runs beyond the structure: the model's facts, then the contradictions judge over them. */
export interface BuildOptions {
  facts: boolean;
  contradictions: boolean;
}

/**
 * Start Build graph: an index run (the structure and the deterministic findings; with `facts`, the
 * model's facts too), then, with `contradictions`, a contradictions run, which reads those facts.
 * The service runs one job of a project at a time, so the second waits for the first.
 */
export async function startBuild(api: SpecGraphApiService, projectId: string, o: BuildOptions): Promise<void> {
  const facts = o.facts || o.contradictions;
  await api.startRun(projectId).fetch({ job: 'index', params: { facts, findings: true } });
  if (o.contradictions) await api.startRun(projectId).fetch({ job: 'contradictions' });
}

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
  const [runs, setRuns] = useState<Record<Job, Run[]>>({ index: [], prepare: [], contradictions: [] });
  const [build, setBuild] = useState<BuildOptions>({ facts: false, contradictions: false });
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const fetchRuns = useCallback(async () => {
    const [index, prepare, contradictions] = await Promise.all(
      JOBS.map((job) =>
        api
          .runs({ projectId, job })
          .fetch({ staleTime: 0 })
          .then((r) => r.items)
          .catch(() => [] as Run[]),
      ),
    );
    return { index, prepare, contradictions };
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
  const going = [...runs.index, ...runs.prepare, ...runs.contradictions].find((r) => !ended(r));
  useEffect(() => {
    if (!going) return undefined;
    const id = window.setTimeout(() => {
      void read().then((now) => {
        const still = [...now.index, ...now.prepare, ...now.contradictions].find((r) => r.id === going.id);
        if (still && ended(still)) onChanged();
        setTick((n) => n + 1);
      });
    }, 4000);
    return () => window.clearTimeout(id);
  }, [going, read, onChanged, tick]);

  const start = async (job: 'index' | 'prepare') => {
    setError(null);
    try {
      if (job === 'index') await startBuild(api, projectId, build);
      else await api.startRun(projectId).fetch({ job });
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
  const judging = runs.contradictions.find((r) => !ended(r));
  const judged = lastSucceeded(runs.contradictions);
  const judgeFailed = runs.contradictions[0]?.state === 'failed' ? runs.contradictions[0] : null;
  return (
    <div className={styles.status} aria-label={t('status_label')}>
      {nodes === null ? (
        <Badge variant="outline">{t('status_reading')}</Badge>
      ) : nodes === 0 ? (
        <Badge variant="warning">{t('status_empty')}</Badge>
      ) : (
        <Badge variant="secondary">{t('status_nodes', { count: nodes })}</Badge>
      )}
      {built?.revision && (
        <span className={styles.muted}>{t('status_built', { revision: built.revision.slice(0, 12) })}</span>
      )}
      {indexing ? (
        <span className={styles.muted}>{t('status_indexing', { line: runLine(indexing, t) })}</span>
      ) : (
        <>
          <Button size="sm" variant={nodes === 0 ? undefined : 'outline'} onClick={() => void start('index')}>
            {nodes ? t('status_rebuild') : t('status_build')}
          </Button>
          <BuildChoice value={build} onChange={setBuild} t={t} />
        </>
      )}
      {judging && <span className={styles.muted}>{t('status_judging', { line: runLine(judging, t) })}</span>}
      {!judging && judged && (
        <span className={styles.muted}>
          {t('status_judged', { count: judged.result?.confirmed ?? 0, revision: (judged.revision ?? '').slice(0, 12) })}
        </span>
      )}
      {judgeFailed && !judging && (
        <span className={styles.error}>{t('status_judge_failed', { error: judgeFailed.error ?? '' })}</span>
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

/** The model's parts of Build graph: off by default, each with its cost said. */
export const BuildChoice: React.FC<{ value: BuildOptions; onChange: (v: BuildOptions) => void; t: Text }> = ({
  value,
  onChange,
  t,
}) => (
  <>
    <label className={styles.radio} title={t('build_facts_hint')}>
      <input
        type="checkbox"
        checked={value.facts || value.contradictions}
        disabled={value.contradictions}
        onChange={(e) => onChange({ ...value, facts: e.target.checked })}
      />
      {t('build_facts')}
    </label>
    <label className={styles.radio} title={t('build_contradictions_hint')}>
      <input
        type="checkbox"
        checked={value.contradictions}
        onChange={(e) => onChange({ ...value, contradictions: e.target.checked })}
      />
      {t('build_contradictions')}
    </label>
  </>
);
