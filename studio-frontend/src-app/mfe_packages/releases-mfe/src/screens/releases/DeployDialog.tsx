/**
 * Deploy to… (#1053): one dialog listing every target the project may use --
 * the environments up the ladder (the organization's that admit it, and its
 * own) and, where the Constructor Research kit applies, the caller's
 * Research projects. The server answers `research_kit` on the project's
 * path and the Research projects only where the kit applies, so without the
 * kit the Research target is simply absent.
 *
 * Compact: the Research target first (it builds and runs in one go), then
 * the environments as a dense list -- one row each with what runs there and
 * what can go there -- in a scroll area of its own, so the Research run and
 * the Deploy buttons stay in view. Environments where nothing can go yet
 * fold into one line; a search narrows the list once there are many.
 *
 * A Research target shows the caller's sign-in (and leads to signing in),
 * the Research project and hardware to run on (the kit's
 * `research_projects`/`research_hardware`, read with the caller's own
 * sign-in), then builds the product there -- following the build with a
 * progress bar and its log -- deploys that build, and gives the
 * application's public link once it runs. A failure says its cause and the
 * action that fixes it (#1054). One Research environment per Research
 * project: the dialog reuses it, and the server changes it rather than
 * adding another when the hardware or the sign-in changed.
 *
 * FrontX 0.4 gives a screen no slot of its own inside its page
 * (`app/mfe/slots.ts`), so the kit's contribution is its data: the target
 * appears from what the server says the kit makes possible.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useScreenAvailability } from '@constructor-studio/mfe-shared';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  NativeSelect,
  NativeSelectOption,
} from '@gears-frontx/ui-kit';
import type { Deployment, DeployEnvironment, PathAction, ProjectPath, ResearchHardware, ResearchProject } from '../../api/types';
import type { IdeBuild } from '@constructor-studio/mfe-shared';
import { SEARCH_FROM, deployTargets, type TargetRow } from '../../model/deploy-targets';
import {
  ROUTES,
  ended,
  pickableResearchProjects,
  researchEnvironmentFor,
  researchEnvironmentInput,
  researchEnvironmentStale,
  type Intent,
} from '../../model/path';
import { researchProgressOf, type ResearchProgress as Progress } from '../../model/research-progress';
import { useDeployRequest } from './DeployActions';
import { CauseView } from './ProjectPath';
import { ErrorLine, StateBadge, errText, useApi, useReleases } from './parts';
import { ResearchProgress } from './ResearchProgress';
import styles from './ReleasesScreen.module.css';

/** How often a Research build and its deploy are read again. */
const FOLLOW_MS = 4000;

export function DeployDialog({
  environments,
  builds,
  deployments,
  path,
  focus,
  onClose,
  onChanged,
  onIntent,
}: {
  environments: DeployEnvironment[];
  builds: IdeBuild[];
  /** The project's deployments, newest first: what each environment runs. */
  deployments: Deployment[];
  path: ProjectPath | null;
  /** The environment to start on, or the Research target. */
  focus: { environmentId: string | null; research: boolean };
  onClose: () => void;
  onChanged: (message: string) => void;
  onIntent: (intent: Intent, action: Partial<PathAction>) => void;
}) {
  const { t, container } = useReleases();
  // Organization › Infrastructure is named only where its kit put the screen.
  const noEnvironmentKey = useScreenAvailability().route(ROUTES.infrastructure) ? 'no_environment' : 'no_environment_admin';
  const research = !!path?.research_kit;
  const clusters = useMemo(() => environments.filter((e) => e.kind !== 'research' || research), [environments, research]);
  const [query, setQuery] = useState('');
  const [unfolded, setUnfolded] = useState(false);
  const targets = useMemo(
    () => deployTargets(clusters, builds, deployments, focus.environmentId, query),
    [clusters, builds, deployments, focus.environmentId, query]
  );
  // A search shows what matches, folded or not.
  const open = unfolded || query.trim() !== '';
  const done = (m: string) => {
    onChanged(m);
    onClose();
  };
  const row = (r: TargetRow, quiet: boolean) => (
    <EnvironmentTarget key={r.env.id} row={r} quiet={quiet} focused={focus.environmentId === r.env.id} onChanged={done} />
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent container={container} size="lg" closeLabel={t('close')} className={styles.deployDialog} data-deploy-dialog>
        <DialogHeader>
          <DialogTitle>{t('deploy_to_title')}</DialogTitle>
        </DialogHeader>
        <p className={styles.muted}>{t('deploy_to_about')}</p>
        {research && path && (
          // A plain wrapper: the dialog insets its children, and the
          // target's own border sits inside that inset.
          <div>
            <ResearchTarget
              path={path}
              environments={environments}
              onIntent={(intent, a) => {
                onClose();
                onIntent(intent, a);
              }}
              onChanged={onChanged}
            />
          </div>
        )}
        <section className={styles.targetsSection} data-deploy-environments>
          <div className={styles.targetsHead}>
            <h3 className={styles.subTitle}>{t('target_environments')}</h3>
            <span className={styles.muted}>{t.count('targets_count', clusters.length)}</span>
            {clusters.length >= SEARCH_FROM && (
              <Input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('targets_search')}
                aria-label={t('targets_search')}
                className={styles.targetSearch}
                data-deploy-search
              />
            )}
          </div>
          <div className={styles.targetsScroll} data-deploy-targets-scroll>
            {clusters.length === 0 ? (
              <p className={styles.muted}>{t(noEnvironmentKey)}</p>
            ) : (
              <>
                {targets.open.length > 0 && <ul className={styles.targetList}>{targets.open.map((r) => row(r, false))}</ul>}
                {targets.folded.length > 0 && (
                  <div data-deploy-folded={targets.folded.length}>
                    <button
                      type="button"
                      className={styles.foldLine}
                      aria-expanded={open}
                      onClick={() => setUnfolded((u) => !u)}
                      data-deploy-unfold
                    >
                      <span aria-hidden className={styles.foldMark}>
                        {open ? '▾' : '▸'}
                      </span>
                      {t.count('targets_nothing_to_deploy', targets.folded.length)}
                    </button>
                    {open && <ul className={styles.targetList}>{targets.folded.map((r) => row(r, true))}</ul>}
                  </div>
                )}
                {targets.open.length === 0 && targets.folded.length === 0 && (
                  <p className={styles.muted}>{t('targets_none_match')}</p>
                )}
              </>
            )}
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}

