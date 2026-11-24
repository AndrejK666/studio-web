/**
 * Project › Releases as the release map (owner feedback, 2026-11-24): four
 * stages, left to right -- Build, Images, Environment, Deploy -- drawn as a
 * small pipeline on top, each node with its state and key fact; the node
 * picked shows its stage under the map, one at a time. The stage, the build
 * whose images go and the environment they go to are kept in the address;
 * without a stage named the page opens on the first that failed or runs,
 * else Deploy. Deploy to… stays: one dialog over every target.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChildMfeBridge } from '@gears-frontx/react';
import { useSharedProperty } from '@gears-frontx/react';
import { Badge, Button } from '@gears-frontx/ui-kit';
import { PageEmpty, PageLoading, ProjectPage } from '@constructor-studio/mfe-shared/page';
import {
  STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT,
  isNotFound,
  openScreen,
  screenView,
  useHostChrome,
  usePollWhileVisible,
  writeListState,
  useScreenAvailability,
} from '@constructor-studio/mfe-shared';
import type { Deployment, PathAction, PathStep, ProjectPath, ProjectTargets } from '../../api/types';
import { ROUTES, deploymentFromSearch, type Intent } from '../../model/path';
import { anyRunning, ideBuildsOf, type IdeBuild } from '@constructor-studio/mfe-shared';
import { ladderSteps } from '../../model/releases';
import {
  attentionStage,
  fitGap,
  hasDeployableImages,
  imagesFit,
  productBuilds,
  readReleaseAddress,
  releaseMap,
  writeReleaseAddress,
  type ReleaseAddress,
  type StageId,
} from '../../model/release-map';
import { noProduct } from '../../model/environment-targets';
import { useReleasesTranslations } from '../../i18n';
import { DeployDialog } from './DeployDialog';
import { DeploymentDetail } from './DeploymentDetail';
import { PathStepNote } from './ProjectPath';
import { ProjectBindings } from './Bindings';
import { ProjectBuilds } from './Builds';
import { EnvironmentConfig, EnvironmentPreviews } from './DeployActions';
import { NoProductLine, useTargetNames } from './Targets';
import { ENVIRONMENTS_ADDRESS, EnvironmentsGrid, environmentRows } from './EnvironmentsGrid';
import { EnvironmentDetail } from './Ladder';
import { ReleaseMap } from './ReleaseMap';
import { DeployStage, ImagesStage, StageHead } from './Stages';
import { ErrorLine, ReleasesProvider, errText, useApi, useReleases, type ReleasesContextValue } from './parts';
import styles from './ReleasesScreen.module.css';

/** The project in scope, from the shell's shared property. */
function useProjectId(): string | null {
  const project = useSharedProperty(STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT);
  return typeof project === 'string' && project ? project : null;
}

export const ReleasesScreen: React.FC<{ bridge: ChildMfeBridge | null }> = ({ bridge }) => {
  const { containerRef, dataTheme, language } = useHostChrome();
  const { t, loading } = useReleasesTranslations();
  const projectId = useProjectId();
  return (
    <div ref={containerRef} className={styles.screen} data-theme={dataTheme} data-project-releases>
      {loading ? (
        <ProjectPage title={null} busy>
          <PageLoading />
        </ProjectPage>
      ) : !projectId ? (
        <ProjectPage title={t('title')}>
          <PageEmpty title={t('no_project')} />
        </ProjectPage>
      ) : (
        // Keyed by the project: another project is another read, from nothing.
        <ProjectReleases
          key={projectId}
          projectId={projectId}
          base={{ t, language, projectId, organizationId: '', container: containerRef, bridge }}
        />
      )}
    </div>
  );
};

ReleasesScreen.displayName = 'ReleasesScreen';

/** The screen's context, with the project's organization once its targets say it. */
function ProjectReleases({ projectId, base }: { projectId: string; base: ReleasesContextValue }) {
  const [organizationId, setOrganizationId] = useState('');
  return (
    <ReleasesProvider value={{ ...base, organizationId }}>
      <Releases projectId={projectId} onOrganization={setOrganizationId} />
    </ReleasesProvider>
  );
}

/** The deploy the address names, read once as the screen opens. */
function addressedDeployment(): string | null {
  try {
    return deploymentFromSearch(window.location.search);
  } catch {
    return null;
  }
}

/** The address the screen opened with: the release's choices, and the
 *  environment a failed run on the organization overview leads to. */
function openingAddress(): ReleaseAddress {
  try {
    const address = readReleaseAddress(window.location.search);
    const env = /^environment-([0-9a-f-]{36})$/.exec(screenView(window.location.search) ?? '')?.[1] ?? null;
    return env && !address.env ? { ...address, env, stage: address.stage ?? 'environment' } : address;
  } catch {
    return { stage: null, build: null, env: null };
  }
}

