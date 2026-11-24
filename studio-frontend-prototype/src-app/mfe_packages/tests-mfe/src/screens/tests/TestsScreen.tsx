/**
 * Project › Tests — the first built-in kit (ADR-0068 §7, ADR-0069 §5), the
 * prototype's Tests tab carried over: does what we built work, and is what
 * the specs say checked? A header with the mainline's state and what could
 * not be read; three cards (the mainline's CI, the open pull requests',
 * spec ↔ code); then the CI runs of the last two weeks and the open pull
 * requests. A "test" here is a CI job: the sync reads every run's jobs and
 * the step a failed one failed at.
 *
 * The joins below (runs × repositories × pull requests × document checks ×
 * conformance) are a backend candidate: an agent asking "is this project
 * green?" should get the same answer from one route.
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { ChildMfeBridge } from '@gears-frontx/react';
import {
  apiRegistry,
  useSharedProperty,
  FRONTX_SHARED_PROPERTY_THEME,
  FRONTX_SHARED_PROPERTY_LANGUAGE,
} from '@gears-frontx/react';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@gears-frontx/ui-kit';
import {
  useScreenAvailability,
  openScreen,
  STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT,
  STUDIO_SHARED_PROPERTY_CONTEXT_WORKSPACE,
} from '@constructor-studio/mfe-shared';
import { GridFailed } from '@constructor-studio/mfe-shared/grid';
import { PageEmpty, PageLoading, ProjectPage } from '@constructor-studio/mfe-shared/page';
import { TestsApiService } from '../../api/TestsApiService';
import type { CiRunList, Conformance, OpenPullRequest, PullRequestChecks } from '../../api/types';
import {
  ciReadFailures,
  dailyStrip,
  failedJobLabel,
  mainline,
  passRate,
  pullRun,
  pullsCi,
  readProblem,
  repoPathsOf,
  runStatus,
  specCode,
  type BuildStatus,
} from '../../model/tests';
import { useTestsTranslations } from '../../i18n';
import { PullsGrid, RunsGrid, relTime, tone, type PullGridRow } from './TestsGrids';
import styles from './TestsScreen.module.css';

const DAY_MS = 86_400_000;
const DARK_HOST_THEMES = ['dark', 'dracula', 'dracula-large'];

type Text = ReturnType<typeof useTestsTranslations>['t'];

interface Read {
  /** When it was read: the cards and the strip agree on what "today" is. */
  at: number;
  runs: CiRunList;
  repoPaths: Map<string, string>;
  failures: { repo: string; error: string }[];
  pulls: OpenPullRequest[] | null;
}

type Failed = { error: string };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function useBridgeString(bridge: ChildMfeBridge, property: string, fallback: string): string {
  const read = () => {
    const v = bridge.getProperty(property)?.value;
    return typeof v === 'string' ? v : fallback;
  };
  const [value, setValue] = useState(read);
  useEffect(
    () =>
      bridge.subscribeToProperty(property, (p) => {
        if (typeof p.value === 'string') setValue(p.value);
      }),
    [bridge, property]
  );
  return value;
}

/** The project and workspace in scope, from the shell's shared properties. */
function useScope(): { projectId: string | null; workspaceId: string | null } {
  const project = useSharedProperty(STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT);
  const workspace = useSharedProperty(STUDIO_SHARED_PROPERTY_CONTEXT_WORKSPACE) as { id?: string } | null;
  return {
    projectId: typeof project === 'string' && project ? project : null,
    workspaceId: workspace && typeof workspace.id === 'string' ? workspace.id : null,
  };
}

