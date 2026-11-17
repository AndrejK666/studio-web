---
type: design
status: proposed
owner: studio-team
---

# Technical Design — gear matches (studio-product)

- [ ] `p2` - **ID**: `cpt-studio-design-gear-match`

Which gears go into a project's product, as the **gears-matcher** service reads
the project's specifications. The service (`gears-matcher/`, its contract
`gears-matcher/schemas/service/matcher-service.openapi.yaml`) takes a spec as
files and answers a verified coverage report: per requirement a verdict
(`covered`, `partial`, `gap`, `clarification_needed`, `not_assessed`) and the
candidate gears of the gears-rust catalogue with the evidence for each. This
document is how Studio asks for one, keeps it, and turns it into decisions a
person takes. The code is `studio-backend/src/product/gear_match/` and
`gear_match_rest.rs`; the screen is the Product kit's (`product-mfe`, Project ›
Product › Gear match).

## 1. Where it lives

In **studio-product**, the gear that owns a project's product: the report is
advice about the product's picks, and the product's own completion is what
applies it. Not a gear of its own: it has no data that outlives the product,
and a second gear would need a port back into the product for every action.

- `config.rs` — `studio-product`'s `config.gears_matcher`: `base_url` (or the
  variable `base_url_env`, `STUDIO_GEARS_MATCHER_URL`) and the variable holding
  the shared secret (`secret_env`, `STUDIO_GEARS_MATCHER_SECRET`), the
  literal-or-env convention of `studio-insight` and `studio-spec-quality`.
  Optional: without either, every match route answers **503 naming what is
  missing**, and nothing else of the product changes.
- `client.rs` — the five calls (`/v1/info`, submit with `Idempotency-Key`,
  run, report, cancel) with the bearer; a problem's stable `code` is kept.
