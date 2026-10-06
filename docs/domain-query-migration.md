# Moving the portal onto the domain query

*2026-10-07. A plan, not a decision record. Each step can ship on its own and
names what it waits on. When a step is done, mark it here.*

The goal: a screen describes the data it shows, and the backend answers that
from the domain model in graph-storage. A screen that changes changes its
request. A field nobody had yet is a model edit (`POST /types/{id}/fields`),
not backend code and not a migration.

The read is there: `POST /studio-domain-model/v1/query`, beside the existing
reads, which keep working ([studio-web#637](https://github.com/constructorfabric/studio-web/pull/637);
the design is the "Query (experimental)" component of
[the gear design](design/studio-domain-model.md)). This page says how the portal
gets from where it is to reading through it, and what each step waits on in
graph-storage ([the asks](upstream/graph-storage-requests.md), items 2 and 6–11).

## Where we start

**Who calls the domain model today.** Only the prototype does, in
`studio-frontend-prototype/src/api.ts`, `App.tsx` and `domain-model-graph.tsx`,
and only for these calls:
- `GET /types`;
- `POST /model/sync`;
- `POST /model/import`;
- `GET /model/graph`;
- `GET /objects/graph`.

No screen calls `GET /objects`. The product screens (organizations, people,
projects, documents, artifacts, components) read their own gears, and those
are relational stores or their own graph types, not domain objects.

So there are two transitions, and they should not be confused:

1. **The API transition.** Reads of domain objects go through the query. This is
   small, because there is only one consumer.
2. **The data transition.** Product data comes to live as domain objects. This
   is large, and it should be decided entity by entity, not done wholesale.

## What moves into the graph, and what does not

ADR-0024 and ADR-0013 already draw the line. It is repeated here because the
data transition is where it gets tested:

- **Into the graph:** entities and relations that are traversed, drawn and
  searched, and whose shape we expect to change. Examples: work items, risks,
  components and their dependencies, the model's own types.
- **Stays relational:** what is operational, private, heavily mutated, or an
  authorization surface. That means identity, membership, credentials and
  secrets, access configuration, tasks and schedules, and notifications.
  Graph-storage has no per-row authorization beyond the tenant, no version on
  read (item 2) and no reusable delete (item 4). Those three are exactly what
  this data needs.

## The steps

| # | Step | Waits on | Done when |
|---|---|---|---|
| 0 | Query beside the existing reads | — | #637 merged (in review) |
| 1 | Typed client generated from the model | — | the prototype compiles against generated types |
| 2 | First consumer: the instance graph view | 1 | `GET /objects/graph` has no caller and is deprecated |
| 3 | Authorization per type | ADR-0019 follow-up (`privilege_for`) | a query for a type the caller may not read is refused |
| 4 | Filters pushed down to indexes | graph-storage **item 8** | an indexed filter answers `complete: true` past 5,000 objects |
| 5 | Exact and reverse relations | graph-storage **items 9, 10** | `warnings` is empty for the model's 50 colliding relations; `include` can go incoming |
| 6 | First feature built on the model | 1–3 | a new screen ships with no backend change of its own |
| 7 | Safe updates | graph-storage **item 2** | a write with a stale version is refused |
| 8 | Retire the old reads | 2, G1 removal date | `GET /objects` and `GET /objects/graph` removed from the contract |

### 1. A typed client generated from the model

`GET /types` already returns every entity with its fields. A script in
`scripts/` (beside `regen-domain-frontend.mjs`) writes one TypeScript type per
entity, the relation names per entity, and a `query()` helper typed over both
into the prototype. CI regenerates the file and fails if it differs, the way
`api-contract.json` is held to the code.

The reason: when the model changes, the frontend learns it at compile time, not
from a 400 in a browser. This is what makes "the backend follows the frontend"
safe in both directions.

The seed model is what the file is generated from. A tenant whose model has
diverged from the seed gets the 400s the query already gives; the typed client
covers the shared model, not every tenant's edits.

### 2. The first consumer

The instance graph in the prototype (`GET /objects/graph`) moves to the query.
It is the only read of domain objects today, so after it moves nothing calls
the old route. That route then gets `deprecated` and a removal date in its
description, per API rule G1.

The move is also the measurement: once the screen is on the query, the
query's p95 on Dev comes from VictoriaMetrics, alongside how often
`complete: false` and `warnings` appear.

### 3. Authorization per type

The domain model authorizes nothing beyond the tenant. That is acceptable for
the model's own types and for objects nobody has called private yet. It stops
being acceptable at the first screen that shows data with an owner. Per
ADR-0019, rows are answered by the PDP: the query asks for a privilege per type
and action (`domain.<entity>.read`) and applies the answer as a filter or a
refusal in the planner, before anything is read.

This has to land before step 6. Without it, every new feature on the model is
either public or a security hole.

### 4. Filters pushed down

Today the gear reads up to 5,000 objects of a type and filters them in its own
process. Graph-storage 0.1.4 filters and orders on payload paths a type
declares in its `index` trait, but Studio cannot add an `index` to a type it has
already registered: the in-process client has no update (item 8).

When item 8 lands:
- A field in the ontology gets `"filterable": true`.
- The gear updates the type with that path in `index`, using `revalidate`.
- The planner splits each `where` into two parts. The part over indexed paths
  goes to `project_nodes` as `$filter`/`$orderby`; the rest stays in-process
  over the narrowed set.

`SCAN_LIMIT` then applies only to a filter that names no indexed field.

What stays in-process is the `total`. The projection has no count (item 5's
status), so the count is over what the narrowed read returned.

### 5. Exact and reverse relations

Until item 10, a relation that shares its verb with another one can return the
other's edges; the query says so in `warnings`. Until item 9, a relation can
only be read from the side that declares it. When both land:
- `neighbours` passes the relation's name as a discriminator filter, and the
  `warnings` go away.
- `include` takes `"direction": "incoming"` (or the model's inverse label) for
  the reverse read, for example "the teams that deliver this project".

### 6. The first feature on the model

Moving existing data comes last. The better first proof is a feature that has
no store yet, built straight on the model: a risk register or a work-item board
for a project, say. Both are already entities in the model.

The frontend adds the screen, and the model gains whatever fields the screen
needs. The backend gains nothing. If that holds, the approach works; if the
screen needs backend code, that code is the next thing to make generic.

Moving an existing relational store onto the model is a separate decision per
entity, against the line above, with its own data migration and a period of
dual reads.

### 7. Safe updates

`POST /objects` stays the write path. Updates are last-writer-wins, because
graph-storage reports no version on read (item 2). When it does:
- the query returns each row's version;
- `POST /objects` takes `if_version`;
- the typed client threads the version from read to write.

No screen that lets two people edit the same object should ship before this.

### 8. Retiring the old reads

After step 2 and the removal date: `GET /objects` and `GET /objects/graph` go,
together with their lines in `api-contract-baseline.txt` (rule G2). The
`/model/*` and `/types/*` routes stay; they are how the model itself is edited.

## Risks worth watching

- **Strict fields.** The query refuses a field the model does not declare, while
  `POST /objects` only warns. Objects can therefore hold fields no query can
  read. Step 1 makes this visible early; `GET /types/{id}/conformance` measures
  it.
- **Hubs.** A traversal is capped at 10,000 nodes and does not page (item 6). A
  query that includes a relation of a very connected object can come back
  `complete: false`. The flag is honest, and the data is still missing.
- **Deletes.** A deleted domain object's key cannot be reused (item 4). Screens
  that delete need "retire" semantics, as the components catalogue already has.
- **One version of graph-storage.** Every step above that waits on an item also
  waits on a release Studio can take. Studio is on crates.io releases now, so a
  release is a version bump, not a fork.
