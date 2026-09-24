---
type: prd
status: accepted
owner: studio-team
capabilities: domain, tenancy, auth, authz, storage, connectors, facade, deploy
---

# PRD — Constructor Studio

## Overview

Constructor Studio, from Constructor Fabric, gives an engineering team a
governed place to do project work. A project holds its people, sources, secrets
and connectors, and launches a full Theia IDE session against those sources with
AI agents already configured. This repository is the web runtime of the
product: the Rust backend assembled from CF/Gears (`studio-backend/`), the FrontX
portal (`studio-frontend/`), the pre-FrontX prototype portal
(`studio-frontend-prototype/`), Keycloak-based login (`keycloak/`) and the
per-workspace IDE sessions (`theia/`).

The product brief this document is built from is [`PRODUCT.md`](../../PRODUCT.md);
it stays the authority on positioning, principles and brand. The architecture is
in [the design document](../design/constructor-studio.md) and the split into
gears and features in [the decomposition](../decomposition/constructor-studio.md).

## Problem

An engineer who wants to work on a codebase with AI agents alongside has to
assemble that environment locally: clone every repository, hold a personal
access token for each source host, put an LLM provider key where the agent can
read it, and configure quality and search tooling by hand. Each of those is
repeated per person and per machine, and each leaves a credential somewhere the
organization does not govern. A local IDE with an agent plugin cannot keep
provider keys and Git credentials out of the place where the work happens, and a
hosted IDE without a tenant model cannot say which organization, project and
people a session belongs to. Nobody can answer "which repositories do we have"
or "who is working in this project" from one place.

## Goals

- An engineer opens a project and is working — repositories cloned, agents
  authenticated, quality and search surfaces present — without assembling any
  of it locally.
- Everything a person needs (sources, people, secrets, connectors, the IDE
  session) belongs to a project and is reached from it: the project is the unit.
- Credentials never travel to where the work happens: provider keys and Git
  tokens stay server-side and reach the session by reference.
- The product says only what the backend can prove: derived state is labelled
  as derived, and a surface the model anticipates but does not have yet shows as
  reserved, never as fake data.

## Non-Goals

- Customers, pricing, licensing terms, usage numbers and public marketing copy:
  none exist in this repository and none are to be fabricated.
- Billing, metering and compliance certification: no gear in the assembly
  provides them.
- SSH cloning: the session container has no SSH key or agent, so cloning is
  HTTPS-only even when a workspace manifest lists `git@…` remotes.
- IDE sessions in every Kubernetes environment: the chart ships with
  `backend.sessions.enabled: false`, the dev values turn the Kubernetes session
  driver on and the test values keep it off, and while it is on the backend
  stays single-replica (`deploy/helm/studio-web/values.yaml`). A portal surface
  that assumes a session must degrade honestly where there is none.
- A binding brand system: there is no committed Studio visual identity; the
  FrontX marks in the tree are template scaffolding.
- Deciding, in this document, what `PRODUCT.md` lists as undecided: whether
  nested projects may nest further, whether root projects derive an owner, and
  what the shared connector catalogue is called while organizations stay hidden.

## Users & Use Cases

**Primary: software engineers working on a codebase.** They arrive with
repositories on GitHub, GitLab (including self-hosted), GitHub Enterprise,
Bitbucket or a plain HTTPS Git URL, and want to read, edit, review and ship with
AI agents alongside. Their working surface is a per-workspace Theia IDE session
launched from the portal, not a local checkout.

- Open a project and launch its IDE session; the sources are cloned into the
  workspace on first launch.
- Work with the agents already present in the session — Theia AI with
  @Universal/@Coder, Codex, Claude Code and the Orca agent panel — authenticated
  through Studio rather than by a key in the container.
- Read and edit the project's documents in the IDE's markdown editor, see them
  classified and validated against their document type, and open a document,
  file, artifact graph or Gearbox product from the portal straight into the IDE.

**Secondary: project administrators.** They invite members, bind sources to a
project, and manage connectors and secrets.

- Connect a source host or model provider once per organization and pick
  repositories from it afterwards (see
  [Connect a source](../feature/connection-create.md)).
- Create a workspace and projects inside it, empty or from existing repositories
  (see [Create a project](../feature/project-create.md) and
  [Workspaces in scope](../feature/workspace-scope.md)).

**Secondary: platform and tenant administrators.** They place newly signed-in
people into organizations, see who has signed in without belonging to one, and
own the hidden organization level (ADR-0009, ADR-0010), which the portal shows
only behind `localStorage.setItem("studio.platformAdmin", "on")`.

