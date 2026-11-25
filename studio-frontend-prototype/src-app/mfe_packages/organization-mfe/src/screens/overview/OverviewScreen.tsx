/**
 * Organization › Overview, for the people who lead it (the prototype's
 * org-dashboard.tsx, ADR-0069 parity). One read — `GET /studio-organizations/
 * v1/overview` — drawn as:
 *
 *   - the header: the organization, and how much needs attention;
 *   - the tiles: one per kit block that has one (Spend, Delivery, Specs… —
 *     each in its kit's own words, ADR-0079), then People, the organization's own;
 *   - "Needs attention › For you": the person's Inbox (InboxGroup.tsx; the
 *     server's `GET /studio-user/v1/me/inbox`), where the prototype had it;
 *   - "Needs attention › For others": refused connections, every block's
 *     needs, failed runs, idle people;
 *   - the workspaces, each with its worst project and why.
 *
 * This screen names no kit: a block of a kit not installed for the
 * organization is not in the answer, and a tile or need leads where its block
 * says. Where a row, a tile or a workspace leads is a screen of this portal,
 * and only one that shows where the person is (`useScreenAvailability`): a
 * target with no screen here gets no button rather than a dead one.
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
  KitContentSlot,
  openPlace,
  openScreen,
  useOrganization,
  useScreenAvailability,
  useStudioEventRefresh,
} from '@constructor-studio/mfe-shared';
import { requestWorkspace } from '../../actions/workspaceActions';
import { OverviewApiService } from '../../api/OverviewApiService';
import {
  attentionStatus,
  othersAttention,
  say,
  wordsIn,
  workspaceLine,
  type NeedTarget,
  type SayOptions,
} from '../../overview/model';
import type { BlockDetails, BlockLink, BlockTile, OrgOverview, OrgRunFailure, OrgWorkspace } from '../../overview/types';
import { BackgroundApiService } from '../../api/BackgroundApiService';
import { RunDetails, when } from '../background/BackgroundGrids';
import { useBackgroundTranslations, useOverviewTranslations } from '../../i18n';
import { InboxGroup } from './InboxGroup';
import styles from './OverviewScreen.module.css';

type Text = ReturnType<typeof useOverviewTranslations>['t'];

/** The whole Inbox (`screens/inbox`), opened from the top bar too. */
const INBOX_ROUTE = '/inbox';

/** Where one of the organization's own rows leads: the shell's screens. A
 *  kit's tile or need carries its own link. */
