# studio-backend — notes for agents

Rules that live nowhere in the type system, each learned from a real
regression. Read them before changing a gear.

## Reading the artifact graph: never `list()` and then filter

graph-storage's projection cannot filter or order on payload fields
(`docs/upstream/graph-storage-requests.md` §5), and `scope`, `repo` and `updated_at` are
all payload fields. So `GraphStore::list()` walks the tenant's **whole** typed
node set in pages of 200, one after another. On studio-dev (2026-09-25) that
was 24–33 thousand nodes and **12–20 s per call**, which put `/nodes`,
`/source-activity`, `/spec-rows` and `/specs-per-source` over 10 s on the
product dashboard.

The fix is `studio_artifact_index`, a Postgres mirror of the graph
(`src/artifact_ingest/index.rs`, explained in `../docs/design/studio-artifact-ingest.md`).
For it to work, every artifact read and write has to go through its API:

- **Read by scope** with `GraphStore::list_in_scope`, `count_in_scope`,
  `files_in_scope` or `page` (on the service: `list_in_scope` / `page_nodes`).
  Each is one indexed query. `list()` followed by `node_in_scope` is exactly
  the walk this replaced; use it only for a genuinely unscoped read, and say
  why in a comment.
- **Write only through `GraphStore`** (`upsert_nodes`, `delete_nodes`), never
  with `GraphStorageClientV1` directly. `IndexedGraphStore` updates the index
  in the same call, so a write that skips it leaves the index behind the
  graph, and the listings then show stale or missing artifacts.
- **A new write or delete path on `GraphStore`** also needs an override in
  `IndexedGraphStore`. When the index cannot follow a change, call `withdraw`
  (the tenant falls back to the graph and refills) rather than leaving it
  quietly wrong.
- **A new listing rule** (another filter, another sort) goes into
  `graph::page_of_nodes` and `ArtifactIndex::page` together. `index_tests.rs`
  checks the two against each other over a query matrix, so extend the matrix
  too.
- **The test to run** is `cargo test -- artifact_ingest::index`. It needs
  Docker, because the suite starts its own Postgres.

graph-storage has payload `$filter`/`$orderby` since weftgraph 0.1.1, and since
0.3 a count (`count_nodes`) and an in-process type update
(`register_types_with`). That is still not enough to delete the index: there
is no offset, no index behind a payload ordering, the count is capped at
`projection_count_max`, and the artifact types do not declare the paths yet. The gaps and the migration
are in `docs/upstream/graph-storage-requests.md`, item 5, "Status". When they close,
delete the index rather than keep two mirrors in step.

## Domain objects: one write path, two readers

`POST /studio-domain-model/v1/query` answers from `studio_domain_objects` and
`studio_domain_edges` (the read model, ADR-0066, `src/domain_model/mirror.rs`)
once a tenant's is filled, and from the graph before that. The same rules as
the artifact index follow from it:

- **Write domain objects and relations only through `DomainStore`**, which
  the gear wires as `IndexedDomainStore`. A write straight to the graph client
  leaves the rows behind, and queries then miss it.
- **A new write path on `DomainStore`** needs an override in
  `IndexedDomainStore`, or a `withdraw` when the rows cannot follow.
- **A new query feature** goes into both executors, `query.rs` (graph) and
  `query/sql.rs` (SQL), and into `mirror_tests.rs`, which asks both the same
  question and compares. It needs Docker: `cargo test -- domain_model::mirror`.
- **A scoped read filters in the graph.** Every domain node type declares
  `/payload/_scope` in its `index` trait (`gts::derived_node_schema`), so
  `list_objects` with a scope sends `$filter=payload/_scope eq '…'` on every
  page. Another filterable path goes into `gts::INDEX_PATHS` with a typed
  property, and the registration (`Update` + `revalidate`) brings stored types
  up to it; a type that refuses keeps walking. Test against the gear itself:
  `cargo test -- domain_model::store_graph_tests`.
- **Never delete a domain node** in graph-storage: its key could never be
  written again. Mark it (`store::DELETED_FIELD`), as `POST /mutate` does.

## Reading repositories: never the provider on a request path

