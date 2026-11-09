/**
 * What Admin reads and writes, ported from the prototype's client
 * (`00828880:studio-frontend-prototype/src/api.ts`, ADR-0069): organizations
 * and their mode conversions (`account-management`), members, invitations and
 * people (`studio-user`), the identity directory (`studio-identity`), teams
 * (`resource-group`), the access catalogue and the logo
 * (`studio-organizations`), secrets (`credstore`), connections
 * (`studio-connector`) and the type catalogue (`studio-components-catalog`,
 * `types-registry`). Each route names its gear behind the gateway prefix.
 *
 * Reads the shared `AccountsApiService` already has (me, a tenant, children,
 * tenant metadata) are taken from there, not repeated here.
 */

import { BaseApiService, RestEndpointProtocol, RestPlugin, RestProtocol, type RestRequestContext } from '@gears-frontx/react';
import type {
  CatalogType,
  Colleague,
  Connection,
  Conversion,
  GtsEntityPage,
  Group,
  MemberDirectory,
  MemberIdentities,
  MembershipRole,
  MyMembership,
  OrgInvitation,
  OrgMember,
  OrganizationLogo,
  PlatformIdentity,
  StudioProfile,
  TypeCount,
} from './types';
import type { RoleDef } from '../model/access';

const q = (params: Record<string, string>) => new URLSearchParams(params).toString();
const e = encodeURIComponent;

/** studio-user's page ceiling. */
export const MAX_PAGE = 200;

/**
 * `If-Match: *` on a credstore rotate: the gear's explicit unconditional
 * overwrite. A plugin because the mutation descriptor takes no headers.
 */
export class UnconditionalSecretPutPlugin extends RestPlugin {
  onRequest(context: RestRequestContext): RestRequestContext {
    if (context.method !== 'PUT' || !context.url.includes('/credstore/v1/secrets/')) return context;
    return { ...context, headers: { ...context.headers, 'If-Match': '*' } };
  }
}

export interface MembershipBody {
  role: MembershipRole;
  status?: 'active' | 'suspended';
  source?: 'assignment' | 'manual';
  /** Replaces how the organization describes the person; absent leaves it. */
  directory?: MemberDirectory;
}

export class AdminApiService extends BaseApiService {
  constructor() {
    const restProtocol = new RestProtocol({ timeout: 30000 });
    restProtocol.plugins.add(new UnconditionalSecretPutPlugin());
    const restEndpoints = new RestEndpointProtocol(restProtocol);
    super({ baseURL: '/cf' }, restProtocol, restEndpoints);
  }

  private get rest() {
    return this.protocol(RestEndpointProtocol);
  }

  /* ── account-management ── */

  readonly createTenant = this.protocol(RestEndpointProtocol).mutation<
    { id: string; name: string },
    { name: string; parent_id: string; tenant_type: string }
  >('POST', '/account-management/v1/tenants');

  /** Rename: `name` is the only mutable field (RFC 7396 merge patch). */
  renameTenant(tenantId: string) {
    return this.rest.mutation<unknown, { name: string }>('PATCH', `/account-management/v1/tenants/${e(tenantId)}`);
  }

  deleteTenant(tenantId: string) {
    return this.rest.mutation<void, void>('DELETE', `/account-management/v1/tenants/${e(tenantId)}`);
  }

  requestConversion(tenantId: string) {
    return this.rest.mutation<Conversion, { target_mode: 'managed' | 'self_managed'; comment: string }>(
      'POST',
      `/account-management/v1/tenants/${e(tenantId)}/conversions`
    );
  }

  readonly inboundConversions = this.protocol(RestEndpointProtocol).queryWith<
    { items?: Conversion[] },
    { parentId: string }
  >(({ parentId }) => `/account-management/v1/tenants/${e(parentId)}/child-conversions`);

