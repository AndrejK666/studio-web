/** The project release overview, with builds, deploy history and diagnostics on demand. */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChildMfeBridge } from '@gears-frontx/react';
import { useSharedProperty } from '@gears-frontx/react';
import { Badge, Button, Skeleton } from '@gears-frontx/ui-kit';
import { STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT, isNotFound, openScreen, screenView, useHostChrome, useScreenAvailability } from '@constructor-studio/mfe-shared';
import type { Deployment, PathAction, ProjectPath, ProjectTargets } from '../../api/types';
import { ROUTES, deploymentFromSearch, intentOf, pathSteps, type Intent, type SpecsSeen } from '../../model/path';
import { DeployDialog } from './DeployDialog';
import { DeploymentDetail } from './DeploymentDetail';
import { ActionButton, ProjectPathView } from './ProjectPath';
import { ideBuildsOf, type IdeBuild } from '../../model/builds';
import { deployableBuilds } from '../../model/project-deploys';
import { ladderSteps, releaseStatus, versionOf } from '../../model/releases';
import { useReleasesTranslations } from '../../i18n';
import { ProjectBindings } from './Bindings';
import { ProjectBuilds } from './Builds';
import { EnvironmentActions, EnvironmentConfig, EnvironmentPreviews } from './DeployActions';
import { DeployHistory } from './History';
import { noProduct } from '../../model/environment-targets';
import { EnvironmentGroups, NoProductLine, ResearchBuilds, useTargetNames } from './Targets';
import {
  ErrorLine,
  ReleasesProvider,
  StateBadge,
  TONE_BADGE,
  errText,
  useApi,
  useReleases,
  type ReleasesContextValue,
} from './parts';
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
        <Skeleton className={styles.skeleton} />
      ) : !projectId ? (
        <p className={styles.muted}>{t('no_project')}</p>
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

function Releases({ projectId, onOrganization }: { projectId: string; onOrganization: (id: string) => void }) {
  const { t, bridge } = useReleases();
  // Organization › Infrastructure is named only where its kit put the screen.
  const screens = useScreenAvailability();
  const noEnvironmentKey = screens.route(ROUTES.infrastructure) ? 'no_environment' : 'no_environment_admin';
  const api = useApi();
  const [path, setPath] = useState<ProjectPath | null>(null);
  const [specs, setSpecs] = useState<SpecsSeen>('unavailable');
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
  // Also open the environment a failed run leads to from the organization overview.
  const [addressedEnvironment] = useState(() => /^environment-([0-9a-f-]{36})$/.exec(
    screenView(window.location.search) ?? ''
  )?.[1] ?? null);
  const [open, setOpen] = useState<string | null>(addressedEnvironment);
  const [showBuilds, setShowBuilds] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const buildsSection = useRef<HTMLElement>(null);
  const environmentsSection = useRef<HTMLElement>(null);
  const openBuilds = () => {
    setShowBuilds(true);
    buildsSection.current?.scrollIntoView?.({ block: 'start' });
  };
  const changed = useCallback((message: string) => {
    setNotice(message);
    setRound((r) => r + 1);
  }, []);
  const follow = useCallback(() => setRound((r) => r + 1), []);

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
      () => { if (live) setBuildRead('failed'); }
    );
    void api.specPlan({ projectId }).fetch({ staleTime: 0 }).then(
      (p) => { if (live) setSpecs({ count: p.total ?? p.items?.length ?? 0 }); },
      () => { if (live) setSpecs('unavailable'); }
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

  const envName = (id: string) => targets?.environments.find((x) => x.environment.id === id)?.environment.name ?? id;
  const steps = targets ? ladderSteps(targets.environments, deployments, builds) : [];
  const noEnvironment = !!targets && targets.environments.length === 0;
  const readyBuilds = deployableBuilds(builds);
  const published = readyBuilds.length;
  const runningIn = steps.find((s) => !!s.runs)?.environment.name ?? null;
  const status = targets && !deploymentError && buildRead === 'ready' ? releaseStatus(steps, published) : null;

  const current = path?.steps.find((step) => step.id === path.current);
  const action = current?.action;
  const intent = action ? intentOf(action) : null;
  const hasAction = intent && intent.kind !== 'none' && (intent.kind !== 'screen' || screens.route(intent.route));
  const lastDeploy = deployments.reduce<Deployment | null>(
    (latest, deploy) => !deploy.preview && (!latest || deploy.requested_at > latest.requested_at) ? deploy : latest,
    null
  );

  // What a path step's or a cause's button does here.
  const onIntent = (intent: Intent, action: Partial<PathAction>) => {
    switch (intent.kind) {
      case 'screen':
        openScreen(bridge, intent.route);
        return;
      case 'tab':
        if (intent.tab === 'build') openBuilds();
        else {
          if (action.environment_id) setOpen(action.environment_id);
          environmentsSection.current?.scrollIntoView?.({ block: 'start' });
        }
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

  return (
    <div className={styles.stack}>
      <header className={styles.header}>
        <h1 className={styles.title}>{t('title')}</h1>
        <div className={styles.chips} data-release-status>
          {status ? (
            status.map((c) => (
              <Badge key={c.text} variant={TONE_BADGE[c.tone]}>
                {c.text}
              </Badge>
            ))
          ) : unavailable ? (
            <Badge variant="secondary">{t('no_environments_here')}</Badge>
          ) : (
            !error && deploymentError === null && buildRead !== 'failed' && <span className={styles.muted}>{t('reading')}</span>
          )}
        </div>
      </header>
      {(targets || unavailable) && (
        <section className={styles.card} data-release-overview>
          <h2 className={styles.subTitle}>{t('release_overview')}</h2>
          <dl className={styles.releaseFacts}>
            <div>
              <dt>{t('newest_build')}</dt>
              <dd>{buildRead === 'ready'
                ? readyBuilds[0]?.chartVersion ?? readyBuilds[0]?.buildId ?? t('nothing_published')
                : t(buildRead === 'failed' ? 'release_builds_unavailable' : 'reading')}</dd>
            </div>
            <div>
              <dt>{t('release_last_deployment')}</dt>
              <dd>
                {deploymentError !== null ? t('release_deployments_unavailable') : lastDeploy ? (
                  <span className={styles.chips}>
                    <button type="button" className={styles.releaseLink} onClick={() => setShown(lastDeploy.id)}>
                      {lastDeploy.environment_name} · {versionOf(lastDeploy) ?? lastDeploy.product}
                    </button>
                    <StateBadge d={lastDeploy} />
                  </span>
                ) : t('nothing_deployed')}
              </dd>
            </div>
          </dl>
          {current?.reason && <p className={styles.muted}>{current.reason}</p>}
          <div className={styles.row}>
            {action && hasAction ? (
              <ActionButton action={action} onIntent={onIntent} />
            ) : buildRead !== 'loading' && published === 0 && (
              <Button size="sm" onClick={openBuilds}>{t('release_view_builds')}</Button>
            )}
            {targets && (
              <Button size="sm" variant={hasAction || published === 0 ? 'outline' : 'default'}
                onClick={() => setDialog({ environmentId: null, research: false })} data-deploy-to>
                {t('deploy_to')}
              </Button>
            )}
          </div>
        </section>
      )}
      {shown && <DeploymentDetail key={shown} id={shown} onClose={() => setShown(null)} onIntent={onIntent} />}
      {dialog && targets && (
        <DeployDialog
          environments={targets.environments.map((x) => x.environment)}
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
      {deploymentError !== null && <ErrorLine>{deploymentError}</ErrorLine>}
      {notice && (
        <div className={styles.notice} role="status" data-deploy-notice>
          {notice}
        </div>
      )}
      {(targets || unavailable || error) && (
        <>
          <section ref={environmentsSection} className={styles.stack} data-step="deploy">
            <h2 className={styles.subTitle}>{t('release_environments')}</h2>
            {productMissing && targets && <NoProductLine action={productAction} onIntent={onIntent} />}
            {unavailable ? (
              <p className={styles.muted}>{t('no_environments_backend')}</p>
            ) : targets && !deploymentError && (
              <EnvironmentGroups
                steps={steps}
                path={path}
                names={names}
                blocked={blocked}
                onResearch={() => setDialog({ environmentId: null, research: true })}
                noEnvironment={
                  <div className={styles.stack}>
                    <p className={styles.muted}>{t(noEnvironmentKey)}</p>
                    {noEnvironmentKey === 'no_environment' && (
                      <div className={styles.row}>
                        <Button size="sm" variant="outline" onClick={() => openScreen(bridge, ROUTES.infrastructure)}>
                          {t('open_build_infrastructure')}
                        </Button>
                      </div>
                    )}
                  </div>
                }
                bindings={targets.bindings}
                open={open}
                onOpen={(id) => setOpen(open === id ? null : id)}
                onChanged={changed}
                panel={(s) => (
                  <section className={styles.stack} data-release-step={s.environment.name}>
                    <div className={styles.headRow}>
                      <h3 className={styles.subTitle}>{s.environment.name}</h3>
                      <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>
                        {t('close')}
                      </Button>
                    </div>
                    <EnvironmentActions
                      env={s.environment}
                      latest={s.latest ?? undefined}
                      deployments={deployments}
                      builds={builds}
                      envName={envName}
                      onChanged={changed}
                    />
                    <EnvironmentPreviews env={s.environment} deployments={deployments} onChanged={changed} />
                    <EnvironmentConfig
                      key={`${s.environment.id}-${round}`}
                      env={s.environment}
                      bindings={targets.bindings}
                      secrets={targets.secrets ?? []}
                      onChanged={changed}
                    />
                  </section>
                )}
              />
            )}
            {targets && !noEnvironment && (
              // Folded: the exception, not the way a release goes (ADR-0056 §1).
              <details className={styles.card} data-project-own-environments>
                <summary className={styles.summary}>
                  <b>{t('own_environments')}</b> <span className={styles.muted}>{t('own_environments_sub')}</span>
                </summary>
                <ProjectBindings key={round} targets={targets} onSaved={() => changed(t('bindings_saved'))} />
              </details>
            )}
          </section>
          <section ref={buildsSection} className={styles.card} data-releases-builds>
            <div className={styles.sectionHead}>
              <span className={styles.groupText}>
                <h2 className={styles.subTitle}>{t('builds_title')}</h2>
                <span className={styles.muted}>{t('builds_about')}</span>
              </span>
              <Button size="sm" variant="outline" aria-expanded={showBuilds} data-release-tab="build"
                onClick={() => setShowBuilds(!showBuilds)}>{t(showBuilds ? 'builds_hide' : 'builds_show')}</Button>
            </div>
            {buildRead === 'ready' && builds.length === 0 && !showBuilds && (
              <div className={styles.emptyState} data-releases-empty="builds">
                <p className={styles.muted}>{t('builds_empty')}</p>
                {!productMissing && path?.research_kit && (
                  <div className={styles.row}>
                    <Button size="sm" variant="outline" onClick={() => setDialog({ environmentId: null, research: true })}>
                      {t('research_run')}
                    </Button>
                  </div>
                )}
              </div>
            )}
            {!showBuilds && targets && <ResearchBuilds builds={builds} environments={targets.environments} names={names} />}
            {showBuilds && (
              <ProjectBuilds
                ideBuilds={builds}
                environments={targets?.environments.map((x) => x.environment) ?? []}
                environmentsReady={targets !== null}
                deployments={deployments}
                round={round}
                now={now}
                onChanged={changed}
                onFollow={follow}
                runningIn={runningIn}
              />
            )}
          </section>
          <section className={styles.card} data-releases-history>
            <div className={styles.sectionHead}>
              <span className={styles.groupText}>
                <h2 className={styles.subTitle}>{t('release_history')}</h2>
                <span className={styles.muted}>{t('history_about')}</span>
              </span>
              {deployments.length > 0 && (
                <Button size="sm" variant="outline" aria-expanded={showHistory} data-release-tab="history"
                  onClick={() => setShowHistory(!showHistory)}>
                  {showHistory ? t('history_hide') : t.count('history_show', deployments.length)}
                </Button>
              )}
            </div>
            {deployments.length === 0 && deploymentError === null && (
              <div className={styles.emptyState} data-releases-empty="history">
                <p className={styles.muted}>{t('history_empty')}</p>
              </div>
            )}
            {showHistory && <DeployHistory deployments={deployments} />}
          </section>
        </>
      )}
      {path && (
        <details className={styles.card}>
          <summary className={styles.summary}>{t('release_diagnostics')}</summary>
          <ProjectPathView
            steps={pathSteps(path, specs)}
            current={path.current}
            specsCount={specs === 'unavailable' ? null : specs.count}
            onIntent={onIntent}
          />
        </details>
      )}
    </div>
  );
}
