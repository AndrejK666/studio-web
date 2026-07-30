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

## CI/CD (GitHub Actions)

- **`ci.yml`** — on push/PR, path-filtered: backend (fmt, clippy `-D warnings`, build, test, `--list-gears` smoke) and frontend (test, build). The backend job checks out `constructorfabric/gears-rust` next to the repo — path dependencies expect `../../gears-rust`; add a `GEARS_RUST_TOKEN` secret if that repo is private.
- **`release.yml`** — on tag `v*`: release binary + frontend dist → GitHub Release; Docker images (`studio-backend`, `studio-frontend` with nginx `/cf` proxy) → GHCR; then a `deploy` job gated by the `production` environment (target wiring is a TODO stub — helm/kubectl or ssh+compose).

Release: `git tag v0.1.0 && git push origin v0.1.0`.
