/**
 * Organization › People — the prototype's `PeopleView` in `mode="org"`
 * (`people.tsx`, `people-org.tsx`), carried over (ADR-0069): everyone in the
 * organization as studio-user holds them (ADR-0040 §1), joined to the
 * colleague projection for photos, descriptions and last seen; and where each
 * person works — the projects they can access (the access config) and the
 * ones they were seen active in (open pull requests, the Activity feed,
 * desktops, Insight). A list, or a person × project matrix; a person opens in
 * a panel; a project opens its Team.
 *
 * Inviting creates a Studio invitation the person accepts when they sign in
 * with the address; nothing is created in the identity provider. Who may is
 * the backend's to say: a refused write shows its refusal.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { apiRegistry, type ChildMfeBridge } from '@gears-frontx/react';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Skeleton,
} from '@gears-frontx/ui-kit';
import {
  ACCESS_CONFIG_TYPE,
  AccountsApiService,
  OrganizationProvider,
  PeopleApiService,
  accessOf,
  directoryLine,
  errorMessage,
  gitHandles,
  lastSeenOf,
  normalizeAccessConfig,
  onlineNow,
  openProjectTeam,
  orgPeople,
  personProjects,
  projectStack,
  refusalText,
  useHostChrome,
  useOrganization,
  withColleagues,
  type AccessConfig,
  type Colleague,
  type Member,
  type OrganizationRef,
  type OrgProject,
  type PersonRow,
  type RoleDef,
  type ScreenText,
  useScreenAvailability,
} from '@constructor-studio/mfe-shared';

/** project-git's open pull request, by GTS id (ADR-0071 §5). */
const PULL_REQUEST_TYPE = 'gts.cf.studio.domain.pull_request.v1~';
import { usePeopleTranslations } from '../../i18n';
import { useOrgActivity } from './useOrgActivity';
import { PeopleMatrix } from './PeopleMatrix';
import { PersonPanel } from './PersonPanel';
import { PeopleGrid, type PeopleCells, type PersonGridRow } from './PeopleGrid';
import { ProjectLegend } from './ProjectMarks';
import { membershipLabel } from './words';
import styles from './PeopleScreen.module.css';

/** How many project marks a row shows before "+N". */
const STACK_MAX = 4;

/** The list's layout, remembered for the tab. */
type Layout = 'list' | 'matrix';
const LAYOUT_KEY = 'people.layout';
function storedLayout(): Layout {
  try {
    return sessionStorage.getItem(LAYOUT_KEY) === 'matrix' ? 'matrix' : 'list';
  } catch {
    return 'list';
  }
}

const errText = (e: unknown): string => refusalText(e) ?? errorMessage(e);

/** The members, the access config and the colleague projection; fails only when nobody can be read. */
async function readPeople(orgId: string): Promise<{ members: Member[]; cfg: AccessConfig; colleagues: Colleague[] }> {
  const api = apiRegistry.getService(PeopleApiService);
  const accounts = apiRegistry.getService(AccountsApiService);
  const [members, access, seeded] = await Promise.all([
    orgPeople(
      orgId,
      (id) => api.orgMembers(id),
      () => api.myColleagues()
    ),
    accounts
      .getTenantMetadata<Partial<AccessConfig>>({ tenantId: orgId, metadataType: ACCESS_CONFIG_TYPE })
      .fetch({ staleTime: 0 })
      .then(
        (entry) => entry?.value ?? null,
        () => null
      ),
    // Best effort: an empty ladder renders a role key rather than its name.
    api.accessCatalogue.fetch({ staleTime: 0 }).then(
      (c) => c.default_roles,
      () => [] as RoleDef[]
    ),
  ]);
  // Best effort: without it the list still has names, addresses and roles.
  const colleagues = await api.myColleagues().catch(() => [] as Colleague[]);
  return { members, cfg: normalizeAccessConfig(access, seeded), colleagues };
}

export const PeopleScreen: React.FC<{ bridge: ChildMfeBridge }> = ({ bridge }) => {
  const { containerRef, dataTheme, language } = useHostChrome();
  const { t, loading } = usePeopleTranslations();
  return (
    <div ref={containerRef} className={styles.screen} data-theme={dataTheme}>
      {loading ? (
        <Skeleton className={styles.skeleton} />
      ) : (
        <OrganizationProvider>
          <InOrganization t={t} language={language} bridge={bridge} container={containerRef} />
        </OrganizationProvider>
      )}
    </div>
  );
};

PeopleScreen.displayName = 'PeopleScreen';

