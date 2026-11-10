/**
 * The wire shapes Admin reads and writes, as the prototype's client
 * (`00828880:studio-frontend-prototype/src/api.ts`) declared them.
 */

import type { GtsCatalog } from '../model/domain-runtime';

/** The roles a membership may carry (studio-user `MEMBERSHIP_ROLES`). */
export type MembershipRole = 'owner' | 'admin' | 'member';

/** One address a person can be reached at. */
export interface PersonEmail {
  /** Lowercased. */
  address: string;
  /** profile | sign_in | alias */
  source: string;
  verified: boolean;
  primary: boolean;
}

/** How an organization describes one of its people — shown, never decided from. */
export interface MemberDirectory {
  affiliation?: string | null;
  department?: string | null;
  title?: string | null;
  /** The member they report to, by user id. */
  reports_to?: string | null;
}

/** One member of an organization, from `GET /studio-user/v1/organizations/{id}/members`. */
export interface OrgMember {
  user_id: string;
  display_name?: string | null;
  email?: string | null;
  emails?: PersonEmail[];
  avatar_url?: string | null;
  last_seen_at_epoch_ms?: number | null;
  directory?: MemberDirectory | null;
  role: MembershipRole | string;
  status: 'active' | 'suspended';
  /** creation | assignment | invitation | bootstrap | first_login | manual */
  source: string;
  created_at_epoch_ms: number;
  updated_at_epoch_ms: number;
}

/** One way a person signs in. */
export interface PersonLogin {
  provider: string;
  subject: string;
  verified: boolean;
  linked_at_epoch_ms: number;
  email?: string | null;
  email_verified?: boolean;
}

/** An external account attributed to a person. */
export interface PersonAlias {
  kind: string;
  external_id: string;
  /** suggested | claimed | confirmed */
  confidence: string;
  attributes: boolean;
  added_at_epoch_ms: number;
}

export interface MemberIdentities {
  user_id: string;
  logins: PersonLogin[];
  aliases: PersonAlias[];
}

export interface OrgInvitation {
  id: string;
  org_id: string;
  email: string;
  role: string;
  expires_at_epoch_ms: number;
  accepted_at_epoch_ms?: number | null;
}

export interface DirectoryMembership {
  org_id: string;
  org_name?: string | null;
  role: string;
  status: 'active' | 'suspended' | string;
}

/** A Keycloak identity, visible only to a platform administrator. */
export interface PlatformIdentity {
  id: string;
  username: string;
  email?: string;
  display_name?: string;
  identity_provider?: string;
  first_seen_at_epoch_ms?: number;
  status: 'platform_admin' | 'assigned' | 'unassigned';
  home_tenant_id?: string;
  home_tenant_name?: string;
  organization_role?: string;
  memberships?: DirectoryMembership[] | null;
}

/** Somebody the caller shares an organization with (ADR-0036): no addresses. */
export interface Colleague {
  org_id: string;
  user_id: string;
  display_name?: string | null;
  role: MembershipRole | string;
}

/** One organization the caller belongs to. */
export interface MyMembership {
  org_id: string;
  role: MembershipRole | string;
  status: 'active' | 'suspended';
  org_name?: string | null;
}

/** The caller's Studio person. */
export interface StudioProfile {
  id: string;
  display_name?: string | null;
  email?: string | null;
}

/** A resource-group group: a team, for a grant. */
export interface Group {
  id: string;
  type: string;
  name?: string;
}

/** An AM dual-consent mode conversion. */
export interface Conversion {
  request_id?: string;
  id?: string;
  tenant_id: string;
  child_tenant_name?: string;
  target_mode: string;
  status: string;
  expires_at?: string;
}

/** An organization's logo, as `GET /studio-organizations/v1/logo` answers. */
export interface OrganizationLogo {
  content_type: string;
  /** The image, base64. */
  data: string;
  digest: string;
}

/** Workspace settings (AM tenant metadata): only what Secrets reads. */
export interface WorkspaceSettings {
  root_token_ref?: string;
}

/** A connection of studio-connector: only what Secrets reads. */
export interface Connection {
  id: string;
  name?: string;
  provider?: string;
  /** credstore reference of the token. */
  secret_ref?: string | null;
}

