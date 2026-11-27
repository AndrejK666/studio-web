# Moving the portal onto the domain query

*2026-10-07. A plan, not a decision record. Each step can ship on its own and
names what it waits on. When a step is done, mark it here.*

The goal: a screen describes the data it shows, and the backend answers that
from the domain model in graph-storage. A screen that changes changes its
request. A field nobody had yet is a model edit (`POST /types/{id}/fields`),
not backend code and not a migration.

The read is there: `POST /studio-domain-model/v1/query`, beside the existing
reads, which keep working (the design is the "Query (experimental)" component of
[the gear design](design/studio-domain-model.md)). This page says how the portal
gets from where it is to reading through it, and what each step waits on in
graph-storage ([the asks](upstream/graph-storage-requests.md), items 2 and 6–11).

## Where we start

*Updated 2026-11-27.* The portal is `studio-frontend-prototype/src-app`: the
FrontX shell with its screens as kits (ADR-0069). The old single-page
prototype in `studio-frontend-prototype/src` was where this plan started; the
paths below are the current ones.

**Who calls the domain model.** Every MFE reads it through one shared client
in `src-app/mfe_packages/shared/src/data/domain.ts`:
- the model, `GET /types`: `domainTypes` / `useDomainTypes`;
- a type's objects, `POST /query`: `domainQuery` / `useDomainQuery` (cached,
  read again on `domain.objects_changed`), `domainQuerySend` (uncached) and
  `fetchDomainAll` (every page, by cursor);
- writes, `POST /mutate`: `domainMutate`.

The request and answer shapes are in `shared/src/domain/domainQuery.ts`.
Screens still on their own gears' reads move onto the query one by one; that
migration is its own branch.

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

  *Team structure is the first case at the line (2026-10-07).* A team, its
  unit and who is in it with what share are traversed and drawn, so they
  belong in the graph; organization membership and sign-in stay in studio-user.
  Today the teams are mirrored from the roadmap plan; they move to being
  authored in the model at step 7.

## The steps

| # | Step | Waits on | Done when |
|---|---|---|---|
| 0 | Query beside the existing reads | — | **done** 2026-10-07: `POST /studio-domain-model/v1/query` |
| 1 | Typed client generated from the model | — | **done** 2026-10-07: `domain-model.gen.ts`, `api.queryDomain`, `--check` in CI; 2026-11-26 the portal's shared client reads it (`DomainQueryOf`) |
| 2 | Deprecate `GET /objects`; keep `GET /objects/graph` | — | **done** with step 1: removal after 2026-12-01 |
| 3 | Authorization per type | [ADR-0035](adr/0035-domain-objects-are-authorized-through-the-pdp.md) | **done** 2026-10-07, stand-checked: a query for a type the caller may not read is refused |
| 4 | Filters pushed down to indexes | ~~graph-storage item 8~~ | **done** 2026-10-26 another way: the read model ([ADR-0066](adr/0066-domain-objects-are-read-from-a-postgres-mirror-of-the-graph.md)) answers every filter in Postgres, `complete: true` at any size |
| 5 | Exact and reverse relations | ~~graph-storage items 9, 10~~ | **done** 2026-10-26: an edge's discriminator names its relation, and `include` takes `~name` (ADR-0066) |
| 6 | First feature built on the model | 1–3 | **done** 2026-10-07: saved views (`views.tsx`); no backend change |
| 7 | Safe updates | graph-storage **item 2** | a write with a stale version is refused |
| 8 | Retire `GET /objects` | 2, G1 removal date | `GET /objects` removed from the contract |

### 1. A typed client generated from the model

`scripts/gen-domain-client.mjs` reads the seed model
(`studio-backend/src/domain_model/ontology.studio.json` and the types the
built-in kits bring, what `GET /types` serves an organization on the base
kits) and the types gears declare as they start
(`studio-backend/src/domain_model/gear-declared-types.json`). It writes
`studio-frontend-prototype/src-app/mfe_packages/shared/src/domain/model.gen.ts`,
which holds:
- one interface per entity, with its own and inherited fields;
- per entity, the relations `include` accepts and the entity each one reaches.

*2026-11-27: gears' types too.* A gear declares its types at run time
(`TypeNeed` through `ensure_type`): the artifact gear's `ci-run`,
`product-build`, `ci-job`, `release`, the documents and reports gears' records
and the rest. They were in every organization's model and in no file, so the
generated file did not have them and their reads were untyped.
`gear-declared-types.json` is every gear's declarations, rendered from the
gears' code by a backend test (`gear_types_snapshot_tests.rs`), which fails
when the file says something else (`UPDATE_GOLDEN=1` rewrites it). The
generator applies them after the seed and the kits the way
`declare_gear_type` does: a type the model lacks is created, a field or
relation it lacks is added, nothing it has changes.