export const TARGET_ROUTE: Record<NeedTarget, string> = {
  connectors: '/connections',
  projects: '/organization/workspaces',
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
    if (route) openScreen(bridge, route);
  };
  /** A block's link: a screen inside a project (the project's level decides
   *  what shows there), or one of this level's screens when it shows here. */
  const follow = (link: BlockLink | null | undefined): (() => void) | null => {
    if (!link) return null;
    const { workspace_id: workspaceId, project_id: projectId } = link;
    if (workspaceId && projectId) {
      return () => openPlace(bridge, {
        organizationId, workspaceId, projectId, route: link.route, view: link.view ?? undefined,
      });
    }
    if (!availability.route(link.route)) return null;
    return () => (link.view ? openScreen(bridge, link.route, link.view) : openScreen(bridge, link.route));
  };
  const read = useApiQuery(apiRegistry.getService(OverviewApiService).overview({ organizationId }));
  // A run that ended (a sync, a report, a build) may change what needs
  // attention: read again, from the organization on screen's live channel.
  useStudioEventRefresh(isRunEnding, () => void read.refetch());
  const o: OrgOverview | undefined = read.data;
  const words: SayOptions = {
    language,
    money: (value, currency) => money(value, currency, language),
    unknown: t('unknown'),
  };
  const others = o ? othersAttention(o, words) : [];
  // What waits on the reader, once their Inbox is read: the header counts both.
  const [you, setYou] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const detailsId = useId();

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
            {(o.blocks ?? []).map((block) => block.tile && (
              <BlockTileCard key={`${block.kit}/${block.id}`} block={`${block.kit}/${block.id}`} tile={block.tile}
                words={words} follow={follow} />
            ))}
            <Tile title={t('tile_people')} open={routeOf('people') ? { label: t('open_people'), go: () => go('people') } : null}>
              <span className={styles.big}>{t('tile_people_value', { active: shown(o.people.active, t) })}</span>
              <span className={styles.muted}>
                {t('tile_people_sub', { idle: shown(o.people.idle?.length ?? null, t) })}
              </span>
            </Tile>
          </div>

          <KitContentSlot name="organization.overview.content" />
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
                      const failures = r.action?.target === 'tasks' ? o.recent_failures : null;
                      const details = r.details?.rows.length ? r.details : null;
                      const hasDetails = !!(details || failures?.length);
                      const show = expanded === r.key;
                      const act = r.action?.target ? (routeOf(r.action.target) ? () => go(r.action!.target!) : null)
                        : follow(r.action?.link);
                      return (
                      <li key={r.key} className={`${styles.row} ${styles[r.tone]}`} data-attention={r.key.split(':')[0]}>
                        <b>{r.sentence}</b>
                        {r.detail && <span className={styles.muted}> · {r.detail}</span>}
                        {hasDetails ? (
                          <button type="button" className={styles.action} aria-expanded={show}
                            aria-controls={show ? detailsId : undefined}
                            onClick={() => setExpanded(show ? null : r.key)}>
                            {details ? wordsIn(details.label, language) : t('show_recent_failures')}
                          </button>
                        ) : act && r.action && (
                          <button type="button" className={styles.action} onClick={act}>
                            {r.action.label}
                          </button>
                        )}
                        {show && hasDetails && (
                          <div id={detailsId} className={styles.attentionDetails}>
                            {details && <BlockDetailRows details={details} words={words} />}
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

/** A kit block's tile, drawn from the block alone: its title, figure, quieter
 *  lines, the list it folds out and where its figures come from. */
function BlockTileCard({
  block,
  tile,
  words,
  follow,
}: {
  block: string;
  tile: BlockTile;
  words: SayOptions;
  follow: (link: BlockLink | null | undefined) => (() => void) | null;
}) {
  const [open, setOpen] = useState(false);
  const link = follow(tile.link);
  const items = tile.items?.rows.length ? tile.items : null;
  return (
    <Tile
      title={wordsIn(tile.title, words.language)}
      block={block}
      open={link && tile.link ? { label: wordsIn(tile.link.label, words.language), go: link } : null}
    >
      {tile.value && <span className={styles.big}>{say(tile.value, words)}</span>}
      {tile.lines.map((line, i) => (
        <span key={i} className={styles.muted}>{say(line, words)}</span>
      ))}
      {items && <>
        <button type="button" className={styles.tileOpen} aria-expanded={open} onClick={() => setOpen(!open)}>
          {wordsIn(items.label, words.language)}
        </button>
        {open && <ul className={styles.list}>{items.rows.map((row, i) => {
          const go = follow(row.link);
          const text = say(row.text, words);
          return <li key={i}>{go
            ? <button type="button" className={styles.tileOpen} onClick={go}>{text}</button>
            : <span>{text}</span>}</li>;
        })}</ul>}
      </>}
    </Tile>
  );
}

/** What a kit's need is about: each row a title (a link where it has an
 *  address) and quieter notes. */
function BlockDetailRows({ details, words }: { details: BlockDetails; words: SayOptions }) {
  return (
    <ul>
      {details.rows.map((row, i) => {
        const href = row.href && /^https?:\/\//i.test(row.href) ? row.href : null;
        const note = row.note.map((line) => say(line, words)).filter(Boolean).join(' · ');
        return (
          <li key={i}>
            {href ? <a href={href} target="_blank" rel="noreferrer">{row.text}</a> : <span>{row.text}</span>}
            {note && <span className={styles.muted}>{' · '}{note}</span>}
          </li>
        );
      })}
    </ul>
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
  block,
  open = null,
  children,
}: {
  title: string;
  /** The kit block it draws (`kit/id`), for tests and the walk. */
  block?: string;
  /** The screen the tile's figures come from, when it shows here. */
  open?: { label: string; go: () => void } | null;
  children: React.ReactNode;
}) {
  return (
    <Card data-overview-block={block}>
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
