# ADR-0010: Backend-to-backend bridge between studio-backend and the Theia IDE

Status: proposed · 2026-08-24

> ADR files are split across two trees for historical reasons:
> `studio-backend/docs/adr/` holds 0001–0003 and 0005 (backend-domain
> decisions); `docs/adr/` holds 0004 and 0006–0009 (product/shell decisions).
> This one lives in `docs/adr/` because it spans both the backend gears and the
> Theia extension. It supersedes nothing; it extends **ADR-0003 (per-workspace
> Theia sessions)**.

## Context

Today Studio runs two independent backends that never talk to each other
directly:

- **studio-backend** — the Rust/CF-Gears process: portal REST, account
  management, connectors, artifact graph, and the `studio-session` gear
  (ADR-0003) that launches and reverse-proxies one Theia container per
  `(tenant, workspace)`.
- **The Theia node backend** — `theia/studio`, a self-contained Node process
  inside each IDE container. Its `StudioRuntimeEndpoint`
  (`theia/studio/src/node/studio-backend-module.ts`) is the authority over the
  mounted `/workspace`: workspace config (TOML sources), repository discovery,
  the git operation journal/queue, sync orchestration, and workspace migration.
  It exposes all of this to the **browser only**, over Theia's JSON-RPC:
  - a request/response service `StudioRuntimeService` at
    `/services/studio-runtime` (`getSession`, `getRepositories`,
    `enqueueOperation`, the `*WorkspaceSource` mutations, `*WorkspaceSync`,
    `*WorkspaceMigration`, …), and
  - a broadcast client callback surface `StudioRuntimeClient`
    (`onOperationEvent`, `onAuditEvent`, `onRepositoriesChanged`,
    `onWorkspaceSnapshotChanged`, `onWorkspaceActivityEvent`).
  Both contracts live in `theia/studio/src/common/{studio-protocol,workspace-protocol}.ts`.

The only coupling between the two is operational, established by
`studio-session`: it starts the container, hands the browser a reverse-proxied
URL gated by `session_token`, and shares the `/workspace` clone volume. There is
**no** path for studio-backend to read or drive what happens inside a running
IDE — it cannot enqueue a commit, read the operation journal, observe a sync, or
react to a workspace-config change. Everything the Theia backend already models
is invisible to the portal.

We want the portal (studio-backend + React frontend) to be able to **work with
the IDE through our own backend**: trigger and observe editor-side operations,
surface workspace/repository/sync state in the portal, and feed IDE activity
into the artifact graph — without forking the Theia extension's ownership of the
workspace or duplicating its logic.

### Constraints carried in from earlier decisions

- The Theia PoC is single-user and unauthenticated on its own; it *requires* an
  authenticated proxy in front (ADR-0003). Any new backend-facing surface it
  grows must therefore be reachable **only** server-to-server, never from the
  browser or the public proxy path.
- studio-session already owns container lifecycle, labels
  (`cf.studio.workspace_id` / `cf.studio.tenant_id`), the loopback port
  allocation, and the `session_token`. Endpoint discovery for any bridge must
  come from there, not be reinvented.
- Tenancy/authz is a platform invariant (ADR-0009): a bridge call must run under
  a real `SecurityContext` and stay inside the caller's tenant subtree. The
  Theia container itself is tenant-blind, so the tenant boundary has to be
  enforced on the studio-backend side before a call ever reaches the container.

## Decision

Introduce a **backend-to-backend bridge** with two directions and a clean
ownership split. Neither existing contract to the browser changes.

### 1. Transport: an internal S2S control API on the Theia node

Add a second listener to the Theia node backend, mounted through the
`BackendApplicationContribution.configure(app)` hook that `StudioRuntimeEndpoint`
already participates in (it implements `BackendApplicationContribution` but only
uses `onStart` today). This is an **HTTP+JSON control API** that mirrors the
existing `StudioRuntimeService` methods, reusing the exact same request/response
types from `studio-protocol.ts`/`workspace-protocol.ts` — the browser RPC and
the S2S API become two façades over one endpoint object, so they can never drift
in behaviour.

The control API is:

- bound to an **internal port** distinct from the browser-facing Theia port, and
  **not** routed through the studio-session reverse proxy — so it is invisible
  to the browser and the public path;
- authenticated by a **shared server-to-server token** injected into the
  container as an env secret at launch (alongside the existing `agent_env`
  secrets), required on every request;
- request/response only. State changes still flow through the existing operation
  queue, so the S2S caller gets the same journaling, idempotency, and audit as
  the browser.

studio→Theia commands (enqueue an operation, mutate a workspace source, start a
sync, read a snapshot, drive a migration) go over this API.

### 2. Events: Theia → studio via the existing broadcast, forwarded out

The Theia endpoint already fans every state change out to registered
`StudioRuntimeClient`s. Register **one additional, non-browser client** inside
the node backend whose job is to forward those callbacks
(`onOperationEvent`/`onAuditEvent`/`onRepositoriesChanged`/
`onWorkspaceSnapshotChanged`/`onWorkspaceActivityEvent`) out of the container to
studio-backend. Transport for the egress is an **outbound HTTP POST** (or
WebSocket) to a studio-backend ingress URL, carrying the same S2S token and the
session identity. No new event model is invented — the wire events are the
`StudioRuntimeClient` payloads verbatim.

On the studio-backend side these land on an **event-ingress REST endpoint**,
are authenticated by the S2S token + session lookup, resolved to a
`(tenant, workspace)` via the studio-session registry, and republished onto the
platform's **`event-broker` gear** so any interested gear (artifact graph
ingest, notifications) can subscribe without coupling to Theia.