export const TestsScreen: React.FC<{ bridge: ChildMfeBridge }> = ({ bridge }) => {
  const theme = useBridgeString(bridge, FRONTX_SHARED_PROPERTY_THEME, 'default');
  const language = useBridgeString(bridge, FRONTX_SHARED_PROPERTY_LANGUAGE, 'en');
  const { t, loading } = useTestsTranslations();
  const { projectId, workspaceId } = useScope();
  // The open pull requests are project-git's `pull-request` (ADR-0071 §5):
  // without that type the tab shows CI runs and conformance, and no pull
  // request. Unknown shows them.
  const pullsShown = useScreenAvailability().type(PULL_REQUEST_TYPE);

  return (
    <div className={styles.screen} data-theme={DARK_HOST_THEMES.includes(theme) ? 'dark' : 'light'}>
      {loading ? (
        <ProjectPage title={null} busy>
          <PageLoading />
        </ProjectPage>
      ) : !projectId ? (
        <ProjectPage title={t('title')}>
          <PageEmpty title={t('no_project')} />
        </ProjectPage>
      ) : (
        // Keyed by the scope: another project is another read, from nothing.
        <ProjectTests
          key={`${projectId}:${workspaceId ?? ''}:${pullsShown}`}
          pullsShown={pullsShown}
          projectId={projectId}
          workspaceId={workspaceId}
          t={t}
          language={language}
          onOpenSpecs={() => openScreen(bridge, '/projects/specs')}
        />
      )}
    </div>
  );
};

TestsScreen.displayName = 'TestsScreen';

/** The domain type the open pull requests section shows (`sectionNeeds` in mfe.json). */
export const PULL_REQUEST_TYPE = 'gts.cf.studio.domain.pull_request.v1~';

