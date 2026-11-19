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
person takes, how a product is assembled with it or without it (§8), and how
an organization's projects use it (§9). The code is
`studio-backend/src/product/gear_match/`, `gear_match_rest.rs` and
`gear_match_usage_rest.rs`; the screens are the **Gears matcher** kit's
(`gears-matcher`, ADR-0072), the second entry of `product-mfe`: Project › Gear
match and Organization › Gears matcher.

## 1. Where it lives

The **code** is in **studio-product**, the gear that owns a project's product:
the report is advice about the product's picks, and the product's own
completion is what applies it. Not a gear of its own: it has no data that
outlives the product, and a second gear would need a port back into the product
for every action.

The **kit** is its own (ADR-0072): `gears-matcher`, a built-in kit that is not
a base kit by default (`OPT_IN_BUILTIN`), levels organization and project,
`requires: ["project-product"]`. It claims (ADR-0071 §1) the gear-match write
routes and the three MCP tools of §5, brings the Inbox source and the two
screens, and provides the `gears_matcher` assembly strategy (its manifest's
`assembly_strategy`, ADR-0074). Where it does not apply, the claimed writes and tools answer
`KIT_NOT_INSTALLED` naming it, the screens are not shown, and the product is
assembled by `spec_mapping` (§8). The reads stay open, as every gear's do. The
Product kit claimed all of this until ADR-0072; nothing was renamed, so no
alias or `renamed` report is involved, and the matches already kept stay in
the gear's database and show again once the kit is installed.

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
- `usage.rs` — the organization's use of the matcher, counted in SQL (§9).

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
| `clarification_needed`, and the report's own `clarifications` | **answer** | a question form; `PUT gear-match-answers` keeps the answer; the question is an **Inbox** item (`endpoint` source `gear-match-questions` of the Gears matcher kit, `GET /inbox/gear-match-questions`) for whoever asked the match until answered; the next match sends the answer beside the requirement it answers (a paragraph of its statement, before its Rationale, in the copy sent only — the document is not changed) |
| `not_assessed` (a `partial` run) | **re-run** | a new match; replies already received are cached by the matcher |

The Inbox was chosen over the project domain model's issue queue: a question
here waits on one person (who asked the match), needs a free-text answer, and
belongs to the match, not to a fact of the model. The domain model's `iss:`
decisions record an opened issue about a fact, which a matcher question is
not.

