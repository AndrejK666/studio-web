---
type: design
status: accepted
owner: studio-team
---

# Design — Constructor Studio

## Overview

Constructor Studio Web is the web runtime of Constructor Studio. It has four
running parts: a Rust backend assembled from CF/Gears (`studio-backend/`), a
FrontX portal where projects, people, integrations and secrets live
(`studio-frontend/`), the pre-FrontX prototype portal kept as a playground
(`studio-frontend-prototype/`), and per-workspace Eclipse Theia IDE sessions
(`theia/`) launched from the portal. Keycloak authenticates, and a single
PostgreSQL instance holds the application databases and the knowledge graph.

What the product must do is in [the PRD](../prd/constructor-studio.md); how it
splits into gears and features is in
[the decomposition](../decomposition/constructor-studio.md). This document
describes the system as it is built and links to the documents that own the
details rather than repeating them: [`docs/api-conventions.md`](../api-conventions.md)
(the REST and event contract), [`docs/errors-catalog.md`](../errors-catalog.md),
[`docs/events-catalog.md`](../events-catalog.md),
[`docs/theia-bridge-contract-v1.md`](../theia-bridge-contract-v1.md),
[`docs/backend-handover.md`](../backend-handover.md),
[`studio-backend/README.md`](../../studio-backend/README.md) and the decisions
in [`docs/adr/`](../adr/README.md).

## Architecture

The backend is a modular monolith: one `studio-backend` binary in which every
gear is linked at build time and discovered through `inventory`
(`studio-backend/src/registered_gears.rs`). Platform gears come from
`gears-rust` by Git dependency; Studio's own gears live in-crate under
`studio-backend/src/`. All REST traffic enters through the platform API gateway
under the `/cf/` prefix, is authenticated by the OIDC or static authn plugin,
authorized through `authz-resolver` and the Studio PDP, and scoped to the
caller's tenant. Gears call each other in-process through the ClientHub rather
than over HTTP. Cargo features select optional parts: `llm` (mini-chat, the
`api_egress` LLM egress and `studio-llm-proxy`, default on), `graph`
(graph-storage and its consumers, default on), `theia-bridge` and
`theia-event-broker` (the Theia bridge and its broker-backed event sink, off by
default).

### Platform gears linked from gears-rust

- System: `api_gateway`, `authn_resolver`, `authz_resolver`,
  `gear_orchestrator`, `grpc_hub`, `nodes_registry`, `resource_group`,
  `tenant_resolver`, `types_registry`.
- Authentication plugins: `oidc_authn_plugin` (real login), `static_authn_plugin`
  and `static_authz_plugin` (static dev tokens).
- `account_management` with its IdP plugins `keycloak_idp_plugin` (real user
  provisioning against Keycloak) and `static_idp_plugin` (Keycloak-less
  profiles).
- Feature gears: `credstore` with `static_credstore_plugin`, `file_storage`,
  `simple_user_settings`.
- Behind `llm`: `mini_chat` and `api_egress`. Behind `graph`: `graph_storage`.

### Studio gears in `studio-backend/src`

