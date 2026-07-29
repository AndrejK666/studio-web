# studio-web

Constructor Studio web server — backend, frontend, installer.

| Project | What | Stack |
|---|---|---|
| [`studio-backend/`](studio-backend/) | Studio API service assembled from [CF/Gears](https://github.com/constructorfabric/gears-rust): multi-tenancy, users, groups. REST + OpenAPI at `/cf/docs`. | Rust (axum/tokio/sea-orm via gears) |
| [`studio-frontend/`](studio-frontend/) | Walking-skeleton SPA: token → `/me` → tenant list through the gateway. | Vite + React 19 + TS, vitest |

## Quick start

```bash
# backend (needs a gears-rust checkout as a sibling of this repo)
cd studio-backend && cargo run -- --config config/dev.yaml run
# frontend
cd studio-frontend && npm install && npm run dev   # http://localhost:5173
```

## CI/CD (GitHub Actions)

- **`ci.yml`** — on push/PR, path-filtered: backend (fmt, clippy `-D warnings`, build, test, `--list-gears` smoke) and frontend (test, build). The backend job checks out `constructorfabric/gears-rust` next to the repo — path dependencies expect `../../gears-rust`; add a `GEARS_RUST_TOKEN` secret if that repo is private.
- **`release.yml`** — on tag `v*`: release binary + frontend dist → GitHub Release; Docker images (`studio-backend`, `studio-frontend` with nginx `/cf` proxy) → GHCR; then a `deploy` job gated by the `production` environment (target wiring is a TODO stub — helm/kubectl or ssh+compose).

Release: `git tag v0.1.0 && git push origin v0.1.0`.
