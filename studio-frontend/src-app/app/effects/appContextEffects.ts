/**
 * App Context Effects
 *
 * Fills the top bar's context slot and reacts to selections in it.
 *
 * Organizations are resolved here because account-management is a service the
 * shell already owns. Projects are not resolved here at all — the studio-project
 * gear belongs to projects-mfe, so those events only carry state the MFE has
 * already loaded for its own screen.
 *
 * Selections made IN the slot also have to reach that MFE, and this is where
 * they leave the shell: `publishSelectedProject` mirrors every project
 * transition onto a shared property, the only host -> child channel that
 * survives an MFE's module realm.
 */

import {
  eventBus,
  apiRegistry,
  type FrontXApp,
} from '@gears-frontx/react';
import {
  AccountsApiService,
  IdentityApiService,
  PLATFORM_ROOT_TENANT_ID,
  TENANT_TYPES,
  type Tenant,
} from '@/app/api';
import {
  publishSelectedOrganization,
  publishSelectedProject,
  publishSelectedWorkspace,
} from '@/app/mfe/sharedContext';
import {
  setContextAccess,
  setContextLoading,
  setContextOrganizations,
  setContextOrg,
  setContextWorkspaces,
  setContextWorkspacesStatus,
  setContextWorkspace,
  addContextWorkspace,
  setScreenUsesWorkspace,
  setContextProjects,
  openContextProject,
  closeContextProject,
  type ContextEntity,
  type WorkspacesStatus,
} from '@/app/slices/appContextSlice';

/** Tenants Studio calls organizations; workspaces are their children. */
function isOrganization(tenant: Tenant): boolean {
  return tenant.tenant_type === TENANT_TYPES.organization;
}

/** Account-management's own listing ceiling, so one page is enough. */
const WORKSPACE_PAGE_LIMIT = 200;

function toEntity(tenant: Tenant): ContextEntity {
  return { id: tenant.id, name: tenant.name };
}

interface ContextSliceShape {
  org?: ContextEntity | null;
  workspacesStatus?: WorkspacesStatus;
}

function contextSlice(app: FrontXApp): ContextSliceShape {
  const state = app.store.getState() as Record<string, unknown>;
  return (state['app/context'] as ContextSliceShape | undefined) ?? {};
}

function currentOrgId(app: FrontXApp): string | null {
  return contextSlice(app).org?.id ?? null;
}

/**
 * Register context effects.
 *
 * Called once during app initialization, alongside the bootstrap effects.
 */
