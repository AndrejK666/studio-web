---
type: design
status: proposed
owner: studio-team
---

# Technical Design — the M&A due diligence kit (mna)

- [ ] `p2` - **ID**: `cpt-studio-design-kits-mna`

A deal team evaluates a target company's software before an acquisition and
answers whether to proceed, and on what conditions. Studio already holds most
of the evidence once the target's repositories are connected: sources and
their sync, git contributors, CI runs, spec checks. The built-in kit `mna`
("M&A due diligence", studio-web#1024) puts a deal on top of that. It is the
third **project type** (ADR-0073), beside Gears and Constructor Research: a
deal is a project of the M&A type.

This document is the first slice: phase 1 of #1024 (the model and the Deal
screen) and the base of phase 2 (an evidence summary from data Studio already
has). The rest is in [§7](#7-follow-ups).

## Table of Contents

<!-- toc -->

- [1. Decisions it rests on](#1-decisions-it-rests-on)
- [2. The model](#2-the-model)
- [3. Creating a deal](#3-creating-a-deal)
- [4. The function and its routes](#4-the-function-and-its-routes)
- [5. The evidence summary](#5-the-evidence-summary)
- [6. The Deal tab](#6-the-deal-tab)
- [7. Follow-ups](#7-follow-ups)
- [8. Open questions](#8-open-questions)

<!-- /toc -->

## 1. Decisions it rests on

From #1024's decision (2026-11-19) and its correction:

- **A deal is a project of type M&A.** The deal's fields (target, thesis,
  phase, IC date, recommendation, sign-off) are attributes of the kit's
  subtype of Project, not a separate Deal object. An organization may group
  its deals in a workspace of its own; nothing requires it.
- **The target's repositories are the project's sources**, connected
  read-only through the existing connections from Project › Sources, the
  type's first next step. Snapshots and data rooms come later.
- **Confidentiality comes from the project's tenant**: only the project's
  members see the deal; no PDP rule of its own.
- **Sign-off needs the deal lead.** A project carries no roles of its own
  (its access is its organization's, ADR-0051), so the deal lead is **the
  project's owner**, `project.config` `owner_id`, set when the project is
  created. A project that names no owner has no deal lead, and nobody signs
  off until it does.
- **Scanners:** what Studio already computes (spec checks, CI, git
  contributors, delivery). External SAST/SCA through connectors later.

## 2. The model

The kit's overlay (`studio-backend/src/kit_registry/builtin/mna.kit.json`,
ADR-0070) brings four types. The kit's own types are catalogued under the
kit's namespace, `gts.cf.studio.kit.mna.*` as #1024 asks; the subtype of
Project is chained onto Project's GTS id, as every kit's type that `extends`
another is (ADR-0073 §1).

| Type (entity) | GTS id | Fields |
|---|---|---|
| M&A deal (`mna-project`, extends `project`) | `gts.cf.studio.domain.project.v1~cf.studio.kit.mna.project.v1~` | `target`, `thesis`, `deal_phase` (`screening` \| `confirmatory_dd` \| `signing` \| `integration`), `ic_date` (a day), `recommendation` (`proceed` \| `proceed_with_conditions` \| `stop`), `conditions[]`, `signed_off_by`, `signed_off_at` |
| Finding (`mna-finding`) | `gts.cf.studio.kit.mna.finding.v1~` | `title`, `severity` (`critical` … `info`), `source` (the repository or part of the target it is about), `evidence`, `origin` (where it came from: `manual`, `spec_check`, `ci`, `git`, `interview`), `status` (`open` \| `accepted` \| `resolved`) |
| Deal risk (`mna-risk`) | `gts.cf.studio.kit.mna.risk.v1~` | `title`, `likelihood`, `impact`, `owner`, `mitigation`, `finding_id` (the finding it comes from), `status` (`open` \| `mitigating` \| `accepted` \| `closed`) |
| Open question (`mna-open-question`) | `gts.cf.studio.kit.mna.open_question.v1~` | `what`, `who`, `answer`, `status` (`open` \| `answered` \| `closed`) |

Relations: each item `about` the deal; a risk `from_finding` a finding. The
deal's phase is `deal_phase`, not `phase`: Project lifecycle's `phase` is on
the same object (ADR-0073 §6: the object keeps the storage type `project`),
and the two are different things.

Where the objects are: the deal's fields on the project's own object (type
`project`, keyed `self`, in the project's scope, as Project lifecycle writes
its phase); findings, risks and questions as objects of their types in the
project's scope, each carrying its own `item_id`. Nothing has a table of its
own. The function reads and writes the project's object only through the kit
installer's pair (`project_object`, `put_project_object` in `phase.rs`),
the one place that names the type it is stored as, so storing it as the
subtype itself (studio-web#1118) changes that pair and nothing here.

The subtype's fields are typed as strictly as an overlay field says:
`deal_phase` and `recommendation` are enumerations, `ic_date` a date,
`signed_off_at` a timestamp, `conditions` a list of text; the function
refuses anything else (400 `invalid_argument`) before the model sees it.

The project-lifecycle kit has a `risk` type too (a delivery risk on any
project); the deal's risk ledger is the kit's own `mna-risk` because its
vocabulary (likelihood, the finding it comes from) is a deal's.

## 3. Creating a deal

The kit's `project_creation` (ADR-0073 §4–§5):

- `mode`: `modernize` — a deal evaluates existing software;
- `steps`: `sources` only — no gear repository, no scaffold, no PRD from the
  brief (a deal's brief is not a product's);
- `next_steps`:
  1. **Connect the target's repositories** → `/projects/sources`, done with
     the path's `repos` step;
  2. **Fill in the thesis** → `/deal`, done when the project's object has
     `thesis` set;
  3. **Review the evidence** → `/deal`, dismissible.

Step 2 needed a second form of `done_when`: **`field:<name>`**, a field of
the kit's own project type (checked when the manifest is read), done once
the project's object in the model has it set. The Overview reads that object
(`POST /studio-domain-model/v1/query`, `type: project`, its `tenant_id` the
project) only when a pending step names a field. The project path knows
nothing of a kit's fields, so this is not a path step.

The kit is opt-in (`OPT_IN_BUILTIN`): it applies only to a project created as
a deal, or where somebody installs it for a project. Its level is `project`
only.

## 4. The function and its routes

Until kit functions run in Studio's function runtime (ADR-0068 §9), the kit's
function is compiled into **studio-kits** (`kit_registry/mna.rs`), as Project
lifecycle's phase is (`phase.rs`): the gear that installs a kit's model writes
a built-in kit's types through the domain model's port. Every write is the
domain model's, **as the caller**: the PDP's `domain.edit` decides (403
`DOMAIN_EDIT_REQUIRED`). The kit claims its write routes and tools (ADR-0071),
so where it does not apply they answer `KIT_NOT_INSTALLED` before the handler;
the reads answer an empty deal (`installed: false`) or empty lists.

| Method | Path | What |
|---|---|---|
| `GET` | `/studio-kits/v1/mna/deal?project_id=` | the deal, the deal lead and whether the caller may sign off |
| `PATCH` | `/studio-kits/v1/mna/deal?project_id=` | change fields; an empty string clears; changing the recommendation or its conditions takes the sign-off back |
| `POST` | `/studio-kits/v1/mna/deal/sign-off?project_id=` | the deal lead signs off (`DEAL_LEAD_REQUIRED`; `NO_RECOMMENDATION`) |
| `GET` | `/studio-kits/v1/mna/evidence?project_id=` | §5 |
| `GET`, `POST` | `/studio-kits/v1/mna/findings?project_id=` | list (newest first, paged), record (201) |
| `PUT`, `DELETE` | `/studio-kits/v1/mna/findings/{finding_id}?project_id=` | replace (who recorded it and when stay), delete (204) |
| `GET`, `POST`, `PUT`, `DELETE` | `/studio-kits/v1/mna/risks…` | the same for risks; `finding_id` names one of the deal's findings |
| `GET`, `POST`, `PUT`, `DELETE` | `/studio-kits/v1/mna/open-questions…` | the same for open questions |

MCP (`kit_registry/mna_mcp.rs`, claimed by the kit): `mna_deal` (the deal and
its evidence), `mna_deal_update` (fields, and `sign_off: true`), `mna_findings`,
`mna_finding_upsert`, `mna_risks`, `mna_risk_upsert`. #1024 named three tools,
`mna_deal`, `mna_findings` and `mna_risks`; each is a read with a write
companion, the way `project_phase` and `project_phase_set` are, because a tool
is one effect (read or write) for an agent's permissions. Open questions have
REST only so far (#1117).

## 5. The evidence summary

`GET /studio-kits/v1/mna/evidence` is computed on the server, read as the
caller, so it shows no more than the routes behind it would. Each fact has a
`key`, a `value`, sometimes a `total`, and a `source` in words; one whose
source could not be asked is `available: false`, its `value` null and the
reason in `detail`. **Never a number made up**: unknown is not zero.

| Fact | From |
|---|---|
| `repositories`, `repositories_synced` | `project.config` `sources[]`; each repository's last finished sync (`synced_at` on its `repo` node, studio-artifact-ingest) |
| `contributors`, `truck_factor`, per repository too | the provider's contributor list through each source's own connection (`Repository::contributors`, whole history, up to 100, bots left out). Truck factor: the fewest people who made more than half of the commits. A repository whose connection refuses is named in `detail` |
| `active_contributors` | Insight: people with commits over 90 days (`GET /studio-organizations/v1/metrics`, `git.contributors`); unavailable where Insight is not configured |
| `ci_pass_rate` (out of the finished runs), `mainline_build` | the CI runs the last sync kept (`GET /studio-artifact-ingest/v1/runs`); cancelled, skipped and running runs do not count |
| `specs_checked`, `specs_failing`, `spec_findings_open` | the project's rollup (`GET /studio-organizations/v1/rollups?project_id=`): spec checks and Spec Quality's open findings, null there is unavailable here |
| `findings_open`, `risks_open`, `questions_open` | the deal's own objects (a risk is open while `open` or `mitigating`) |

## 6. The Deal tab

`mna-mfe` (`studio-frontend-prototype/src-app/mfe_packages/mna-mfe`), Project ›
Deal (`/deal`), shown only where the kit applies (`presentation.kit: "mna"`):

- a header with the target, the phase and the IC date;
- the recommendation with its conditions and a Sign off button, enabled only
  for the deal lead;
- the thesis editor;
- the evidence summary (§5), each number with where it came from;
- Findings, Risks and Open questions on the shared `ListGrid`, each with a
  create/edit dialog.

English and Russian; design tokens, so the dark theme follows.

## 7. Follow-ups

Phases 3–5 of #1024, each a sub-issue:

- scenarios and costs, with a baseline cost and the arithmetic on the server —
  #1112;
- the technical health index from the evidence — #1113;
- the 100-day plan — #1114;
- interviews — #1115;
- Inbox sources: questions and risks waiting on their owner, a sign-off
  waiting on the deal lead — #1116;
- agent functions (drafting the recommendation, proposing risks and questions
  from findings) and the open-question tools — #1117.

## 8. Open questions

1. **The deal lead as a role.** The project's owner is the deal lead because a
   project carries no roles. When projects get roles of their own, the kit
   declares a `deal-lead` role and the sign-off checks it instead.
2. **Who owns a risk or answers a question** is free text now (the target's
   people have no Studio account). The Inbox source (#1116) needs a person.
3. **Edges.** Items are scoped to the project and carry `finding_id`; the
   declared relations (`about`, `from_finding`) are not written as edges yet,
   so the model's graph does not show them.