/** One environment as one row: its name, what runs there, and the newest
 *  build that may go there with its Deploy button. */
function EnvironmentTarget({
  row,
  quiet,
  focused,
  onChanged,
}: {
  row: TargetRow;
  quiet: boolean;
  focused: boolean;
  onChanged: (message: string) => void;
}) {
  const { t } = useReleases();
  const { env, newest, latest } = row;
  const { busy, error, ask } = useDeployRequest(onChanged);
  const version = newest ? (newest.chartVersion ?? newest.buildId) : '';
  return (
    <li
      className={styles.targetRow}
      data-deploy-target={env.id}
      data-deploy-target-focused={focused || undefined}
      data-deploy-target-quiet={quiet || undefined}
    >
      <span className={styles.targetName}>
        <b title={env.name}>{env.name}</b>
        {env.kind === 'research' && <Badge variant="secondary">{t('target_research_short')}</Badge>}
        {env.protected && <Badge variant="warning">{t('needs_approval')}</Badge>}
      </span>
      <span className={styles.targetState} data-deploy-target-state>
        {latest ? <StateBadge d={latest} /> : <span className={styles.muted}>{t('target_nothing_deployed')}</span>}
      </span>
      {/* Folded, a row says only what runs there: the line above it says
          nothing can go there yet. */}
      {!quiet && (
        <span className={styles.targetAction}>
          {newest ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void ask(
                  { environment_id: env.id, build: newest.buildId },
                  t('what_deploy_to', { version, environment: env.name })
                )
              }
            >
              {t('target_deploy', { version })}
            </Button>
          ) : (
            <span className={styles.muted}>{t('target_no_build_short')}</span>
          )}
        </span>
      )}
      {error && (
        <span className={styles.targetError}>
          <ErrorLine>{error}</ErrorLine>
        </span>
      )}
    </li>
  );
}

type Run =
  | { at: 'idle' }
  | {
      at: 'building';
      buildId: string;
      runId: string;
      environmentId: string;
      lines: string[];
      progress: Progress | null;
    }
  | {
      at: 'deploying';
      buildId: string;
      deployment: Deployment | null;
      lines: string[];
    }
  | { at: 'done'; deployment: Deployment }
  | {
      at: 'failed';
      deployment: Deployment | null;
      message: string;
      /** A build that asked Research for its images before it failed: they may be deployed. */
      built?: { buildId: string; environmentId: string };
    };

/** What the bar says in each state of a run. */
function progressOf(run: Run): Progress | null {
  switch (run.at) {
    case 'building':
      return run.progress ?? { step: 'prepare' };
    case 'deploying':
      return { step: 'deploy' };
    case 'done':
      return { step: 'ready' };
    default:
      return null;
  }
}