Inheritance and relation resolution mirror `ontology.rs` and `query.rs`. CI
runs the script with `--check` next to `check-docs` and fails when the file is
stale, the way `api-contract.json` is held to the code.

*2026-11-26: the shared client reads it.* Until then nothing imported
`model.gen.ts`; the request types were written by hand. Now
`shared/src/domain/domainQuery.ts` has a typed twin of each shape, keyed by
the type's name: `DomainQueryOf<T>`, `DomainSelectionOf<T>`,
`DomainRowOf<T>`, `DomainResultOf<T>`. `useDomainQuery`, `domainQuery` and
`fetchDomainAll` infer `T` from the body's `type`, so a literal
`{type: 'milestone', fields: ['name']}` is checked: `fields`, `order_by` and
`include` (each relation against its target) take only what the type has,
and a row's `value` is a `Milestone`. A type the generated file does not have
(a kit's own, an organization's edit) reads untyped, as before, and so does a
body typed as the plain `DomainQueryRequest`. `where` stays untyped: it names
relations, combinators and dotted paths, and the gear's 400 lists what it
accepts. `domainQuery.types.test.ts` keeps the wrong queries as
`@ts-expect-error`: an unknown field in `fields` and in `order_by`, a field of
the wrong relation target, and the same through inference.

The reason: when the model changes, the frontend learns it at compile time, not
from a 400 in a browser. This is what makes "the backend follows the frontend"
safe in both directions.

The seed model is what the file is generated from. A tenant whose model has
diverged from the seed gets the 400s the query already gives; the typed client
covers the shared model, not every tenant's edits.

### 2. Deprecate the list, keep the graph

*Revised 2026-10-07.* The plan said the instance graph in the prototype would be
the query's first consumer. It should not be. That screen draws objects of
every type and every edge between them, which is a graph-shaped read:
`GET /objects/graph` answers it in one call and the query does not. The query
is one type at a time, with named relations. Moving the screen would mean one
query per type plus every relation by name, which is a worse read for that
screen and no step forward. So `GET /objects/graph` stays, as the graph read.

`GET /objects` has no caller in either portal, and the query does everything it
does. It gets `deprecated` and a removal date in its description now (rule G1).

The query's first consumer is therefore step 6, a screen that reads a type and
its relations. That is the shape the query was built for, and its p95,
`complete: false` rate and `warnings` rate on Dev are measured from there.

### 3. Authorization per type

*Proposed as [ADR-0035](adr/0035-domain-objects-are-authorized-through-the-pdp.md): `domain.view`, `domain.edit` through the PDP with project narrowing at every include level, and `domain.model` as administration.*

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
no store yet, built straight on the model.

*Done 2026-10-07: **saved views**.* A risk register was considered and set
aside: nothing in the PRD or the roadmap asks for one, so it would have proved
the approach and given the product nothing. Views are a gap the portal already
names ("saved views — future" in [domain-alignment.md](domain-alignment.md)).
They are also the strongest form of the claim, because a view is a screen
stored as data.

- **The model already had the entity.** `view` carries `name`, `view_kind`,
  `query` and `presentation`. A view's `query` is exactly the body of
  `POST /query`, so anything that reads the model can run it.
- **The screen is the Views section in the prototype.** It picks a type,
  columns, conditions (ANDed), related objects and an order. It saves through
  `POST /objects` and renders through `/query`, paged, sorted and searched by
  the backend.
- **A view is retired, not deleted.** Retiring sets the model's own
  `valid_to`, so a graph key is never tombstoned (graph-storage item 4).
- **The generator also emits the fields and relations at runtime**
  (`DOMAIN_FIELDS`, `DOMAIN_RELATION_TARGETS`), so the editor offers exactly
  what the query accepts.

**What it showed.**
- **No backend change was needed.** The whole path ran on a stand with real
  graph-storage: save, list, run with relations, search, retire. The screen
  rendered there in headless Chrome.
- **The relation ambiguity is not hypothetical.** The very first view
  (projects with `uses` → repository) came back with three warnings:
  `uses` shares the `references` edge type with `represented_as`,
  `includes_3` and `advances`. The screen folds them into one line, and
  gears-rust#5240 is what removes them.

**Then the graph kind.** A view can also be drawn as a graph: the same stored
query, with its included relations as edges, on the canvas the model graph
already uses. That makes the Knowledge Graph surface that
[domain-alignment.md](domain-alignment.md) reserved a saved view as well, and
it, too, needed no backend change.

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