| Gear | Module | What it does |
|---|---|---|
| `studio-session` | `studio_session` | Launches, tracks and reaps per-workspace Theia IDE sessions through a Docker or a Kubernetes driver. |
| `studio-theia` | `studio_theia` | Backend-to-backend bridge to the Theia node backend inside a session: control calls out, authenticated event ingress in. |
| `studio-llm-proxy` | `llm_proxy` | OpenAI-compatible endpoint that forwards IDE AI calls upstream with a server-held provider key. |
| `studio-connector` | `connectors` | Connections to source hosts, model providers and chat platforms, plus the eleven connector-plugin gears (GitHub, GitLab, Bitbucket, Anthropic, OpenAI, Slack, Zulip, Discord and their webhook variants). |
| `studio-credstore-pg` | `credstore_pg` | Credstore value-store plugin backed by a Postgres table, so stored credentials survive a restart. |
| `studio-secrets-bootstrap` | `secrets_bootstrap` | Heals config-seeded credstore secrets once at start. |
| `studio-documents` | `documents` | Document types, templates, stages and capabilities, documents, and bindings of repository files to types with validation. |
| `studio-spec-quality` | `spec_quality` | Authenticated passthrough to the external spec-quality detectors, with the wait run as a background task. |
| `studio-artifact-ingest` | `artifact_ingest` | Ingests issues, pull requests and files from a connector source into the knowledge graph as typed GTS nodes. |
| `studio-domain-model` | `domain_model` | Stores the Studio domain model as GTS types in Graph Storage and lets it be extended. |
| `studio-components-catalog` | `components_catalog` | Catalogues Constructor Fabric gears from crates.io, scaffolds gears into a project repository, and previews products with the Gearbox engine. |
| `studio-kits` | `kit_registry` | Kit catalogue metadata and each project's desired kit installations. |
| `studio-user` | `user_profile` | The canonical user, its logins, memberships, aliases and invitations. |
| `studio-identity-directory` | `identity_directory` | Root-scoped read-only view of Keycloak identities, including those in no organization. |
| `studio-organizations` | `organizations` | Creates an organization together with its owner's membership and access grant. |
| `studio-authz-plugin` | `studio_authz_plugin.rs` | The Studio PDP: tenant clamp, with role grants layered on top for mapped resource types. |
| `studio-presence` | `presence` | Heartbeat-based online presence and direct messages over the push channel. |
| `studio-events` | `studio_events` | The single domain-neutral push channel to the portal (SSE plus replay). |
| `studio-tasks` | `tasks` | Durable background runs: a run is a row, execution is a queue entry. |
| `studio-scheduler` | `scheduler` | Cron and interval schedules that enqueue runs into `studio-tasks`. |
| `studio-notify` | `notify` | Validates and queues chat notifications, delivered as `studio-tasks` runs with retries. |
| `studio-insight` | `insight` | The one integration seam to Constructor Insight's read-only SQL endpoint. |

### Portal

`studio-frontend/` is a FrontX host shell plus microfrontends (ADR-0006). The
shell draws a 56px top bar and an overlay drawer and navigates three levels —
organization, workspace, project (ADR-0008,
[Levels in the shell](../feature/shell-levels.md)). The shell composes app-owned
shadcn-style primitives with Tailwind, and its theme tokens hold whole colours
(ADR-0007); the MFE screens use `@gears-frontx/ui-kit` inside shadow roots. The
MFEs under `src-app/mfe_packages/` are `organization-mfe` (Overview, Workspaces,
Organization settings), `projects-mfe` (Projects, New project, New workspace),
`connections-mfe` (Connections, Connect source), `people-mfe`, `kits-mfe` and
`search-mfe` (a search overlay), with `shared` for code they share. An MFE entry
may also be an iframe whose address arrives at runtime (ADR-0021).

`studio-frontend-prototype/` is the earlier single-page portal on port 8081. It
still carries the "Open Studio" launcher and screens the FrontX portal does not
have yet, among them documents, the components catalogue, kits, the domain
model graph, the identity directory, presence and notifications.

### IDE session

The session image (`theia/Dockerfile`) is Eclipse Theia 1.74.0 with these
extension packages:

- `theia/studio` — the Constructor Studio extension: the portal bridge, the
  workspace's repositories, the document surfaces, the Orca agents panel, Git
  operations, Analyze and Audit panels, and the workspace and artifact graphs.
- `theia/product-ext` — the product surface: the markdown editor, quality rail,
  flow rail and log, figure and table editors, search, repositories and project
  views, comments, tracked changes and co-presence in a document.
- `theia/gearbox-studio` — Gearbox inside Studio: gear catalogue, products,
  resolution, lock, conflicts and generation views, the native `.gdl` language
  and the `@Gearbox` chat agent, running on the Gearbox engine pinned by
  `STUDIO_GEARBOX_REF`.
- `theia/drawio-editor` — a draw.io diagram editor extension.

`theia/gdl-language` is a plain VS Code client for `.gdl` files kept for places
without Theia and is not built into the image.

A session is a container on the local Docker daemon bound to a loopback port in
41000–41099, or a Pod plus ClusterIP Service reached through the backend's
authenticated proxy. It lives four hours before the reaper collects it and
survives backend restarts through label adoption (ADR-0003). Sources are cloned
over HTTPS on first launch, with Git tokens supplied by an inline credential
helper from credstore references.

### Infrastructure