/** The caller's Research: sign-in, project and hardware, then build, deploy, link. */
function ResearchTarget({
  path,
  environments,
  onIntent,
  onChanged,
}: {
  path: ProjectPath;
  environments: DeployEnvironment[];
  onIntent: (intent: Intent, action: Partial<PathAction>) => void;
  onChanged: (message: string) => void;
}) {
  const { t, projectId, organizationId } = useReleases();
  const api = useApi();
  const signIn = path.research?.state ?? 'none';
  const signedIn = signIn === 'signed_in' || signIn === 'runs_out';
  const [projects, setProjects] = useState<ResearchProject[] | null>(null);
  const [connection, setConnection] = useState<string | null>(null);
  const [picked, setPicked] = useState('');
  const [hardware, setHardware] = useState<ResearchHardware[]>([]);
  const [hw, setHw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<Run>({ at: 'idle' });
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    api
      .myResearchProjects({ projectId })
      .fetch({ staleTime: 0 })
      .then((r) => {
        if (!live) return;
        const listed = pickableResearchProjects(r.items);
        setProjects(listed);
        setConnection(r.connection_id);
        setPicked((p) => p || listed[0]?.id || '');
      })
      .catch((e: unknown) => live && setError(errText(e)));
    return () => {
      live = false;
    };
  }, [api, projectId, signedIn]);

  useEffect(() => {
    if (!picked) return;
    let live = true;
    api
      .myResearchHardware({ projectId, researchProject: picked })
      .fetch({ staleTime: 0 })
      .then((r) => live && setHardware(r.items))
      .catch(() => live && setHardware([]));
    return () => {
      live = false;
    };
  }, [api, projectId, picked]);

  // Follow the build, then the deploy, until each ends.
  useEffect(() => {
    if (run.at !== 'building' && run.at !== 'deploying') return;
    let live = true;
    const timer = window.setTimeout(async () => {
      try {
        if (run.at === 'building') {
          const [b, task] = await Promise.all([
            api.build({ projectId, buildId: run.buildId }).fetch({ staleTime: 0 }),
            api
              .taskRun({ runId: run.runId, tenantId: organizationId })
              .fetch({ staleTime: 0 })
              .catch(() => null),
          ]);
          if (!live) return;
          const said = task?.progress?.trim();
          const lines = said && !seen.current.has(said) ? [...run.lines, said] : run.lines;
          if (said) seen.current.add(said);
          const progress = researchProgressOf(task?.result) ?? run.progress;
          // The build's run starts the deploy itself (then_deploy): follow it.
          if (b.status === 'passed' && b.deployment_id) {
            const d = await api.deployment({ projectId, id: b.deployment_id }).fetch({ staleTime: 0 });
            if (!live) return;
            setRun({
              at: 'deploying',
              buildId: run.buildId,
              deployment: d,
              lines,
            });
          } else if (b.status === 'passed' && b.deploy_failure) {
            setRun({
              at: 'failed',
              deployment: null,
              message: b.deploy_failure,
              built: { buildId: run.buildId, environmentId: run.environmentId },
            });
          } else if (ended(b.status) && b.status !== 'passed') {
            setRun({
              at: 'failed',
              deployment: null,
              message: b.cause?.summary ?? b.failure ?? t('research_build_failed'),
              built: b.images?.length ? { buildId: run.buildId, environmentId: run.environmentId } : undefined,
            });
          } else {
            setRun({ ...run, lines, progress });
          }
        } else if (run.deployment) {
          const d = await api.deployment({ projectId, id: run.deployment.id }).fetch({ staleTime: 0 });
          if (!live) return;
          if (d.state === 'succeeded') {
            setRun({ at: 'done', deployment: d });
            onChanged(t('research_runs'));
          } else if (ended(d.state))
            setRun({
              at: 'failed',
              deployment: d,
              message: d.outcome ?? d.reason ?? '',
            });
          else setRun({ ...run, deployment: d });
        }
      } catch (e) {
        if (live) setRun({ at: 'failed', deployment: null, message: errText(e) });
      }
    }, FOLLOW_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [api, projectId, organizationId, run, t, onChanged]);

  const project = projects?.find((p) => p.id === picked);
  const deploymentOff = project?.deployment_enabled === false;

  const start = async () => {
    if (!project || !connection || deploymentOff) return;
    setError(null);
    seen.current = new Set();
    try {
      // One environment per Research project: the one there is, changed by
      // the server when the hardware or the sign-in is not what it has.
      let env = researchEnvironmentFor(environments, project.id);
      if (!env || researchEnvironmentStale(env, connection, hw || null)) {
        env = await api.createProjectEnvironment(projectId).fetch(
          researchEnvironmentInput(
            connection,
            project,
            hw || null,
            environments.map((e) => e.name)
          )
        );
      }
      const started = await api.startBuild(projectId).fetch({ environment_id: env.id, then_deploy: true });
      setRun({
        at: 'building',
        buildId: started.build_id,
        runId: started.run_id,
        environmentId: env.id,
        lines: [],
        progress: null,
      });
    } catch (e) {
      setError(errText(e));
    }
  };

  // Deploy what the failed build had Research make: nothing is built again.
  const deployBuilt = async () => {
    if (run.at !== 'failed' || !run.built) return;
    const { buildId, environmentId } = run.built;
    setError(null);
    try {
      const d = await api.deployBuiltImages(projectId, buildId).fetch({ environment_id: environmentId });
      setRun({ at: 'deploying', buildId, deployment: d, lines: [] });
    } catch (e) {
      setError(errText(e));
    }
  };

  const busy = run.at === 'building' || run.at === 'deploying';
  const progress = progressOf(run);
  const lines = run.at === 'building' || run.at === 'deploying' ? run.lines : [];
  return (
    <section className={styles.researchTarget} data-deploy-target-research>
      <div className={styles.targetsHead}>
        <h3 className={styles.subTitle}>{t('target_research')}</h3>
        <span data-research-sign-in={signIn}>
          <Badge variant={signedIn ? (signIn === 'runs_out' ? 'warning' : 'success') : 'danger'}>
            {signIn === 'signed_in'
              ? t('research_signed_in')
              : signIn === 'runs_out'
                ? t.count('research_runs_out', path.research?.days_left ?? 0)
                : signIn === 'expired'
                  ? t('research_expired')
                  : t('research_not_signed_in')}
          </Badge>
        </span>
        {signIn !== 'signed_in' && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onIntent({ kind: 'screen', route: '/connections' }, { kind: 'sign_in' })}
          >
            {t('action_sign_in')}
          </Button>
        )}
      </div>
      {signedIn && projects !== null && projects.length === 0 && <p className={styles.muted}>{t('research_no_projects')}</p>}
      {signedIn && projects && projects.length > 0 && (
        <div className={styles.researchForm}>
          <NativeSelect
            value={picked}
            onChange={(e) => setPicked(e.target.value)}
            aria-label={t('research_project')}
            disabled={busy}
          >
            {projects.map((p) => (
              <NativeSelectOption key={p.id} value={p.id} disabled={p.deployment_enabled === false && p.id !== picked}>
                {p.deployment_enabled === false ? `${p.name || p.id} (${t('research_deployment_off_short')})` : p.name || p.id}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <NativeSelect value={hw} onChange={(e) => setHw(e.target.value)} aria-label={t('research_hardware')} disabled={busy}>
            <NativeSelectOption value="">{t('research_hardware_default')}</NativeSelectOption>
            {hardware.map((h) => (
              <NativeSelectOption key={h.id} value={h.id}>
                {h.trial ? `${h.name} (${t('research_trial')})` : h.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Button
            size="sm"
            disabled={busy || !picked || !connection || deploymentOff}
            onClick={() => void start()}
            data-research-run
          >
            {t('research_run')}
          </Button>
        </div>
      )}
      {deploymentOff && (
        <p className={styles.warn} data-research-deployment-off>
          {t('research_deployment_off')}
        </p>
      )}
      {error && <ErrorLine>{error}</ErrorLine>}
      {progress && (
        <div className={styles.stack} data-research-build={run.at === 'building' ? run.buildId : undefined}>
          {run.at === 'building' && <span className={styles.muted}>{t('research_building', { build: run.buildId })}</span>}
          {run.at === 'deploying' && <span className={styles.muted}>{t('research_deploying')}</span>}
          <ResearchProgress progress={progress} />
          {(run.at === 'building' || run.at === 'deploying') && (
            <pre className={`${styles.log} ${styles.pre} ${styles.researchLog}`} aria-live="polite" data-research-build-log>
              {lines.join('\n') || t('loading')}
            </pre>
          )}
        </div>
      )}
      {run.at === 'done' && (
        <p data-research-url>
          {run.deployment.public_url ? (
            <>
              {t('runs_at')}{' '}
              <a className={styles.link} href={run.deployment.public_url} target="_blank" rel="noreferrer">
                {run.deployment.public_url}
              </a>
            </>
          ) : (
            t('research_runs')
          )}
        </p>
      )}
      {run.at === 'failed' &&
        (run.deployment?.cause ? (
          <CauseView
            cause={run.deployment.cause}
            deploymentId={run.deployment.id}
            onIntent={(intent, a) => {
              if (a.kind === 'choose_hardware') setRun({ at: 'idle' });
              else onIntent(intent, a);
            }}
          />
        ) : (
          <ErrorLine>{run.message}</ErrorLine>
        ))}
      {run.at === 'failed' && run.built && (
        <Button size="sm" variant="outline" onClick={() => void deployBuilt()} data-research-deploy-built>
          {t('research_deploy_built')}
        </Button>
      )}
    </section>
  );
}
