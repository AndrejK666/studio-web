# ADR-0003: Per-workspace Theia IDE sessions in containers

Status: accepted (MVP scope) · 2026-07-30

## Context

The portal's "Open Studio" hands off to the Theia-based IDE
(fabric-poc/poc/theia). That PoC is deliberately single-user: one process, one
fixed workspace, no authentication of its own — its README requires an
authenticated proxy in front and one instance per user/workspace. To serve
many workspaces we therefore need a session manager that launches one IDE
container per (tenant, workspace) and hands the browser its address.

## Decision

1. **Theia image** (`cf-studio-theia:latest`, built from fabric-poc/poc/theia):
   bundles browser-app; env contract `STUDIO_*` (workspace id, actor, git mode,
   optional `STUDIO_REPO_URL` cloned on first launch by the entrypoint);
   workspace bind-mounted at `/workspace`; port 3003; non-root (uid 1000).

2. **studio-session gear** — Studio's first own gear, in-crate in
   studio-backend (`src/studio_session/`), `capabilities = [rest, stateful]`:
   - Docker via **bollard** over the local socket; sessions are containers
     labeled `cf.studio.session=1` + workspace/tenant/port labels.
   - REST `/studio-session/v1/sessions` (POST idempotent per workspace,
     GET list/one, DELETE). AuthN via the platform (`.authenticated()`);
     tenant isolation by `SecurityContext::subject_tenant_id()` — foreign
     sessions read as 404.
   - Port allocation from a configured loopback range; the state machine is
     `starting → running` (TCP probe on GET) → `stopped`.
   - `stateful`: a reaper loop stops sessions past `max_session_secs`;
     `adopt_existing()` re-attaches labeled containers after backend restart,
     so sessions survive redeploys.

3. **Exposure**: session ports bind to `127.0.0.1` only. The portal opens
   `http://localhost:{port}/` directly — acceptable for the local MVP where
   browser and backend share a host. Anything multi-host needs an
   authenticated WebSocket-capable proxy in front (see k8s path).

## Consequences

- Registry is in-memory; restart loses `repo_url` provenance but re-adopts
  containers from labels. A DB capability can follow if session metadata
  grows.
- The backend needs Docker: in the docker-compose profile that means
  mounting `/var/run/docker.sock` (host-root equivalence — dev-only, never
  production) and an **identical host/container path** for `workspaces_root`,
  because bind sources are resolved by the host daemon.
- `git_mode` defaults to `disabled`; `push` requires credentials inside the
  session container — deliberately out of MVP scope (public repos clone fine).

## k8s path (successor, same REST contract)

Replace the Docker driver with a Kubernetes one: one Deployment+Service per
session (the theia-cloud model), Ingress path `/studio/{session}` with
WebSocket upgrade and auth at the ingress, PVC per workspace instead of the
host directory, and the reaper deleting idle Deployments. The gear's REST
surface and the portal flow do not change — only the driver behind
`SessionService`.

## Alternatives considered

- **theia-cloud (upstream operator)** — right long-term shape, but requires a
  cluster + operator today; our gear keeps the same session semantics locally.
- **One shared multi-root Theia** — contradicts the PoC's single-user security
  model and mixes tenants in one process. Rejected.
- **Session manager as a standalone Node service** — faster to write, but
  duplicates authn/tenancy the gear gets from the platform for free, and we
  want the first-own-gear experience on a real feature.
