/**
 * Project › Overview: how the project is doing (the prototype's
 * `project-overview.tsx`, ADR-0068 §1 — the shell's, not a kit's). One read,
 * `GET /studio-organizations/v1/project-status`, the server's answer to what
 * the prototype computed from nine (`project-overview-model.ts`,
 * `project-path.ts`):
 *
 *   1. ONE verdict — On track, At risk or Blocked — its reason in a phrase,
 *      "+N more below", and ONE primary action: the next step of the path
 *      (Open IDE once the path is done).
 *   2. The path as a strip: each step's state, the current one outlined, its
 *      line on hover and, on click, below the strip with the button to the
 *      screen where it is done.
 *   3. Needs attention: the signals behind the verdict, worst first, one
 *      sentence and one action a row; what the server could not read is
 *      named ("Not read: …"), never counted as nothing wrong.
 *
 * Actions open other screens through the shell (`openScreen`). A tab this
 * portal does not have yet (the pull requests list) gets no
 * button rather than a dead one (`routeFor`). A 503 is the server saying
 * studio-mcp is down: shown as an error, not as an empty project.
 */

import React, { useState } from 'react';
import { apiRegistry, useApiQuery, useMfeBridge } from '@gears-frontx/react';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Skeleton } from '@gears-frontx/ui-kit';
import { errorMessage, openScreen, responseStatus } from '@constructor-studio/mfe-shared';
import { ProjectStatusApiService } from '../../../../api/ProjectStatusApiService';
import {
  LEVEL_TONE,
  VERDICT_VARIANT,
  nextStep,
  pathProgress,
  routeFor,
  type ProjectPathStep,
  type ProjectStatus,
} from '../../../../model/projectStatus';
import { useOverviewSectionTranslations } from '../../../../i18n';
import styles from './OverviewSection.module.css';
import { PhaseChip } from './PhaseChip';

type Text = ReturnType<typeof useOverviewSectionTranslations>['t'];

export const OverviewSection: React.FC<{ projectId: string }> = ({ projectId }) => {
  const { t, loading } = useOverviewSectionTranslations();
  const bridge = useMfeBridge();
  const read = useApiQuery(apiRegistry.getService(ProjectStatusApiService).status({ projectId }), { staleTime: 0 });
  const open = (route: string | null) => {
    if (route) openScreen(bridge, route);
  };

  if (loading || read.isLoading) {
    return (
      <div className={styles.section} aria-busy="true">
        <Skeleton className={styles.skeleton} />
        <Skeleton className={styles.skeletonWide} />
      </div>
    );
  }
  if (read.isError || !read.data) {
    const status = responseStatus(read.error);
    return (
      <div className={styles.section}>
        <p role="alert" className={styles.error} data-status-error={status ?? 'network'}>
          {status === 503
            ? t('status_unavailable', { error: errorMessage(read.error) })
            : status === 404
              ? t('status_not_found')
              : t('status_failed', { error: errorMessage(read.error) })}
        </p>
        <Button variant="outline" size="sm" onClick={() => void read.refetch()}>
          {t('try_again')}
        </Button>
      </div>
    );
  }
  return (
    <>
      {/* Project lifecycle's phase, only where the kit applies. */}
      <PhaseChip projectId={projectId} t={t} />
      <StatusView
        status={read.data}
        t={t}
        open={open}
        refreshing={read.isFetching}
        onRefresh={() => void read.refetch()}
      />
    </>
  );
};

OverviewSection.displayName = 'OverviewSection';