## Requirements

What the product does today, grouped by area. Each item is implemented in this
repository; the gear or package that implements it is named in brackets.

**Organizations, workspaces and projects**

- A person creates an organization and owns it; the tenant, the owner's
  membership and the access grant are written by one resumable operation
  (`studio-organizations`, ADR-0018).
- A root project is an account-management tenant of type `workspace`, and
  projects are tenants beneath it; the wire keeps the words `workspace` and
  `workspace_id` (ADR-0010, `docs/concept-v2-project-is-the-unit.md`).
- The portal shell navigates three levels — organization, workspace, project —
  with a top bar, an overlay drawer and a context slot (ADR-0008,
  [Levels in the shell](../feature/shell-levels.md)).

**People and identity**

- Sign-in is OIDC Authorization Code + PKCE against Keycloak; GitHub identities
  arrive through Keycloak brokering; static dev tokens remain for scripts.
- A canonical Studio user is separate from the ways a person signs in: `user`,
  `login`, `membership` and `alias` records, with self-service attribution of
  external identities that binds only on a proof of control (`studio-user`,
  ADR-0023, ADR-0012, ADR-0015).
- Authentication does not grant organization membership; a person with no
  membership gets a valid no-access state, and a platform-admin view lists
  identities that belong to no organization yet (`studio-identity-directory`,
  ADR-0011, ADR-0018).
- Presence: who is in Studio right now, and a direct message to someone who is
  online, delivered on the push channel and never stored (`studio-presence`).

**Sources, connectors and credentials**

- A connection is configured once per tenant for a source host (GitHub, GitLab,
  Bitbucket), a model provider (Anthropic, OpenAI) or a chat platform (Slack,
  Zulip, Discord, each with a bot-token and an incoming-webhook variant); the
  API returns the credstore reference, never the token (`studio-connector`).
- Credential values survive a backend restart in a Postgres-backed credstore
  value store (`studio-credstore-pg`), and config-seeded secrets heal themselves
  at start (`studio-secrets-bootstrap`).
- Git tokens reach a session as credstore secret references through an inline
  credential helper and are never written into `.git/config`.

**IDE sessions**

- Launch, list, reach and stop a per-workspace Theia IDE session; sessions live
  four hours before a reaper collects them and survive backend restarts through
  label adoption (`studio-session`, ADR-0003).
- Two runtimes behind one contract: a container on the local Docker daemon, and
  a Pod plus ClusterIP Service per session reached through the backend's
  authenticated proxy.
- The session's Theia node backend is reachable backend-to-backend for control
  calls, and posts its events back through an authenticated ingress
  (`studio-theia`, behind the `theia-bridge` Cargo feature, ADR-0022).
- The IDE's AI calls an OpenAI-compatible endpoint under the Studio gateway with
  the user's own Studio token; the provider key is attached server-side and
  never enters the container (`studio-llm-proxy`, behind the `llm` feature).

**Documents and knowledge**

- Document types carry a markdown template, a section checklist and structural
  rules; types, stages and capabilities are defined at organization level and
  overridden per workspace; a PRD can be composed from a questionnaire
  (`studio-documents`, ADR-0014).
- Documents already in a repository are classified — declared front matter
  first, then inferred from sections, path, title and front-matter keys, then
  the external `purpose` detector — and validated against the chosen type; the
  result is recorded as a binding to the artifact-graph file node
  (`docs/documents-from-a-repository.md`).
- Specification quality is judged by the external spec-quality service's
  `bloat`, `purpose`, `leak` and `traceability` detectors through an
  authenticated passthrough (`studio-spec-quality`).
- Issues, pull requests and files are ingested from a connector source into the
  knowledge graph as typed GTS nodes with deterministic ids
  (`studio-artifact-ingest`).
- The Studio domain model is stored as GTS types in Graph Storage, extended with
  new fields and read back by the portal (`studio-domain-model`, ADR-0024).

**Gears, kits and products**

- The catalogue of Constructor Fabric gears published on crates.io is synced into
  the knowledge graph, and a gear skeleton can be scaffolded into a project's
  repository on a branch, optionally with a pull request
  (`studio-components-catalog`).
- A `product.gdl` can be composed from picked gears and resolved with the
  Gearbox engine, optionally committed; the session IDE carries the same engine
  as the Gearbox views and the `.gdl` language (`theia/gearbox-studio`).
