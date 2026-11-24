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
 *   2. The project's ONE path, sources to running product, as the shared
 *      `ProjectPath` draws it on Product and Releases too: the server's
 *      `stages`; from a server (or a kept status) without them, the old
 *      `path` and studio-environments' `GET /project-path` said as stages.
 *   3. Needs attention: the signals behind the verdict, worst first, one
 *      sentence and one action a row; what the server could not read is
 *      named ("Not read: …"), never counted as nothing wrong.
 *
 * Actions open other screens through the shell (`openScreen`). A tab this
 * portal does not have yet (the pull requests list) gets no
 * button rather than a dead one (`routeFor`), and neither does a kit's tab
 * where that kit is not installed for the project (`useScreenAvailability`:
 * Specs, Activity, the Project domain model, Issues, Product, Releases are
 * kits' screens). The status is read again when a background run ends
 * (studio-events). A 503 is the server saying
 * studio-mcp is down: shown as an error, not as an empty project.
 */

import React, { useEffect, useState } from 'react';
import { apiRegistry, useApiQuery, useMfeBridge } from '@gears-frontx/react';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Skeleton } from '@gears-frontx/ui-kit';
import {
  DerivedViewStrip,
  errorMessage,
  isRunEnding,
  KitContentSlot,
  openScreen,
  responseStatus,
  useScreenAvailability,
  useStudioEventRefresh,
} from '@constructor-studio/mfe-shared';
import {
  ProjectPath,
  joinStages,
  stagesFromDelivery,
  stagesFromStatus,
  stagesOf,
  type PathStage,
} from '@constructor-studio/mfe-shared/path';
import { ProjectDeliveryApiService, ProjectStatusApiService } from '../../../../api/ProjectStatusApiService';
import { LEVEL_TONE, VERDICT_VARIANT, nextStep, routeFor, type ProjectStatus } from '../../../../model/projectStatus';
import { useOverviewSectionTranslations } from '../../../../i18n';
import styles from './OverviewSection.module.css';
import { PhaseChip } from './PhaseChip';
import { NextSteps } from './NextSteps';

type Text = ReturnType<typeof useOverviewSectionTranslations>['t'];

/**
 * How long a project's status is shown without asking again. It was read on
 * every tab click and window refocus (`staleTime: 0`), each a read of every
 * gear behind it (studio-web#1077).
 */
const STATUS_FRESH_MS = 60_000;

/** The route an action opens here, or null: not in this portal, or its kit not installed. */
type Reach = (target: string, key?: string, kit?: string | null) => string | null;

export const OverviewSection: React.FC<{
  projectId: string;
  /** The organization on screen: whose domain model a next step's `field:` is read from. */
  orgId?: string | null;
}> = ({ projectId, orgId = null }) => {
  const { t, loading } = useOverviewSectionTranslations();
  const bridge = useMfeBridge();
  const availability = useScreenAvailability();
  // The server names the kit each signal and step belongs to and leaves out
  // those of kits not installed (ADR-0070 §7); the shell's answer is asked
  // too, so a kit removed since the read offers no dead button.
  const reach: Reach = (target, key, kit) => {
    const route = routeFor(target, key);
    return route && availability.route(route) && availability.kit(kit) ? route : null;
  };
  // Kept a minute per project: the server reads every gear behind it, and a
  // tab click or a window refocus within that minute shows the answer it
  // has. What moves the status on — a run ending, the Refresh button — reads
  // it again at once.
  const read = useApiQuery(apiRegistry.getService(ProjectStatusApiService).status({ projectId }), {
    staleTime: STATUS_FRESH_MS,
  });
  // A run that ended — a sync, a build, a deploy — may have moved the verdict
  // or the path: read the status again (the shell's live channel, scoped to
  // the organization on screen), keeping the old answer on screen meanwhile.
  useStudioEventRefresh(isRunEnding, () => void read.refetch());
  // The path's stages are the server's. A status without them (a server
  // before them, or one kept before them and not yet computed again) says
  // its own steps 1-6, and studio-environments says 5-9.
  const serverStages = stagesOf(read.data?.stages);
  const olderStatus = !!read.data && !serverStages;
  const [delivery, setDelivery] = useState<PathStage[] | null>(null);
  useEffect(() => {
    if (!olderStatus) return;
    let live = true;
    apiRegistry
      .getService(ProjectDeliveryApiService)
      .path({ projectId })
      .fetch({ staleTime: STATUS_FRESH_MS })
      .then(
        (p) => live && setDelivery(stagesOf(p.stages) ?? stagesFromDelivery(p.steps)),
        () => live && setDelivery([])
      );
    return () => {
      live = false;
    };
  }, [olderStatus, projectId]);
  const stages = serverStages ?? joinStages(stagesFromStatus(read.data?.path), delivery ?? []);
  const open = (route: string | null) => {
    if (route) openScreen(bridge, route);
  };
  /** ↻: compute the status now, then show it. */
  const [recomputing, setRecomputing] = useState(false);
  const recompute = () => {
    setRecomputing(true);
    apiRegistry
      .getService(ProjectStatusApiService)
      .freshStatus({ projectId })
      .fetch({ staleTime: 0 })
      .catch(() => undefined)
      .finally(() => {
        setRecomputing(false);
        void read.refetch();
      });
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
      {read.data.computed_at && (
        <p className={styles.muted} data-status-computed>
          <DerivedViewStrip
            view={{ status: recomputing ? 'computing' : 'ready', computed_at: read.data.computed_at, inputs: [] }}
            onRefresh={recompute}
            labels={{
              byCommit: (commits) => commits,
              computed: (ago) => t('status_computed', { ago }),
              computing: t('status_computing'),
              failed: (why) => why,
              never: '',
              refresh: t('status_refresh'),
            }}
          />
        </p>
      )}
      {/* What the project's type says to do next, until done or dismissed. */}
      <NextSteps
        projectId={projectId}
        orgId={orgId}
        path={read.data.path}
        t={t}
        reachRoute={(route) => (availability.route(route) ? route : null)}
        open={open}
      />
      <StatusView
        status={read.data}
        stages={stages}
        t={t}
        open={open}
        reach={reach}
        refreshing={read.isFetching}
        onRefresh={() => void read.refetch()}
      />
    </>
  );
};

OverviewSection.displayName = 'OverviewSection';

function StatusView({
  status,
  stages,
  t,
  open,
  reach,
  refreshing,
  onRefresh,
}: {
  status: ProjectStatus;
  /** The whole path, sources to running product. */
  stages: PathStage[];
  t: Text;
  open: (route: string | null) => void;
  reach: Reach;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const next = nextStep(status);
  const ide = reach('ide');
  const nextRoute = next ? reach(next.tab, next.step, next.kit) : null;
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
          {next && nextRoute ? (
            <Button title={next.status} data-next-step={next.step} onClick={() => open(nextRoute)}>
              {next.action}
            </Button>
          ) : (
            ide && (
              <Button data-open-ide onClick={() => open(ide)}>
                {t('open_ide')}
              </Button>
            )
          )}
          {next && nextRoute && ide && (
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

      <ProjectPath stages={stages} onOpen={(route) => open(route)} />

      <KitContentSlot name="project.overview.content" />

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
                const route = reach(s.action.target, s.key, s.kit);
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