Compose (`docker-compose.yml`) runs `keycloak`, `graph-postgres`,
`backend-bootstrap` (seeds the root tenant), `backend`, `embedding-model`,
`frontend` (8080), `frontend-prototype` (8081) and `session-image` (builds the
session image and exits). Kubernetes runs the same logical stack from the Helm
chart in `deploy/helm/studio-web`, deployed by GitHub Actions to `studio-dev`
and `studio-test`; graph PostgreSQL and Keycloak are deployed separately from
`infra-v*` tags ([`deploy/README.md`](../../deploy/README.md),
[`deploy/PIPELINES.md`](../../deploy/PIPELINES.md)).

## Data Model

The entities below exist in code today; the product-wide domain model is in
`domain-model/` and, as stored types, in `studio-domain-model`.

- **Tenants.** Account-management owns the tenant tree: the root tenant, the
  organization, and the workspace (a root project, `tenant_type: workspace`)
  with nested projects beneath it (ADR-0010). Projects' attributes are tenant
  metadata. The organization's access config is tenant metadata
  `cf.studio.access.config.v1`, holding the access model (`tenant` or `roles`)
  and its grants (ADR-0009, ADR-0019).
- **People** (`studio-user`). `identity_user` (the person, profile only),
  `identity_login` (a sign-in method that resolves to them),
  `identity_membership` (an organization and the role held there),
  `identity_alias` (a non-login identifier they claim, with a confidence) and
  `identity_invitation` (stored as a digest, never the token) (ADR-0023).
- **Connections** (`studio-connector`). A provider, label, base URL, scope and
  owner tenant, with the credential held in credstore and referenced, never
  returned. Credential values are rows in `studio_credstore_values`.
- **Documents** (`studio-documents`). `studio_document_types` (template, section
  checklist, rules, questionnaire), `studio_process_stages`,
  `studio_process_capabilities`, `studio_documents` (scoped to the workspace
  tenant; `project_id` `NULL` means inherited by every project),
  `studio_document_analyses` (quality verdicts) and `studio_document_bindings`
  (a repository file's graph node, its detected type, state, confidence, source,
  candidates, validation report and content digest).
- **Knowledge graph** (`graph-storage`). Typed GTS nodes and edges: repository
  artifacts (`gts.cf.studio.artifact.*` — issues, pull requests, files) from
  `studio-artifact-ingest`; `gear` and `crate_version` nodes joined by
  `has_version` from `studio-components-catalog`; the domain model's `model` and
  `object_type` nodes from `studio-domain-model` (ADR-0024, ADR-0013).
- **Kits** (`studio-kits`). Catalogue entries and project-scoped desired
  installations; the kit bytes stay in their Git repositories.
- **Background work.** `studio_tasks_runs` (a run with state, attempts, summary
  or last error), `studio_scheduler_schedules`, and `studio_events_log` /
  `studio_events_cursor` (the event sequence and replay window).
- **IDE sessions** (`studio-session`). A running container or Pod per workspace,
  tracked by labels rather than a table, with a session gate token and a
  per-session S2S token for the bridge.

## Interfaces

**REST.** Every gear serves under `/cf/<gear-prefix>/v1`, documented in the
OpenAPI UI at `/cf/docs` and bound by [`docs/api-conventions.md`](../api-conventions.md)
and ADR-0020. The Studio prefixes, from each gear's `rest.rs`:

| Prefix | Gear |
|---|---|
| `/studio-session/v1` | sessions (`/sessions`) and the IDE proxy (`/ide/{id}/…`) |
| `/studio-theia/v1` | control calls into a workspace's session |
| `/studio-llm/v1` | `/chat`, `/models`, `/client-config` |
| `/studio-connector/v1` | `/providers`, `/connections`, `/probe`, `/graph-sync` |
| `/studio-documents/v1` | organization and workspace types, stages, capabilities, documents, spec rows and pipeline |
| `/studio-spec-quality/v1` | detector passthrough and `/verdicts` |
| `/studio-artifact-ingest/v1` | ingest runs |
| `/studio-domain-model/v1` | `/model`, `/types`, `/objects`, `/relations` |
| `/studio-components-catalog/v1` | `/components`, `/versions`, `/types`, `/field-schemas`, `/profiles`, `/compose`, `/gearbox`, `/sync`, `/activity`, project scaffold and product preview |
| `/studio-kits/v1` | `/catalog`, project installations |
| `/studio-user/v1` | `/me`, `/users`, `/organizations`, `/resolve`, `/merge` |
| `/studio-identity/v1` | `/users`, `/memberships` |
| `/studio-organizations/v1` | `/organizations`, `/rollups`, `/capabilities`, `/access-catalogue` |
| `/studio-presence/v1` | `/me`, `/online`, `/messages` |
| `/studio-events/v1` | `/stream` (SSE), `/events?after_seq=` (replay) |
| `/studio-tasks/v1` | `/runs`, `/task-types` |
| `/studio-scheduler/v1` | `/schedules` |
| `/studio-notify/v1` | `/messages` |
| `/studio-insight/v1` | `/health`, `/query`, `/pull`, `/push`, `/components` |