*Waiting on this (2026-10-07): **the organization's teams.** The roadmap
report's plan already holds units, teams, people and each person's share of
their team (`allocation`), and mirrors them into the model as `org-unit`,
`team`, `person` and `membership` objects (`acquisition: mirrored`, see
[studio-reports](design/studio-reports.md)). The plan stays the source of
truth until this step lands, because it has a revision and the model does not.
When it lands, the direction flips: teams and memberships are authored in the
model, with `if_version`, and the plan reads them.*

### 8. Retiring the old reads

After the removal date: `GET /objects` goes, together with its lines in
`api-contract-baseline.txt` (rule G2). `GET /objects/graph` stays as the graph
read (step 2), and the `/model/*` and `/types/*` routes stay; they are how the
model itself is edited.

## Gaps closed 2026-11-26

Found while moving the first screens onto the query:

- **A base type reads its subtypes.** `{"type": "file"}` answers
  `repository-file` objects too, as a relation pointing at `file` always did;
  before, only Project's kit subtypes were read this way. Each row's `entity`
  names its concrete type. A gear's own read through the port
  (`query_bulk`) keeps to the type itself, because a gear's records of a base
  type are not its subtypes' (artifact ingest's `text-content` is not the
  documents gear's `text-chunk`).
- **Filter by subtype.** `{"_type": {"_in": ["deals-project"]}}` in `where`
  (also `_eq`, `_neq`, `_nin`) tests the concrete type, on the root, under
  `include` and in a filter on related objects. A name the rows cannot be is a
  400 listing those they can.
- **Several projects in one request.** `project_ids` (at most 200, not with
  `project_id`) reads objects of any of them, one statement in the read model.
  Each must be one the caller may read: one that is not refuses the whole
  request with a 403 (reason `DOMAIN_PROJECT_NOT_READABLE:<id>`), so a screen
  never shows part of a portfolio as all of it.
- **A grant per type.** Objects an `include` or a related filter reaches were
  narrowed with the root type's grant. Now each type is asked of the PDP on its
  own, once per request; objects of a type the caller may not read are left out
  and `warnings` says which type.
- **The MCP tool** `domain_model_query` takes `cursor`, `aggregate` and
  `project_ids`, as the REST call does.

## Gaps closed 2026-11-27

- **`_ilike` and `_nilike`.** SQL's case-insensitive `LIKE` over the whole
  value: `%` is any run of characters, `_` one, a backslash makes the next
  one literal. It tests a string, or a number by its JSON text (so
  `{"number": {"_ilike": "%12%"}}` finds run 112), and nothing else; a
  pattern that ends with a lone backslash is a 400. In Postgres it is
  `lower(value) LIKE lower($pattern) ESCAPE $escape`, both bound, never SQL
  text; in memory the same reading (`like_pattern`), and `mirror_tests.rs`
  asks both. A screen that searches for what a person typed escapes it with
  `likeLiteral` (mfe-shared) and wraps it in `%…%`.
