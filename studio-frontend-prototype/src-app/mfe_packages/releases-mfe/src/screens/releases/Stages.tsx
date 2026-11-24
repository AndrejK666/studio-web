/**
 * The release map's Images and Deploy stages (owner feedback, 2026-11-24).
 *
 * Images: what a build made, on the shared grid -- its images per app, where
 * they live (Research's own registry or the organization's), its chart -- and
 * how many environments they can go to, which opens the Environment stage on
 * those. A build picker chooses whose images the Deploy stage takes, and "Deploy these
 * images" takes them there: a passed build's as well as the images a failed
 * Research build had asked for.
 *
 * Deploy: the chosen images to the chosen environment, by the route the
 * environment's kind takes (a cluster installs the published chart, Research
 * runs the images it built, deploy-only), then the deploy as it goes and how
 * it ended -- the application's address, or why it failed -- and what else
 * there is to do there: decide a deploy that waits, roll back, take the
 * release out, preview. The project's deploy history is under it; a deploy in
 * it can be deployed again, which is how a rollback to any earlier build goes.
 */

import { useState, type ReactNode } from 'react';
import { Badge, Button, NativeSelect, NativeSelectOption } from '@gears-frontx/ui-kit';
import type { Deployment, PathAction, PathStep } from '../../api/types';
import type { IdeBuild } from '../../model/builds';
import { hasDeployableImages, type ReleaseMap, type StageId } from '../../model/release-map';
import { rollbackTarget, runsNow } from '../../model/project-deploys';
import { versionOf, type LadderStep } from '../../model/releases';
import type { Intent } from '../../model/path';
import { ImagesGrid } from './ImagesGrid';
import { buildTone } from './BuildsGrids';
import { PendingDecisions, PreviewForm, isResearch, useDeployRequest } from './DeployActions';
import { DeployHistory } from './History';
import { DeployProgress, PromoteBuild } from './Ladder';
import { PathStepNote } from './ProjectPath';
import { TargetIcon } from './Targets';
import { Confirm, ErrorLine, StateBadge, TONE_BADGE, When, relTime, useReleases } from './parts';
import styles from './ReleasesScreen.module.css';

/** A stage's heading: its name and what it is. */
export function StageHead({ stage, children }: { stage: StageId; children?: ReactNode }) {
  const { t } = useReleases();
  return (
    <div className={styles.sectionHead}>
      <span className={styles.groupText}>
        <h2 className={styles.subTitle}>{t(`stage_${stage}`)}</h2>
        <span className={styles.muted}>{t(`stage_${stage}_about`)}</span>
      </span>
      {children && <span className={styles.row}>{children}</span>}
    </div>
  );
}

/** The build picker, the build's images on the shared grid, where they can
 *  go, and Deploy these images. */