Platform gears keep their own prefixes, for example `/cf/account-management/v1`.
Errors follow the canonical categories in [`docs/errors-catalog.md`](../errors-catalog.md).

**Push channel.** `studio-events` is the one push channel to the portal: a
tenant-scoped SSE stream with at-least-once delivery and a cursor for replay.
Producers publish `kind` + `subject` with their own `payload` through the
ClientHub; the vocabulary is [`docs/events-catalog.md`](../events-catalog.md),
the decision ADR-0026, and the client half
[`studio-frontend/docs/studio-events.md`](../../studio-frontend/docs/studio-events.md).

**Portal ↔ IDE.** The portal embeds a session in an iframe and talks to it with
`postMessage` (`theia/studio/src/browser/portal-bridge-contribution.ts`).
Portal → IDE: `studio.init` and `studio.theme` carry the theme, and the editing
hand-off opens things in the IDE — `studio.openInEditor` (a repository file),
`studio.openGraph`, `studio.openDocument` (a portal document in the markdown
editor), `studio.openProduct` and `studio.openGear` (the Gearbox perspective).
IDE → portal: `studio.status` reports the dirty-editor count and
`studio.documentSaved` a document written back through the documents gear.
Messages are accepted only from `window.parent`, and the portal queues its
messages until the handshake is acknowledged.

**Backend ↔ IDE.** `studio-theia` calls the Theia node's internal control API
(`POST /internal/theia/v1/{method}`) and receives its events at an ingress, both
authenticated with the per-session S2S token; the wire surface is
[`docs/theia-bridge-contract-v1.md`](../theia-bridge-contract-v1.md) (ADR-0022).

## Trade-offs

- **In-crate gears over separate services.** Studio's gears are linked into one
  binary with the platform gears. Calls stay in-process through the ClientHub
  and a deployment is one image, at the cost of one release unit for every
  gear.
- **Projects are account-management tenants, not a Studio gear.** The dedicated
  `studio-project` gear was retired (ADR-0010 retires ADR-0005 for every
  client), so tenant isolation and membership come from the platform, and the
  client mirrors the rules the gear used to enforce.
- **Tenant clamp first, roles later.** The PDP always enforces tenant isolation
  and can only narrow it with roles; no Studio resource type is role-mapped yet,
  and administrative authority is answered in the gear (ADR-0009, ADR-0019).
- **Graph as the system of record for derived knowledge, relational for
  identity.** Repository artifacts, the gear catalogue and the domain model live
  in graph-storage, while people, memberships and bindings are relational;
  document content stays in the graph and `studio-documents` stores only a
  binding, so a file has one copy.
- **One domain-neutral push channel.** No producer's protocol, the Theia
  bridge's included, becomes the contract every consumer lives with, at the
  cost of each producer mapping its events onto `kind` and `subject`
  (ADR-0026).
- **Kubernetes without the LLM chain, and sessions per environment.** The
  release image drops `llm` because of a fresh-boot root-tenant deadlock on an
  empty database. IDE sessions are off in the chart by default
  (`backend.sessions.enabled: false`); the dev values enable the Kubernetes
  driver and the test values do not. While sessions are on, the chart refuses
  more than one backend replica, because two real replicas have not yet been
  run against a real cluster.

## Risks

- `gearbox-studio` is ported from a repository that carries no licence yet; its
  owner's permission is needed before it ships beyond evaluation
  (`theia/gearbox-studio/README.md`).
- Source-host tokens are stored in credstore, which diverges from the roadmap
  PRD's decision that Studio should not permanently hold host credentials
  (`docs/roadmap-alignment.md`).
- `PRODUCT.md` still describes authorization as allow-all and Kubernetes v1 as
  running without sessions, while the code has a tenant-clamping PDP with an
  empty role mapping and the dev values enable the session driver; the brief
  and the code should be reconciled.
