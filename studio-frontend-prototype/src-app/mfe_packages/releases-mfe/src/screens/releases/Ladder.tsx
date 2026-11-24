/**
 * What the ladder (ADR-0056 §4) kept once its table moved onto the shared
 * grid (EnvironmentsGrid.tsx): the prototype's StepDetail, DeployProgress and
 * PromoteBuild (releases-tab.tsx at 00828880) -- the chosen environment's
 * detail under the Environment stage's list, and the Deploy stage's progress
 * and Promote.
 */

import { useEffect, useState } from 'react';
import { pollWhileVisible } from '@constructor-studio/mfe-shared';
import { Button } from '@gears-frontx/ui-kit';
import type { Connection, Deployment, DeploymentStatus, ProjectTargets, TaskRun } from '../../api/types';
import type { IdeBuild } from '@constructor-studio/mfe-shared';
import { profilesBoundTo } from '../../model/project-deploys';
import { versionOf, type LadderStep } from '../../model/releases';
import { RungPlace, useDeployRequest } from './DeployActions';
import { ErrorLine, anyUnnamed, personLabel, relTime, useApi, usePeople, useReleases } from './parts';
import styles from './ReleasesScreen.module.css';

/** The chosen environment: where it is, what it still needs, which profile
 *  it runs, and its newest deploy as that deploy tells it -- the reason it
 *  was asked for and its outcome, a crashed container's error first. */
export function EnvironmentDetail({ step: s, bindings }: { step: LadderStep; bindings: ProjectTargets['bindings'] }) {
  const { t, language, organizationId, projectId } = useReleases();
  const api = useApi();
  // The place a rung stands on, and whether the member is signed in to Research.
  const [connections, setConnections] = useState<Connection[] | null>(null);
  useEffect(() => {
    let live = true;
    api
      .connections({ tenantId: projectId })
      .fetch({ staleTime: 60_000 })
      .then((r) => live && setConnections(r.items))
      .catch(() => live && setConnections([]));
    return () => {
      live = false;
    };
  }, [api, projectId]);
  const e = s.environment;
  const profiles = profilesBoundTo(bindings, e.id);
  const people = usePeople(
    [organizationId, projectId],
    anyUnnamed(s.latest ? [{ id: s.latest.requested_by, name: s.latest.requested_by_name }] : [])
  );
  return (
    <div className={styles.stack} data-ladder-detail={e.name}>
      <RungPlace step={s} connections={connections} />
      <div className={styles.muted}>
        {e.kind === 'research' ? (
          <>
            {t('research_application')} <code>{s.namespace}</code> {t('in_research_project')} <code>{e.research_project}</code>
          </>
        ) : (
          <>
            {t('namespace')} <code>{s.namespace}</code>
          </>
        )}
        {s.from && <> · {t('takes_from', { environment: s.from })}</>}
        {' · '}
        {profiles.length ? t('profile_bound', { profiles: profiles.join(', ') }) : t('no_profile_bound')}
      </div>
      {s.latest ? (
        <div data-ladder-latest={s.latest.state}>
          <div className={styles.muted}>
            {t('newest_deploy')} <b>{versionOf(s.latest) ?? s.latest.product}</b> · {s.latest.state} ·{' '}
            {personLabel(s.latest.requested_by, s.latest.requested_by_name, people, t)} ·{' '}
            {relTime(s.latest.requested_at, language)}
          </div>
          {s.latest.reason && <div className={styles.muted}>“{s.latest.reason}”</div>}
          {s.latest.outcome && <pre className={styles.outcome}>{s.latest.outcome}</pre>}
        </div>
      ) : (
        <div className={styles.muted}>{t('nothing_deployed_here')}</div>
      )}
    </div>
  );
}

/** How often a deploy under way is read again. */
const PROGRESS_MS = 4000;