function replaceSearch(search: string): void {
  if (search === window.location.search) return;
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${search}${window.location.hash}`);
}

/** How often the page reads again while a build runs or a deploy goes. */
const FOLLOW_MS = 10_000;

function Releases({ projectId, onOrganization }: { projectId: string; onOrganization: (id: string) => void }) {
  const { t, bridge } = useReleases();
  // Organization › Infrastructure is named only where its kit put the screen.
  const screens = useScreenAvailability();
  const noEnvironmentKey = screens.route(ROUTES.infrastructure) ? 'no_environment' : 'no_environment_admin';
  const api = useApi();
  const [path, setPath] = useState<ProjectPath | null>(null);
  // Deploy to…: closed, or open on an environment or the Research target.
  const [dialog, setDialog] = useState<{ environmentId: string | null; research: boolean } | null>(null);
  // The deploy opened by itself: the address's, or one a step or a cause named.
  const [shown, setShown] = useState<string | null>(addressedDeployment);
  const [targets, setTargets] = useState<ProjectTargets | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [builds, setBuilds] = useState<IdeBuild[]>([]);
  const [buildRead, setBuildRead] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [deploymentError, setDeploymentError] = useState<string | null>(null);
  // When the screen last read: what "lost" and "took" are measured against.
  const [now, setNow] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  // Bumped to read again: after a change, and while a build runs.
  const [round, setRound] = useState(0);
  // The stage shown and the build and environment chosen, kept in the address.
  const [address, setAddress] = useState<ReleaseAddress>(openingAddress);
  // The stage the page opened on when the address named none: fixed once
  // read, so the page does not move under the reader as things change.
  const [opening, setOpening] = useState<StageId | null>(null);
  const panel = useRef<HTMLElement>(null);
  const changed = useCallback((message: string) => {
    setNotice(message);
    setRound((r) => r + 1);
  }, []);
  const follow = useCallback(() => setRound((r) => r + 1), []);

  const choose = useCallback((patch: Partial<ReleaseAddress>) => {
    setAddress((a) => {
      const next = { ...a, ...patch };
      replaceSearch(writeReleaseAddress(window.location.search, next));
      return next;
    });
  }, []);
  // Leaving the screen: the next place starts without the release's choices.
  useEffect(
    () => () => replaceSearch(writeReleaseAddress(window.location.search, { stage: null, build: null, env: null })),
    []
  );

  useEffect(() => {
    let live = true;
    // The path to running; an older backend has none and the screen goes on without it.
    // It carries the targets and the deploys the server read to make it; where it does
    // not (it failed, or the backend is older), they are read on their own.
    const pathRead = api
      .projectPath({ projectId, include: 'targets,deployments' })
      .fetch({ staleTime: 0 })
      .catch(() => null);
    void api.nodes({ projectId, type: 'build', limit: 200, sort: 'updated' }).fetch({ staleTime: 0 }).then(
      (p) => {
        if (!live) return;
        setBuilds(ideBuildsOf(p.nodes ?? []));
        setBuildRead('ready');
      },
      () => {
        if (live) setBuildRead('failed');
      }
    );
    Promise.all([
      pathRead.then((pt) => pt?.targets ?? api.targets({ projectId }).fetch({ staleTime: 0 })),
      pathRead.then((pt) => pt?.deployments ?? api.deployments({ projectId }).fetch({ staleTime: 0 })).then(
        (data) => ({ data, error: null }),
        (e: unknown) => ({ data: null, error: errText(e) })
      ),
      pathRead,
    ])
      .then(([tg, d, pt]) => {
        if (!live) return;
        setNow(Date.now());
        setTargets(tg);
        setError(null);
        setUnavailable(false);
        setDeployments(d.data?.items ?? []);
        setDeploymentError(d.error);
        setPath(pt);
        onOrganization(tg.organization_id);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setNow(Date.now());
        if (isNotFound(e)) setUnavailable(true);
        else setError(errText(e));
      });
    return () => {
      live = false;
    };
  }, [api, projectId, round, onOrganization]);

  const environments = useMemo(() => targets?.environments.map((x) => x.environment) ?? [], [targets]);
  const names = useTargetNames(environments, path);
  // No product yet: nothing to build or deploy, and the screen says so.
  const productMissing = noProduct(path);
  const blocked = productMissing ? t('no_product_short') : null;
  const productAction = path?.steps.find((step) => step.id === 'product')?.action;

  const steps = useMemo(
    () => (targets ? ladderSteps(targets.environments, deployments, builds) : []),
    [targets, deployments, builds]
  );
  const product = useMemo(() => productBuilds(builds), [builds]);
  const runningIn = steps.find((s) => !!s.runs)?.environment.name ?? null;
  const map = useMemo(
    () =>
      releaseMap({
        builds: product,
        steps,
        deployments,
        build: address.build,
        environment: address.env,
        productMissing,
        now,
      }),
    [product, steps, deployments, address.build, address.env, productMissing, now]
  );
  const ready = (!!targets || unavailable) && buildRead !== 'loading';
  // Set once, as the first answers render (React's state derived in render).
  if (ready && opening === null) setOpening(attentionStage(map));
  const stage: StageId = address.stage ?? opening ?? 'deploy';
  // Read again while something moves: a build that says how far it is, a deploy under way.
  usePollWhileVisible(
    follow,
    FOLLOW_MS,
    anyRunning(builds, now) || steps.some((s) => s.state === 'deploying')
  );

  const show = (next: StageId, patch: Partial<ReleaseAddress> = {}) => {
    choose({ ...patch, stage: next });
    panel.current?.scrollIntoView?.({ block: 'nearest' });
  };
  const pathStep = (id: PathStep['id']) => path?.steps.find((s) => s.id === id);

  // What a path step's or a cause's button does here.
  const onIntent = (intent: Intent, action: Partial<PathAction>) => {
    switch (intent.kind) {
      case 'screen':
        openScreen(bridge, intent.route);
        return;
      case 'tab':
        if (intent.tab === 'build') show('build');
        else show('environment', action.environment_id ? { env: action.environment_id } : {});
        return;
      case 'deploy':
        setDialog({ environmentId: intent.environmentId, research: intent.research });
        return;
      case 'deployment':
        setShown(intent.id);
        return;
      case 'url':
        window.open(intent.url, '_blank', 'noopener,noreferrer');
        return;
      default:
    }
  };

  // A build's images to the Deploy stage: the environment chosen stays when
  // they can go there, else the first that takes them.
  const deployImages = (b: IdeBuild) => {
    const current = map.environment.step?.environment;
    const keep = !!current && imagesFit(b, current);
    show('deploy', {
      build: b.buildId,
      env: keep && current ? current.id : (environments.find((e) => imagesFit(b, e))?.id ?? address.env),
    });
  };

  const imagesBuild = map.images.build;
  const environmentList = useMemo(
    () =>
      environmentRows(steps, (s) =>
        imagesBuild && hasDeployableImages(imagesBuild) ? fitGap(imagesBuild, s.environment, deployments).gap : 'none'
      ),
    [steps, imagesBuild, deployments]
  );
  const chooseEnvironment = useCallback((id: string) => choose({ env: id }), [choose]);
  // The Environment stage on the environments the chosen images can go to.
  const showFits = () => {
    replaceSearch(
      writeListState(window.location.search, { q: '', filters: { fits: 'yes' }, sort: null, page: 0 }, ENVIRONMENTS_ADDRESS)
    );
    show('environment');
  };
  const kit = !!path?.research_kit;
  const hasKubernetes = environmentList.some((r) => r.kind === 'kubernetes');
  const hasResearch = environmentList.some((r) => r.kind === 'research');
  const chosen = map.environment.step;
  // Build's own line says what comes next; the path speaks there only of what failed or blocks.
  const buildNote = [pathStep('build')].find((s) => s?.state === 'failed' || s?.state === 'blocked');
  const environmentNote = pathStep('environment');

  return (
    <ProjectPage
      title={t('title')}
      chips={unavailable && <Badge variant="secondary">{t('no_environments_here')}</Badge>}
      actions={
        targets && (
          <Button size="sm" variant="outline" onClick={() => setDialog({ environmentId: null, research: false })} data-deploy-to>
            {t('deploy_to')}
          </Button>
        )
      }
    >
      {!ready && !error && deploymentError === null && <PageLoading label={t('reading')} />}
      {productMissing && targets && <NoProductLine action={productAction} onIntent={onIntent} />}
      {shown && <DeploymentDetail key={shown} id={shown} onClose={() => setShown(null)} onIntent={onIntent} />}
      {dialog && targets && (
        <DeployDialog
          environments={environments}
          builds={builds}
          deployments={deployments}
          path={path}
          focus={dialog}
          onClose={() => setDialog(null)}
          onChanged={changed}
          onIntent={onIntent}
        />
      )}
      {error && <ErrorLine>{error}</ErrorLine>}
      {deploymentError !== null && (
        <ErrorLine>
          {t('release_deployments_unavailable')} {deploymentError}
        </ErrorLine>
      )}
      {notice && (
        <div className={styles.notice} role="status" data-deploy-notice>
          {notice}
        </div>
      )}
      {(targets || unavailable) && (
        <ReleaseMap map={map} names={names} selected={stage} onSelect={(s) => show(s)} productMissing={productMissing} />
      )}
      {(targets || unavailable || error) && (
        <section
          ref={panel}
          id="release-stage-panel"
          role="tabpanel"
          aria-labelledby={`release-stage-${stage}`}
          className={styles.card}
          data-release-stage={stage}
        >
          {stage === 'build' && (
            <section className={styles.stack} data-stage-panel="build" data-releases-builds>
              <StageHead stage="build">
                {path?.research_kit && (
                  <Button
                    size="sm"
                    disabled={!!blocked}
                    title={blocked ?? t('research_run_title')}
                    onClick={() => setDialog({ environmentId: null, research: true })}
                    data-research-open
                  >
                    {t('research_run')}
                  </Button>
                )}
              </StageHead>
              {buildNote && <PathStepNote step={buildNote} onIntent={onIntent} />}
              {buildRead === 'ready' && product.length === 0 && (
                <div className={styles.emptyState} data-releases-empty="builds">
                  <p className={styles.muted}>{t('builds_empty')}</p>
                </div>
              )}
              {buildRead === 'failed' && <ErrorLine>{t('release_builds_unavailable')}</ErrorLine>}
              <ProjectBuilds
                ideBuilds={builds}
                environments={environments}
                environmentsReady={targets !== null}
                round={round}
                now={now}
                runningIn={runningIn}
                onImages={(b) => show('images', { build: b.buildId })}
              />
            </section>
          )}
          {stage === 'images' && (
            <ImagesStage
              builds={product}
              map={map}
              pathStep={pathStep('image')}
              onPick={(id) => choose({ build: id })}
              onDeploy={deployImages}
              onFits={showFits}
              onStage={(s) => show(s)}
              onIntent={onIntent}
            />
          )}
          {stage === 'environment' && (
            <section className={styles.stack} data-stage-panel="environment" data-step="deploy">
              <StageHead stage="environment">
                {chosen && (
                  <Button
                    size="sm"
                    disabled={!!blocked}
                    title={blocked ?? undefined}
                    onClick={() => show('deploy')}
                    data-environment-next
                  >
                    {t('environment_next', { environment: chosen.environment.name })}
                  </Button>
                )}
              </StageHead>
              {environmentNote && <PathStepNote step={environmentNote} onIntent={onIntent} />}
              {unavailable ? (
                <p className={styles.muted}>{t('no_environments_backend')}</p>
              ) : (
                targets && (
                  <>
                    {!hasKubernetes && (
                      <div className={styles.stack} data-releases-empty="kubernetes">
                        <p className={styles.muted}>{t(noEnvironmentKey)}</p>
                        {noEnvironmentKey === 'no_environment' && (
                          <div className={styles.row}>
                            <Button size="sm" variant="outline" onClick={() => openScreen(bridge, ROUTES.infrastructure)}>
                              {t('open_build_infrastructure')}
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                    {kit && !hasResearch && <p className={styles.muted} data-releases-empty="research">{t('group_research_empty')}</p>}
                    {!kit && hasResearch && <p className={styles.muted}>{t('group_research_no_kit')}</p>}
                    {environmentList.length > 0 && (
                      <EnvironmentsGrid
                        rows={environmentList}
                        names={names}
                        selected={chosen?.environment.id ?? null}
                        blocked={blocked}
                        build={imagesBuild?.buildId ?? null}
                        onSelect={chooseEnvironment}
                      />
                    )}
                  </>
                )
              )}
              {targets && chosen && (
                <section className={styles.stack} data-environment-chosen={chosen.environment.name}>
                  <h3 className={styles.subTitle}>{t('environment_settings', { environment: chosen.environment.name })}</h3>
                  <EnvironmentDetail step={chosen} bindings={targets.bindings} />
                  <EnvironmentPreviews env={chosen.environment} deployments={deployments} onChanged={changed} />
                  <EnvironmentConfig
                    key={`${chosen.environment.id}-${round}`}
                    env={chosen.environment}
                    bindings={targets.bindings}
                    secrets={targets.secrets ?? []}
                    onChanged={changed}
                  />
                </section>
              )}
              {targets && targets.environments.length > 0 && (
                // Folded: the exception, not the way a release goes (ADR-0056 §1).
                <details className={styles.card} data-project-own-environments>
                  <summary className={styles.summary}>
                    <b>{t('own_environments')}</b> <span className={styles.muted}>{t('own_environments_sub')}</span>
                  </summary>
                  <ProjectBindings key={round} targets={targets} onSaved={() => changed(t('bindings_saved'))} />
                </details>
              )}
            </section>
          )}
          {stage === 'deploy' && (
            <DeployStage
              map={map}
              deployments={deployments}
              blocked={blocked}
              pathStep={pathStep('running')}
              onChanged={changed}
              onIntent={onIntent}
              onStage={(s) => show(s)}
              onShow={setShown}
            />
          )}
        </section>
      )}
    </ProjectPage>
  );
}