Per requirement the view shows the matcher's evidence, covers, missing and
rationale per candidate, and the **source passage** (`report::passage`: the
requirement's heading and block in the text sent, found by its id).

The report is a list grid (ListGrid, #1076) in two views of the same report,
kept in the address (`gmv.f.view`): **by requirement** (id, verdict, best gear,
confidence, where it is said, what to do; a row opens into its passage and
candidates) and **by gear** (a row per gear the run named: how many
requirements it covers fully and partly, best confidence, in the product,
has code; sorted by coverage; a row opens into the requirements it answers,
and Add / Reject act on all its proposals). A gear is found in the catalogue
by its engine id or its crate, whichever the report or the picks spell.

The matcher is not deterministic. Every match is kept; the view lists the
history, and `GET …/gear-matches/{id}/diff` (default: against the match before)
lists each requirement whose coverage or proposed gears changed.

## 4. Relation to studio-spec-mapping

**Decision: side by side, neither replaces nor feeds the other; a project
chooses which one assembles its product (§8).**

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
they are.

Since ADR-0072 the two are also the two **assembly strategies** of a product
(§8): each proposes picks, and a project uses one, by its own choice or its
organization's default. They still do not feed each other. Revisit when the
matcher's results are stable enough to be the plan's source: then the
matcher's verdicts could become mapping decisions
(`artifact_ingest::port::MappingDecisionStore`) with `source: matcher`.

## 5. Interfaces

REST, all `?project_id=` (the Gears matcher kit claims the writes):

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

The organization's use of the matcher (§9), `?organization_id=` (the caller's
home organization when absent):

| Method | Path | |
|---|---|---|
| `GET` | `/studio-product/v1/gear-match-usage` | per project and summed, over `period_days` (1–365, default 30); `{items, total}` with `offset` / `limit`, `summary` and `service` |

MCP: `project_gear_match` (start), `project_gear_match_report` (read) and
`gear_match_usage` (the organization's usage), all the Gears matcher kit's.

The assembly strategy (§8):

| Method | Path | |
|---|---|---|
| `GET` | `/studio-product/v1/project-assembly-strategy` | the strategy used (or `manual`), where it comes from, why it falls back, the strategies the installed kits provide |
| `PUT` | `/studio-product/v1/project-assembly-strategy` | the project's choice, or `null` for the organization's default (the Product kit's) |
| `GET` | `/studio-product/v1/assembly-strategy` | the organization's default (`?organization_id=`) |
| `PUT` | `/studio-product/v1/assembly-strategy` | set it; `kit.manage` (the Gears matcher kit's) |

MCP: `product_assembly_strategy` (the read; the Product kit's).

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

## 8. Assembly strategies

How a project's product is assembled (ADR-0072, as amended by ADR-0074). A
strategy only **proposes** gears; the engine's completion and the person's
confirmation stay the one way they enter the product (§3: nothing applied
silently).

**Strategies come from kits.** A kit declares the strategy it provides in its
manifest, one optional section, `assembly_strategy: {id, name, description}`
(checked in `kit_registry/manifest.rs`). studio-product reads the strategies of
the kits that apply where the product is and offers the ones it knows how to run;
no list of strategies to offer is kept in its code.

| Strategy | Kit | What it proposes | Needs |
|---|---|---|---|
| `spec_mapping` | Spec mapping (`spec-mapping`, a base kit by default an organization may uninstall) | per capability the specifications name that no pick answers yet, the first gear spec-mapping's plan offers with a contract, a declaration or a member's confirmation behind it, built and in the catalogue the product reads | nothing: instant, free, deterministic |
| `gears_matcher` | Gears matcher (`gears-matcher`, opt-in) | every gear the project's latest finished match proposes (`covered`/`partial` with code) that nobody rejected and the catalogue holds; on confirmation each one's decision is kept `accepted`, as "Add to product" does | the service configured |

**Which one.** The project's choice, else the organization's default, else what
the kits make it: `spec_mapping` when it is installed, else the only strategy
installed. With exactly one strategy kit there is nothing to choose; with none
the product is assembled by hand in the configurator (`strategy: "manual"`): no
proposals, and the panel says so and points to Kits. The organization's default
is set on Organization › Gears matcher by an organization or platform
administrator (`kit.manage`), out of the installed strategies only; the
project's choice ("organization default" or one installed strategy) on
Project › Product, beside the header's action. Both are rows of
`studio_product_assembly_strategies` (`m0004`, `assembly.rs`): `scope_id` is the
organization for its default, the project for its choice; keyed by the
organization the project hangs under.

**Fallback.** A chosen strategy that cannot be used is not used: the product is
assembled by one that can (`spec_mapping` first), else by hand, and the read
says why — `KIT_NOT_INSTALLED` (its kit does not apply, e.g. uninstalled after
the choice), `KIT_UNKNOWN` (the installed kits could not be read: `spec_mapping`
is assumed, the paid matcher is not) or `MATCHER_NOT_CONFIGURED` (the 503
sentence of §1). Choosing a strategy whose kit does not apply is refused
(`KIT_NOT_INSTALLED`), for a project and for the organization's default; a
project can choose `gears_matcher` where the service is down, and falls back
until it answers.

**On the page.** Project › Product shows the strategy used, where it comes from
and any fallback, the project's choice among the installed strategies (one not
usable now shown but disabled, with the reason), and **Propose gears**: the
proposals, what the completion adds with them, and **Add N to the product**.
With `gears_matcher` and no finished match it says so and links to Project ›
Gear match, which runs one.

## 9. Usage by project

Organization › Gears matcher shows how the organization's projects use the
matcher, from `GET /studio-product/v1/gear-match-usage?organization_id=&period_days=`
(`gear_match_usage_rest.rs`, counted in `gear_match/usage.rs`).

**Which projects.** The organization's tree as the caller reads it
(`organizations::port::ProjectsOf`, the walk every organization-level read
uses), so a project the caller cannot reach is neither listed nor counted. Rows
of the gear's tables for other projects or other organizations are never read:
every query is scoped to the organization and filtered to those project ids.

**Counted in PostgreSQL** from the gear's own tables:

- runs started in the period, grouped by project and state (`queued`,
  `running` and `cancelling` count as `running`), with the matcher's `usage`
  summed in SQL (`calls`, `cache_hits`, `input_tokens`, `output_tokens`; a value
  that is absent or not a number counts nothing);
- each project's last match, whenever it ran, with its report's counts
  (`DISTINCT ON`);
- the members' decisions kept now, accepted and rejected (state, not events,
  so not limited to the period);
- the questions of each project's last finished match, open (no answer note)
  or answered: the one count read in Rust, from the report, the way the match
  view and the Inbox list them (`report::questions`);
- the median time from asking to a written report over the period's
  `succeeded` / `partial` runs (`percentile_cont`).

Each project's strategy is resolved as §8 resolves it, from its own kits and
settings, and summed as the strategy split (`spec_mapping`, `gears_matcher`,
`manual`), by source (`project`, `organization`, `studio`) and by fallback code.

**The service.** Not only "configured": the server asks the matcher's
`GET /v1/info` and keeps the answer 30 s (`GearMatches::live_info`), and the
page shows whether it answers, its versions, the catalogue it reads and its
commit, the models and the limits, and plainly "Configured, but not answering"
with the error when it does not.

**On the page.** Tiles: how the projects are assembled, the runs by how they
ended with the median duration, the tokens and model calls, the decisions, the
open questions. Then a project per row on the kit's DataGrid (ListGrid: search,
header sort, pages, the list's empty state, kept in the address under `gmug.`):
project, strategy and where it comes from (a fallback marked), last run and its
state, its coverage (covered / partial / gap / to clarify), runs, tokens and
calls, accepted / rejected, open questions. A row opens that project's Gear
match tab (`openPlace` with the project's workspace). The period switch (7, 30,
90 days) is kept in the address (`gmu.f.period`).
