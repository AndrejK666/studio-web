# Observability — metrics for the studio cluster

Metrics collection for the `webstudio` cluster, provisioned as code: three Helm
releases in the `studio-monitoring` namespace, each with a pinned chart version
and a values file in this directory. `make all` is idempotent.

The shape follows the stack Insight runs, minus the parts we have no source for
(no ClickHouse, no Airbyte/dbt). There is **no Prometheus server and no
Alertmanager**: VictoriaMetrics is the Prometheus-compatible store, and Alloy is
both the scraper and the OTLP receiver.

```
studio-backend ──OTLP :4317──┐
                             │
kubelet / cAdvisor ──────────┤
kube-state-metrics ──────────┼──► Alloy ──remote_write──► VictoriaMetrics ──PromQL──► (Grafana)
Traefik :9100 ───────────────┤     1 replica              30 d, 20 Gi
CloudNativePG :9187 ─────────┘
```

## Components

| Release | Chart | Role |
|---|---|---|
| `vm` | `vm/victoria-metrics-single` 0.45.0 | Metrics store. PromQL in, `remote_write` in, 30-day retention on a 20 Gi `cinder-default` PVC. |
| `kube-state-metrics` | `prometheus-community/kube-state-metrics` 8.4.1 | Kubernetes object state: readiness, restarts, OOMKills, replicas, pod phase. |
| `alloy-metrics` | `grafana/alloy` 1.12.1 | Deployment (not the chart's default DaemonSet). Scrapes every target, receives OTLP, remote-writes to `vm`. |
| `grafana` | `grafana/grafana` 10.5.15 | The UI. No persistence: datasource and dashboards are provisioned, so a deleted pod comes back identical. |

Plus one NetworkPolicy per application namespace (`scrape-netpol.yaml`) — see
**Reaching the application namespaces**.

## What is scraped

Everything below already exported metrics before this stack existed — nothing in
the cluster had to be modified to be observed.

| Job | Target | Gives |
|---|---|---|
| `kubelet-cadvisor` | kubelet `:10250/metrics/cadvisor` | Per-container CPU, memory, network |
| `kubelet-resource` | kubelet `:10250/metrics/resource` | Kubelet's own resource accounting |
| `kube-state-metrics` | in-namespace Service `:8080` | Restarts, OOMKills, ready-vs-desired, pod phase |
| `traefik` | Traefik pods `:9100` | Edge RED: request rate, status classes, TLS and connection failures |
| `cnpg` | CloudNativePG instance pods `:9187` | Postgres: connections, transactions, replication, WAL, database size |
| (OTLP) | pushed by `studio-backend` | `http_server_request_duration_seconds_*` — RED per `http.route` |

The OTLP receiver listens from day one; the backend does not push yet (see
**Turning on application metrics**).

## Dashboards

Three, provisioned into the **Studio** folder from `grafana/dashboards/*.json`:

| UID | Covers |
|---|---|
| `studio-resources` | Per-pod CPU, memory vs limit, throttling, network I/O, restarts, OOMKills, ready-vs-desired, live Theia sessions. |
| `studio-edge` | Traefik: request rate, status classes, per-service rate and errors, latency percentiles, exporter health. |
| `studio-postgres` | CNPG: instances up, backends, cache hit ratio, longest transaction, commits/rollbacks, database sizes, replication lag, lock waits. |

`make dashboards` rebuilds the `studio-dashboards` ConfigMap from those files;
the file provider re-reads the directory every 30 s, so no restart is needed.
Editing a dashboard in the browser is a scratchpad — the provider owns the files
and a restart discards whatever the UI saved.

Two things this arrangement buys, both learned the hard way elsewhere:

- **No dashboard sidecar.** The chart's sidecar discovers labelled ConfigMaps
  through the Kubernetes API, and on this cluster it cannot: the API server's CA
  carries no Authority Key Identifier, which current OpenSSL rejects outright
  (`CERTIFICATE_VERIFY_FAILED ... Missing Authority Key Identifier`). Mounting
  the ConfigMap needs no API call, so the failure mode does not exist.
- **No Helm templating over dashboard JSON.** The JSON files become a ConfigMap
  via `kubectl`, never through `tpl`, so a legend format stays written the way
  Grafana wants it instead of being helm-escaped. (Insight, which embeds
  dashboards inline in a values file, has to escape every one of them.)

## Public access and SSO (prepared, off)

Grafana is `ClusterIP` only. The way in is

```bash
kubectl -n studio-monitoring port-forward svc/grafana 3000:80
# admin; password:
kubectl -n studio-monitoring get secret grafana -o jsonpath='{.data.admin-password}' | base64 -d
```

An Ingress and Keycloak SSO are wired in `grafana/values.yaml` and default to
off, because turning them on needs two things this repository cannot do on its
own:

1. **A DNS record.** `studio-dev.cfabric.org` resolves to Cloudflare and TLS
   terminates there — the cluster has no cert-manager `Issuer`, no
   `Certificate`, and the product's own Ingress carries no `tls` block. A host
   for Grafana is therefore a Cloudflare record someone in infra adds, not a
   certificate we request. Set `ingress.hosts` and
   `grafana.ini.server.domain` to that name (both, or the OAuth redirect
   returns to a host nobody is listening on).
2. **The `grafana` client in the deployed realm.** The public Keycloak image
   ships no realm; it arrives as the `studio-web-keycloak-realm` Secret. The
   client is added to `keycloak/realm-studio.json` here, so that Secret has to
   be regenerated from the updated file before
   `grafana.ini.auth.generic_oauth.enabled` is flipped.

The client is **public, with PKCE** — the same shape `studio-portal` uses. There
is no client secret anywhere: none to seal, rotate, or leak. Its redirect URIs
already include `http://localhost:3000/login/generic_oauth`, so once the realm
Secret carries the client, SSO can be exercised over the port-forward before any
DNS exists.

Everyone who authenticates gets **Viewer**. Dashboards are provisioned with
`allowUiUpdates: false`, so Editor would grant the right to change nothing that
survives a restart; Admin stays the local account, which also keeps a way in for
the case where the IdP is the thing that broke.

> The `grafana/grafana` chart is flagged `deprecated: true` upstream, yet 10.5.15
> is its newest release and carries the current Grafana (12.3.1). The successor
> is `grafana-operator`, a CRD-based rewrite — not worth it for one instance.
> Noted here so the flag is a known fact rather than a surprise at upgrade time.

## Reaching the application namespaces

`studio-dev` and `studio-test` carry a hand-applied `default-deny-ingress`.
Nothing in the repo created it, and it silently broke the first CNPG scrape:
discovery found all three Postgres instances, the targets showed `up == 0`, and
no component reported an error — a dropped packet reads exactly like a broken
exporter.

`scrape-netpol.yaml` opens one hole per namespace: from pods in
`studio-monitoring`, to the container port **named** `metrics`. The named port is
the same handle Alloy's discovery keeps on, so a workload becomes scrapable
exactly when it declares that it exports metrics. Nothing else crosses the
namespace boundary, and egress is untouched — the backend's OTLP push out to the
collector is an outbound connection, and only ingress is denied by default.

## Labels

Every series carries `cluster="webstudio"` (Alloy's `external_labels`). Series
that come from an application namespace also carry `env="dev"` or `env="test"`,
derived from `namespace` by a relabel rule — one store holds both environments
and a query separates them by label, not by reading pod names.

## Cardinality

The one workload here with unbounded pod churn is the session gear: it starts a
Theia pod per workspace, named `cf-studio-session-<workspace-uuid>`, and every
one of them becomes a fresh set of cAdvisor series that never repeats. The
`drop_noise` pass in `alloy-metrics/values.yaml` therefore drops the families
that multiply per device and per interface (`container_fs_*` rates,
`container_blkio_device_usage_total`, `container_network_{tcp,udp}_usage_total`,
`container_spec_*`, …), the pod-level roll-ups cAdvisor duplicates as an empty
`container` label, and the systemd slice tree.

What it deliberately keeps is per-pod CPU, memory and restarts for session pods:
that is the signal we want, and it is one series per pod per family. If session
volume grows enough to matter, the next cut is aggregating session pods into one
series at scrape time, not dropping them.

`kube_pod_labels` carries `cf.studio.session` and `cf.studio.workspace_id`
(the KSM allowlist), which is the only way to tell a session pod from a platform
pod in a query — cAdvisor series carry pod names, never pod labels.

## Turning on application metrics

The backend needs no code change. The `api-gateway` gear already installs the
`HttpMetrics` layer unconditionally — `http.server.request.duration` (histogram,
seconds, OTel semconv attributes `http.request.method`, `http.route`,
`http.response.status_code`) and `http.server.active_requests`. Without a meter
provider those instruments are no-ops, which is exactly the state today: there
is no `opentelemetry` block in `studio-backend/config/*.yaml`, so the toolkit
never initializes one.

Adding the block turns them on:

```yaml
opentelemetry:
  resource:
    service_name: "studio-backend"
  exporter:
    kind: "otlp_grpc"
    endpoint: "${STUDIO_OTLP_ENDPOINT:-http://alloy-metrics.studio-monitoring.svc.cluster.local:4317}"
  tracing:
    enabled: ${STUDIO_OTEL_TRACING:-false}
  metrics:
    enabled: ${STUDIO_OTEL_METRICS:-false}
```

That block is already in `studio-backend/config/k8s.yaml`, and the Helm chart
wires the switches (`backend.telemetry.metrics` / `.tracing` / `.endpoint` →
`STUDIO_OTEL_*`). Both default to **off**. Because the config file is baked into
the image, the flags only take effect from the next image build onward —
flipping the value on a pod running an older image changes nothing, since that
image's config never mentions the variable.

Two things make that work, and both are easy to get wrong:

- `OpenTelemetryConfig` is `#[serde(deny_unknown_fields)]`. A stray key does not
  degrade to a default — it fails the boot.
- The toolkit expands `${VAR}` and `${VAR:-default}` textually, over the raw
  YAML, *before* parsing it. That is why `enabled: ${STUDIO_OTEL_METRICS:-false}`
  yields a real boolean and why the rubber duck is an env var, settable per
  environment from the Helm chart without rebuilding the image.

## Operating it

```bash
make all                  # namespace + all three releases (idempotent)
make status               # releases, pods, PVCs

# Query the store directly, before there is a Grafana to blame:
kubectl -n studio-monitoring port-forward svc/vm-victoria-metrics-single-server 8428:8428
curl -s 'localhost:8428/api/v1/query?query=up' | jq '.data.result[].metric.job'

# The collector's own view of its targets — read this before rewriting a query
# when a panel is empty:
kubectl -n studio-monitoring port-forward svc/alloy-metrics 12345:12345
open http://localhost:12345/
```

## Not here yet

- **Logs and traces.** Loki + an Alloy DaemonSet, Tempo for the OTLP spans the
  toolkit already knows how to emit.
- **Alerts.** Deliberately last. A threshold picked before the baseline exists
  is the fastest route to a muted channel — Insight recorded that lesson; we get
  to inherit it rather than repeat it.
- **Domain metrics for `studio-session`.** Session start latency, failures to
  create, live sessions per tenant, idle reaping. These do not exist in any gear
  yet and need code (the pattern is a meter in the gear, as in
  `gears/bss/ledger/src/infra/metrics.rs`).
- **Multi-replica identity.** The backend runs one replica and the chart refuses
  to autoscale while the session registry is process-local. When that changes,
  OTLP series from two replicas collapse into one unless the pod identity is
  stamped on them (Insight uses a `k8sattributes` processor for exactly this).
