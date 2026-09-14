/* ── Access models, privileges and roles (concept → P1) ───────────────────────
 *
 * Two access models an organization can choose between (Admin → Access):
 *
 *   "tenant"  — access follows tenant membership: whoever is in the scope can
 *               act in it. This is today's behaviour (the platform's tenant
 *               model + static-authz plugin). No roles.
 *   "roles"   — role-based access: privileges are granted through named roles
 *               (a role IS a set of privileges), assigned to members/teams.
 *               Enforced by the Studio PDP plugin (ADR-0006) LAYERED OVER the
 *               tenant model (ADR-0009): tenant isolation is always the outer
 *               bound, roles only narrow access within the tenant — a member
 *               with no matching grant is denied, and no grant can reach across
 *               tenants.
 *
 * The choice and the org's role definitions are stored as AM tenant metadata
 * (same mechanism as the automation "trust ramp"), so this is backend-backed
 * without a new gear. A privilege here mirrors a platform Permission
 * ({resource_type, action}); the catalogue below is the Studio set we will
 * later register as GTS permission instances in types-registry.
 */

export type AccessModel = "tenant" | "roles";

export const ACCESS_MODELS: { id: AccessModel; label: string; blurb: string }[] = [
  {
    id: "tenant",
    label: "Tenant access",
    blurb:
      "Access follows membership: anyone in an organization or project can act within it. Simple, no roles to manage.",
  },
  {
    id: "roles",
    label: "Role-based access",
    blurb:
      "Access is granted through roles — each role is a set of privileges — assigned to members and teams. Fine-grained, but you manage roles.",
  },
];

/** One privilege = a Studio resource + a concrete action (a platform Permission). */
export interface Privilege {
  id: string;
  /** UI grouping (the resource family). */
  group: string;
  label: string;
}

/** The Studio privilege catalogue (ADR-0019 §2). Ordered by resource family,
 *  then action.
 *
 *  This list must match `PRIVILEGES` in `studio-backend/src/access_config.rs`,
 *  which is the side that seeds the ladder into the stored document and the
 *  side the PDP evaluates. This screen WRITES the document (`putAccessConfig`),
 *  so a privilege named here and not there is written into a role and then
 *  carries nothing.
 *
 *  `project.*` and `work.*` used to head this list and are gone: projects are
 *  account-management tenants (ADR-0010), so reaching one is membership rather
 *  than a privilege, and `studio-project` — the gear "Works" belonged to — no
 *  longer exists. */
export const PRIVILEGES: Privilege[] = [
  { id: "people.view", group: "People & Team", label: "View people" },
  { id: "people.invite", group: "People & Team", label: "Invite to the organization" },
  { id: "people.manage", group: "People & Team", label: "Manage memberships and roles" },

  { id: "access.manage", group: "Administration", label: "Manage roles and grants" },

  { id: "connector.view", group: "Connections", label: "View connections" },
  { id: "connector.manage", group: "Connections", label: "Manage connections" },

  { id: "secret.view", group: "Secrets", label: "View secrets" },
  { id: "secret.manage", group: "Secrets", label: "Manage secrets" },

  { id: "document.view", group: "Documents", label: "View documents" },
  { id: "document.edit", group: "Documents", label: "Edit documents" },

  { id: "session.open", group: "Sessions", label: "Open a workspace in the IDE" },
];

/** Catalogue grouped for the editor, preserving the order above. */
export function privilegesByGroup(): { group: string; items: Privilege[] }[] {
  const out: { group: string; items: Privilege[] }[] = [];
  for (const p of PRIVILEGES) {
    let bucket = out.find((b) => b.group === p.group);
    if (!bucket) {
      bucket = { group: p.group, items: [] };
      out.push(bucket);
    }
    bucket.items.push(p);
  }
  return out;
}

const ALL = PRIVILEGES.map((p) => p.id);

/** A role is a named set of privileges. `system` roles are seeded, non-deletable. */
export interface RoleDef {
  key: string;
  name: string;
  privileges: string[];
  system?: boolean;
}

/** The seeded roles for a fresh org (a sensible owner → viewer ladder).
 *
 *  Must match `default_roles()` in `studio-backend/src/access_config.rs`. The
 *  backend seeds this into the document when an organization's first grant is
 *  written; this screen overwrites the document wholesale when it saves, so a
 *  ladder that disagrees here silently replaces the one the PDP was built
 *  against.
 *
 *  `owner` is listed for editing, not for deciding: the PDP treats an
 *  org-scoped `owner` grant as carrying every privilege whatever this array
 *  says (ADR-0019 §7), so an owner cannot be locked out by a bad edit. */
export function defaultRoles(): RoleDef[] {
  return [
    { key: "owner", name: "Owner", system: true, privileges: [...ALL] },
    {
      key: "admin",
      name: "Admin",
      system: true,
      // Everything except redefining the roles themselves: running the
      // organization is an administrator's job, deciding who may run it is
      // the owner's (ADR-0019 §2).
      privileges: ALL.filter((id) => id !== "access.manage"),
    },
    {
      key: "editor",
      name: "Editor",
      system: true,
      privileges: [
        "people.view",
        "document.view",
        "document.edit",
        "connector.view",
        "secret.view",
        "session.open",
      ],
    },
    {
      key: "viewer",
      name: "Viewer",
      system: true,
      privileges: PRIVILEGES.filter((p) => p.id.endsWith(".view")).map((p) => p.id),
    },
  ];
}

/** A grant binds a subject (member or team) to a role within a scope
 *  (the whole organization, or one project). This is the (member/team × role ×
 *  scope) tuple the PDP will read. */
export interface GrantDef {
  id: string;
  subjectType: "member" | "team";
  subjectId: string;
  subjectName: string;
  roleKey: string;
  scopeType: "org" | "project";
  /** Tenant id (org) or project id; empty string means the whole organization. */
  scopeId: string;
  scopeName: string;
}

export interface AccessConfig {
  model: AccessModel;
  roles: RoleDef[];
  grants: GrantDef[];
}

export function defaultAccessConfig(): AccessConfig {
  return { model: "tenant", roles: defaultRoles(), grants: [] };
}

/** Fill in any missing pieces so an older/partial stored config still renders. */
export function normalizeAccessConfig(v: Partial<AccessConfig> | null | undefined): AccessConfig {
  const model: AccessModel = v?.model === "roles" ? "roles" : "tenant";
  const roles = v?.roles && v.roles.length ? v.roles : defaultRoles();
  const grants = Array.isArray(v?.grants) ? (v!.grants as GrantDef[]) : [];
  return { model, roles, grants };
}
