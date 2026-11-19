/**
 * Organization › Overview, for the people who lead it (the prototype's
 * org-dashboard.tsx, ADR-0069 parity). One read — `GET /studio-organizations/
 * v1/overview` — and the prototype's words for it (overview/model.ts):
 *
 *   - the header: the organization, and how much needs attention;
 *   - four tiles: spend, delivery, specs, people;
 *   - "Needs attention › For you": the person's Inbox (InboxGroup.tsx; the
 *     server's `GET /studio-user/v1/me/inbox`), where the prototype had it;
 *   - "Needs attention › For others": refused connections, spend, who the
 *     stuck pull requests wait on, components to decide, idle people;
 *   - the workspaces, each with its worst project and why.
 *
 * Where a row, a tile or a workspace leads is a screen of this portal, and
 * only one that shows where the person is: a kit's screen (Costs, Components)
 * only where its kit is installed (`useScreenAvailability`). A target with no
 * screen here gets no button rather than a dead one.
 *
 * Not yet here: the metrics board (charts over 7/30/90 days, Constructor
 * Insight's figures) — panels the kits that own those figures contribute,
 * once a screen can mount a kit's contribution (parity.md).
 */

import React, { useId, useState } from 'react';
import {
  apiRegistry,
  useApiQuery,
  useMfeBridge,
  useSharedProperty,
  FRONTX_SHARED_PROPERTY_LANGUAGE,
} from '@gears-frontx/react';
import { Badge, Card, CardContent, CardHeader, CardTitle, Skeleton } from '@gears-frontx/ui-kit';
import {
  isRunEnding,
  openPlace,
  openScreen,
  useOrganization,
  useScreenAvailability,
  useStudioEventRefresh,
} from '@constructor-studio/mfe-shared';
import { requestWorkspace } from '../../actions/workspaceActions';
import { OverviewApiService } from '../../api/OverviewApiService';
import {
  GIT_KIT,
  attentionStatus,
  growthText,
  hasKit,
  othersAttention,
  workspaceLine,
  type NeedTarget,
} from '../../overview/model';
import type { OrgOverview, OrgPull, OrgRunFailure, OrgWorkspace } from '../../overview/types';
import { BackgroundApiService } from '../../api/BackgroundApiService';
import { RunDetails, when } from '../background/BackgroundGrids';
import { useBackgroundTranslations, useOverviewTranslations } from '../../i18n';
import { InboxGroup } from './InboxGroup';
import styles from './OverviewScreen.module.css';

type Text = ReturnType<typeof useOverviewTranslations>['t'];

/** The whole Inbox (`screens/inbox`), opened from the top bar too. */
const INBOX_ROUTE = '/inbox';

/** Where a row's action leads (the prototype's views): Costs is the
 *  `org-costs` kit's screen, Components (`gears`) the `components` kit's;
 *  either is offered only where its kit is installed. */
export const TARGET_ROUTE: Record<NeedTarget, string> = {
  connectors: '/connections',
  costs: '/costs',
  projects: '/organization/workspaces',
  gears: '/components',
  people: '/people',
  tasks: '/organization/tasks',
};

function money(value: number, currency: string, language: string): string {
  // A sum that rounds to nothing is $0, not -$0: a forecast or difference can come back as -0.2 (walk 2026-11-16).
  const whole = Math.round(value) === 0 ? 0 : value;
  try {
    return new Intl.NumberFormat(language, { style: 'currency', currency, maximumFractionDigits: 0 }).format(whole);
  } catch {
    return `${Math.round(whole)} ${currency}`;
  }
}

const shown = (v: number | null | undefined, t: Text) => (v === null || v === undefined ? t('unknown') : String(v));

export const OverviewScreen: React.FC = () => {
  const { org } = useOrganization();
  const published = useSharedProperty(FRONTX_SHARED_PROPERTY_LANGUAGE);
  const language = typeof published === 'string' && published ? published : 'en';
  const { t, loading } = useOverviewTranslations();
  if (loading || !org) return <Skeleton className={styles.skeleton} />;
  return <OrganizationOverview key={org.id} organizationId={org.id} name={org.name} t={t} language={language} />;
};

OverviewScreen.displayName = 'OverviewScreen';