export function registerAppContextEffects(app: FrontXApp): void {
  const dispatch = app.store.dispatch;

  const resolveWorkspaces = async (orgId: string | null): Promise<void> => {
    if (!orgId || !apiRegistry.has(AccountsApiService)) {
      dispatch(setContextWorkspaces([]));
      dispatch(setContextWorkspacesStatus('ready'));
      publishSelectedWorkspace(app);
      return;
    }
    const accounts = apiRegistry.getService(AccountsApiService);
    dispatch(setContextWorkspacesStatus('pending'));
    try {
      // @cpt-begin:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-1
      const page = await accounts
        .tenantChildrenOfType({
          tenantId: orgId,
          tenantType: TENANT_TYPES.workspace,
          limit: WORKSPACE_PAGE_LIMIT,
        })
        .fetch();
      // @cpt-end:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-1
      // @cpt-begin:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-2
      // @cpt-begin:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-3
      if (currentOrgId(app) !== orgId) return;
      // @cpt-end:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-2
      // @cpt-end:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-3
      // @cpt-begin:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-7
      dispatch(setContextWorkspaces((page?.items ?? []).map(toEntity)));
      dispatch(setContextWorkspacesStatus('ready'));
      publishSelectedWorkspace(app);
      // @cpt-end:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-7
    } catch (error) {
      if (currentOrgId(app) !== orgId) return;
      // @cpt-begin:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-4
      console.warn(
        'Failed to list workspaces:',
        error instanceof Error ? error.message : String(error)
      );
      dispatch(setContextWorkspacesStatus('failed'));
      // @cpt-end:cpt-studiofrontend-algo-workspace-scope-resolve:p1:inst-4
    }
  };

  /**
   * The organizations a platform administrator switches between.
   *
   * A platform administrator reaches every organization by virtue of the role,
   * not by membership, so this stays a walk of the tenant tree: the root's
   * organization children. Making the root's own membership stand for "member of
   * everything" would be exactly the conflation ADR-0011 §1 forbids — and the
   * root is not of the organization type, so it never appears in the switcher
   * itself.
   */
  const platformOrganizations = async (rootId: string): Promise<Tenant[]> => {
    const accounts = apiRegistry.getService(AccountsApiService);
    try {
      const children = (await accounts.tenantChildren({ tenantId: rootId }).fetch())?.items ?? [];
      return children.filter(isOrganization);
    } catch (error) {
      console.warn(
        'Failed to list organizations under the platform root:',
        error instanceof Error ? error.message : String(error)
      );
      return [];
    }
  };

  /**
   * The organizations an ordinary person is a member of.
   *
   * Membership is the authority (ADR-0011 §2), so the list comes from
   * `studio-user` and the names are resolved per organization — `studio-user`
   * stores ids and roles, not tenant names. An organization whose tenant cannot
   * be read is dropped rather than shown nameless: from outside a self-managed
   * organization's subtree the backend answers 404 by design, and that is
   * isolation working, not an error.
   */
  const memberOrganizations = async (): Promise<Tenant[]> => {
    if (!apiRegistry.has(IdentityApiService)) return [];
    const identity = apiRegistry.getService(IdentityApiService);
    const accounts = apiRegistry.getService(AccountsApiService);
    const memberships = (await identity.myMemberships.fetch())?.items ?? [];
    const resolved = await Promise.all(
      memberships.map(async (membership) => {
        try {
          return await accounts.tenant({ tenantId: membership.org_id }).fetch();
        } catch {
          return null;
        }
      })
    );
    return resolved.filter((tenant): tenant is Tenant => tenant !== null).filter(isOrganization);
  };

  eventBus.on('app/context/fetch', async () => {
    if (!apiRegistry.has(AccountsApiService)) return;

    const accounts = apiRegistry.getService(AccountsApiService);
    dispatch(setContextLoading(true));
    try {
      const me = await accounts.me.fetch();
      const homeTenantId = me?.subject_tenant_id;

      // The home tenant no longer decides WHICH organizations are on offer —
      // only whether this caller is the platform administrator, which is a fact
      // about the token and not a membership.
      const organizations =
        homeTenantId === PLATFORM_ROOT_TENANT_ID
          ? await platformOrganizations(homeTenantId)
          : await memberOrganizations();

      const items = organizations.map(toEntity);
      const current = items[0] ?? null;
      dispatch(setContextOrganizations({ current, items }));
      // An authenticated person with no organization is a supported state, and
      // the shell has to say so rather than render an empty switcher.
      dispatch(setContextAccess(items.length > 0 ? 'ready' : 'unassigned'));
      publishSelectedOrganization(app);
      await resolveWorkspaces(current?.id ?? null);
    } catch (error) {
      console.warn(
        'Failed to resolve organizations:',
        error instanceof Error ? error.message : String(error)
      );
      // A failed resolve is not the same as having no access: leave the access
      // state alone so a transient failure does not show an onboarding screen to
      // somebody who has an organization.
    } finally {
      dispatch(setContextLoading(false));
    }
  });

  eventBus.on('app/context/org/changed', ({ orgId }) => {
    if (currentOrgId(app) === orgId) {
      // Not a change: reselecting must not clear the workspaces and the open
      // project, nor re-read a list that has not moved. It is still the
      // member's way of asking again after a failed read, so that case alone
      // resolves.
      if (contextSlice(app).workspacesStatus === 'failed') void resolveWorkspaces(orgId);
      return;
    }
    dispatch(setContextOrg(orgId));
    publishSelectedOrganization(app);
    publishSelectedWorkspace(app);
    publishSelectedProject(app);
    void resolveWorkspaces(currentOrgId(app));
  });

  eventBus.on('app/context/workspace/changed', ({ workspaceId }) => {
    dispatch(setContextWorkspace(workspaceId));
    publishSelectedWorkspace(app);
    publishSelectedProject(app);
  });

  /** Created by an MFE and handed over as an action chain — see contextActions. */
  eventBus.on('app/context/workspace/created', ({ id, name }) => {
    dispatch(addContextWorkspace({ id, name }));
    publishSelectedWorkspace(app);
    publishSelectedProject(app);
  });

  eventBus.on('app/context/workspace/scoped', () => {
    dispatch(setScreenUsesWorkspace(true));
    if (contextSlice(app).workspacesStatus === 'failed') {
      void resolveWorkspaces(currentOrgId(app));
    }
  });

  eventBus.on('app/context/screen/changing', () => {
    dispatch(setScreenUsesWorkspace(false));
  });

  //  Published by whoever owns projects (projects-mfe)

  eventBus.on('app/context/project/opened', ({ id, name }) => {
    dispatch(openContextProject({ id, name }));
    publishSelectedProject(app);
  });

  eventBus.on('app/context/projects', ({ items }) => {
    dispatch(setContextProjects(items));
  });

  eventBus.on('app/context/project/closed', () => {
    dispatch(closeContextProject());
    publishSelectedProject(app);
  });

  eventBus.on('app/context/project/changed', ({ projectId }) => {
    const state = app.store.getState() as Record<string, unknown>;
    const context = state['app/context'] as { projects?: ContextEntity[] } | undefined;
    const picked = context?.projects?.find((project) => project.id === projectId);
    if (!picked) return;
    dispatch(openContextProject(picked));
    publishSelectedProject(app);
  });
}
