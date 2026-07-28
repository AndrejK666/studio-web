# Constructor Studio Frontend

Walking-skeleton SPA for the Studio backend: Vite + React 19 + TypeScript, vitest for tests. Proves the full chain frontend → api-gateway → authn → account-management (token → `/me` → tenant list).

```bash
npm install
npm run dev      # http://localhost:5173, /cf proxied to http://127.0.0.1:8090
npm test         # vitest
npm run build    # type-check + production bundle in dist/
```

Start the backend first (`../studio-backend`, `cargo run -- --config config/dev.yaml run`), open http://localhost:5173, press **Connect** (dev token is pre-filled).

The API client (`src/api.ts`) is hand-written for now; the plan is to generate it from the backend's live OpenAPI (`/cf/docs`) once the surface stabilizes. Longer term this app is the placeholder for the gears-frontx / fabric-poc based UI (see `../../fabric-poc`).
