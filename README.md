# Constructor Studio Web

Constructor Studio Web is the web runtime for Constructor Studio: the Rust
backend, the primary FrontX portal, the prototype portal, Keycloak-based login,
and per-workspace Theia IDE sessions.

## Supported deployment modes

| Mode | Purpose | Entry point | Configuration |
|---|---|---|---|
| Docker Compose | Local development and functional checks on one machine | `http://localhost:8080` | [`.env.example`](.env.example), [`docker-compose.yml`](docker-compose.yml) |
| Kubernetes | Shared dev, test, and future production environments | Environment hostname | [`deploy/helm/studio-web`](deploy/helm/studio-web), [`deploy/README.md`](deploy/README.md) |

The two modes run the same logical stack, but use different runtime drivers:
Compose launches IDE containers through the local Docker daemon; Kubernetes
launches session Pods through the namespace-scoped Kubernetes driver.

## Local development with Docker Compose

### Prerequisites

- Docker Desktop or Docker Engine with Compose v2;
- access to GitHub while building the backend image (it downloads pinned Rust
  dependencies);
- optionally, a GitHub PAT with `read:packages` when launching Theia sessions
  from a private GHCR image.

Create local environment settings. Do not commit `.env`.

```bash
cp .env.example .env
```

Start the complete local stack:

```bash
docker compose up --build -d
docker compose ps
```

| Service | URL / port |
|---|---|
| Main portal | <http://localhost:8080> |
| Prototype portal | <http://localhost:8081> |
| Backend API and OpenAPI | <http://localhost:8090/cf/docs> |
| Keycloak / local admin console | <https://localhost:8443> |
| PostgreSQL | `127.0.0.1:5433` |

The Compose profile starts these services: `graph-postgres`, `keycloak`,
`backend-bootstrap`, `backend`, `frontend`, and `frontend-prototype`.
`graph-postgres` is the single local PostgreSQL instance; it contains both the
application databases and `graph_storage`.

Open <https://localhost:8443> once and accept the local self-signed certificate
before using browser login. Sign in to the portal with Keycloak user
`admin` or `demo`, password `studio`. Keycloak administration uses
`admin` / `admin` and is only intended for local development.

Useful lifecycle commands:

```bash
docker compose logs -f backend
docker compose down
docker compose down -v  # removes local database data as well
```

### Optional local capabilities

| Capability | Local behaviour |
|---|---|
| LLM / Spec Quality | Add the corresponding keys to `.env`; blank keys leave those integrations unavailable without preventing the stack from starting. |
| Durable credential values | Set `STUDIO_CREDSTORE_KEY` once (`openssl rand -base64 32`). Changing it makes previously stored values unreadable. |
| Theia sessions | Build the expected local image before the first session, then set GHCR credentials in `.env` only if the selected image requires them. |
| S3 file storage | Not provisioned by Compose. Local Compose is not an S3 integration test; use the Kubernetes environment for the Virtuozzo S3 path. |

Build the image used by the current Compose session profile:

```bash
docker build -t cf-studio-theia:local ./theia
```

Compose mounts the Docker socket and `/srv/cf-studio-workspaces` into the
backend. Do not change only one side of that mount: session containers are
created by the host Docker daemon and require the same host path.

## Kubernetes deployment

Kubernetes is the supported shared deployment mode. The Helm chart and
environment values remain in this repository; deployment is performed through
GitHub Actions, not Argo CD or a separate infrastructure repository.

| Environment | Namespace | Public endpoints |
|---|---|---|
| Dev | `studio-dev` | `studio-dev.cfabric.org`, `studio-dev-poc.cfabric.org` |
| Test | `studio-test` | `studio-test.cfabric.org`, `studio-test-poc.cfabric.org` |

The exact Secret contract, Helm values, session RBAC bootstrap, S3 setup and
break-glass recovery procedure are documented in [`deploy/README.md`](deploy/README.md).
The CI/CD promotion rules are in [`deploy/PIPELINES.md`](deploy/PIPELINES.md).

Routine deployment flow:

1. Push or merge code to `main`. The Build Images workflow publishes an
   immutable `sha-<commit>` snapshot, rebuilding only components whose build
   context changed.
2. In GitHub Actions, run **Deploy Services** from `main`.
3. For dev select a `sha-<commit>` image tag and the required service
   component. For test select a published `v*` release tag.
4. For PostgreSQL, Keycloak, or other infrastructure changes, publish an
   `infra-v*` tag and run **Deploy Infra**.

Do not use a cluster-admin kubeconfig in GitHub Actions. Each GitHub
Environment uses the namespace-scoped `studio-deployer` kubeconfig stored as
`KUBE_CONFIG_B64`.

## CI/CD

- **Test** runs on pushes and pull requests, filtered by changed component.
- **Build Images** runs for `main`, version tags (`v*`), infrastructure tags
  (`infra-v*`), and manual requests. Main snapshots rebuild only changed images
  and copy unchanged images into the same immutable SHA snapshot.
- **Deploy Services** is manual and deploys `backend`, `frontend`,
  `prototype`, or `all`. SHA snapshots are dev-only; release tags may be
  promoted to configured shared environments.
- **Deploy Infra** is manual and accepts only published `infra-v*` tags.

The backend's gates can be run before a pull request, in the image CI uses:

```bash
scripts/backend-check.sh            # fmt, clippy, build, features, test
scripts/backend-check.sh clippy     # one gate
scripts/backend-check.sh test studio_session   # a gate plus cargo args
```

It needs only Docker: the gates want a linker plus `protobuf-compiler` and
`cmake`, which on a Windows checkout would otherwise mean an administrator
install of Visual Studio Build Tools. CI stays the authority — it also runs a
gear-assembly smoke test — but a backend change once reached `main` without
compiling because CI was the only check and had not finished.

```bash
# service release
git tag v0.1.0
git push origin v0.1.0

# infrastructure release
git tag infra-v0.1.0
git push origin infra-v0.1.0
```

## Further documentation

- [`studio-backend/README.md`](studio-backend/README.md) — backend architecture
  and development.
- [`studio-backend/docs/adr/0003-theia-sessions.md`](studio-backend/docs/adr/0003-theia-sessions.md)
  — IDE session model.
- [`theia/README.md`](theia/README.md) — Theia image and IDE customisation.
- [`keycloak/README.md`](keycloak/README.md) — Keycloak image and realm setup.
- [`deploy/README.md`](deploy/README.md) — Kubernetes prerequisites and
  operations.