  decideConversion(parentId: string, requestId: string) {
    return this.rest.mutation<Conversion, { status: 'approved' | 'rejected' }>(
      'PATCH',
      `/account-management/v1/tenants/${e(parentId)}/child-conversions/${e(requestId)}`
    );
  }

  /* ── studio-user ── */

  readonly membersPage = this.protocol(RestEndpointProtocol).queryWith<
    { items?: OrgMember[]; total?: number },
    { orgId: string; offset: number }
  >(
    ({ orgId, offset }) =>
      `/studio-user/v1/organizations/${e(orgId)}/members?${q({ offset: String(offset), limit: String(MAX_PAGE) })}`
  );

  /** An organization's members, every page (`people.view`: an owner or a platform admin). */
  async orgMembers(orgId: string): Promise<OrgMember[]> {
    const items: OrgMember[] = [];
    for (let offset = 0; ; offset += MAX_PAGE) {
      const body = await this.membersPage({ orgId, offset }).fetch({ staleTime: 0 });
      const page = body.items ?? [];
      items.push(...page);
      const total = typeof body.total === 'number' ? body.total : items.length;
      if (page.length === 0 || items.length >= total) return items;
    }
  }

  readonly colleaguesPage = this.protocol(RestEndpointProtocol).queryWith<
    { items?: Colleague[]; total?: number },
    { offset: number }
  >(({ offset }) => `/studio-user/v1/me/colleagues?${q({ offset: String(offset), limit: String(MAX_PAGE) })}`);

  /** Everybody the caller shares an organization with, every page. */
  async myColleagues(): Promise<Colleague[]> {
    const items: Colleague[] = [];
    for (let offset = 0; ; offset += MAX_PAGE) {
      const body = await this.colleaguesPage({ offset }).fetch({ staleTime: 0 });
      const page = body.items ?? [];
      items.push(...page);
      const total = typeof body.total === 'number' ? body.total : items.length;
      if (page.length === 0 || items.length >= total) return items;
    }
  }

  readonly myMemberships = this.protocol(RestEndpointProtocol).query<{ items: MyMembership[] }>(
    '/studio-user/v1/me/memberships'
  );

  readonly myProfile = this.protocol(RestEndpointProtocol).query<StudioProfile>('/studio-user/v1/me');

  readonly memberIdentities = this.protocol(RestEndpointProtocol).queryWith<
    MemberIdentities,
    { orgId: string; userId: string }
  >(({ orgId, userId }) => `/studio-user/v1/organizations/${e(orgId)}/members/${e(userId)}/identities`);

  /** Add somebody, change their role or description, suspend or resume them — one write. */
  putMembership(userId: string, orgId: string) {
    return this.rest.mutation<OrgMember, MembershipBody>(
      'PUT',
      `/studio-user/v1/users/${e(userId)}/memberships/${e(orgId)}`
    );
  }

  removeMembership(userId: string, orgId: string) {
    return this.rest.mutation<void, void>('DELETE', `/studio-user/v1/users/${e(userId)}/memberships/${e(orgId)}`);
  }

  /** The canonical Studio person behind a sign-in, created on first sight (platform admin). */
  readonly resolvePerson = this.protocol(RestEndpointProtocol).mutation<
    { user_id: string },
    { provider: 'keycloak'; subject: string; display_name?: string; email?: string }
  >('POST', '/studio-user/v1/resolve');

  readonly invitations = this.protocol(RestEndpointProtocol).queryWith<{ items: OrgInvitation[] }, { orgId: string }>(
    ({ orgId }) => `/studio-user/v1/organizations/${e(orgId)}/invitations`
  );

  invite(orgId: string) {
    return this.rest.mutation<{ invitation: OrgInvitation }, { email: string; role: 'member' | 'admin' }>(
      'POST',
      `/studio-user/v1/organizations/${e(orgId)}/invitations`
    );
  }

  revokeInvitation(orgId: string, invitationId: string) {
    return this.rest.mutation<void, void>(
      'DELETE',
      `/studio-user/v1/organizations/${e(orgId)}/invitations/${e(invitationId)}`
    );
  }

