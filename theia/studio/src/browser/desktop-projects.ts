// The projects a desktop member can open, found the way the portal finds them
// (studio-frontend `appContextEffects.ts`): the organizations come from the
// person's memberships in `studio-user` — membership is the authority
// (ADR-0011 §2), not the tenant the token names — and each organization's
// `workspace` tenants are the projects the portal shows (concept v2: a root
// project is the AM tenant of type `workspace`).

export const TENANT_TYPES = {
    organization: 'gts.cf.core.am.tenant_type.v1~cf.studio.tenant.organization.v1~',
    workspace: 'gts.cf.core.am.tenant_type.v1~cf.studio.tenant.workspace.v1~',
} as const;

/** The platform root: its caller reaches every organization by role, not membership. */
export const PLATFORM_ROOT_TENANT_ID = '00000000-0000-0000-0000-000000000001';

/** account-management's own listing ceiling. */
const PAGE_LIMIT = 200;

export interface Tenant {
    id: string;
    name: string;
    tenant_type?: string;
}

export interface Organization extends Tenant {
    projects: Tenant[];
}

/** GET a gear path (`/account-management/v1/...`) and answer its JSON, or throw. */
export type GetJson = (path: string) => Promise<unknown>;

const items = (page: unknown): Tenant[] => ((page as { items?: Tenant[] } | undefined)?.items ?? []);

function childrenPath(tenantId: string, tenantType?: string): string {
    const query = new URLSearchParams();
    if (tenantType) {
        query.set('$filter', `tenant_type eq '${tenantType}'`);
    }
    query.set('limit', String(PAGE_LIMIT));
    return `/account-management/v1/tenants/${tenantId}/children?${query}`;
}

/** The organizations this person may switch between, as the portal lists them. */
export async function organizationsOf(get: GetJson): Promise<Tenant[]> {
    const me = await get('/account-management/v1/me') as { subject_tenant_id?: string } | undefined;
    if (me?.subject_tenant_id === PLATFORM_ROOT_TENANT_ID) {
        return items(await get(childrenPath(PLATFORM_ROOT_TENANT_ID)))
            .filter(t => t.tenant_type === TENANT_TYPES.organization);
    }
    const memberships = ((await get('/studio-user/v1/me/memberships')) as { items?: { org_id: string }[] } | undefined)?.items ?? [];
    const resolved = await Promise.all(memberships.map(async m => {
        try {
            return await get(`/account-management/v1/tenants/${m.org_id}`) as Tenant;
        } catch {
            // From outside a self-managed organization the answer is 404 by
            // design: isolation working, so it is dropped rather than shown nameless.
            return undefined;
        }
    }));
    return resolved.filter((t): t is Tenant => !!t && t.tenant_type === TENANT_TYPES.organization);
}

/** Every organization with its projects; an organization that cannot be listed says so by throwing. */
export async function projectsOf(get: GetJson): Promise<Organization[]> {
    const organizations = await organizationsOf(get);
    return Promise.all(organizations.map(async org => ({
        ...org,
        projects: items(await get(childrenPath(org.id, TENANT_TYPES.workspace))),
    })));
}