function StatusView({
  status,
  t,
  open,
  refreshing,
  onRefresh,
}: {
  status: ProjectStatus;
  t: Text;
  open: (route: string | null) => void;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const next = nextStep(status);
  const ide = routeFor('ide');
  return (
    <div className={styles.section} data-project-overview>
      <div className={styles.head}>
        <div className={styles.verdict}>
          <Badge variant={VERDICT_VARIANT[status.verdict] ?? 'secondary'} dot data-verdict={status.verdict}>
            {status.label}
          </Badge>
          {status.reason && (
            <span className={styles.reason} data-verdict-reason>
              {status.reason}
            </span>
          )}
          {status.more > 0 && <span className={styles.muted}>{t('more_below', { count: status.more })}</span>}
        </div>
        <div className={styles.actions}>
          {next && routeFor(next.tab, next.step) ? (
            <Button title={next.status} data-next-step={next.step} onClick={() => open(routeFor(next.tab, next.step))}>
              {next.action}
            </Button>
          ) : (
            <Button data-open-ide onClick={() => open(ide)}>
              {t('open_ide')}
            </Button>
          )}
          {next && routeFor(next.tab, next.step) && (
            <Button variant="outline" data-open-ide onClick={() => open(ide)}>
              {t('open_ide')}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={refreshing}
            title={t('refresh_title')}
            aria-label={t('refresh')}
            onClick={onRefresh}
          >
            {refreshing ? '…' : '↻'}
          </Button>
        </div>
      </div>
      <p className={styles.about}>{t('about')}</p>

      <PathStrip steps={status.path} t={t} open={open} />

      <Card data-project-needs>
        <CardHeader>
          <CardTitle className={styles.cardTitle}>
            {t('needs_title')}
            {status.signals.length > 0 && <span className={styles.count}>{status.signals.length}</span>}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {status.signals.length === 0 ? (
            <div className={styles.muted} data-needs-empty>
              <b>{t('nothing_waits')}</b> {status.unread.length === 0 && t('nothing_waits_body')}
            </div>
          ) : (
            <ul className={styles.list}>
              {status.signals.map((s) => {
                const route = routeFor(s.action.target, s.key);
                return (
                  <li
                    key={s.key}
                    className={`${styles.row} ${styles[LEVEL_TONE[s.level] ?? 'info']}`}
                    data-attention={s.key}
                    data-level={s.level}
                  >
                    <span className={styles.rowText}>
                      <b>{s.phrase}</b>
                      {s.detail && <span className={styles.muted}>{s.detail}</span>}
                    </span>
                    {route && (
                      <Button variant="outline" size="sm" onClick={() => open(route)}>
                        {s.action.label}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {status.unread.length > 0 && (
            <p className={styles.missing} data-no-answer title={t('not_read_title')}>
              {t('not_read', { sources: status.unread.join(', ') })}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** The path as one row of steps; a step's line and its button open below the strip. */
function PathStrip({
  steps,
  t,
  open,
}: {
  steps: ProjectPathStep[];
  t: Text;
  open: (route: string | null) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const progress = pathProgress(steps);
  const shown = steps.find((s) => s.step === picked) ?? null;
  return (
    <section className={styles.path} data-project-path aria-label={t('path_label')}>
      <div className={styles.pathHead}>
        <h3 className={styles.pathTitle} title={t('path_about')}>
          {t('path_title')}
        </h3>
        {steps.length > 0 && (
          <Badge variant={progress.done === progress.total ? 'success' : 'secondary'} data-path-progress>
            {t('path_progress', { done: progress.done, total: progress.total })}
          </Badge>
        )}
      </div>
      {steps.length === 0 ? (
        <p className={styles.muted}>{t('path_unknown')}</p>
      ) : (
        <ol className={styles.steps}>
          {steps.map((s, i) => (
            <li key={s.step} className={styles.stepItem}>
              <button
                type="button"
                className={`${styles.step} ${styles[`flow_${s.flow}`] ?? ''} ${picked === s.step ? styles.picked : ''}`}
                title={s.state === 'unknown' ? t('step_unknown', { status: s.status }) : s.status}
                aria-expanded={picked === s.step}
                data-path-step={s.step}
                data-state={s.state}
                data-flow={s.flow}
                onClick={() => setPicked((p) => (p === s.step ? null : s.step))}
              >
                <span className={styles.stepNo}>{s.state === 'done' ? '✓' : i + 1}</span>
                {s.title}
              </button>
            </li>
          ))}
        </ol>
      )}
      {shown && (
        <div className={styles.stepDetail} data-step-detail={shown.step}>
          <span>{shown.state === 'unknown' ? t('step_unknown', { status: shown.status }) : shown.status}</span>
          {routeFor(shown.tab, shown.step) && (
            <Button
              variant={shown.state === 'current' ? 'default' : 'outline'}
              size="sm"
              onClick={() => open(routeFor(shown.tab, shown.step))}
            >
              {shown.action}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