A project's repository has ONE clone on the server,
`{root}/{project_id}/{source dir}`. The root is chosen at startup:
`STUDIO_WORKSPACES_ROOT` when set (compose: shared with the IDE), else
`STUDIO_ARTIFACT_WORKDIR` (a cluster: the chart's artifact-clones claim) --
one code path either way.
Only the artifact sync fetches it, and it marks the commit it read
(`refs/studio/synced`). Everything else reads it through
`artifact_ingest::port::ProjectCheckout` (`SourceCheckout::read_file`,
`ls_tree`, `log`, `authors`, ...), which is local git only. Never
`connectors::sdk::Repository::open(...).read_file/tree/history/contributors`
on a request path for a project source: a source not synced yet answers
"not synced, Re-sync", not a provider call. A copy that must live elsewhere
(Gearbox roots) is filled from the checkout (`CorpusSource::local`,
`git_checkout::mirror_local_into`). Writes (commits, pull requests, tags,
dispatch) still go to the provider. A repository that is not a project
source keeps its own background-refreshed clone and is never fetched inside
a request. Design: `../docs/design/studio-artifact-ingest.md`,
`cpt-studio-principle-artifact-ingest-one-checkout`.

## Gear databases

- A gear with a `database:` section in one profile needs it in every profile,
  or an entry in `DATABASE_OMISSIONS` saying why not
  (`gts_inventory::tests::every_profile_gives_the_same_gears_a_database_or_records_why_not`).
- **PostgreSQL only.** No SQLite dialect and no SQLite-backed tests. Tests take
  a server from `crate::test_pg`. A suite that runs migrations uses
  `fresh_database`, not the shared DSN: two suites migrating the shared
  database at once collide on the `_test` history table.
- **Connection budget.** Each gear pool counts against `max_connections: 160`
  on pg_main, and two replicas must fit. Give a new gear `pool.max_conns: 2`
  unless it needs more, and update the arithmetic in `config/k8s.yaml` and
  `deploy/k8s/cloudnative-pg/README.md`.

## Between gears

A gear uses another only through its `port`, its `sdk` or an item its `mod.rs`
exports. Never `crate::<gear>::<private module>`:
`assembly::manifest::tests::no_gear_reaches_into_another_gears_private_modules`
fails. Need more? Add it to the owner's `sdk` or `port`.

## Running the gates

One command, from the repository root:

```
scripts/backend-gate.sh                    # fmt, clippy -D warnings, all tests
scripts/backend-gate.sh kit_registry       # tests filtered by name
scripts/backend-gate.sh --only fmt,clippy  # fewer steps
scripts/backend-gate.sh --raw 'cargo run --locked --quiet -- api-contract --accept'
```

It prints one line per step, the test counts and whether
`cf-studio-backend` was really compiled, and writes the full output to a log
file it names. The exit code is non-zero when any step failed, so trust it.
Do not start Rust builds with a hand-written `docker run`. The script already
does what such a run would need to do by hand:

- **Waits its turn.** Only one Rust build runs at a time. The slot is the
  container name `cf-studio-gate-slot-1`, and a waiting gate blocks in
  `docker wait`, so there is no need to poll `docker ps`.
- **Keeps a target volume per worktree** (`cf-studio-target-<dir>-<hash>`,
  or `--target`) and **shares dependencies** through sccache on the
  `cf-studio-sccache` volume. A new worktree's first gate takes ~10 min instead
  of ~25.
- **Touches the changed sources** inside the container, so stale mtimes
  through the bind mount cannot make it pass on an old binary.
- **Builds CI's feature set** (`theia-bridge,github-mirror`).

Times on this machine (24 cores, 20 GB WSL), measured 2026-11-16:

| | before | after |
|---|---|---|
| cold clippy + test build, first worktree | 366 + 1121 s | 353 + 536 s |
| the same, a second worktree | 366 + 1121 s | 241 + 356 s |
| after an edit: clippy, then test build | 135 + 138 s | 110–119 s, run side by side |
| link of the test binary | 14.8 s | 5.0 s (mold) |
| target volume | 24.6 GB | 11.4 GB |
| peak memory of one build | 13.1 GB | 13.3 GB |

The peak memory is rustc compiling our one 346k-line crate, and none of the
above changes it. That is why `GATE_SLOTS` stays at 1: two cold builds of the
crate (~11 + ~13 GB) do not fit in 20 GB. Two warm ones (~5 + ~7 GB) do, so
`GATE_SLOTS=2` is safe only when both worktrees are already built.
`CARGO_BUILD_JOBS` does not help, because it limits how many rustc processes
run, not how much memory the one big process uses.

Old `cf-studio-backend-target*` volumes from before this script can be
removed with `docker volume rm`.

## Gates that pass when they should not

- A build through the Windows bind mount can reuse a stale binary.
  `backend-gate.sh` touches the changed sources and reports `compiled
  cf-studio-backend: yes|NO`. In a hand-made run, `touch` them inside the
  container and confirm the log says `Compiling cf-studio-backend` (clippy
  says `Checking`).
- Never pipe a gate through `tail` or `head`, because the exit code you see is
  theirs, not the gate's. `backend-gate.sh` already writes the log for you.
- After adding or renaming a route, `cargo test api_contract` is the gate.
  `studio-backend api-contract --violations` exits 0 either way.
- A change to a DTO, a route or `docs/events-catalog.md` also moves
  `docs/api-contract-accepted.txt`: run `cargo run --quiet -- api-contract
  --accept`. If it refuses, the change breaks a published promise (rule G4):
  keep the old shape, or record the printed line with a reason in
  `docs/api-contract-breaks.txt`. Never delete lines from the accepted file by
  hand, since that is how the check would be bypassed.

## Finding what is slow

The product dashboard is `monitoring.cfabric.org/d/studio-product` (Grafana,
behind a login). The same numbers come straight from VictoriaMetrics:

```
kubectl --context webstudio -n studio-monitoring port-forward svc/vm-victoria-metrics-single-server 18428:8428
# p95 per route over 24h
histogram_quantile(0.95, sum by (http_route, le) (rate(http_server_request_duration_seconds_bucket{env="dev"}[24h])))
```

The highest bucket is 10 s, so a p95 of `10` means "10 s or more". To find
out why a route is slow, read the backend log:
`kubectl --context webstudio -n studio-dev logs deploy/studio-studio-web-backend`.
For example, `projection walked nodes=… pages=… elapsed_ms=…` is a graph walk.
