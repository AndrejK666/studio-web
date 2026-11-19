/**
 * Admin › Access — the prototype's `AccessView` (`App.tsx`) carried over
 * (ADR-0069): choose the organization's access model and, when it is
 * role-based, edit the roles (each a set of privileges) and the grants
 * (member × role × the whole organization or one project). Stored as
 * the organization's AM tenant metadata; the privilege catalogue and the seeded
 * ladder come from the side that evaluates them (`studio-organizations`).
 *
 * A self-managed organization is governed from inside: a notice, not the editor.
 * The membership service maintains the owner grant.
 */

import { useEffect, useState } from 'react';
import { apiRegistry } from '@gears-frontx/react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Checkbox,
  Input,
  NativeSelect,
  NativeSelectOption,
} from '@gears-frontx/ui-kit';
import { AccountsApiService, responseStatus, useOrganization, type OrganizationRef, type Tenant } from '@constructor-studio/mfe-shared';
import { AdminApiService } from '../../api/AdminApiService';
import {
  ACCESS_MODELS,
  normalizeAccessConfig,
  privilegesByGroup,
  type AccessConfig,
  type AccessModel,
  type GrantDef,
  type RoleDef,
} from '../../model/access';
import { byName, fromColleagues, fromMembers, type Member } from '../../model/members';
import { ErrorLine, Header, errText, useAdmin } from './common';
import { GrantsGrid } from './GrantsGrid';
import styles from './Admin.module.css';

export function AccessSection() {
  const { t } = useAdmin();
  const { org, loading } = useOrganization();
  if (loading) return <p className={styles.muted}>{t('reading')}</p>;
  if (!org) return <p className={styles.muted}>{t('no_org')}</p>;
  return <Access key={org.id} org={org} />;
}

interface Loaded {
  version: number;
  defaultRoles: RoleDef[];
  privileges: string[];
  tenant: Tenant | null;
}

