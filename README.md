# studio-web

Constructor Studio web server — backend, frontend, installer.

| Project | What | Stack |
|---|---|---|
| [`studio-backend/`](studio-backend/) | Studio API service assembled from [CF/Gears](https://github.com/constructorfabric/gears-rust): multi-tenancy, users, groups. REST + OpenAPI at `/cf/docs`. | Rust (axum/tokio/sea-orm via gears) |
| [`studio-frontend/`](studio-frontend/) | Walking-skeleton SPA: token → `/me` → tenant list through the gateway. | Vite + React 19 + TS, vitest |

## Quick start

**One click (Docker):** everything — Postgres, backend built from source, frontend on nginx:

```bash
docker compose up --build -d
# portal:   http://localhost:8080    (sign in: studio-admin-token)
# API/docs: http://localhost:8090/cf/docs
```

Requires Docker (Desktop with WSL integration is fine) and a `gears-rust` checkout as a
sibling of this repo. The first build compiles the whole gears workspace — grab a
coffee; rebuilds are cached. Stop with `docker compose down` (add `-v` to wipe data).
To enable the Ask AI feature, put a real OpenAI key into
`studio-backend/config/docker.yaml` → `static-credstore-plugin` before building.

**Daily dev (fast iteration):** database in Docker, backend on the host (WSL), frontend via Vite:

```bash
docker compose up -d postgres                                   # once
cd studio-backend && cargo run -- --config config/postgres.yaml run   # WSL
cd studio-frontend && npm install && npm run dev                # http://localhost:5173
```

(or the zero-Docker variant: `--config config/dev.yaml` runs the backend on SQLite)

## Theia IDE sessions (Open Studio)

"Open Studio" launches a dedicated Theia IDE container per workspace via the
`studio-session` gear (our first own gear — see
`studio-backend/docs/adr/0003-theia-sessions.md`).

One-time setup: build the IDE image (repo `fabric-poc` checked out next to
this one):

```bash
cd ../fabric-poc/poc/theia
docker build -t cf-studio-theia:latest .
```

Then in the portal: workspace → Open Studio → Launch. Optional Git URL is
cloned into the workspace on first launch. Sessions bind to loopback ports
41000-41099, live 4 h (reaper), survive backend restarts (label adoption),
and can be stopped from the launcher.

Requirements: Docker daemon reachable from the backend (`/var/run/docker.sock`).
In the full-docker profile the compose file mounts the socket and
`/srv/cf-studio-workspaces` into the backend (host and container paths must be
identical — bind sources are resolved by the host daemon).

## OIDC login (real sign-in)

The static dev tokens stay for scripts and quick starts; real browser login
uses the `oidc-authn-plugin` gear against a Keycloak shipped in compose.

```bash
docker compose up -d postgres keycloak
cd studio-backend && cargo run -- --config config/oidc.yaml run
```

Then in the portal press "Sign in with SSO" — users `admin` / `demo`
(password `studio`). Dev Keycloak runs self-signed TLS on
<https://localhost:8443>: open that URL once and accept the certificate
before the first login. Admin console: same URL, `admin`/`admin`.

How it fits together: the portal does Authorization Code + PKCE
(`src/oidc.ts`, no dependencies), Keycloak issues a JWT whose `sub` is the
user UUID and whose `tenant_id` claim (from a user attribute, see
`docker/keycloak/realm-studio.json`) is the home tenant UUID; the
`oidc-authn-plugin` validates it via discovery/JWKS (the dev CA is trusted
through `http_client.custom_ca_certificate_paths`) and maps claims into the
platform SecurityContext. mini-chat's background S2S goes through the same
realm (`s2s_oauth`, confidential client `mini-chat`).

### Cloning from a self-hosted GitLab (or GitHub Enterprise)

The GitHub/GitLab chips compose `github.com` / `gitlab.com` URLs. For a
self-hosted host use the **Git URL** source with the full HTTPS clone URL and
a PAT:

| Field | Value |
|---|---|
| name | `csh_hypotheses_back` (becomes the directory) |
| source | **Git URL** |
| url | `https://gitlab.constr.dev/hypotheses/csh_hypotheses_back.git` |
| PAT | a GitLab personal access token with the `read_repository` scope |
| mount at | optional — e.g. `.workspace-sources/hypotheses/csh_hypotheses_back` to match a CLI-created workspace layout |

HTTPS, not SSH: the session container has no SSH key or agent, while a PAT
travels as a credstore secret reference and is injected into the clone through
an inline credential helper (never written to `.git/config`). If the workspace
manifest lists `git@…` SSH remotes (as CLI-created ones do), the portal's
HTTPS source is what actually materializes the working copy; the manifest entry
stays untouched.

### Using your own IdP (Keycloak, Azure AD, Auth0, …)

1. Create a **public client** with **PKCE (S256)**, redirect URI
   `http://localhost:5173/*` (or your portal origin) and matching web origin.
2. Tokens must carry: UUID `sub`, and a `tenant_id` claim with the user's
   home-tenant UUID (custom claim/attribute mapper). Adjust
   `jwt.claim_mapping` in `config/oidc.yaml` if your claim names differ.
3. Point `jwt.trusted_issuers` (and `s2s_oauth.discovery_url`, if used) at
   your issuer URL — https required; add your corporate root CA via
   `http_client.custom_ca_certificate_paths` when it is not in system roots.
4. Frontend: set `VITE_OIDC_ISSUER` and `VITE_OIDC_CLIENT_ID`.

## CI/CD (GitHub Actions)

- **`ci.yml`** — on push/PR, path-filtered: backend (fmt, clippy `-D warnings`, build, test, `--list-gears` smoke) and frontend (test, build). The backend job checks out `constructorfabric/gears-rust` next to the repo — path dependencies expect `../../gears-rust`; add a `GEARS_RUST_TOKEN` secret if that repo is private.
- **`release.yml`** — on tag `v*`: release binary + frontend dist → GitHub Release; Docker images (`studio-backend`, `studio-frontend` with nginx `/cf` proxy) → GHCR; then a `deploy` job gated by the `production` environment (target wiring is a TODO stub — helm/kubectl or ssh+compose).

Release: `git tag v0.1.0 && git push origin v0.1.0`.