- **The artifact types declare what `/nodes?q=` searches.** `author` and
  `number` on `work-item`, `pull-request` and `ci-run`, `author` on `comment`
  and `commit`, `full_path` on `repository` (`own_fields` in the artifact
  gear's `model_store.rs`). The gear declares them when it writes, and now
  also at its sweep for an organization already moved, so one nobody syncs
  gains them too.
- **`ci-run`, `product-build` and every other gear-declared type are in
  `model.gen.ts`** (step 1), so `fetchProjectArtifacts` reads typed rows and
  `ARTIFACT_SEARCH_FIELDS` is checked against the model at compile time.

## Which screens read through the query, and which stay (2026-11-27)

**On the query.** Admin › Objects (`TypeObjects`, `ObjectAttributes`, saved
views), Activity › Timeline and the project overview's next steps. Each reads
a type the domain model owns, through `useDomainQuery` / `fetchDomainAll` in
mfe-shared, and asks the PDP what every other reader of those objects asks.

**On the query where the model answers (2026-11-26).** The project's
repositories (Tests, Releases, Product), CI runs as builds (Releases, Product)
and IDE builds (Releases, Product) read `{type, project_id}` on `repository`,
`ci-run` and `product-build` through `fetchProjectArtifacts` in mfe-shared.
The artifact gear moves each organization into the model once, in the
background, and leaves a `sync-state` marker (`art-store-moved-v1`); until it
is there, and under `storage.artifacts: graph` (where it never is, or says
`returned`), the model holds none or only part of the artifacts, so the
helper reads `GET /nodes` instead. A marker the caller cannot read (a member
with project grants only does not reach organization-wide objects) is the
same "not yet". The two routes ask the same question now (below), so the
fallback shows nobody more than the query would.

*2026-11-27.* **Product's search** (`q` on `listArtifactNodes`) reads the
same way: `where` is an `_or` of `_ilike: "%term%"` over the fields of
`/nodes`' `q` the kind declares (repository: title, path, full path; CI
run: title, author, path, number; IDE build: title, path). An organization
whose model has not gained `author`/`number` yet answers 400; the helper then
asks `/nodes` the same search, under the same grant. **The project's
repositories in projects-mfe** (the Sources tab, the sync of sources with no
repository yet, the Artifacts tab's repository picker) read
`{type: repository, project_id}` through the same helper
(`ArtifactIngestApiService.nodes` with `orgId`, cached as
`projectArtifacts(...)`).

**Looked at and left where they are.** The rule for a move: the screen shows
the same thing to every role after it. These do not, or are not a plain read
of one type.

| Read | Screens | Why it stays |
|---|---|---|
| `GET /studio-artifact-ingest/v1/nodes` | The fallback of the screens above; the project's Artifacts tab (its list of every kind, a repository's contents, the counts in its header); cursor paging; the IDE; MCP | **Authorization is the query's now.** The route asks the domain-object policy for `domain.view` as the caller, in the organization the scope hangs under (`DomainObjects::read_access`, the answer `POST /query` applies), and keeps only nodes whose owner (project, else workspace, else organization) it admits: 403 without a grant, 503 while the PDP cannot be asked or the domain model is not there. A scope the caller may not read whole is narrowed before it is paged, so `total` counts only what they may read. It stays for a tenant whose artifacts have not moved, or under `storage.artifacts: graph`. **The Artifacts tab's list stays (2026-11-27)** because it is not one type and not only the gear's: it pages every artifact kind together, newest first. On the query that is the base type with `{"_type": {"_in": [...]}}`, and two of those types, `work-item` and `comment` (and `finding`), are also what members write themselves, so the tab would start listing a project's hand-written work items and comments among its synced artifacts. The untyped `/nodes` also asks `domain.view` with no type, where the query would ask for the base type: a different question of the PDP. |
| `GET /studio-artifact-ingest/v1/runs` | Tests | **Decided 2026-11-27: stays a REST route.** Authorization is the query's, as `/nodes`: runs and jobs of a project outside the grants are not listed. It is derived, and the derivation is the point: jobs joined to their run by the job's `run` field (no declared relation joins `ci-job` to `ci-run`, so `include` cannot follow it), the job set of the run's latest attempt, `latest_completed` per workflow (an arg-max per group, which `aggregate` does not answer: it folds numbers, it does not pick a row), and revision and branch matching (`ci_runs.rs`). On the query that is two reads and `ci_runs.rs` again in the browser, in every screen that shows it. What would move it: a declared `ci-job → ci-run` relation (written by the sync) and a "latest row per group" read in the query. |
| `GET /studio-documents/v1/workspaces/{w}/types` | Specs, Documents | Derived: the platform catalogue (not in the model) under the organization's and the workspace's overrides, minus what the workspace hides. The query sees only the stored overrides. |
| `GET /studio-documents/v1/specs-per-source` | Sources | A join across two gears: decided bindings, then the repository each file came from. No single `aggregate` counts that. |
| `GET /studio-components-catalog/v1/components`, `/profiles`, `/registry` | Product, Admin | Tiered (platform pins, organization, project, ADR-0061), classified by the reference, superseded entries hidden. |
| Search, the activity feed, the projects table's rollups, the organization overview | | Ranked or folded across many types and gears: search runs hybrid retrieval, the feed merges several sources in time order, rollups and the overview count per project in one read. One query per type would be more reads and the same code in the browser. |
| Derived domain-model facts, `GET /objects/graph`, `GET /type-counts` | Admin › Model | Graph-shaped or across every type (step 2): the query is one type at a time. |

**What moves them.** For `/nodes`: every organization moved into the model
and `storage.artifacts: graph` retired (then the fallback goes); for the
Artifacts tab, a marker on the synced objects of the shared types (or their
own types) so "the gear's artifacts of every kind" is one `where`. For
`/runs`: the job relation and a latest-per-group read, above.

**Gears reading through the store.** The artifact sync reads back the
repository it walks: the files it may forget and the comments it counts. Both
go through `GraphStore::list_of_repo` / `count_of_repo`; the model answers them
with one query narrowed by the declared `repo` field instead of every file or
comment of the organization, and graph-storage keeps the whole-type read it
cannot avoid. The sync's marks (pull requests and issues read whole, cached),
the repository's last state, the prune of a detached repository and the names
search lays on its hits stay on `GraphStore::list`: they read a type whole on
purpose, or the set is small and cached. The components catalogue's registry
reads already answer from the model through `ModelSink`, which keeps the old
store as its fallback until a tenant has moved; going around it to the port
would drop that fallback for sets of a few dozen rows.

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