- A catalogue of kits, and the per-project record of which kits are desired;
  `cfs` materializes kit files into a checkout (`studio-kits`).

**Background work and notifications**

- Durable background runs with state, attempts, cancel and retry
  (`studio-tasks`); cron and interval schedules that enqueue runs
  (`studio-scheduler`); queued chat notifications with retries and a dead-letter
  record (`studio-notify`).
- One domain-neutral push channel to the portal, with replay after a reconnect
  (`studio-events`, ADR-0026).

**Contract**

- Every REST operation and published event follows one written contract,
  enforced by a ratchet against a committed surface rather than by review
  (ADR-0020, [`docs/api-conventions.md`](../api-conventions.md),
  [`docs/errors-catalog.md`](../errors-catalog.md),
  [`docs/events-catalog.md`](../events-catalog.md)).

## Authentication & Authorization

Authentication is Keycloak. The portal signs in with OIDC Authorization Code +
PKCE and renews silently from a refresh token in `sessionStorage`; the backend
validates tokens with `oidc-authn-plugin`, and `static-authn-plugin` keeps static
tokens for scripts. User provisioning runs through the Keycloak IdP plugin of
account-management (ADR-0004). An identity proves who the person is and decides
nothing else (ADR-0018).

Authorization has two parts (ADR-0019). Row access is answered by the Studio PDP
(`studio-authz-plugin`), whose tenant clamp keeps every request inside the
caller's tenant subtree; roles are layered on top of the tenant model and can
only narrow access (ADR-0009). No Studio resource type is role-mapped yet, so
every request is answered by the tenant clamp. Administrative authority — who
may manage an organization's people, invitations and roles — is answered in the
gear from the organization's access config (`access_config.rs`). The portal
labels roles it derives from server state as derived and must not present role
controls as enforcement.

## Data & Storage

One PostgreSQL instance (`graph-postgres` in Compose) holds the application
databases and `graph_storage`. Gears with their own relational tables include
`studio-documents`, `studio-user`, `studio-tasks`, `studio-scheduler`,
`studio-events` and `studio-credstore-pg`. The knowledge graph is
`cf-gears-graph-storage` on PostgreSQL with pgvector, behind the `graph` Cargo
feature, with an in-process ONNX or a remote embeddings provider. File storage is
the `file-storage` gear, backed by Virtuozzo S3 in the Kubernetes environments
(`deploy/FILE_STORAGE_S3.md`); Compose does not provision S3.

## Integrations & External Systems

- Source hosts: GitHub, GitLab, Bitbucket.
- Model providers: Anthropic, OpenAI, and any OpenAI-compatible upstream behind
  `studio-llm-proxy`.
- Chat platforms: Slack, Zulip, Discord.
- Keycloak, as identity provider and GitHub broker.
- The external spec-quality service, wrapped by `studio-spec-quality`.
- Constructor Insight, whose read-only SQL endpoint is reached only through
  `studio-insight`.
- crates.io, read by the gear catalogue sync.
- The Gearbox engine, pinned by commit in the session image and in the backend
  preview.

`studio-spec-quality`, `studio-insight` and `studio-llm-proxy` are facades: each
exposes an existing external service under the Studio gateway, authenticates the
caller with the normal Studio token and attaches the server-held credential, so
that credential never reaches a browser or a session container.

## Deployment

Two supported modes run the same logical stack. Docker Compose is for local
development and functional checks on one machine: it starts Keycloak, the single
Postgres, the backend and its bootstrap, both portals and the session image, and
launches IDE containers through the host Docker daemon. Kubernetes is the shared
deployment for the `studio-dev` and `studio-test` namespaces, installed from the
Helm chart in `deploy/helm/studio-web` by the Studio Delivery GitHub Actions
workflow with a namespace-scoped kubeconfig; images are published to GHCR under
immutable `sha-` tags. The Kubernetes release is built without the `llm` feature
and with `graph` and `theia-bridge` (`deploy/README.md`, `deploy/PIPELINES.md`).

## Success Metrics

No usage numbers exist in this repository, so success is stated as observable
outcomes rather than targets:

- An engineer opens a project and reaches a working IDE session with its
  repositories cloned and its agents authenticated, without a local checkout or
  a credential in the browser.
- No provider key or Git token is readable inside a session container or
  returned by any API.
- Every surface the portal shows is either backed by a backend read or labelled
  as derived, local or reserved.
- The REST contract ratchet and the backend gates pass on every pull
  request.