export function ImagesStage({
  builds,
  map,
  pathStep,
  onPick,
  onDeploy,
  onFits,
  onStage,
  onIntent,
}: {
  /** The product's builds, newest first. */
  builds: IdeBuild[];
  map: ReleaseMap;
  pathStep?: PathStep;
  onPick: (buildId: string) => void;
  onDeploy: (build: IdeBuild) => void;
  /** The Environment stage, showing the environments these images can go to. */
  onFits: () => void;
  onStage: (stage: StageId) => void;
  onIntent: (intent: Intent, action: Partial<PathAction>) => void;
}) {
  const { t, language } = useReleases();
  const b = map.images.build;
  // The builds that made something to deploy, and the one shown whatever it made.
  const pickable = builds.filter((x) => x.images.length > 0 || x.chartRef || x.buildId === b?.buildId);
  const fits = map.images.fits;
  const deployable = !!b && hasDeployableImages(b);
  return (
    <section className={styles.stack} data-stage-panel="images">
      <StageHead stage="images">
        {b && (
          <Button
            size="sm"
            disabled={fits.length === 0}
            title={fits.length === 0 ? t('images_nowhere') : undefined}
            onClick={() => onDeploy(b)}
            data-images-deploy
          >
            {t('images_deploy')}
          </Button>
        )}
      </StageHead>
      {pathStep && <PathStepNote step={pathStep} onIntent={onIntent} />}
      {!b ? (
        <div className={styles.emptyState} data-releases-empty="images">
          <p className={styles.muted}>{t('images_none')}</p>
          <div className={styles.row}>
            <Button size="sm" variant="outline" onClick={() => onStage('build')}>
              {t('images_to_build')}
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.stack} data-images-build={b.buildId}>
          <div className={styles.toolbar}>
            <label className={styles.toolbarField}>
              <span className={styles.muted}>{t('images_build')}</span>
              <NativeSelect value={b.buildId} onChange={(e) => onPick(e.target.value)} data-images-build-picker>
                {pickable.map((x) => (
                  <NativeSelectOption key={x.id} value={x.buildId}>
                    {x.buildId} · {x.status} · {relTime(x.finishedAt ?? x.startedAt, language)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            <Badge variant={TONE_BADGE[buildTone(b.status)]}>{b.status}</Badge>
            {b.chartRef && (
              <span className={styles.muted} data-build-chart>
                {t('chart')}{' '}
                <code>
                  {b.chartRef}
                  {b.chartVersion ? `:${b.chartVersion}` : ''}
                </code>
              </span>
            )}
            <span className={styles.grow} />
            {fits.length > 0 ? (
              <button
                type="button"
                className={styles.link}
                title={fits.map((e) => e.name).join(', ')}
                onClick={onFits}
                data-images-fits={fits.length}
              >
                {t.count('images_fits_count', fits.length)}
              </button>
            ) : (
              <span className={styles.warn} data-images-fits={0}>
                {t('images_nowhere')}
              </span>
            )}
          </div>
          {deployable && b.status === 'failed' && <p className={styles.warn}>{t('map_images_failed_build')}</p>}
          {b.images.length > 0 ? (
            <ImagesGrid build={b} />
          ) : (
            <p className={styles.muted} data-releases-empty="build-images">
              {b.status === 'running' ? t('map_images_waiting') : t('images_none_made')}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/** Deploy the chosen images to the chosen environment, follow it, and the history. */
export function DeployStage({
  map,
  deployments,
  blocked,
  pathStep,
  onChanged,
  onIntent,
  onStage,
  onShow,
}: {
  map: ReleaseMap;
  deployments: Deployment[];
  /** Why nothing can be deployed yet (no product); null: it can. */
  blocked: string | null;
  pathStep?: PathStep;
  onChanged: (message: string) => void;
  onIntent: (intent: Intent, action: Partial<PathAction>) => void;
  onStage: (stage: StageId) => void;
  /** Open one deploy with its cause and log. */
  onShow: (deploymentId: string) => void;
}) {
  const { t, language } = useReleases();
  const b = map.images.build;
  const step: LadderStep | null = map.environment.step;
  const env = step?.environment ?? null;
  const request = useDeployRequest(onChanged);
  const [uninstalling, setUninstalling] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const waiting = env ? deployments.filter((d) => d.environment_id === env.id && d.state === 'awaiting_approval') : [];
  const back = env ? rollbackTarget(deployments, env.id) : null;
  const latest = map.deploy.deployment;
  const version = b ? (b.chartVersion ?? b.buildId) : '';
  const why =
    blocked ??
    (!b || !hasDeployableImages(b)
      ? t('deploy_needs_images')
      : !env
        ? t('deploy_needs_environment')
        : map.environment.gap
          ? t(`map_gap_${map.environment.gap}`)
          : waiting.length > 0
            ? t('decide_first')
            : null);
  const previews = !!env && !isResearch(env) && !!env.previews && !why;
  return (
    <section className={styles.stack} data-stage-panel="deploy">
      <StageHead stage="deploy" />
      {pathStep && <PathStepNote step={pathStep} onIntent={onIntent} />}
      <div className={styles.card} data-deploy-plan>
        <div className={styles.plan}>
          <button type="button" className={styles.planPart} onClick={() => onStage('images')} data-deploy-plan-images>
            <span className={styles.muted}>{t('stage_images')}</span>
            <b>{b ? <code>{b.buildId}</code> : t('map_images_none')}</b>
            <span className={styles.muted}>
              {b ? (b.images.length > 0 ? t.count('build_made_images', b.images.length) : (b.chartVersion ?? '—')) : '—'}
            </span>
          </button>
          <span className={styles.planArrow} aria-hidden="true">
            →
          </span>
          <button type="button" className={styles.planPart} onClick={() => onStage('environment')} data-deploy-plan-environment>
            <span className={styles.muted}>{t('stage_environment')}</span>
            <b className={styles.targetMain}>
              {map.environment.kind && <TargetIcon kind={map.environment.kind} />}
              {env?.name ?? t('map_environment_none')}
            </b>
            <span className={styles.muted}>
              {map.environment.kind ? t(`target_kind_${map.environment.kind}`) : '—'}
              {env?.protected ? ` · ${t('needs_approval')}` : ''}
            </span>
          </button>
          <span className={styles.planGo}>
            <Button
              disabled={!!why || request.busy}
              title={why ?? undefined}
              onClick={() =>
                b && env && void request.askBuild(env, b.buildId, t('what_deploy_to', { version, environment: env.name }))
              }
              data-deploy-run
            >
              {request.busy ? t('starting') : version ? t('deploy_run', { version }) : t('deploy')}
            </Button>
          </span>
        </div>
        {why && <p className={styles.muted} data-deploy-why>{why}</p>}
        {request.error && <ErrorLine>{request.error}</ErrorLine>}
        {step?.promote && b && step.promote.buildId !== b.buildId && !blocked && (
          <div className={styles.row} data-deploy-promote>
            <span className={styles.muted}>{t('deploy_promote_hint', { from: step.from ?? '' })}</span>
            <PromoteBuild step={step} build={step.promote} onChanged={onChanged} />
          </div>
        )}
        {previews && b && env && (
          <div className={styles.row}>
            <Button size="sm" variant="ghost" aria-expanded={previewing} onClick={() => setPreviewing((v) => !v)} data-preview-build={b.buildId}>
              {t('preview')}
            </Button>
            {previewing && (
              <PreviewForm
                build={b}
                most={env.previews?.ttl_hours ?? 72}
                busy={request.busy}
                onCancel={() => setPreviewing(false)}
                onStart={(name, ttl) =>
                  void request
                    .ask(
                      { environment_id: env.id, build: b.buildId, preview: { name: name || undefined, ttl_hours: ttl } },
                      t('what_preview', { version, environment: env.name })
                    )
                    .then((ok) => ok && setPreviewing(false))
                }
              />
            )}
          </div>
        )}
      </div>
      {env && (
        <div className={styles.card} data-deploy-current={latest?.state ?? 'none'}>
          <h3 className={styles.subTitle}>{t('deploy_latest_in', { environment: env.name })}</h3>
          {!latest ? (
            <p className={styles.muted}>{t('nothing_deployed_here')}</p>
          ) : (
            <>
              <div className={styles.chips}>
                <StateBadge d={latest} />
                <b>{versionOf(latest) ?? latest.product}</b>
                <span className={styles.muted}>
                  <When iso={latest.requested_at} />
                </span>
                <Button size="sm" variant="ghost" onClick={() => onShow(latest.id)} data-deploy-open-detail>
                  {t('deploy_open_detail')}
                </Button>
              </div>
              {map.deploy.state === 'running' && latest.state !== 'awaiting_approval' && (
                <DeployProgress deployment={latest} onEnded={onChanged} />
              )}
              {map.deploy.url && (
                <p data-deploy-url>
                  {t('runs_at')}{' '}
                  <a className={styles.link} href={map.deploy.url} target="_blank" rel="noreferrer">
                    {map.deploy.url}
                  </a>
                </p>
              )}
              {/* The path's note above says it already, with the actions that fix it. */}
              {map.deploy.cause && !(pathStep?.state === 'failed' && pathStep.deployment_id === latest.id) && (
                <div className={`${styles.error} ${styles.pre}`} data-deploy-cause>
                  {map.deploy.cause}
                </div>
              )}
            </>
          )}
          {waiting.length > 0 && <PendingDecisions waiting={waiting} onChanged={onChanged} />}
          {(back || runsNow(latest ?? undefined)) && (
            <div className={styles.row}>
              {back && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={request.busy}
                  title={t('rollback_title', { when: relTime(back.requested_at, language) })}
                  onClick={() =>
                    void request.ask(
                      { environment_id: env.id, redeploy_of: back.id },
                      t('what_rollback', { version: versionOf(back) ?? t('the_earlier_build') })
                    )
                  }
                  data-deploy-rollback
                >
                  {t('roll_back_to', { version: versionOf(back) ?? t('the_earlier_build') })}
                </Button>
              )}
              {runsNow(latest ?? undefined) && latest && (
                <Button size="sm" variant="destructive" disabled={request.busy} onClick={() => setUninstalling(true)} data-deploy-uninstall>
                  {t('uninstall')}
                </Button>
              )}
            </div>
          )}
          {uninstalling && latest && (
            <Confirm
              title={t('uninstall_title', { product: latest.product, environment: env.name })}
              body={t('uninstall_body')}
              confirmLabel={t('uninstall')}
              busy={request.busy}
              error={request.error}
              onCancel={() => setUninstalling(false)}
              onConfirm={() =>
                void request
                  .ask({ environment_id: env.id, product: latest.product, profile: latest.profile, action: 'uninstall' }, t('uninstall'))
                  .then((ok) => ok && setUninstalling(false))
              }
            />
          )}
        </div>
      )}
      <section className={styles.stack} data-releases-history>
        <div className={styles.sectionHead}>
          <span className={styles.groupText}>
            <h3 className={styles.subTitle}>{t('release_history')}</h3>
            <span className={styles.muted}>{t('history_about')}</span>
          </span>
        </div>
        {deployments.length === 0 ? (
          <div className={styles.emptyState} data-releases-empty="history">
            <p className={styles.muted}>{t('history_empty')}</p>
          </div>
        ) : (
          <DeployHistory deployments={deployments} onChanged={onChanged} />
        )}
      </section>
    </section>
  );
}
