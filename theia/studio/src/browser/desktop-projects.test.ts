import { PLATFORM_ROOT_TENANT_ID, TENANT_TYPES, projectsOf } from './desktop-projects';

const ORG = { id: 'org-1', name: 'Acme', tenant_type: TENANT_TYPES.organization };
const HIDDEN = 'org-hidden';
const PROJECT = { id: 'ws-1', name: 'Payments', tenant_type: TENANT_TYPES.workspace };

/** A Studio answering the paths the desktop asks, and remembering which. */
function studio(routes: Record<string, unknown>) {
    const asked: string[] = [];
    const get = async (path: string): Promise<unknown> => {
        asked.push(path);
        const key = Object.keys(routes).find(route => path === route || path.startsWith(`${route}?`));
        if (!key) {
            throw new Error('HTTP 404');
        }
        return routes[key];
    };
    return { get, asked };
}

describe('the projects a desktop member sees', () => {
    it('come from the organizations they are a member of, not from their home tenant', async () => {
        const { get, asked } = studio({
            '/account-management/v1/me': { subject_tenant_id: 'home-tenant' },
            '/studio-user/v1/me/memberships': { items: [{ org_id: ORG.id, role: 'member' }] },
            [`/account-management/v1/tenants/${ORG.id}`]: ORG,
            [`/account-management/v1/tenants/${ORG.id}/children`]: { items: [PROJECT] },
        });
        expect(await projectsOf(get)).toEqual([{ ...ORG, projects: [PROJECT] }]);
        expect(asked.some(path => path.includes('home-tenant'))).toBe(false);
        const listing = new URL(asked.find(path => path.includes(`${ORG.id}/children`))!, 'http://studio');
        expect(listing.searchParams.get('$filter')).toBe(`tenant_type eq '${TENANT_TYPES.workspace}'`);
    });

    it('leave out an organization whose tenant cannot be read', async () => {
        const { get } = studio({
            '/account-management/v1/me': {},
            '/studio-user/v1/me/memberships': { items: [{ org_id: HIDDEN }, { org_id: ORG.id }] },
            [`/account-management/v1/tenants/${ORG.id}`]: ORG,
            [`/account-management/v1/tenants/${ORG.id}/children`]: { items: [] },
        });
        expect(await projectsOf(get)).toEqual([{ ...ORG, projects: [] }]);
    });

    it('are every organization\'s for the platform administrator', async () => {
        const { get, asked } = studio({
            '/account-management/v1/me': { subject_tenant_id: PLATFORM_ROOT_TENANT_ID },
            [`/account-management/v1/tenants/${PLATFORM_ROOT_TENANT_ID}/children`]: { items: [ORG, { id: 'x', name: 'x', tenant_type: 'other' }] },
            [`/account-management/v1/tenants/${ORG.id}/children`]: { items: [PROJECT] },
        });
        expect(await projectsOf(get)).toEqual([{ ...ORG, projects: [PROJECT] }]);
        expect(asked).not.toContain('/studio-user/v1/me/memberships');
    });

    it('are none, not an error, for a person with no organization', async () => {
        const { get } = studio({
            '/account-management/v1/me': {},
            '/studio-user/v1/me/memberships': { items: [] },
        });
        expect(await projectsOf(get)).toEqual([]);
    });
});
