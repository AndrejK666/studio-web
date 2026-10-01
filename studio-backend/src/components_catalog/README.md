# studio-components-catalog

Catalogues *our own gears* — every crate published under the
`constructorfabric` keyword on crates.io, and the gears and FrontX packages
its repository scans find — in the knowledge graph, says how ready each one is
and how good, and scaffolds new ones into a project's repository.

## Why it exists

The platform is a set of gears, and the question "what gears are there, at what
versions" had no answer inside Studio: it lived on crates.io and in people's
heads. This gear makes it data. It lists every crate under the keyword, pulls
each crate's detail and version history from the public crates.io API, and
stores them as typed `gear` and `crate_version` nodes joined by `has_version`,
which the portal reads back.

Cataloguing led to the second half: once Studio knows what a gear looks like,
it can create one. `POST /projects/{id}/scaffold` writes a gear skeleton into
the project's repository on a branch, optionally opening a pull request.

## What it owns

Graph nodes, and per-project metadata pointing at the repository gears are
scaffolded into. Sync progress is a `studio-tasks` run. Without the `graph`
feature it falls back to an in-memory store, so the catalogue still works.

## REST

| Method + path | Does |
|---|---|
| `POST /sync` → `GET /studio-tasks/v1/runs/{id}` | refresh the catalogue from crates.io, then poll the run |
| `GET /components`, `GET /versions` | the catalogue itself |
| `GET /reference` | the catalogue joined with the Gearbox engine's gears, one entry per component — the IDE's Components view ([`reference.rs`](reference.rs)), with each gear's readiness and grade; `?include=all` adds what is not a component, with the reason |
| `GET /component-values` | each component's resolved profile values, and its quality grade ([`quality.rs`](quality.rs)) |
| `GET /profiles`, `POST /components/{name}/profile` | the stored profiles, and a person's correction to one |
| `GET /activity` | delivery activity per component, from Insight |
| `GET /types`, `GET /types/counts` | graph types and how many objects each holds |
| `GET`/`PUT`/`DELETE /field-schemas[/{describes}]` | the shapes describing catalogue fields |
| `GET`/`POST /projects/{id}/gear-repo` | which repository a project's gears live in |
| `POST /projects/{id}/create-repo` | create that repository through the connector |
| `POST /projects/{id}/scaffold` | write a gear skeleton, optionally as a PR |
| `GET /gearbox` | whether product previews run, and against which gear corpus |
| `GET /gearbox/catalogue` | the engine's gear catalogue over the backend's corpus, for an IDE whose workspace has none; `corpus_clone_path` when the corpus needs a token |
| `GET /gearbox/corpus/info/refs`, `POST /gearbox/corpus/git-upload-pack` | the corpus over Git smart HTTP, as the member, with the corpus's own token attached upstream; fetch only |
| `POST /projects/{id}/product/preview` | compose a `product.gdl` from picked gears, resolve it with the Gearbox engine, optionally commit it |

## Kinds and categories

One vocabulary each, decided from evidence in [`taxonomy.rs`](taxonomy.rs) and
served with the evidence (`kind_reason`, `category_reason`) by `/reference` and
laid onto `/components` nodes (`component_kind`, `component_category`,
`component_excluded`).

- **Kinds:** `gear` (a `gear.gdl` service or a `gear.toml`), `plugin`, `sdk`,
  `library` (toolkit and every other crate), `micro-frontend` (module
  federation), `frontend-library`, `tool` (a `bin` / CLI), `kit`.
- **Not components**, left out of the default list with a reason: `config`,
  `test-support`, `docs`, `template`, `example`. Older copies of a component
  (a second node for one name, a scan node under a guessed crate name) are
  `superseded`; the read drops them before any re-sync, and the next sync
  deletes them.
- **Categories:** the engine's own set (`api-ingress`, `bss`,
  `core-functionality`, `core-platform-integration`, `gen-ai`, `oss`,
  `serverless`), taken from `gear.gdl`, then `gear.toml`, then the gear a
  plugin or SDK belongs to, then an unambiguous crates.io category. Otherwise
  null; the raw registry categories and npm tags stay in `source_categories`.

`/reference` is cached per catalogue generation (moved by every sync, profile
and field-schema write), corpus commit and activity window, and the engine's
catalogue is kept on disk beside the corpus so a restart does not wait for a
fetch.

## Readiness and grade

- **The roadmap board** ([`roadmap.rs`](roadmap.rs)) is a sync source:
  `POST /sync` takes `roadmaps: [{ tenant, connection_id?, owner, number,
  consumers? }]`. Column meaning is read off the board (the `Status` order is
  the pipeline, percentage fields are progress, a `Prio (A.C.V)` field is
  per-consumer priority). Items are matched to gears by title words, strictly,
  by the gear's directory before its crate name; a tie is left to a person,
  who pins the item in the gear's `roadmap_item` field. The board a plan came
  from is recorded as `auto.roadmap_board`, which the portal's Sources label
  names. Reading a board needs a connection that can read organization
  projects.
- **Repository facts** ([`repo_facts.rs`](repo_facts.rs)): version, releases,
  lifecycle, spec progress, dependents, sizes and the rest, read from the
  engine's own checkout of the corpus when Gearbox is configured.
- **Plan meets demand**: an overdue milestone, top-priority demand without a
  dated or committed plan, a status that contradicts progress, a board that
  says shipped where the repository has no release.
- **The grade** ([`quality.rs`](quality.rs)): the gear schema's `quality` block
  (24 criteria in six areas, `A` ≥ 90 … `E`, no better than B until in
  production), read against the *resolved* values on every read and never
  stored, so a correction moves it at once. An unknown value fails, with the
  fix that would answer it.

## Gearbox

The preview and the catalogue are [`gearbox.rs`](gearbox.rs): the engine's CLI
over a shallow checkout of the gear corpus, off unless `STUDIO_GEARBOX_WORKDIR`
is set (the chart's `backend.gearbox`). The backend image, the session image
and the desktop's engine extension build the same engine at the same commit
(`STUDIO_GEARBOX_REF`), so the portal and the IDE agree.

## In the assembly

- Gear `studio-components-catalog`, capabilities `[rest]`, deps
  `types_registry`, `account_management`, `credstore`.
- Config section `gears.studio-components-catalog`.
- Repository access is a connection from [`../connectors`](../connectors); the
  graph is the same one [`../artifact_ingest`](../artifact_ingest) writes to.
