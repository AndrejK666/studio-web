# studio-components-catalog

Catalogues *our own gears* — every crate published under the
`constructorfabric` keyword on crates.io — in the knowledge graph, and
scaffolds new ones into a project's repository.

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
| `POST /sync` → `GET /tasks/{id}` | refresh the catalogue from crates.io, then poll |
| `GET /components`, `GET /versions` | the catalogue itself |
| `GET /reference` | the catalogue joined with the Gearbox engine's gears, one entry per component — the IDE's Components view ([`reference.rs`](reference.rs)); `?include=all` adds what is not a component, with the reason |

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
| `GET /types`, `GET /types/counts` | graph types and how many objects each holds |
| `GET`/`PUT`/`DELETE /field-schemas[/{describes}]` | the shapes describing catalogue fields |
| `GET`/`POST /projects/{id}/gear-repo` | which repository a project's gears live in |
| `POST /projects/{id}/create-repo` | create that repository through the connector |
| `POST /projects/{id}/scaffold` | write a gear skeleton, optionally as a PR |
| `GET /gearbox` | whether product previews run, and against which gear corpus |
| `POST /projects/{id}/product/preview` | compose a `product.gdl` from picked gears, resolve it with the Gearbox engine, optionally commit it |

The preview is [`gearbox.rs`](gearbox.rs): the engine's CLI over a shallow
checkout of the gear corpus, off unless `STUDIO_GEARBOX_WORKDIR` is set. The
session image carries the same engine as the `.gdl` language server
(`theia/gdl-language`), at the same commit, so the portal and the IDE agree.

## In the assembly

- Gear `studio-components-catalog`, capabilities `[rest]`, deps
  `types_registry`, `account_management`, `credstore`.
- Config section `gears.studio-components-catalog`.
- Repository access is a connection from [`../connectors`](../connectors); the
  graph is the same one [`../artifact_ingest`](../artifact_ingest) writes to.
