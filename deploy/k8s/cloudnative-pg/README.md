# Graph PostgreSQL for dev and test

This is an experimental PostgreSQL 19 beta deployment. PostgreSQL 19 is not in
CloudNativePG's supported PostgreSQL range yet; do not use this profile for
production data.

## Connections

`max_connections` is declared in both templates at PostgreSQL's own default of
100. It is written down rather than inherited because it is a budget several
other files spend against, and an implicit ceiling is one nobody can check:

| Consumer | Ceiling | Where it is set |
|---|---|---|
| studio-backend, 13 gear pools | 52 | `pool.max_conns: 4` on `pg_main`, `studio-backend/config/k8s.yaml` |
| studio-backend, graph-storage | 8 | that gear's own `pool` override |
| studio-backend, studio-events | 2 | that gear's own `pool` override |
| Keycloak | 10 | `keycloak.dbPoolMaxSize`, `deploy/helm/studio-web/values.yaml` |
| backend-bootstrap Job | ~2 | transient, one pass per upgrade |
| CloudNativePG + exporter | ~5 | the operator |
| `superuser_reserved_connections` | 3 | PostgreSQL default |
| **Total** | **~82** | |

The thing to know before changing any of it: toolkit-db caches one pool **per
gear**, not per server, so the `max_conns` on `pg_main` is multiplied by the
number of gear databases — fourteen. Raising it by one raises the ceiling by
fourteen. Give a single gear its own `pool` block instead, the way
`graph-storage` has one.

A second backend replica doubles the backend's share — 124 on its own — which
does not fit, and this is now the **main** thing in the way of running one.
The other blocker, a push channel whose sequence lived in process memory, is
gone: `studio-events` keeps its sequence and its replay window in the database
listed above, so two replicas agree on what a cursor means.

Two ways to make room, neither free. Lowering the shared `max_conns` from 4 to
3 brings two replicas to roughly 96 including everything else, at the cost of
queueing sooner under a burst. Raising `max_connections` costs memory on the
server — a PostgreSQL backend is a process — so `resources` has to move with
it. The pooler below is the third way and is not available yet.

### PgBouncer

`pooler.template.yaml` is a CloudNativePG `Pooler` and is **deliberately not
applied**. Session pooling would multiplex nothing here (the backend's pools
are long-lived, so each would simply hold a server connection), and transaction
pooling is blocked by two things in the backend: sqlx's per-connection prepared
statement cache, which toolkit-db exposes no way to disable, and
studio-scheduler's session-level advisory lock, which transaction pooling would
quietly stop enforcing. The file states both in full, along with what to change
and how to verify it afterwards.

## Ordering

1. Create an `infra-v*` tag on a tested commit from `main` and wait for the
   **Build Images** workflow to publish the infrastructure release.
2. Confirm that the graph PostgreSQL and Keycloak release images are readable
   from GHCR.
   Public image visibility does not grant Kubernetes deploy access; deployments
   remain controlled by cluster RBAC.
3. Install the pinned CloudNativePG operator version documented in the cluster
   runbook and wait for its controller deployment.
4. Run **Deploy Infra** with the published `infra-v*` tag. It renders the
   matching template with the versioned image reference and applies it to the
   selected namespace.
5. Wait for `cluster/studio-postgres` to report `Cluster in healthy state`.
6. Verify that Secret `studio-postgres-app` exists. CloudNativePG creates it;
   both Helm environment values map the username key to `username`.

The dev template creates one 10 GiB Cinder-backed instance. The test template
creates two 20 GiB Cinder-backed instances on separate nodes. Neither exposes a
public Service. Each template also reconciles a separate logical `keycloak`
database and login role inside the same PostgreSQL cluster. Create the
namespace-local `keycloak-postgres-app` Secret before applying the template; it
must use type `kubernetes.io/basic-auth`, contain `username: keycloak` and a
strong `password`, and also provide `host`, `port`, and `dbname` keys for the
Keycloak workload. Keycloak 26.7 does not officially support PostgreSQL 19, so
this shared-cluster layout is for dev/test only. Backup configuration is
intentionally a separate gate and must be completed before storing important
data.