### 3. Ownership: a new `studio-theia` gear

Give the bridge its own gear rather than bolting it onto `studio-session`
(which stays purely a lifecycle/transport manager). The new **`studio-theia`**
gear owns:

- **`TheiaControlClientV1`** — a `ClientHub`-discovered client that speaks the
  S2S control API to a given session's Theia container. Callers in
  studio-backend depend on the trait, not on HTTP details.
- **Portal REST** — the studio-backend-facing surface the React frontend calls,
  which maps portal concepts onto `TheiaControlClientV1` calls under a real
  `SecurityContext` and the tenant clamp.
- **Event ingress** — the REST endpoint that receives forwarded Theia events and
  republishes them to `event-broker`.
- **S2S auth** — minting/validating the per-session S2S token, paired with the
  `session_token` studio-session already issues.
- **Endpoint discovery** — resolving a workspace/session to its Theia control
  URL and token by asking `studio-session` (labels + port allocation), never by
  guessing addresses.

### 4. Contract: versioned, with `studio-protocol.ts` as source of truth

The S2S contract is the same shape as the browser RPC, so the TypeScript
definitions in `studio-protocol.ts` / `workspace-protocol.ts` remain the single
source of truth. We pin it as a **versioned GTS type**
`gts.cf.studio.theia.control.v1~` on the studio-backend side (so the graph and
event payloads are schema-tracked like every other artifact), and treat the two
sides as a versioned pair: an additive change bumps the minor and stays
back-compatible; a breaking change is `…control.v2~` with both versions served
during migration. Optional methods on `StudioRuntimeService` stay optional on
the bridge — a session that predates a method answers "unsupported", it does not
error.

## Consequences

- studio-backend gains first-class, tenant-safe access to editor state and
  operations without duplicating the Theia backend's workspace/git logic — the
  Theia node stays the single authority over `/workspace`.
- The Theia extension grows exactly one internal listener and one forwarding
  client; its browser contract is untouched, so the IDE keeps working
  standalone (dev, tests) with the bridge simply idle when no S2S token is set.
- The public attack surface does not grow: the control API is internal-port +
  S2S-token only and never traverses the reverse proxy. The browser still only
  ever sees `/services/studio-runtime` behind the authenticated proxy.
- Events flow through `event-broker`, so new consumers (graph ingest,
  notifications) attach without touching Theia or the bridge.
- New moving parts to run and secure: an internal port per container, an S2S
  token lifecycle tied to the session, and an outbound path from the container
  to studio-backend (must be allowed by the container's egress in every driver —
  docker-compose and k8s).
- The bridge is only as available as the session: it is meaningful only while a
  container is `running`, and must degrade cleanly (portal shows "IDE not
  running") when studio-session reports no live session.

## Alternatives considered

- **Reuse the browser RPC path (`/services/studio-runtime`) from
  studio-backend.** Rejected: that path is designed for a single authenticated
  browser behind the proxy; driving it server-side would mean either exposing it
  off-proxy (breaks the ADR-0003 security model) or having studio-backend
  impersonate a browser client over Theia's WebSocket RPC — fragile and
  conflates the two consumers.
- **Put the bridge logic in `studio-session`.** Rejected: studio-session is the
  lifecycle/transport boundary; mixing a semantic control/event API into it
  couples container management to editor semantics and makes both harder to
  evolve. A dedicated `studio-theia` gear keeps each with one job.
- **A standalone Node sidecar as the bridge.** Rejected for the same reason
  ADR-0003 rejected a standalone session manager: it would re-implement the
  authn/tenancy/event-broker wiring the gear gets from the platform for free.
- **Shared database / shared `/workspace` files as the integration point.**
  Rejected: the operation journal and sync state are the Theia backend's private
  representation; reading them out-of-band would fork ownership and lose the
  idempotency/audit guarantees the queue provides.

## Phased plan

1. **Contract v1 (design, no behaviour change).** Freeze the S2S method + event
   set as a subset of `StudioRuntimeService`/`StudioRuntimeClient`; register the
   `gts.cf.studio.theia.control.v1~` GTS type; define the S2S token scheme and
   how studio-session injects it and publishes the internal endpoint.
2. **studio→Theia control path.** Implement `configure(app)` on the Theia
   endpoint to serve the internal HTTP API over the existing endpoint object;
   implement `TheiaControlClientV1` + portal REST in `studio-theia`; wire
   endpoint discovery from studio-session. First method end-to-end:
   `getRepositories` (read-only), then `enqueueOperation`.
3. **Theia→studio events.** Add the forwarding `StudioRuntimeClient` in the node
   backend; add the event-ingress REST + `event-broker` republish in
   `studio-theia`; land the first graph-ingest consumer for
   `onOperationEvent`/`onRepositoriesChanged`.
4. **Harden + productionize.** k8s driver parity (internal Service, egress
   policy), token rotation, unsupported-method negotiation, portal UX for
   session-down, and versioning/back-compat tests.

## Open questions

- Egress from the Theia container to studio-backend in k8s: NetworkPolicy shape
  and the stable in-cluster address for the ingress.
- Whether events should be pushed (container → studio) or pulled via the
  existing delta APIs (`getOperationDeltas`/`getAuditDeltas` are already
  sequence-cursored) on a studio-side poller — push is lower-latency, pull is
  simpler and survives restarts by cursor. Leaning push with pull as the
  reconnect backfill.
- S2S token lifetime vs. `session_token`: same lifetime and rotation, or an
  independent, shorter-lived control token.