  /* ── studio-identity (platform administrator only) ── */

  readonly platformIdentities = this.protocol(RestEndpointProtocol).query<{ items: PlatformIdentity[] }>(
    '/studio-identity/v1/users'
  );

  assignIdentity(identityId: string) {
    return this.rest.mutation<void, { tenant_id: string; role: MembershipRole }>(
      'POST',
      `/studio-identity/v1/users/${e(identityId)}/assignment`
    );
  }

  /* ── resource-group ── */

  readonly groups = this.protocol(RestEndpointProtocol).query<{ items?: Group[] }>('/resource-group/v1/groups');

  /* ── studio-organizations ── */

  /** The privilege catalogue and the seeded role ladder, from the side that evaluates them. */
  readonly accessCatalogue = this.protocol(RestEndpointProtocol).query<{
    privileges: string[];
    default_roles: RoleDef[];
  }>('/studio-organizations/v1/access-catalogue');

  /** An organization's logo; 404 when it has none. */
  readonly logo = this.protocol(RestEndpointProtocol).queryWith<OrganizationLogo, { orgId: string }>(
    ({ orgId }) => `/studio-organizations/v1/logo?${q({ organization_id: orgId })}`
  );

  setLogo(orgId: string) {
    return this.rest.mutation<OrganizationLogo, { content_type: string; data: string }>(
      'PUT',
      `/studio-organizations/v1/logo?${q({ organization_id: orgId })}`
    );
  }

  deleteLogo(orgId: string) {
    return this.rest.mutation<void, void>('DELETE', `/studio-organizations/v1/logo?${q({ organization_id: orgId })}`);
  }

  /* ── credstore ── */

  readonly createSecret = this.protocol(RestEndpointProtocol).mutation<
    unknown,
    { reference: string; value: string; sharing: 'tenant'; type?: string }
  >('POST', '/credstore/v1/secrets');

  /** Unconditional overwrite (`If-Match: *`, see the plugin above). */
  rotateSecret(reference: string) {
    return this.rest.mutation<unknown, { value: string; sharing: 'tenant'; type?: string }>(
      'PUT',
      `/credstore/v1/secrets/${e(reference)}`
    );
  }

  readonly secret = this.protocol(RestEndpointProtocol).queryWith<unknown, { reference: string }>(
    ({ reference }) => `/credstore/v1/secrets/${e(reference)}`
  );

  deleteSecret(reference: string) {
    return this.rest.mutation<unknown, void>('DELETE', `/credstore/v1/secrets/${e(reference)}`);
  }

  /* ── studio-connector ── */

  readonly connections = this.protocol(RestEndpointProtocol).queryWith<{ items: Connection[] }, { tenant: string }>(
    ({ tenant }) => `/studio-connector/v1/connections?${q({ tenant })}`
  );

  /* ── studio-components-catalog, types-registry ── */

  /** Every node type the graph holds, and which of them this organization treats as components. */
  readonly catalogTypes = this.protocol(RestEndpointProtocol).queryWith<{ types?: CatalogType[] }, { orgId: string }>(
    ({ orgId }) => `/studio-components-catalog/v1/types?${q({ organization_id: orgId })}`
  );

  readonly typeCounts = this.protocol(RestEndpointProtocol).queryWith<{ counts?: TypeCount[] }, { orgId: string }>(
    ({ orgId }) => `/studio-components-catalog/v1/types/counts?${q({ organization_id: orgId })}`
  );

  setTypeComponent(orgId: string, typeId: string) {
    return this.rest.mutation<CatalogType, { component: boolean }>(
      'PUT',
      `/studio-components-catalog/v1/types/${e(typeId)}/component?${q({ organization_id: orgId })}`
    );
  }

  readonly gtsTypeTitles = this.protocol(RestEndpointProtocol).query<GtsEntityPage>('/types-registry/v1/entities');
}