function OrganizationOverview({
  organizationId,
  name,
  t,
  language,
}: {
  organizationId: string;
  name: string;
  t: Text;
  language: string;
}) {
  const bridge = useMfeBridge();
  const availability = useScreenAvailability();
  /** The route of a target, when its screen shows where the person is. */
  const routeOf = (target: NeedTarget): string | null =>
    availability.route(TARGET_ROUTE[target]) ? TARGET_ROUTE[target] : null;
  const go = (target: NeedTarget) => {
    const route = routeOf(target);
    if (!route) return;
    if (target === 'gears') openScreen(bridge, route, 'needs-decision');
    else openScreen(bridge, route);
  };
  const read = useApiQuery(apiRegistry.getService(OverviewApiService).overview({ organizationId }));
  // A run that ended (a sync, a report, a build) may change what needs
  // attention: read again, from the organization on screen's live channel.
  useStudioEventRefresh(isRunEnding, () => void read.refetch());
  const o: OrgOverview | undefined = read.data;
  const cash = (n: number) => money(n, o?.spend?.currency || 'USD', language);
  // A component decision is taken on the Components kit's screen: where it is not installed nobody here can take
  // it, so the row would lead nowhere. Other rows still say something worth knowing without their button.
  const others = o ? othersAttention(o, cash).filter((r) => r.action.target !== 'gears' || routeOf('gears') !== null) : [];
  // What waits on the reader, once their Inbox is read: the header counts both.
  const [you, setYou] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showSpecs, setShowSpecs] = useState(false);
  const detailsId = useId();
  const failingProjects = o?.workspaces.flatMap((ws) => ws.projects
    .filter((project) => (project.specs_failing ?? 0) > 0)
    .map((project) => ({ workspaceId: ws.id, workspace: ws.name, project }))) ?? [];

  return (
    <div className={styles.screen} data-org-overview>
      <header className={styles.header}>
        <h2 className={styles.title} title={t('about')}>
          {o?.name ?? name}
        </h2>
        {o ? (
          <Badge variant={others.length > 0 ? 'warning' : 'success'} dot data-attention-status>
            {attentionStatus(you, others.length)}
          </Badge>
        ) : read.isError ? (
          <Badge variant="danger">{t('unreadable')}</Badge>
        ) : (
          <Badge variant="info">{t('reading')}</Badge>
        )}
      </header>
      <p className={styles.about}>{t('about')}</p>

      {read.isError && (
        <p role="alert" className={styles.error}>
          {t('load_failed', { error: String(read.error) })}
        </p>
      )}
      {read.isLoading && <Skeleton className={styles.skeletonWide} />}

      {o && (
        <>
          <div className={styles.tiles} data-overview-tiles>
            <Tile title={t('tile_spend')} open={routeOf('costs') ? { label: t('open_costs'), go: () => go('costs') } : null}>
              {o.costs === 'hidden' ? (
                <span className={styles.muted}>{t('tile_spend_hidden')}</span>
              ) : o.costs === 'unreadable' || !o.spend ? (
                <span className={styles.muted}>{t('tile_spend_unreadable')}</span>
              ) : o.spend.has_prices === false ? (
                <span className={styles.muted}>{t('tile_spend_prices_missing')}</span>
              ) : o.spend.unpriced.length > 0 && o.spend.current === 0 ? (
                <span className={styles.muted}>{t('tile_spend_unpriced')}</span>
              ) : (
                <>
                  <span className={styles.big}>{cash(o.spend.current)}</span>
                  <span className={styles.muted}>
                    {t('tile_spend_sub', {
                      growth: growthText(o.spend.current, o.spend.previous),
                      forecast: cash(o.spend.forecast),
                    })}
                  </span>
                  {o.spend.unpriced.length > 0 && <span className={styles.muted}>{t('tile_spend_unpriced')}</span>}
                </>
              )}
            </Tile>
            {/* Pull requests are the Git kit's: without it there is no delivery tile, not an unknown one. */}
            {hasKit(o, GIT_KIT) && (
              <Tile
                title={t('tile_delivery')}
                open={routeOf('projects') ? { label: t('open_workspaces'), go: () => go('projects') } : null}
              >
                <span className={styles.big}>{t('tile_delivery_value', { merged: shown(o.delivery.merged, t) })}</span>
                <span className={styles.muted}>
                  {t('tile_delivery_sub', {
                    open: shown(o.delivery.open, t),
                    wait: shown(o.delivery.median_wait_days, t),
                  })}
                </span>
              </Tile>
            )}
            <Tile title={t('tile_specs')}>
              <span className={styles.big}>
                {t('tile_specs_value', { failing: shown(o.specs.failing, t), specs: shown(o.specs.specs, t) })}
              </span>
              <span className={styles.muted}>{t('tile_specs_sub', { findings: shown(o.specs.open_findings, t) })}</span>
              {failingProjects.length > 0 && <>
                <button type="button" className={styles.tileOpen} aria-expanded={showSpecs} onClick={() => setShowSpecs(!showSpecs)}>
                  {t('open_failing_specs')}
                </button>
                {showSpecs && <ul className={styles.list}>{failingProjects.map(({ workspaceId, workspace, project }) => (
                  <li key={project.id}>
                    <button type="button" className={styles.tileOpen} onClick={() => openPlace(bridge, {
                      organizationId, workspaceId, projectId: project.id, route: '/projects/specs', view: 'failing-specs',
                    })}>
                      {workspace} / {project.name} · {t('project_failing_specs', { count: project.specs_failing ?? 0 })}
                    </button>
                  </li>
                ))}</ul>}
              </>}
            </Tile>
            <Tile title={t('tile_people')} open={routeOf('people') ? { label: t('open_people'), go: () => go('people') } : null}>
              <span className={styles.big}>{t('tile_people_value', { active: shown(o.people.active, t) })}</span>
              <span className={styles.muted}>
                {t('tile_people_sub', { idle: shown(o.people.idle?.length ?? null, t) })}
              </span>
            </Tile>
          </div>

          <div className={styles.columns}>
            <Card data-org-needs>
              <CardHeader>
                <CardTitle>{t('needs_title')}</CardTitle>
              </CardHeader>
              <CardContent>
                <InboxGroup
                  organizationId={organizationId}
                  workspaces={o.workspaces.length}
                  t={t}
                  onCount={setYou}
                  onOpenInbox={() => openScreen(bridge, INBOX_ROUTE)}
                />
                <h3 className={styles.group}>
                  {t('for_others')}
                  {others.length > 0 && <span className={styles.count}>{others.length}</span>}
                </h3>
                {others.length === 0 ? (
                  <p className={styles.muted}>{t('nothing_waits')}</p>
                ) : (
                  <ul className={styles.list}>
                    {others.map((r) => {
                      const pulls = r.key === 'queue:nobody' ? o.pulls_without_reviewers : null;
                      const failures = r.action.target === 'tasks' ? o.recent_failures : null;
                      const hasDetails = !!(pulls?.length || failures?.length);
                      const show = expanded === r.key;
                      return (
                      <li key={r.key} className={`${styles.row} ${styles[r.tone]}`} data-attention={r.key.split(':')[0]}>
                        <b>{r.sentence}</b>
                        {r.detail && <span className={styles.muted}> · {r.detail}</span>}
                        {hasDetails ? (
                          <button type="button" className={styles.action} aria-expanded={show}
                            aria-controls={show ? detailsId : undefined}
                            onClick={() => setExpanded(show ? null : r.key)}>
                            {t(pulls ? 'show_unreviewed_pulls' : 'show_recent_failures')}
                          </button>
                        ) : routeOf(r.action.target) && (
                          <button type="button" className={styles.action} onClick={() => go(r.action.target)}>
                            {r.action.label}
                          </button>
                        )}
                        {show && hasDetails && (
                          <div id={detailsId} className={styles.attentionDetails}>
                            {pulls && <ul>{pulls.map((pull) => <PullDetails key={pull.id} pull={pull} t={t} />)}</ul>}
                            {failures && <>
                              <ul>{failures.map((run) => (
                                <FailedRun key={run.id} run={run} language={language}
                                  organizationId={organizationId} workspaces={o.workspaces} />
                              ))}</ul>
                              {routeOf('tasks') && <button type="button" className={styles.tileOpen} onClick={() => go('tasks')}>
                                {t('open_all_runs')}
                              </button>}
                            </>}
                          </div>
                        )}
                      </li>
                      );
                    })}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card data-org-workspaces>
              <CardHeader>
                <CardTitle>{t('workspaces_title')}</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className={styles.list}>
                  {o.workspaces.map((ws) => (
                    <li key={ws.id} className={styles.row} data-overview-workspace={ws.id}>
                      <b>{ws.name}</b>
                      <span className={styles.muted}> · {workspaceLine(ws, o.stuck_days)}</span>
                      {/* The workspace itself: the shell moves the session into it. */}
                      <button
                        type="button"
                        className={styles.action}
                        onClick={() => requestWorkspace(bridge, { id: ws.id, name: ws.name }, organizationId)}
                      >
                        {t('open_workspace')}
                      </button>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function PullDetails({ pull, t }: { pull: OrgPull; t: Text }) {
  const title = `#${pull.number} ${pull.title}`;
  const url = pull.url && /^https?:\/\//i.test(pull.url) ? pull.url : null;
  const repository = url?.match(/^https?:\/\/[^/]+\/(.+?)\/(?:pull|[-]\/merge_requests)\/\d+/i)?.[1];
  return (
    <li>
      {url
        ? <a href={url} target="_blank" rel="noreferrer">{title}</a>
        : <span>{title}</span>}
      <span className={styles.muted}>
        {' · '}{[pull.project, repository, t('pull_idle_days', { days: pull.quiet_days })].filter(Boolean).join(' · ')}
      </span>
    </li>
  );
}

interface FailedRunProps {
  run: OrgRunFailure;
  language: string;
  organizationId: string;
  workspaces: OrgWorkspace[];
}

function FailedRun(props: FailedRunProps) {
  const { run, language } = props;
  const [open, setOpen] = useState(false);
  return (
    <li>
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>{run.task_type} · {when(run.created_at, language)}</summary>
        {open && <FailedRunDetails {...props} />}
      </details>
    </li>
  );
}

function FailedRunDetails({ run, language, organizationId, workspaces }: FailedRunProps) {
  const { t: overviewText } = useOverviewTranslations();
  const { t } = useBackgroundTranslations();
  const bridge = useMfeBridge();
  const availability = useScreenAvailability();
  const result = useApiQuery(apiRegistry.getService(BackgroundApiService).run({ id: run.id, tenant: run.tenant_id }));
  if (result.data) {
    const { payload, last_error, progress } = result.data;
    const projectId = typeof payload.project_id === 'string' ? payload.project_id : run.tenant_id;
    const environmentId = typeof payload.environment_id === 'string' && /^[0-9a-f-]{36}$/.test(payload.environment_id)
      ? payload.environment_id : null;
    const workspace = workspaces.find((place) => place.projects.some((project) => project.id === projectId));
    const project = workspace?.projects.find((place) => place.id === projectId);
    const route = environmentId && availability.route('/releases')
      ? '/releases'
      : run.task_type.startsWith('connector.') && availability.route('/projects/sources')
        ? '/projects/sources'
        : '/projects/overview';
    const repo = typeof payload.repo_full_path === 'string' ? payload.repo_full_path : null;
    const firstLine = last_error?.split(/\r?\n/).find((line) => line.trim())?.trim();
    const reason = firstLine && firstLine.length > 240 ? `${firstLine.slice(0, 237)}…` : firstLine;
    return (
      <>
        <p className={styles.muted}>{reason || progress || overviewText('run_no_reason')}</p>
        {repo && <p className={styles.muted}>{repo}</p>}
        {workspace && project && (
          <button type="button" className={styles.tileOpen} onClick={() => openPlace(bridge, {
            organizationId, workspaceId: workspace.id, projectId, route,
            view: environmentId && route === '/releases' ? `environment-${environmentId}` : undefined,
          })}>
            {overviewText('run_open_project', { project: project.name })}
          </button>
        )}
        {environmentId && !(project && route === '/releases') && availability.route('/infrastructure') && (
          <button type="button" className={styles.tileOpen}
            onClick={() => openScreen(bridge, '/infrastructure', `environment-${environmentId}`)}>
            {overviewText('run_open_environment')}
          </button>
        )}
        <details>
          <summary>{overviewText('run_technical_details')}</summary>
          <RunDetails run={result.data} t={t} language={language} />
        </details>
      </>
    );
  }
  return <p role={result.isError ? 'alert' : 'status'}>
    {result.isError ? t('load_failed', { error: String(result.error) }) : overviewText('reading')}
  </p>;
}

function Tile({
  title,
  open = null,
  children,
}: {
  title: string;
  /** The screen the tile's figures come from, when it shows here. */
  open?: { label: string; go: () => void } | null;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className={styles.tileTitle}>{title}</CardTitle>
      </CardHeader>
      <CardContent className={styles.tileBody}>
        {children}
        {open && (
          <button type="button" className={styles.tileOpen} data-tile-open onClick={open.go}>
            {open.label}
          </button>
        )}
      </CardContent>
    </Card>
  );
}