function Access({ org }: { org: OrganizationRef }) {
  const { t } = useAdmin();
  const api = apiRegistry.getService(AdminApiService);
  const accounts = apiRegistry.getService(AccountsApiService);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [cfg, setCfg] = useState<AccessConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflicted, setConflicted] = useState(false);
  // Only individual grants are evaluated by the authorization service.
  const [members, setMembers] = useState<Member[]>([]);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  // Add-grant form.
  const [gSubject, setGSubject] = useState('');
  const [gRole, setGRole] = useState('');
  const [gScope, setGScope] = useState('');

  useEffect(() => {
    let live = true;
    Promise.all([
      api.accessConfig({ orgId: org.id }).fetch({ staleTime: 0 }),
      api.accessCatalogue.fetch({ staleTime: 0 }),
      accounts
        .getTenant({ tenantId: org.id })
        .fetch({ staleTime: 0 })
        .catch(() => null),
    ]).then(
      ([entry, catalogue, tenant]) => {
        if (!live) return;
        const normalized = normalizeAccessConfig(entry.document, catalogue.default_roles);
        setLoaded({ version: entry.version, defaultRoles: catalogue.default_roles, privileges: catalogue.privileges, tenant });
        setCfg(normalized);
      },
      (e: unknown) => live && setError(errText(e))
    );
    return () => {
      live = false;
    };
  }, [api, accounts, org.id]);

  // Best-effort: a failed read just leaves a picker empty.
  useEffect(() => {
    let live = true;
    api.orgMembers(org.id).then(
      (list) => live && setMembers(byName(fromMembers(list))),
      () =>
        api.myColleagues().then(
          (list) => live && setMembers(byName(fromColleagues(list, org.id))),
          () => live && setMembers([])
        )
    );
    void (async () => {
      const workspaces = await accounts.getWorkspaces({ organizationId: org.id })
        .fetch({ staleTime: 0 }).then((page) => page?.items ?? [], () => []);
      if (!live) return;
      const pages = await Promise.all([org.id, ...workspaces.map((workspace) => workspace.id)].map((parentId) =>
        accounts.getProjects({ parentId }).fetch({ staleTime: 0 }).then((page) => page?.items ?? [], () => [])
      ));
      if (live) setProjects(byName([...new Map(pages.flat().map((project) => [project.id, project])).values()]));
    })();
    return () => {
      live = false;
    };
  }, [api, accounts, org.id]);

  const selfManaged = loaded?.tenant?.self_managed ?? false;
  const privileges = loaded?.privileges ?? [];
  const hasOwner = cfg?.grants.some((grant) => grant.subjectType === 'member'
    && grant.scopeType === 'org' && grant.roleKey === 'owner' && grant.subjectId.trim()) ?? false;

  function mutate(next: AccessConfig) {
    if (busy) return;
    setCfg(next);
    setDirty(true);
    setSaved(false);
  }

  function addGrant() {
    if (!cfg || !gSubject || !gRole || gRole === 'owner') return;
    const subj = members.find((s) => s.id === gSubject);
    const scopeProj = projects.find((p) => p.id === gScope);
    if (!subj || (gScope && !scopeProj)) return;
    const sameAssignment = (grant: GrantDef) => grant.subjectType === 'member' && grant.subjectId === gSubject
      && (gScope ? grant.scopeType === 'project' && grant.scopeId === gScope : grant.scopeType === 'org');
    if (cfg.grants.some((grant) => sameAssignment(grant) && grant.roleKey === 'owner')) return;
    const existing = cfg.grants.find(sameAssignment);
    const grant: GrantDef = {
      id: existing?.id ?? crypto.randomUUID(),
      subjectType: 'member',
      subjectId: gSubject,
      subjectName: subj.name,
      roleKey: gRole,
      scopeType: gScope ? 'project' : 'org',
      scopeId: scopeProj?.id ?? org.id,
      scopeName: scopeProj?.name ?? org.name,
    };
    mutate({ ...cfg, grants: [...cfg.grants.filter((g) => !sameAssignment(g)), grant] });
    setGSubject('');
  }

  function setModel(model: AccessModel) {
    if (!cfg || (model === 'roles' && !hasOwner)) return;
    mutate({ ...cfg, model });
  }

  function togglePrivilege(roleKey: string, privId: string) {
    if (!cfg) return;
    mutate({
      ...cfg,
      roles: cfg.roles.map((r) => {
        if (r.key !== roleKey) return r;
        const has = r.privileges.includes(privId);
        return { ...r, privileges: has ? r.privileges.filter((p) => p !== privId) : [...r.privileges, privId] };
      }),
    });
  }

  function addRole() {
    if (!cfg) return;
    const key = `role_${crypto.randomUUID().replace(/-/g, '_')}`;
    mutate({ ...cfg, roles: [...cfg.roles, { key, name: t('access_new_role'), privileges: ['people.view'] }] });
  }

  async function save() {
    if (!cfg || !loaded || conflicted || busy) return;
    setBusy(true);
    setError(null);
    try {
      const entry = await api.saveAccessConfig(org.id).fetch({ expected_version: loaded.version, document: cfg });
      setLoaded({ ...loaded, version: entry.version });
      setCfg(normalizeAccessConfig(entry.document, loaded.defaultRoles));
      setDirty(false);
      setSaved(true);
    } catch (e) {
      if (responseStatus(e) === 409) setConflicted(true);
      else setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function reload() {
    if (!loaded || busy) return;
    setBusy(true);
    setError(null);
    try {
      const entry = await api.accessConfig({ orgId: org.id }).fetch({ staleTime: 0 });
      setLoaded({ ...loaded, version: entry.version });
      setCfg(normalizeAccessConfig(entry.document, loaded.defaultRoles));
      setConflicted(false);
      setDirty(false);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const groups = privilegesByGroup(privileges);

  return (
    <>
      <Header
        title={t('access_title')}
        info={<p>{t('access_about', { name: org.name })}</p>}
        action={
          <Button disabled={!cfg || !dirty || busy || selfManaged || conflicted} onClick={() => void save()} data-access-save>
            {busy ? t('saving') : saved && !dirty ? t('saved') : t('save')}
          </Button>
        }
      />
      {error && <ErrorLine>{error}</ErrorLine>}
      {conflicted && <Card>
        <CardContent className={styles.cardBody}>
          <p role="alert">{t('access_save_conflict')}</p>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void reload()}>
            {t('access_reload_after_conflict')}
          </Button>
        </CardContent>
      </Card>}

      {!loaded && !error ? (
        <p className={styles.muted}>{t('reading')}</p>
      ) : !cfg ? null : selfManaged ? (
        <p className={styles.notice} data-access-self-managed>
          {t('access_self_managed', { name: org.name })}
        </p>
      ) : (
        <>
          <Card>
            <CardContent className={styles.cardBody}>
              <h3 className={styles.subtitle}>{t('access_model')}</h3>
              <div className={styles.models} role="radiogroup" aria-label={t('access_model')}>
                {ACCESS_MODELS.map((m) => (
                  <label key={m.id} className={`${styles.model} ${cfg.model === m.id ? styles.modelOn : ''}`}>
                    <input
                      type="radio"
                      name="access-model"
                      checked={cfg.model === m.id}
                      disabled={m.id === 'roles' && !hasOwner}
                      onChange={() => setModel(m.id)}
                      data-access-model={m.id}
                    />
                    <div>
                      <div className={styles.name}>{t(`access_model_${m.id}`)}</div>
                      <div className={styles.sub}>{t(`access_model_${m.id}_blurb`)}</div>
                    </div>
                  </label>
                ))}
              </div>
              {!hasOwner && <p className={styles.notice}>{t('access_owner_required')}</p>}
            </CardContent>
          </Card>

          {cfg.model === 'roles' ? (
            <>
              <p className={styles.notice}>{t('access_rolling_out')}</p>
              {cfg.roles.map((role) => (
                <Card key={role.key} data-access-role={role.key}>
                  <CardContent className={styles.cardBody}>
                    <div className={styles.roleHead}>
                      <Input
                        className={styles.search}
                        aria-label={t('access_role_name')}
                        value={role.name}
                        readOnly={role.key === 'owner'}
                        onChange={(e) =>
                          mutate({
                            ...cfg,
                            roles: cfg.roles.map((r) => (r.key === role.key ? { ...r, name: e.target.value } : r)),
                          })
                        }
                      />
                      {role.system || role.key === 'owner' ? (
                        <Badge variant="secondary" title={t('access_system_hint')}>
                          {t('access_system')}
                        </Badge>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={cfg.grants.some((grant) => grant.roleKey === role.key)}
                          onClick={() => mutate({ ...cfg, roles: cfg.roles.filter((r) => r.key !== role.key) })}
                        >
                          {t('delete')}
                        </Button>
                      )}
                      <span className={`${styles.sub} ${styles.headerAction}`}>
                        {t('access_privilege_count', { have: role.privileges.length, all: privileges.length })}
                      </span>
                    </div>
                    <div className={styles.roleGrid}>
                      {groups.map((g) => (
                        <div key={g.group} className={styles.group}>
                          <div className={styles.groupLabel}>{g.group}</div>
                          {g.items.map((p) => (
                            <label key={p.id} className={styles.check}>
                              <Checkbox
                                // Owner holds every privilege, never editable.
                                disabled={role.key === 'owner'}
                                checked={role.key === 'owner' || role.privileges.includes(p.id)}
                                onCheckedChange={() => togglePrivilege(role.key, p.id)}
                              />
                              {p.label}
                            </label>
                          ))}
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ))}
              <div>
                <Button variant="outline" onClick={addRole} data-access-add-role>
                  {t('access_add_role')}
                </Button>
              </div>

              <Card data-access-grants>
                <CardContent className={styles.cardBody}>
                  <h3 className={styles.subtitle}>{t('access_grants')}</h3>
                  <p className={styles.muted}>{t('access_grants_about')}</p>
                  {cfg.grants.some((grant) => grant.subjectType === 'team') && (
                    <p className={styles.notice}>{t('access_team_grants_inactive')}</p>
                  )}
                  <GrantsGrid
                    t={t}
                    grants={cfg.grants}
                    roles={cfg.roles}
                    onRemove={(g) => mutate({ ...cfg, grants: cfg.grants.filter((x) => x.id !== g.id) })}
                  />

                  <div className={styles.inline}>
                    <NativeSelect aria-label={t('access_pick_subject')} value={gSubject} onChange={(e) => setGSubject(e.target.value)}>
                      <NativeSelectOption value="">
                        {members.length ? t('access_select_member') : t('access_no_members')}
                      </NativeSelectOption>
                      {members.map((s) => (
                        <NativeSelectOption key={s.id} value={s.id}>
                          {s.name}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                    <NativeSelect aria-label={t('access_col_role')} value={gRole} onChange={(e) => setGRole(e.target.value)}>
                      <NativeSelectOption value="">{t('access_select_role')}</NativeSelectOption>
                      {cfg.roles.filter((r) => r.key !== 'owner').map((r) => (
                        <NativeSelectOption key={r.key} value={r.key}>
                          {r.name}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                    <NativeSelect aria-label={t('access_col_scope')} value={gScope} onChange={(e) => setGScope(e.target.value)}>
                      <NativeSelectOption value="">{t('access_whole_org')}</NativeSelectOption>
                      {projects.map((p) => (
                        <NativeSelectOption key={p.id} value={p.id}>
                          {p.name}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                    <Button disabled={!gSubject || !gRole} onClick={addGrant} data-access-add-grant>
                      {t('access_add_grant')}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </>
          ) : (
            <p className={styles.notice}>{t('access_tenant_on')}</p>
          )}
        </>
      )}
    </>
  );
}