- `store.rs` — two tables in the gear's database (`m0003`):
  `studio_product_gear_matches` (one row per match: what was sent with its
  text, the matcher's run id, `/v1/info` at the start, progress, the report as
  written, its totals, usage, error) and `studio_product_gear_match_notes` (a
  member's decision on a proposed gear, an answer to a question — the
  project's, across matches). Keyed by the organization the project hangs
  under, as the product's descriptions are.
- `task.rs` — `product.gear_match` on studio-tasks.
- `report.rs` — pure: the report read for a person, the paths and answers of
  what is sent, the difference of two runs.

## 2. A match

1. `POST /studio-product/v1/gear-matches?project_id=` **as the caller**: the
   project is resolved as they read the tree, the documents are read through
   `documents::port::SpecTexts` (the same documents the project domain model
   reads — the typed documents of the project's repository, its Studio
   documents `studio:<id>`, its uploads `upload:<name>` — and the same `paths`
   / `glob` selection a domain-model build takes, #1029). With nothing named:
   the project's PRDs, else all. Authorization happens here, as
   `project_create`'s does; the run then acts as studio-tasks.
2. `GET /v1/info` first: it proves the service answers and gives its limits
   (20 documents, 500 kB each, 2 MB a request), checked before anything is
   kept. A path is made one the matcher takes (`upload:x.csv` →
   `upload/x.csv.md`, `studio:<id>` → `studio/<id>.md`); each document's
   SHA-256 is of the text as sent.
3. The match row is written (`queued`) with the request body, and one run is
   queued with the match id. An `Idempotency-Key` from the caller makes the
   match id (`uuid v5` of project and key), so a resend answers the same match.
4. The run submits once, with the match's own key (`studio-<match id>`): a
   retried attempt gets the same matcher run back, and nothing is paid twice.
   It follows the run (2 s backing off to 10 s), records progress
   (`requirements_done` of `requirements_total`, shown in Background work and
   sent as `task.progress` studio-events), and on `succeeded` / `partial`
   reads the report and keeps it. An attempt follows a run for at most 12
   minutes, inside the queue's 15-minute lease, then the next attempt picks it
   up from the recorded matcher run id; six attempts cover the service's hour.
5. **Kept with the match:** the matcher's run id, its versions and the
   catalogue commits from `/v1/info` (and the report's own `provenance`), and
   per document the project path, the matcher path, the hash sent, and the
   commit and branch a repository document was read at — the spec revisions
   the report is about.
6. **Cancel** (`POST …/gear-matches/{id}/cancel`) marks the match and asks
   the run to stop; the run then cancels the matcher's run. A cancel from
   Background work, or a shutdown, stops the run without the mark: a shutdown
   leaves the matcher's run for the next attempt, and the next read of a match
   whose run was cancelled cancels the matcher's run too.

## 3. From verdict to action

Nothing is applied silently. Each verdict becomes something a person decides:

| Verdict | Studio offers | How |
|---|---|---|
| `covered` / `partial`, a candidate judged `covered`/`partial` that has code | **propose**: "Add to product" per candidate | the product's own completion (`POST /gearbox/complete`) with the pick added, then the product's save — exactly what the configurator does; the member's accept or reject is kept (`PUT gear-match-decisions`) and shown on every later match |
| `covered` / `partial` with only future parts (no code) | **review** | shown, not addable |
| `gap` | **create a gear** | the existing "Create a gear" scaffold (`POST /projects/{project_id}/scaffold`, the Components tab's `ScaffoldDialog`), drafted from the requirement's id and passage |
| `clarification_needed`, and the report's own `clarifications` | **answer** | a question form; `PUT gear-match-answers` keeps the answer; the question is an **Inbox** item (`endpoint` source `gear-match-questions` of the Product kit, `GET /inbox/gear-match-questions`) for whoever asked the match until answered; the next match sends the answer beside the requirement it answers (a paragraph of its statement, before its Rationale, in the copy sent only — the document is not changed) |
| `not_assessed` (a `partial` run) | **re-run** | a new match; replies already received are cached by the matcher |

The Inbox was chosen over the project domain model's issue queue: a question
here waits on one person (who asked the match), needs a free-text answer, and
belongs to the match, not to a fact of the model. The domain model's `iss:`
decisions record an opened issue about a fact, which a matcher question is
not.

Per requirement the view shows the matcher's evidence, covers, missing and
rationale per candidate, and the **source passage** (`report::passage`: the
requirement's heading and block in the text sent, found by its id).

The matcher is not deterministic. Every match is kept; the view lists the
history, and `GET …/gear-matches/{id}/diff` (default: against the match before)
lists each requirement whose coverage or proposed gears changed.

## 4. Relation to studio-spec-mapping

**Decision: side by side, neither replaces nor feeds the other (for now).**

- *spec-mapping* infers capabilities from Functional Requirements by words
  and contracts, instantly, for free, deterministically, on every read; its
  unit is a capability and its decisions are mapping decisions on the graph.
- *the matcher* judges each requirement against the whole catalogue with
  several models, in minutes, for money, and its answers vary; its unit is a
  requirement id.

They do not share a key (capability vs requirement), so feeding one into the
other would need a mapping neither has. Replacing spec-mapping would lose the
instant plan the Components tab and the product map draw from. So the report
view marks a candidate that spec-mapping's plan also names ("also in the
spec plan"), which is where they agree, and leaves both decision stores as
they are. Revisit when the matcher's results are stable enough to be the
plan's source: then the matcher's verdicts could become mapping decisions
(`artifact_ingest::port::MappingDecisionStore`) with `source: matcher`.

## 5. Interfaces

REST, all `?project_id=` (the Product kit claims the writes):

| Method | Path | |
|---|---|---|
| `POST` | `/studio-product/v1/gear-matches` | start; `202 {run_id, match_id, state}` |
| `GET` | `/studio-product/v1/gear-matches` | history, newest first |
| `GET` | `/studio-product/v1/gear-matches/{match_id}` | one (or `latest`) read per requirement; `raw=true` adds the report |
| `GET` | `/studio-product/v1/gear-matches/{match_id}/diff` | against `base` |
| `POST` | `/studio-product/v1/gear-matches/{match_id}/cancel` | stop it |
| `PUT` | `/studio-product/v1/gear-match-decisions` | accept / reject / forget a proposed gear |
| `PUT` | `/studio-product/v1/gear-match-answers` | answer a question |
| `GET` | `/studio-product/v1/inbox/gear-match-questions` | the Inbox source |

MCP: `project_gear_match` (start) and `project_gear_match_report` (read).

## 6. Deployment

- Compose: `config/docker.yaml` names `http://gears-matcher:8080`; the secret
  is `STUDIO_GEARS_MATCHER_SECRET` from `.env`, no default.
- Helm: `backend.gearsMatcher.url` (the gears-matcher release's Service) and
  the `gears_matcher_secret` key of the app Secret, both optional.

## 7. Not done yet

- Uploading a whole spec folder at once; a document over 500 kB is refused,
  not split.
- `own_gears` is taken from the request only; a project's own gears in the
  catalogue are not filled in automatically.
- An answer is sent with the next match only; writing it into the
  specification is the domain model's sentence proposal, by hand.