/** Where a deploy that is under way is: waiting for a runner, the phase its
 *  run reported, and how many of the release's pods are ready. Read again
 *  every few seconds; the screen reads again once the deploy ends. */
export function DeployProgress({ deployment, onEnded }: { deployment: Deployment; onEnded: (message: string) => void }) {
  const { t, organizationId, projectId } = useReleases();
  const api = useApi();
  const [run, setRun] = useState<TaskRun | null>(null);
  const [rollout, setRollout] = useState<DeploymentStatus | null>(null);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    const look = async () => {
      const [r, st] = await Promise.all([
        deployment.run_id && organizationId
          ? api
              .taskRun({ runId: deployment.run_id, tenantId: organizationId })
              .fetch({ staleTime: 0 })
              .catch(() => null)
          : null,
        api
          .deploymentStatus({ projectId, id: deployment.id })
          .fetch({ staleTime: 0 })
          .catch(() => null),
      ]);
      if (!live) return;
      setNow(Date.now());
      setRun(r);
      setRollout(st);
      const ended = st?.deployment.state ?? (r && ['succeeded', 'failed', 'cancelled'].includes(r.state) ? r.state : null);
      if (ended && ended !== 'queued' && ended !== 'running' && ended !== 'awaiting_approval') {
        live = false;
        onEnded(
          t('deploy_ended', {
            version: versionOf(deployment) ?? deployment.product,
            environment: deployment.environment_name,
            state: ended,
          })
        );
      }
    };
    void look();
    // Not while the tab is hidden: shown again, it looks at once.
    const stop = pollWhileVisible(() => void look(), PROGRESS_MS);
    return () => {
      live = false;
      stop();
    };
  }, [api, organizationId, projectId, deployment, onEnded, t]);
  const workloads = rollout?.workloads ?? [];
  const desired = workloads.reduce((n, w) => n + Math.max(w.desired, 0), 0);
  const ready = workloads.reduce((n, w) => n + Math.max(Math.min(w.ready, w.desired), 0), 0);
  const since = run?.started_at ?? deployment.decided_at ?? deployment.requested_at;
  const seconds = since && now !== null ? Math.max(0, Math.round((now - Date.parse(since)) / 1000)) : null;
  const phase = !run || run.state === 'queued' ? t('waiting_for_runner') : (run.progress ?? t('starting'));
  return (
    <div className={styles.progress} data-deploy-progress>
      {desired > 0 ? (
        <progress max={desired} value={ready} aria-label={t('pods_ready_label')} />
      ) : (
        <progress aria-label={t('deploy_under_way')} />
      )}
      <div className={styles.muted}>
        {phase}
        {desired > 0 && <> · {t('pods_ready', { ready, desired })}</>}
        {seconds !== null && <> · {seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`}</>}
      </div>
      {(rollout?.problems ?? []).slice(0, 3).map((p) => (
        <div key={p} className={styles.warn}>
          {p}
        </div>
      ))}
    </div>
  );
}

/** Promote: deploy here the build the environment before it runs. */
export function PromoteBuild({ step, build, onChanged }: { step: LadderStep; build: IdeBuild; onChanged: (message: string) => void }) {
  const { t } = useReleases();
  const { busy, error, askBuild } = useDeployRequest(onChanged);
  const version = build.chartVersion ?? build.buildId;
  const replaces = step.runs ? versionOf(step.runs) : null;
  return (
    <>
      <Button
        size="sm"
        disabled={busy}
        title={
          replaces
            ? t('promote_title_replaces', { version, from: step.from ?? '', environment: step.environment.name, replaces })
            : t('promote_title', { version, from: step.from ?? '', environment: step.environment.name })
        }
        onClick={() => void askBuild(step.environment, build.buildId, t('what_promote', { version, environment: step.environment.name }))}
        data-ladder-promote
      >
        {t('promote', { version })}
      </Button>
      {error && <ErrorLine>{error}</ErrorLine>}
    </>
  );
}
