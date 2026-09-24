---
type: decomposition
status: accepted
owner: studio-team
---

# Decomposition — Constructor Studio

## Approach

The product decomposes along the gear boundary of the backend assembly: each
capability in [the PRD](../prd/constructor-studio.md) is owned by one or a few
gears, platform gears from gears-rust wherever one exists and an in-crate Studio
gear only where none does. The portal decomposes into FrontX microfrontends, one
per area of a navigation level, and the IDE into Theia extension packages. User
facing behaviour that crosses those parts is specified as a feature spec under
[`docs/feature/`](../feature/), and each decision that shaped a boundary is an
ADR under [`docs/adr/`](../adr/README.md). The architecture is described in
[the design document](../design/constructor-studio.md).

### Capabilities and the parts that cover them

| Capability | Backend gears | Portal and IDE |
|---|---|---|
| `domain` | `studio-documents`, `studio-domain-model`, `studio-components-catalog`, `studio-kits`, `studio-artifact-ingest`, `studio-spec-quality` | `projects-mfe`, `kits-mfe`, prototype documents and catalogue screens, `theia/product-ext`, `theia/gearbox-studio` |
| `tenancy` | `account_management`, `tenant_resolver`, `resource_group`, `studio-organizations` | `organization-mfe`, `projects-mfe`, the shell's level ladder |
| `auth` | `authn_resolver`, `oidc_authn_plugin`, `static_authn_plugin`, `keycloak_idp_plugin`, `studio-user`, `studio-identity-directory` | the shell's OIDC sign-in, `people-mfe`, Keycloak realm in `keycloak/` |
| `authz` | `authz_resolver`, `studio-authz-plugin`, the shared `access_config` module | derived role labels in the portal |
| `storage` | `graph_storage`, `file_storage`, `credstore`, `studio-credstore-pg`, `studio-secrets-bootstrap`, `studio-tasks`, `studio-scheduler`, `studio-events` | none of its own |
| `connectors` | `studio-connector` and its eleven connector-plugin gears, `studio-notify` | `connections-mfe` |
| `facade` | `studio-llm-proxy`, `studio-spec-quality`, `studio-insight` | Theia AI configured against `studio-llm-proxy` by the portal bridge |
| `deploy` | `studio-session` (Docker and Kubernetes drivers), `studio-theia` | `docker-compose.yml`, `deploy/helm/studio-web`, `theia/Dockerfile` |

`studio-presence` (who is online) and `api_gateway` serve every capability
rather than one.

## Features

The feature specs below are the user-facing slices of the FrontX portal written
so far. Each names its Cypilot ids, its actor flows, its Definitions of Done and
its acceptance criteria.

- [Levels in the shell](../feature/shell-levels.md) — the organization,
  workspace and project levels, the menu each level draws, and the breadcrumb
  of three slots. Capability: `tenancy`.
- [Workspaces in scope](../feature/workspace-scope.md) — the shell owns the
  organization's workspace list, creates a workspace and makes it current, and
  roots the projects list at it. Capability: `tenancy`.
- [The organization's workspaces](../feature/workspaces-screen.md) — the
  organization-level list of workspaces and the way into each. Capability:
  `tenancy`.
- [The organization overview](../feature/organization-overview.md) — the first
  screen of the organization level, with tiles that either answer or name what
  is missing. Capability: `tenancy`.
- [Create a project](../feature/project-create.md) — the New project wizard,
  empty or from existing repositories, writing an account-management tenant.
  Capabilities: `tenancy`, `connectors`.
- [Connect a source](../feature/connection-create.md) — the Connections screen
  and the overlay that adds a source host or model provider at organization
  scope. Capability: `connectors`.
- [Project artifacts](../feature/project-artifacts.md) — the project's rail and
  its artifacts table, synced per repository. Capabilities: `domain`,
  `connectors`.

## Sequencing

**Built and running.** The backend assembly with every gear listed in the
design document; OIDC sign-in against Keycloak with GitHub brokering; the
canonical user with logins, memberships, aliases and invitations; organizations
created with an owner; projects as account-management tenants; connections for
source hosts, model providers and chat platforms; per-workspace IDE sessions
with the Docker driver in Compose and the Kubernetes driver behind a chart
switch; the LLM proxy; documents with types, stages, capabilities and
repository bindings; artifact ingest into the knowledge graph; the gear
catalogue, scaffolding and Gearbox product preview; durable tasks, schedules,
queued notifications and the push channel; the FrontX shell with the seven
features above; the Theia extensions `studio`, `product-ext`, `gearbox-studio`
and `drawio-editor`.

**Next, as the repository records it.**

1. Decide how a notification leaves Studio — a project channel, personal
   e-mail or a stored inbox — and then build it; `studio-notify` owns the queue
   and no e-mail driver exists yet (`TASKS.md`, 2026-09-17).
2. Row-level authorization: map the first Studio resource types in the PDP's
   `privilege_for`, which returns nothing today, as gears start asking
   (ADR-0019 follow-ups).
3. Gearbox phases not yet done: P4 (start screen and create/add wizards
   verified) and P6b (Product view toolbar actions, screen scope, Fabric
   themes), and the ported code's licence permission
   (`theia/gearbox-studio/README.md`).
4. Unfinished items from the first planning round: the list of required gears
   for Studio Cloud/Web v1, the domain-model folder and playground, the initial
   v1 scope PRD, and a review that multi-user, multi-tenant source management
   works in Theia (`TASKS.md`, 2026-07-28 and 2026-07-29).
5. Features still marked partial: the organization overview's tiles that need
   an aggregate endpoint, and the open Definitions of Done in project artifacts.

## Open Questions

- Whether nested projects may nest further, whether root projects derive an
  owner, and what the shared connector catalogue is called while organizations
  stay hidden (`PRODUCT.md`).
- Whether source-host access should move from stored tokens to OAuth-app or
  installation tokens, as the roadmap PRD decided (`docs/roadmap-alignment.md`).