/** How many nodes of a type the graph holds; `capped` means "at least". */
export interface TypeCount {
  leaf_id: string;
  count: number;
  capped: boolean;
}

/** One GTS type the graph holds, and what this organization says about it. */
export interface CatalogType {
  type_id: string;
  leaf_id: string;
  is_abstract: boolean;
  component: boolean;
  schema: 'builtin' | 'tenant' | 'none';
}

/** The types-registry's entities, for their titles. */
export interface GtsEntityPage {
  entities?: { gts_id: string; content?: { title?: string } }[];
}

/* ── studio-connector: Integrations (the prototype's `api.ts` at 00828880) ── */

/** A provider this deployment can serve: one whose driver plugin is linked. */
export interface ConnectorProvider {
  provider: string;
  display_name: string;
  default_base_url: string;
  /** GTS instance id of the driver plugin. */
  instance_id: string;
  /** `source_code` | `ai` | `notification` | `cluster` | `registry` | `compute`. */
  category: string;
  /** Label for the credential field, e.g. "API Key" vs "Personal Access Token (PAT)". */
  credential_label: string;
  /** Placeholder hinting at the credential's shape, e.g. "sk-ant-…". */
  credential_hint: string;
  /** `notification` only: the credential fixes the channel (an incoming webhook). */
  fixed_target?: boolean;
  /** A connection may be stored without a credential: a public gear repository. */
  token_optional?: boolean;
  /** Made by signing in to the provider's identity provider (ADR-0049). */
  sign_in?: boolean;
}

/** A connection as Integrations lists it. */
export interface StoredConnection {
  id: string;
  /** Tenant holding it: the organization, or an ancestor when inherited. */
  owner_tenant_id: string;
  provider: string;
  label: string;
  /** Account the credential belongs to, captured when it was verified. */
  account: string;
  base_url: string;
  /** personal | workspace | organization */
  scope: string;
  secret_ref: string;
  created_at_epoch_secs: number;
  options?: Record<string, string>;
  /** Whether the caller created it. */
  mine?: boolean;
}

export interface ConnectorIdentity {
  account: string;
  display_name?: string | null;
}

/** The answer to a create, a patch and a test. */
export interface ConnectionTest extends ConnectorIdentity {
  connection: StoredConnection;
}

export interface RemoteRepo {
  id: string;
  name: string;
  full_path: string;
  clone_url: string;
  default_branch?: string | null;
  description?: string | null;
  visibility?: string | null;
}

/** What Integrations reads of studio-environments: the cluster and registry each environment uses. */
export interface EnvironmentUse {
  name: string;
  connection_id: string;
  registry_connection_id?: string | null;
}

/** `GET /studio-domain-model/v1/types`: the organization's Studio domain model (ADR-0066). */
export interface DomainTypesResponse {
  ontology: { entities?: unknown[]; buckets?: unknown[] };
  /** Whether this caller may change the model (`domain.model`, ADR-0035). */
  can_edit_model: boolean;
  /** The GTS ids each type and relation kind is registered under. */
  gts?: GtsCatalog;
}

/** `GET /studio-domain-model/v1/type-counts`: objects per type; `complete: false` while the read model fills. */
export interface DomainTypeCounts {
  counts: Record<string, number>;
  complete: boolean;
}

/** A model edit's answer: the type as it is now and the model's new version. */
export interface DomainModelEdit {
  entity: unknown;
  version: number;
  migrated?: number | null;
}

export interface DomainModelRevision {
  version: number;
  at: string;
  by: string;
  op: string;
  target: string;
  summary: string;
  patch: unknown[];
  undo: unknown[];
}

export interface DomainModelHistory {
  head: number;
  revisions: DomainModelRevision[];
}

export interface DomainModelGraph {
  nodes: { key: string; name: string; payload: Record<string, unknown> }[];
  edges: { type_id: string; from: string; to: string; payload?: Record<string, unknown> }[];
}

export interface DomainObjectsGraph {
  nodes: { instance_id: string; entity: string; bucket: string; name: string; value: Record<string, unknown> }[];
  edges: DomainModelGraph['edges'];
  truncated?: boolean;
}