function ProjectTests({
  projectId,
  workspaceId,
  pullsShown,
  t,
  language,
  onOpenSpecs,
}: {
  projectId: string;
  workspaceId: string | null;
  /** Whether project-git's pull requests are installed here. */
  pullsShown: boolean;
  t: Text;
  language: string;
  /** Spec ↔ code is shown in full on Specs. */
  onOpenSpecs: () => void;
}) {
  const [read, setRead] = useState<Read | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Read apart, because each is slow in its own way and the CI answers without them.
  const [checks, setChecks] = useState<PullRequestChecks | Failed | null>(null);
  const [conformance, setConformance] = useState<Conformance | Failed | null>(null);
  // Bumped by Retry: the same reads, once more.
  const [attempt, setAttempt] = useState(0);
  const retry = () => {
    setError(null);
    setAttempt((n) => n + 1);
  };

  useEffect(() => {
    const forProject = projectId;
    let alive = true;
    const mine = () => alive;
    const api = apiRegistry.getService(TestsApiService);
    Promise.all([
      api.ciRuns({ projectId: forProject }).fetch({ staleTime: 0 }),
      api
        .repositories({ projectId: forProject })
        .fetch({ staleTime: 0 })
        .catch(() => null),
      pullsShown
        ? api
            .openPullRequests({ projectId: forProject })
            .fetch({ staleTime: 0 })
            .catch(() => null)
        : Promise.resolve(null),
    ])
      .then(([runs, repos, pulls]) => {
        if (!mine()) return;
        setRead({
          at: Date.now(),
          runs,
          repoPaths: repoPathsOf(repos?.nodes ?? []),
          failures: ciReadFailures(repos?.nodes ?? []),
          pulls: pulls?.items ?? null,
        });
      })
      .catch((e: unknown) => mine() && setError(message(e)));
    if (pullsShown)
      api.pullRequestChecks
        .fetch({ project_id: forProject, publish: false })
        .then((c) => mine() && setChecks(c))
        .catch((e: unknown) => mine() && setChecks({ error: message(e) }));
    if (workspaceId) {
      Promise.all([
        api.declaredCapabilities({ projectId: forProject }).fetch({ staleTime: 0 }),
        api.capabilities({ workspaceId }).fetch({ staleTime: 0 }),
      ])
        .then(([declared, vocab]) => {
          const terms: Record<string, string[]> = {};
          const contracts: Record<string, string[]> = {};
          for (const cap of vocab.items ?? []) {
            if (cap.terms?.length) terms[cap.key] = cap.terms;
            if (cap.contracts?.length) contracts[cap.key] = cap.contracts;
          }
          return api.conformance.fetch({
            project_id: forProject,
            capabilities: declared.items.map((c) => c.key),
            terms,
            contracts,
          });
        })
        .then((c) => mine() && setConformance(c))
        .catch((e: unknown) => mine() && setConformance({ error: message(e) }));
    }
    return () => {
      alive = false;
    };
  }, [projectId, workspaceId, attempt, pullsShown]);

  const now = read?.at ?? 0;
  const main = useMemo(() => (read ? mainline(read.runs, now) : null), [read, now]);
  const recent = useMemo(
    () => (read?.runs.items ?? []).filter((r) => Date.parse(r.created_at ?? '') >= now - 14 * DAY_MS),
    [read, now]
  );
  const strip = useMemo(() => dailyStrip(read?.runs.items ?? [], now), [read, now]);
  const prCi = useMemo(() => (read?.pulls ? pullsCi(read.pulls, read.runs.items, read.repoPaths) : null), [read]);
  const docCheck = useMemo(() => {
    const out = new Map<string, PullRequestChecks['items'][number]>();
    if (checks && 'items' in checks) for (const c of checks.items) out.set(`${c.repo}#${c.number}`, c);
    return out;
  }, [checks]);
  // A new array only when the pulls, the runs or the documents' checks change: each one reloads the grid.
  const pullRows = useMemo<PullGridRow[]>(
    () =>
      (read?.pulls ?? []).map((p: OpenPullRequest) => {
        const run = pullRun(p, read?.runs.items ?? [], read?.repoPaths ?? new Map());
        return { ...p, run, status: run ? runStatus(run) : null, doc: docCheck.get(`${p.repo}#${p.number}`) };
      }),
    [read, docCheck]
  );
  const docFailing =checks && 'items' in checks ? checks.items.filter((c) => c.state === 'failure').length : null;
  const spec = conformance && 'items' in conformance ? specCode(conformance) : null;

  const status = (s: BuildStatus) => t(`status_${s}`);
  return (
    <ProjectPage
      title={t('title')}
      help={t('about')}
      helpLabel={t('help_label')}
      chips={
        read && (
          <div className={styles.chips} data-tests-status>
            {main ? (
              <Badge variant={tone(main.status)} dot data-tests-status="mainline">
                {main.status === 'passed'
                  ? t('mainline_green')
                  : main.status === 'failed'
                    ? t('mainline_red')
                    : t('mainline_other', { status: status(main.status) })}
              </Badge>
            ) : (
              <span className={styles.muted}>{t('no_run_yet')}</span>
            )}
            {prCi && prCi.red > 0 && (
              <Badge variant="danger" data-tests-status="pulls">
                {t(prCi.red === 1 ? 'pulls_red_one' : 'pulls_red_many', {
                  count: prCi.red,
                })}
              </Badge>
            )}
            {read.failures.map((f) => (
              <Badge key={f.repo} variant="danger" title={f.error} data-tests-ci-error>
                {t(readProblem(f.error).connection ? 'read_problem' : 'read_problem_other', { repo: f.repo })}
              </Badge>
            ))}
          </div>
        )
      }
    >
      {error && <GridFailed message={t('load_failed', { error })} retry={t('retry')} onRetry={retry} />}
      {!error && !read && <PageLoading label={t('loading')} />}

      {read && (
        <div className={styles.cards} data-tests-cards>
          <Card data-tests-mainline>
            <CardHeader>
              <CardTitle>
                {t('card_mainline')}
                {main?.branch ? ` · ${main.branch}` : ''}
              </CardTitle>
            </CardHeader>
            <CardContent className={styles.cardBody}>
              <span className={styles.big}>
                {main
                  ? main.status === 'passed'
                    ? t('ci_passed')
                    : main.status === 'failed'
                      ? t('ci_failed')
                      : status(main.status)
                  : t('no_run')}
              </span>
              {main && (
                <>
                  <span className={styles.muted}>
                    {main.run.url && /^https?:\/\//i.test(main.run.url) ? (
                      <a href={main.run.url} target="_blank" rel="noreferrer" className={styles.link}>
                        {main.run.workflow}
                      </a>
                    ) : main.run.workflow} · <code>{main.run.sha.slice(0, 7)}</code> ·{' '}
                    {relTime(main.run.created_at, language, now)}
                  </span>
                  {main.failed.map((j) => (
                    <span key={j.name} className={styles.failed} data-tests-mainline-failed>
                      ✗ {failedJobLabel(j)}
                    </span>
                  ))}
                  <span className={styles.muted}>
                    {main.week
                      ? t('week', {
                          rate: passRate(main.week),
                          finished: main.week.finished,
                        })
                      : t('no_week')}
                  </span>
                </>
              )}
            </CardContent>
          </Card>

          {pullsShown && (
            <Card data-tests-pulls-card>
              <CardHeader>
                <CardTitle>{t('card_pulls')}</CardTitle>
              </CardHeader>
              <CardContent className={styles.cardBody}>
                <span className={styles.big}>
                  {read.pulls === null
                    ? '—'
                    : read.pulls.length === 0
                      ? t('none_open')
                      : t('pulls_green', {
                          green: prCi?.green ?? 0,
                          total: read.pulls.length,
                        })}
                </span>
                {prCi && read.pulls && read.pulls.length > 0 && (
                  <span className={styles.muted}>
                    {[
                      prCi.red ? t('pulls_parts_red', { count: prCi.red }) : null,
                      prCi.running ? t('pulls_parts_running', { count: prCi.running }) : null,
                      prCi.none ? t('pulls_parts_none', { count: prCi.none }) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ') || t('pulls_all_green')}
                  </span>
                )}
                <span className={styles.muted}>
                  {checks === null
                    ? t('docs_checking')
                    : 'error' in checks
                      ? t('docs_error')
                      : checks.total === 0
                        ? t('docs_none')
                        : docFailing
                          ? t.count('docs_failing', docFailing)
                          : t('docs_pass')}
                </span>
              </CardContent>
            </Card>
          )}

          <Card data-tests-spec-card>
            <CardHeader>
              <CardTitle>{t('card_spec')}</CardTitle>
            </CardHeader>
            <CardContent className={styles.cardBody}>
              {conformance && 'error' in conformance ? (
                <span className={styles.error} title={conformance.error} data-tests-spec-error>
                  {t('spec_error')}
                </span>
              ) : (
                <>
                  <span className={styles.big}>
                    {spec
                      ? t('spec_covered', {
                          implemented: spec.implemented,
                          functional: spec.functional,
                        })
                      : '…'}
                  </span>
                  <span className={styles.muted}>
                    {spec
                      ? [
                          spec.missing ? t('spec_missing', { count: spec.missing }) : t('spec_all'),
                          spec.nonfunctional
                            ? t('spec_nonfunctional', {
                                count: spec.nonfunctional,
                              })
                            : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')
                      : t('spec_reading')}
                  </span>
                  <button type="button" className={styles.link} onClick={onOpenSpecs} data-tests-open-specs>
                    {t('open_specs')}
                  </button>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {read && (
        <section className={styles.section} data-tests-runs>
          <h3 className={styles.sectionTitle}>{t('runs_title')}</h3>
          <div className={styles.strip} data-tests-strip>
            {strip.map((d) => (
              <span
                key={d.day}
                className={`${styles.day} ${d.failed ? styles.red : d.passed ? styles.green : ''}`}
                title={`${d.day}: ${d.passed} / ${d.failed}`}
              />
            ))}
          </div>
          <RunsGrid runs={recent} t={t} language={language} now={now} />
        </section>
      )}

      {read?.pulls && read.pulls.length > 0 && (
        <section className={styles.section} data-tests-pulls>
          <h3 className={styles.sectionTitle}>{t('pulls_title')}</h3>
          <PullsGrid rows={pullRows} checking={checks === null} t={t} />
        </section>
      )}
    </ProjectPage>
  );
}
