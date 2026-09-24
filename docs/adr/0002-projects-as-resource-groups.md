# ADR-0002: Projects — Resource Group-backed in v0.1, domain gear later

Status: **accepted (v0.1 scope)** · Date: 2026-07-28

## Context

The Studio v2 model chains Organization → Workspace → **Project** (an effort inside a
workspace, with its own members). Our stack covers organizations and workspaces (tenant
types) but has no Project anywhere.

The modeling question: is a Project an *isolation boundary* or a *domain entity*?
Per the v2 representation model, isolation ends at the workspace (the workspace owns
the knowledge graph and the tenancy scope); a project groups work and people inside it.
So a tenant per project would be over-modeling (barriers, IdP provisioning hooks and
closure maintenance for something that is not a security boundary).

The platform already has a primitive for exactly this shape: **Resource Group** —
typed, tenant-scoped group forests with memberships. account-management itself uses RG
for user groups instead of building its own tables.

## Decision (v0.1)

A Project is an RG group of a Studio-owned GTS type:

- Type: `gts.cf.core.rg.type.v1~cf.studio.project.v1~` (`can_be_root: true`,
  `allowed_membership_types: [gts.cf.core.rg.type.v1~cf.core.am.user.v1~]` — the same
  AM member-handle used for user groups). Registered via RG's type API
  (`POST /types-registry/v1/types`, see `demo/setup-projects.sh`).
- Workspace binding: group `metadata.workspace_id` = the workspace tenant id.
- Project members: RG memberships (`group × member-handle × user_id`).

No Rust code required — the whole layer is data.

## Known limitation (accepted for dev)

RG scopes a group to the **caller's** tenant. With the dev static tokens (home tenant =
root) projects land in the root tenant and workspace binding is by metadata only, not
by tenancy. Proper scoping arrives with either per-workspace identities (OIDC) or a
context-tenant mechanism. This is acceptable for the portal walking skeleton and is
the main trigger for graduating to a domain gear.

## Graduation path

**Step 2 — `simple-resource-registry` (when it ships).** gears-rust contains a
spec-stage gear (`gears/simple-resource-registry/docs/`, PRD/DESIGN only, no code yet)
that is a near-exact fit: universal CRUD for typed resources — fixed envelope
(identity, ownership, timestamps) + JSON payload validated against GTS type
definitions, tenant/owner/type authorization, optional lifecycle events
(created/updated/deleted) usable as workflow triggers. When implemented, Project
migrates there as GTS type `cf.studio.project.v1~` with a validated payload
(workspace_id, status, dates) — real tenant authorization and events, still zero
custom Rust. Project *membership* can stay on RG or move into the payload.

**Step 3 — a dedicated `studio-projects` gear** only if logic outgrows CRUD: rich
lifecycle rules, knowledge-graph links, cross-gear queries ("all projects where user X
is a member"). The portal's REST shape is kept swap-friendly either way.

Related spec-stage gear worth watching: `approval-service` (docs only) — generic
approval flows that project lifecycle transitions could delegate to.
