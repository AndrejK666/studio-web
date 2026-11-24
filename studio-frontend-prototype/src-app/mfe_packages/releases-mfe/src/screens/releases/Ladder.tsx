/**
 * The ladder (ADR-0056 §4), the prototype's ReleaseLadder, StepDetail,
 * DeployProgress and PromoteBuild (releases-tab.tsx at 00828880): the newest
 * published build, then a row per environment in the order a release climbs
 * them -- what runs there, how its newest deploy went, whether the chosen
 * images can go there, what it takes from -- and Choose, which makes it the
 * environment the Deploy stage deploys to (the release map, 2026-11-24). A
 * row opens on its newest deploy as the deploy tells it. DeployProgress and
 * PromoteBuild are the Deploy stage's.
 */

import React, { Fragment, useEffect, useState } from 'react';
import { pollWhileVisible } from '@constructor-studio/mfe-shared';
import { Badge, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@gears-frontx/ui-kit';
import type { Connection, Deployment, DeploymentStatus, ProjectTargets, TaskRun } from '../../api/types';
import type { IdeBuild } from '../../model/builds';
import { productUrls, profilesBoundTo } from '../../model/project-deploys';
import { stepStatus, versionOf, type LadderStep } from '../../model/releases';
import { RungPlace, useDeployRequest } from './DeployActions';
import { ErrorLine, TONE_BADGE, When, personLabel, relTime, useApi, usePeople, useReleases, type Tone } from './parts';
import styles from './ReleasesScreen.module.css';

/** A ladder step's tone (releases.ts) as a chip's. */
const LADDER_TONE: Record<ReturnType<typeof stepStatus>['tone'], Tone> = {
  ok: 'ok',
  warn: 'warn',
  bad: 'danger',
  idle: 'neutral',
};

export function ReleaseLadder({
  steps,
  bindings,
  selected,
  onSelect,
  fitOf,
  head,
  targetOf,
  blocked = null,
}: {
  steps: LadderStep[];
  bindings: ProjectTargets['bindings'];
  /** The environment chosen for the deploy. */
  selected: string | null;
  onSelect: (environment: string) => void;
  /** Whether the chosen images can go there: adds the column when given. */
  fitOf?: (step: LadderStep) => React.ReactNode;
  /** What the card says above its rows: the group's heading. */
  head: React.ReactNode;
  /** Where a row's environment runs: adds the column when given. */
  targetOf?: (step: LadderStep) => React.ReactNode;
  /** Why nothing can be deployed here yet: Choose waits, saying so. */
  blocked?: string | null;
}) {
  const { t, projectId } = useReleases();
  const api = useApi();
  const [expanded, setExpanded] = useState<string | null>(null);
  // Every rung asks which place it stands on: read once for the ladder.
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
  const columns = 6 + (targetOf ? 1 : 0) + (fitOf ? 1 : 0);
  return (
    <section className={styles.card} data-release-ladder>
      {head}
      {steps.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('col_environment')}</TableHead>
              {targetOf && <TableHead>{t('col_target')}</TableHead>}
              <TableHead>{t('col_status')}</TableHead>
              <TableHead>{t('col_runs')}</TableHead>
              {fitOf && <TableHead>{t('col_fits')}</TableHead>}
              <TableHead>{t('col_takes_from')}</TableHead>
              <TableHead>{t('col_last_deploy')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {steps.map((s) => {
              const id = s.environment.id;
              const status = stepStatus(s);
              return (
                <Fragment key={id}>
                  <TableRow
                    className={styles.clickable}
                    onClick={() => setExpanded(expanded === id ? null : id)}
                    aria-expanded={expanded === id}
                    data-ladder-row={s.environment.name}
                    data-ladder-selected={selected === id || undefined}
                  >
                    <TableCell>
                      <span className={styles.chips} data-ladder-step={s.environment.name} data-ladder-state={s.state}>
                        <b>{s.environment.name}</b>
                        {s.environment.protected && <Badge variant="info">{t('needs_approval')}</Badge>}
                        {s.environment.project_id && (
                          <Badge variant="secondary" data-own-environment>
                            {t('projects_own')}
                          </Badge>
                        )}
                      </span>
                    </TableCell>
                    {targetOf && <TableCell>{targetOf(s)}</TableCell>}
                    <TableCell>
                      <Badge
                        variant={TONE_BADGE[s.state === 'deploying' ? 'running' : LADDER_TONE[status.tone]]}
                        data-ladder-status
                      >
                        {status.text}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {s.runs ? (
                        <>
                          <code>{versionOf(s.runs) ?? s.runs.product}</code>
                          {productUrls(s.runs.outcome).map((u) => (
                            <div key={u}>
                              <a
                                href={u}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                data-product-url
                              >
                                {t('open_product')}
                              </a>
                            </div>
                          ))}
                        </>
                      ) : (
                        <span className={styles.muted}>{t('nothing')}</span>
                      )}
                    </TableCell>
                    {fitOf && <TableCell>{fitOf(s)}</TableCell>}
                    <TableCell>{s.from ?? <span className={styles.muted}>{t('a_build')}</span>}</TableCell>
                    <TableCell>
                      <When iso={s.latest?.requested_at} />
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <span className={styles.ladderActions}>
                        <Button
                          size="sm"
                          variant={selected === id ? 'default' : 'outline'}
                          aria-pressed={selected === id}
                          disabled={!!blocked}
                          title={blocked ?? t('choose_environment_title')}
                          onClick={() => onSelect(id)}
                          data-ladder-choose
                        >
                          {t(selected === id ? 'environment_chosen' : 'choose_environment')}
                        </Button>
                      </span>
                    </TableCell>
                  </TableRow>
                  {expanded === id && (
                    <TableRow data-ladder-expanded={s.environment.name}>
                      <TableCell colSpan={columns}>
                        <StepDetail step={s} bindings={bindings} connections={connections} />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

/** An environment's row, opened: where it is, which profile it runs, and its
 *  newest deploy as that deploy tells it -- the reason it was asked for and
 *  its outcome, a crashed container's error first. */
function StepDetail({
  step: s,
  bindings,
  connections,
}: {
  step: LadderStep;
  bindings: ProjectTargets['bindings'];
  connections: Connection[] | null;
}) {
  const { t, language, organizationId, projectId } = useReleases();
  const e = s.environment;
  const profiles = profilesBoundTo(bindings, e.id);
  const people = usePeople([organizationId, projectId]);
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
  const { t, organizationId } = useReleases();
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
        organizationId
          ? api
              .deploymentStatus({ organizationId, id: deployment.id })
              .fetch({ staleTime: 0 })
              .catch(() => null)
          : null,
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
  }, [api, organizationId, deployment, onEnded, t]);
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
