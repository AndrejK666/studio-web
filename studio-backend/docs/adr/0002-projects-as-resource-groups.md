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

## Graduation criteria → `studio-projects` gear

Move to a dedicated domain gear when any of these appears: project lifecycle
(draft/active/archived with rules), links into the knowledge graph, per-project
settings with validation, cross-gear queries ("all projects where user X is a member"),
or the tenancy limitation above starts to matter. The REST shape of the portal is kept
gear-compatible so the swap is a client change, not a redesign.
