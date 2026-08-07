# Deploying studio-web to Kubernetes

The chart lives in `deploy/helm/studio-web` (app repo — versioned together
with the code it deploys). Environment value files live with the deploy
pipeline (`constructorfabric/studio-web-ci`, Pattern B);
`helm/values-dmz.example.yaml` documents the contract.

## Images

Published by GitHub Actions on a `v*` tag (`.github/workflows/release.yml`):

- `ghcr.io/constructorfabric/studio-web/studio-backend:<tag>`
- `ghcr.io/constructorfabric/studio-web/studio-frontend:<tag>`

Both run non-root (backend: `studio` system user; frontend:
nginx-unprivileged, uid 101, port 8080). Chart requires explicit immutable
tags — no `latest`.

## Configuration model

One image, any environment:

- **Backend** starts with `--config config/k8s.yaml`, which resolves every
  environment-specific value from env vars; the chart wires those from
  pre-created Secrets (see `values-dmz.example.yaml` header for the exact
  Secret names/keys).
- **Frontend** serves a static bundle; per-environment values (OIDC issuer,
  client id, links) are injected at container start into `env.js`
  (`window.__STUDIO_ENV__`) — no rebuild per environment.

## Feature flags in cluster v1

- **IDE sessions are disabled** (`studio-session.enabled=false` in
  `k8s.yaml`): the Docker session driver needs `/var/run/docker.sock`;
  the per-session Pod driver is a future step (ADR-0003). Session APIs
  answer 503 with a clear message; the rest of the portal is unaffected.
- **User invites are optional**: set `backend.idpAdmin.baseUrl` +
  `idp_admin_secret` to enable the Keycloak Admin provisioning plugin;
  without them the plugin self-deprioritizes.

## Install

```bash
helm upgrade --install studio-web deploy/helm/studio-web \
  -n studio --create-namespace \
  -f values-dmz.yaml
```

Prerequisites: the three Secrets from `values-dmz.example.yaml`, an OIDC
realm (issuer must serve real TLS), and a Postgres with a CREATEDB-capable
app user. Per-gear databases are NOT auto-provisioned: `auto_provision` only creates SQLite directories, so the databases come from the initdb list in k8s/postgres.yaml, which runs once on an empty volume — add one by hand if you introduce a gear later.