interface ScreenProps {
  t: ScreenText;
  language: string;
  bridge: ChildMfeBridge | null;
  container: React.RefObject<HTMLDivElement | null>;
}

function InOrganization(props: ScreenProps) {
  const { org, loading } = useOrganization();
  if (loading) return <p className={styles.muted}>{props.t('reading')}</p>;
  if (!org) return <p className={styles.muted}>{props.t('no_org')}</p>;
  // Keyed by the organization: another organization is another read, from nothing.
  return <OrgPeople key={org.id} org={org} {...props} />;
}

function OrgPeople({ org, t, language, bridge, container }: ScreenProps & { org: OrganizationRef }) {
  const [people, setPeople] = useState<Member[] | null>(null);
  const [colleagues, setColleagues] = useState<Colleague[]>([]);
  const [cfg, setCfg] = useState<AccessConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [contact, setContact] = useState<PersonRow | null>(null);
  const [layout, setLayoutState] = useState<Layout>(storedLayout);
  const [inviting, setInviting] = useState(false);
  const [now] = useState(() => Date.now());

  const setLayout = (l: Layout) => {
    setLayoutState(l);
    try {
      sessionStorage.setItem(LAYOUT_KEY, l);
    } catch {
      /* the choice just is not remembered */
    }
  };

  /** Bumped by Try again: the read below runs once per value. */
  const [attempt, setAttempt] = useState(0);
  const load = () => setAttempt((n) => n + 1);

  useEffect(() => {
    let live = true;
    readPeople(org.id).then(
      (read) => {
        if (!live) return;
        setError(null);
        setPeople(read.members);
        setCfg(read.cfg);
        setColleagues(read.colleagues);
      },
      (e: unknown) => {
        if (!live) return;
        setError(errText(e));
        setPeople([]);
      }
    );
    return () => {
      live = false;
    };
  }, [org.id, attempt]);

  const all = useMemo(() => people ?? [], [people]);
  const rows = useMemo(() => withColleagues(all, colleagues, org.id), [all, colleagues, org.id]);
  // The open pull requests and the feed are project-git's: read where its type is.
  const git = useScreenAvailability(bridge ? { bridge } : undefined).type(PULL_REQUEST_TYPE);
  const activity = useOrgActivity(org.id, people === null ? null : rows, { git });
  const model = cfg?.model ?? 'tenant';
  const orgProjects: OrgProject[] = useMemo(() => activity.projects ?? [], [activity.projects]);
  const projectRowsOf = (p: PersonRow) =>
    personProjects(orgProjects, accessOf(p.id, p.role, cfg, orgProjects), activity.index.get(p.id));
  const online = onlineNow(activity.dir, activity.presence);
  const { dir, presence, desktops } = activity;
  const lastSeen = (p: PersonRow) => lastSeenOf(p.id, p.lastSeenMs, dir, presence, desktops);
  const describe = (p: PersonRow) =>
    directoryLine(
      p.directory,
      (id) => all.find((m) => m.id === id)?.name,
      (name) => t('reports_to', { name })
    );
  // A new array only when a person, their last seen or their directory line changed: each one reloads the grid.
  const gridRows = useMemo<PersonGridRow[]>(
    () =>
      rows.map((p) => ({
        ...p,
        seen: lastSeenOf(p.id, p.lastSeenMs, dir, presence, desktops),
        line: directoryLine(
          p.directory,
          (id) => all.find((m) => m.id === id)?.name,
          (name) => t('reports_to', { name })
        ),
      })),
    [rows, all, dir, presence, desktops, t]
  );
  /** Last seen is a column only when some source has it for somebody. */
  const anySeen = gridRows.some((p) => p.seen !== undefined);

  const openProject = (project: OrgProject) => {
    setContact(null);
    openProjectTeam(bridge, {
      project: { id: project.id, name: project.name },
      workspace: { id: project.workspaceId, name: project.workspaceName },
      siblings: orgProjects.filter((p) => p.workspaceId === project.workspaceId),
      organizationId: org.id,
    });
  };

  const cells: PeopleCells = {
    t,
    language,
    now,
    model,
    projectCount: orgProjects.length,
    loading: activity.loading,
    online,
    stackOf: (p) => projectStack(projectRowsOf(p), model, STACK_MAX),
    hasHandle: (p) => gitHandles(activity.identities.get(p.id)?.aliases ?? []).length > 0,
    openPerson: setContact,
    openProject,
    invite: () => setInviting(true),
  };

  const missing = activity.missing.map((m) => t.count(m.key, m.count)).join(', ');

  return (
    <>
      <header className={styles.header}>
        <h2 className={styles.title}>{t('title')}</h2>
        {people !== null && (
          <div className={styles.chips} data-people-status>
            <Badge variant="secondary">{t.count('people', rows.length)}</Badge>
            {activity.projects && <Badge variant="secondary">{t.count('projects', activity.projects.length)}</Badge>}
            {cfg && (
              <Badge variant="info" title={model === 'roles' ? t('model_roles_hint') : t('model_tenant_hint')}>
                {model === 'roles' ? t('model_roles') : t('model_tenant')}
              </Badge>
            )}
            {activity.loading && people.length > 0 && <Badge variant="info">{t('reading_activity')}</Badge>}
            {!activity.loading && activity.missing.length > 0 && (
              <Badge variant="warning" title={t('unread_title', { list: missing })} data-people-unread>
                {t('unread')}
              </Badge>
            )}
            <span className={styles.muted}>{t('in_org', { name: org.name })}</span>
          </div>
        )}
        <div className={styles.headerAction}>
          <Button onClick={() => setInviting(true)} data-invite-open>
            {t('invite')}
          </Button>
        </div>
      </header>
      <div className={styles.about}>
        <p>{t('about_1', { org: org.name })}</p>
        <p>{t('about_2')}</p>
      </div>

      {error && people !== null && people.length > 0 && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {notice && <p className={styles.notice}>{notice}</p>}

      <div className={styles.bar}>
        <div className={styles.toggle} role="group" aria-label={t('layout')}>
          <Button
            variant={layout === 'list' ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={layout === 'list'}
            onClick={() => setLayout('list')}
            data-people-layout="list"
          >
            {t('layout_list')}
          </Button>
          <Button
            variant={layout === 'matrix' ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={layout === 'matrix'}
            onClick={() => setLayout('matrix')}
            data-people-layout="matrix"
          >
            {t('layout_matrix')}
          </Button>
        </div>
        <ProjectLegend model={model} t={t} />
      </div>

      {layout === 'matrix' ? (
        people === null || activity.projects === null ? (
          <p className={styles.muted}>{t('loading')}</p>
        ) : (
          <PeopleMatrix
            people={rows}
            projects={orgProjects}
            model={model}
            t={t}
            rowsOf={(id) => {
              const p = rows.find((r) => r.id === id);
              return p ? projectRowsOf(p) : [];
            }}
            onCell={openProject}
            onPerson={(p) => setContact(p)}
          />
        )
      ) : people === null ? (
        <Skeleton className={styles.skeleton} />
      ) : error && people.length === 0 ? (
        <div className={styles.empty} role="alert">
          <strong>{t('read_failed')}</strong>
          <span className={styles.muted}>{error}</span>
          <Button variant="outline" onClick={load}>
            {t('retry')}
          </Button>
        </div>
      ) : (
        <PeopleGrid rows={gridRows} anySeen={anySeen} cells={cells} />
      )}

      {contact && (
        <PersonPanel
          person={contact}
          describe={describe(contact)}
          membership={membershipLabel(contact.role, t)}
          model={model}
          rows={projectRowsOf(contact)}
          activity={activity}
          lastSeenMs={lastSeen(contact)}
          online={online.has(contact.id)}
          t={t}
          language={language}
          container={container}
          onOpenProject={openProject}
          onClose={() => setContact(null)}
        />
      )}

      {inviting && (
        <InviteDialog
          org={org}
          t={t}
          container={container}
          onClose={() => setInviting(false)}
          onInvited={(email) => {
            setInviting(false);
            setNotice(t('invited', { email }));
          }}
        />
      )}
    </>
  );
}

/** A Studio invitation to the organization, by address. */
function InviteDialog({
  org,
  t,
  container,
  onClose,
  onInvited,
}: {
  org: OrganizationRef;
  t: ScreenText;
  container: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onInvited: (email: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    const address = email.trim();
    if (!address) return;
    setBusy(true);
    setError(null);
    try {
      await apiRegistry.getService(PeopleApiService).invite(org.id).fetch({ email: address, role: 'member' });
      onInvited(address);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent container={container} closeLabel={t('close')} data-invite-dialog>
        <form className={styles.form} onSubmit={(e) => void invite(e)}>
          <DialogHeader>
            <DialogTitle>{t('invite_title', { org: org.name })}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            type="email"
            aria-label={t('invite_address')}
            placeholder="name@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <p className={styles.muted}>{t('invite_hint')}</p>
          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={busy || !email.trim()} data-invite-send>
              {busy ? t('inviting') : t('invite')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
