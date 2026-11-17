/**
 * Organization › Background work — the prototype's tasks.tsx carried over
 * (ADR-0069 parity): the runs `studio-tasks` keeps and the schedules
 * `studio-scheduler` fires.
 *
 * Two lists, because they answer different questions. **Runs** is "what has
 * this deployment been doing, and what went wrong". **Schedules** is "what
 * fires on its own", with the one control a person needs: run it now. The
 * runs open on what failed and what is running; a scheduled task's succeeded
 * runs fold into one row. Both lists are on the kit's DataGrid
 * (`BackgroundGrids`, #1076).
 *
 * `studio-tasks` announces every run transition on `studio-events`, and the
 * shell relays its one subscription to this screen: the list reads itself
 * again when a run moves. The poll stays as a floor while a run on screen is
 * still moving — it covers a deployment without the channel, as in the
 * prototype.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiRegistry, useSharedProperty, FRONTX_SHARED_PROPERTY_LANGUAGE } from '@gears-frontx/react';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@gears-frontx/ui-kit';
import { isRunEvent, useOrganization, usePollWhileVisible, useStudioEventRefresh } from '@constructor-studio/mfe-shared';
import { GridFailed } from '@constructor-studio/mfe-shared/grid';
import { BackgroundApiService, scheduleOf } from '../../api/BackgroundApiService';
import { ATTENTION_STATES, EVERY_STATE, STATES, foldRecurring, mergePages, type ShownRun } from '../../background/model';
import type { TaskRun, TaskSchedule } from '../../background/types';
import { useBackgroundTranslations } from '../../i18n';
import { RunDetails, RunsGrid, SchedulesGrid, type RunQuery } from './BackgroundGrids';
import styles from './BackgroundScreen.module.css';

const PAGE = 50;
const LIVE_POLL_MS = 4000;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Page {
  at: number;
  items: ShownRun[];
  total: number;
}

export const BackgroundScreen: React.FC = () => {
  const { t, loading } = useBackgroundTranslations();
  const published = useSharedProperty(FRONTX_SHARED_PROPERTY_LANGUAGE);
  const language = typeof published === 'string' && published ? published : 'en';
  const api = apiRegistry.getService(BackgroundApiService);
  // The organization in view: its runs and schedules only, never the deployment's (walk 2026-11-16).
  const organizationId = useOrganization().org?.id ?? null;

  const [state, setState] = useState<string | null>(null);
  const [taskType, setTaskType] = useState<string>('');
  const [limit, setLimit] = useState(PAGE);
  const [tick, setTick] = useState(0);
  const [page, setPage] = useState<Page | null>(null);
  /** The runs did not load: the grid gives way to a retry. */
  const [loadError, setLoadError] = useState<string | null>(null);
  /** A retry, a cancel or a run-now did not work. */
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [counts, setCounts] = useState<Partial<Record<string, number>>>({});
  const [types, setTypes] = useState<string[]>([]);
  const [schedules, setSchedules] = useState<TaskSchedule[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const refresh = useCallback(() => setTick((n) => n + 1), []);
  const recurring = useMemo(() => new Set((schedules ?? []).map((sc) => sc.task_type)), [schedules]);

  useEffect(() => {
    let alive = true;
    api.taskTypes.fetch().then(
      (r) => alive && setTypes(r.items),
      () => alive && setTypes([])
    );
    return () => {
      alive = false;
    };
  }, [api]);

  // The scheduler is optional: its absence is an empty list, not an error.
  useEffect(() => {
    let alive = true;
    api.schedules.fetch({ staleTime: 0 }).then(
      (r) => alive && setSchedules(organizationId ? r.items.filter((sc) => scheduleOf(sc, organizationId)) : []),
      () => alive && setSchedules([])
    );
    return () => {
      alive = false;
    };
  }, [api, tick, organizationId]);

  useEffect(() => {
    let alive = true;
    if (!organizationId) return;
    void Promise.all(
      STATES.map((st) =>
        api
          .runs({ organizationId, state: st, limit: 1 })
          .fetch({ staleTime: 0 })
          .then(
            (r) => [st, r.total ?? r.items.length] as const,
            () => null
          )
      )
    ).then((pairs) => {
      if (!alive) return;
      const next: Partial<Record<string, number>> = {};
      for (const pair of pairs) if (pair) next[pair[0]] = pair[1];
      setCounts(next);
    });
    return () => {
      alive = false;
    };
  }, [api, tick, organizationId]);

  useEffect(() => {
    let alive = true;
    if (!organizationId) return;
    const read = async (): Promise<Page> => {
      const typeFilter = taskType || undefined;
      if (!state) {
        // The default: failed and running together. The backend narrows by one
        // state, so it is asked once per state and the pages merged.
        const pages = await Promise.all(
          ATTENTION_STATES.map((st) => api.runs({ organizationId, state: st, taskType: typeFilter, limit }).fetch({ staleTime: 0 }))
        );
        return {
          at: Date.now(),
          items: mergePages(
            pages.map((p) => p.items),
            0,
            limit
          ),
          total: pages.reduce((n, p) => n + (p.total ?? p.items.length), 0),
        };
      }
      const r = await api
        .runs({ organizationId, state: state === EVERY_STATE ? undefined : state, taskType: typeFilter, limit })
        .fetch({ staleTime: 0 });
      return { at: Date.now(), items: foldRecurring(r.items, recurring), total: r.total ?? r.items.length };
    };
    read().then(
      (p) => {
        if (!alive) return;
        setPage(p);
        setLoadError(null);
        setUnavailable(false);
      },
      (e: unknown) => {
        if (!alive) return;
        const text = message(e);
        // 503: studio-tasks has no database here — a configuration fact.
        if (text.includes('not available in this deployment') || text.includes('503')) setUnavailable(true);
        else setLoadError(text);
      }
    );
    return () => {
      alive = false;
    };
  }, [api, state, taskType, limit, recurring, tick, organizationId]);

  useStudioEventRefresh(isRunEvent, refresh);

  const live = !!page?.items.some((r) => r.state === 'queued' || r.state === 'running');
  // Not while the tab is hidden: shown again, it reads at once.
  usePollWhileVisible(refresh, LIVE_POLL_MS, live);

  const onAct = useCallback(
    (run: TaskRun, what: 'cancel' | 'retry') => {
      if (what === 'cancel' && !window.confirm(t('cancel_confirm', { task: run.task_type, id: run.id.slice(0, 8) })))
        return;
      void (what === 'cancel' ? api.cancel(run.id, run.tenant_id) : api.retry(run.id, run.tenant_id))
        .fetch(undefined)
        .catch((e: unknown) => setError(t('action_failed', { error: message(e) })))
        .finally(refresh);
    },
    [api, t, refresh]
  );

  const onRunNow = useCallback(
    (sc: TaskSchedule) => {
      void api
        .runNow(sc.id)
        .fetch(undefined)
        .catch((e: unknown) => setError(t('action_failed', { error: message(e) })))
        .finally(refresh);
    },
    [api, t, refresh]
  );

  // The grid's state and type filters are the server's question: a new one reads the runs again.
  const onQuery = useCallback((query: RunQuery) => {
    setState(query.state);
    setTaskType(query.taskType);
  }, []);
  const cadenceOf = useCallback(
    (type: string) => schedules?.find((sc) => sc.task_type === type)?.expression,
    [schedules]
  );
  const onOpen = useCallback((run: ShownRun) => setOpen((was) => (was === run.id ? null : run.id)), []);

  if (loading) return null;

  const opened = open ? page?.items.find((run) => run.id === open) : undefined;

  return (
    <div className={styles.screen} data-background-work>
      <header className={styles.header}>
        <h2 className={styles.title} title={t('about')}>
          {t('title')}
        </h2>
        <div className={styles.chips}>
          {(counts.running ?? 0) > 0 && <Badge variant="info">{t('count_running', { count: counts.running ?? 0 })}</Badge>}
          {(counts.queued ?? 0) > 0 && (
            <Badge variant="secondary">{t('count_queued', { count: counts.queued ?? 0 })}</Badge>
          )}
          {(counts.failed ?? 0) > 0 && <Badge variant="danger">{t('count_failed', { count: counts.failed ?? 0 })}</Badge>}
          {counts.running === 0 && counts.failed === 0 && <Badge variant="success">{t('all_quiet')}</Badge>}
          {schedules && schedules.length > 0 && (
            <span className={styles.muted}>· {t('schedules_count', { count: schedules.length })}</span>
          )}
        </div>
      </header>
      <p className={styles.about}>{t('about')}</p>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {unavailable && <p className={styles.muted}>{t('unavailable')}</p>}

      <Card data-background-runs>
        <CardHeader>
          <CardTitle>{t('runs')}</CardTitle>
        </CardHeader>
        <CardContent className={styles.body}>
          <div className={styles.filters}>
            {state === null && <span className={styles.muted}>{t('showing_attention')}</span>}
            {live && <span className={styles.muted}>{t('live')}</span>}
          </div>
          {loadError ? (
            <GridFailed message={t('load_failed', { error: loadError })} retry={t('try_again')} onRetry={refresh} />
          ) : (
            page && (
              <RunsGrid
                rows={page.items}
                t={t}
                language={language}
                now={page.at}
                counts={counts}
                types={types}
                cadenceOf={cadenceOf}
                onAct={onAct}
                onQuery={onQuery}
                onOpen={onOpen}
              />
            )
          )}
          {page && page.total > page.items.length && page.items.length >= limit && (
            <Button variant="ghost" size="sm" onClick={() => setLimit((n) => n + PAGE)}>
              {t('more')}
            </Button>
          )}
          {/* A run's details open under the list, not under its row. */}
          {opened && <RunDetails run={opened} t={t} language={language} />}
        </CardContent>
      </Card>

      <Card data-background-schedules>
        <CardHeader>
          <CardTitle>{t('schedules')}</CardTitle>
        </CardHeader>
        <CardContent>
          {schedules && <SchedulesGrid schedules={schedules} t={t} language={language} runNow={onRunNow} />}
        </CardContent>
      </Card>
    </div>
  );
};

BackgroundScreen.displayName = 'BackgroundScreen';
