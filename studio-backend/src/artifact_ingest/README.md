# studio-artifact-ingest

Pulls issues, pull requests and files out of a connector source and puts them
into the knowledge graph as typed GTS nodes, so the rest of Studio can ask
questions about a repository instead of fetching it again.

## Why it exists

A repository's meaning is spread across three places that answer different
questions: the provider's API knows the issues and pull requests, the checkout
knows the files, and neither knows how they relate. This gear normalizes all
three into one typed shape — `gts.cf.studio.artifact.*` instances with
deterministic ids — so a re-sync upserts rather than duplicates, and so a
consumer traverses one graph instead of three APIs.

## Where the files come from

Three channels, tried in order, because cloning a repository twice is a waste
of the disk that already holds it:

1. **The studio-session workspace checkout** — the IDE has already cloned it
   (`STUDIO_WORKSPACES_ROOT`), so the files are on disk.
2. **Our own shallow clone** — opt-in (`STUDIO_ARTIFACT_WORKDIR`), for when no
   session has run.
3. **The connector tree API** — metadata only, when there is no disk to use.

## Reading nodes back is a walk, not a query

`GET /nodes` narrows by `scope`, by `repo`, and orders by the artifact's own
`updated_at`. All three live in the node payload, and graph-storage's
projection can filter and order on `node_key`, `name`, `created_at` and
`updated_at` only — never on a payload path. So this gear pages the whole typed
node set into the process and narrows it here.

On studio-dev that is **28,717 nodes, 31 MB of payload, 144 sequential round
trips** for one request, and the endpoint's p95 is **8.06 s** — the slowest
surface in the product by a factor of five. The cost is linear in the size of
the project and has no ceiling.

A per-tenant cache of the projection makes a client's walk through its own
pages cost one graph walk instead of one per page. It is dropped the moment an
ingest is accepted, and expires after 60 s so that another replica's ingest
cannot be served stale for longer than that.

| variable | default | |
|---|---|---|
| `STUDIO_ARTIFACT_LIST_CACHE_TTL_SECS` | `60` | `0` turns the cache off |
| `STUDIO_ARTIFACT_LIST_CACHE_MAX_NODES` | `40000` | budget across all tenants |

The budget is in nodes rather than entries because entries differ by three
orders of magnitude, and it is deliberately about one default listing: the pod
has a 1 GiB limit against a ~500 MiB working set, and a cached node is a parsed
`serde_json::Value`, several times the 1.1 KB its payload measures on disk. The
`projection walked` log line carries the node count, the page count and the
elapsed time, so the number to set is measured rather than guessed.

**This is a cache of a query we should have been able to write.** The real fix
is `$filter`/`$orderby` over the payload paths a type already declares in its
`index` trait — request 5 in [`../../docs/graph-storage-requests.md`](../../docs/graph-storage-requests.md),
which also records where in the platform that change lives.

## What it owns

Nothing durable of its own. Nodes and edges belong to graph-storage; the sync's
progress belongs to `studio-tasks`. A build without the `graph` feature falls
back to an in-memory store so the portal still reads something back.

## REST

| Method + path | Does |
|---|---|
| `POST /sync` | queue an ingest run; returns a task id that is also a `studio-tasks` run id |
| `GET /tasks/{id}` | that run's state and counts |
| `GET /nodes`, `GET /edges` | read back what was ingested, optionally by type |
| `GET /repo-files` | the file side of the graph |
| `POST /search` | retrieval over the ingested artifacts |
| `POST /files`, `POST /quality` | ingest a file set directly; quality signals |

## In the assembly

- Gear `studio-artifact-ingest`, capabilities `[rest]`, deps `types_registry`,
  `credstore`.
- Config section `gears.studio-artifact-ingest`.
- Sources and credentials come from [`../connectors`](../connectors); long runs
  come from [`../tasks`](../tasks).

The module documentation in `mod.rs` is the authoritative description of the
normalization; this file is the orientation.
