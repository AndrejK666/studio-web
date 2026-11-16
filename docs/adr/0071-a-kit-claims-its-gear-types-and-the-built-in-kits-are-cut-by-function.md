---
type: adr
status: proposed
date: 2026-11-12
---

# ADR-0071: A kit claims the gear types, tools and routes it stands for, and the built-in kits are cut by what they do

**ID**: `cpt-studio-adr-kit-claims`

Status: **proposed** · Date: 2026-11-12 · Builds on ADR-0067 §6 (a kit brings the rest, a gear holds), ADR-0068 (Studio is a shell; kits), ADR-0069 §4 (base kits), ADR-0070 (the core model, the gear layer, installed / dormant / absent) · **Amends** ADR-0070 §1 (the owner of `work-item`, `finding`, `comment` and `assignment`, and the kits that bring tabs only), §2 (a section's `needs`, and declared dependencies between kits), §3 (who sets `meta.kit` on a gear's type), §5 (the equality check ignores a slug rename), §6 (`KIT_NOT_INSTALLED` covers a gear's tools and write routes) and §7 decisions 1, 2, 5 and 7 · **Supersedes** ADR-0068 §7's table of built-in kits · **Extends** ADR-0068 §3 (the manifest gains `gears` and `requires`) and **answers** ADR-0068 open question 2 (declared kit dependencies) · Part of #998

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
  - [Who records that a gear's type belongs to a kit](#who-records-that-a-gears-type-belongs-to-a-kit)
  - [What a claim covers](#what-a-claim-covers)
  - [Where the decision is written](#where-the-decision-is-written)
- [Decision Outcome](#decision-outcome)
  - [1. A kit claims a gear's types, tools and write routes](#1-a-kit-claims-a-gears-types-tools-and-write-routes)
  - [2. The manifest's `gears` section](#2-the-manifests-gears-section)
  - [3. What the claiming kit decides](#3-what-the-claiming-kit-decides)
  - [4. The gear without its kit](#4-the-gear-without-its-kit)
  - [5. Declared dependencies: `requires` and `needs`](#5-declared-dependencies-requires-and-needs)
  - [6. The built-in kits, cut by function](#6-the-built-in-kits-cut-by-function)
  - [7. The gear types that are core](#7-the-gear-types-that-are-core)
  - [8. Renamed and merged kits: slug aliases for one release](#8-renamed-and-merged-kits-slug-aliases-for-one-release)
  - [9. What this changes in ADR-0070 and ADR-0068](#9-what-this-changes-in-adr-0070-and-adr-0068)
- [Migration order](#migration-order)
- [Consequences](#consequences)
- [Risks](#risks)
- [Confirmation](#confirmation)
- [Open questions](#open-questions)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

ADR-0070 split Studio's seed into a core and kits. That split covered the seed's 63
types. It did not cover the types that gears declare for themselves, and those are where
the screens' data lives.

**Today's kits.** `builtin_catalogue()` lists 18 built-in kits
(`studio-backend/src/kit_registry/service.rs` 755–890). 17 have a compiled-in
`kit_registry/builtin/*.kit.json`; `studio-api-docs` has none. `moved_to_kits` in the seed
has 43 entries (`domain_model/ontology.studio.json` 6057), and the core keeps 44 types.

**The kits' types are mostly vocabulary.** The 20 types that kits bring after ADR-0070
phase 5 come from the product team's model. Only 8 of them have a writer: `pull-request`,
`work-item`, `comment`, `finding`, `review-request`, `approval`, `approval-request` and
`lifecycle-stage`.

**The screens' data is in gear types that no kit owns.** Gears declare 65 types through
`TypeNeed`. 12 are seed types. The other 53 are not, and none of them has a kit:
`declare_gear_type` sets `meta.kit` only from the seed's annotation or from
`moved_to_kits` (`domain_model/gear_declarations.rs` 62–76). So `budget`, `deployment`,
`ci-run`, `gear` and `spec-extraction` stay `origin: gear`, with no kit, whatever is
installed. Uninstalling `org-costs` hides the Costs tab, but `budget` stays visible in the
generic screens and in `domain_model_types`, and `domain_model_types` cannot name a kit for
`deployment`. The one gear tool that refuses without its kit does it by hand: the research
gate in `environments/service.rs` 2826–2849 and 3747–3763.

**MCP tools are hardly tied to kits.** The manifests declare 4 tools (`research_projects`,
`research_hardware` in `constructor-research.kit.json` 22; `project_phase`,
`project_phase_set` in `project-lifecycle.kit.json` 697). The gears expose about 110:
`studio-environments` 30, `studio-documents` 16, `studio-product` 14, `studio-kits` 18.
`project_phases` is implemented (`kit_registry/mcp.rs` 316) but missing from the
manifest.

**The cut follows how tabs were added, not what they do:**

- **Names that do not match the content.** The Issues tab (`project-issues`) shows the open
  questions of the project's domain model, read from
  `GET /studio-documents/v1/project-domain-model/issues` (`kit_registry/contents.rs`
  243–263; `issues-mfe/src/api/IssuesApiService.ts` 32). Its types, though, are Git
  tracker issues (`work-item`) and spec findings (`finding`).
- **Kits too small to stand alone.** Six kits are one tab with no type of their own:
  `org-connections`, `project-artifacts`, `project-team`, `org-costs`,
  `org-infrastructure`, `project-domain-model`. Connections and people are the shell's by
  ADR-0068 §1. `org-connections` does not even declare the routes its screen calls
  (`contents.rs` 600–603).
- **One area cut across three kits.** `org-infrastructure`, `product-releases` (Releases)
  and `constructor-research` all live on `studio-environments`.
  `model/infra-services.ts` is copied into both `product-mfe` and `infrastructure-mfe`.
  `product-releases` alone reads 55 routes and writes 29 across 7 gears (`contents.rs`
  496–592), mixing what the product is made of with how it ships.
- **Dependencies between kits that the cut created.** Activity's Timeline needs
  `milestone` from project-lifecycle (`activity-mfe/mfe.json` 50). Tests reads open pull
  requests (`contents.rs` 272). `components` writes connections (`contents.rs` 434–436).
- **`needs` is a bare id.** The portal's `needs: ["milestone"]` is compared with entity ids
  (`app/layout/useInstalledKits.ts` 72–80), not with the GTS id ADR-0070 §2 prescribes.

The question: **how does a kit say which gear types, tools and routes are its own, and
what set of built-in kits follows from cutting by function?**

The analysis behind this record, with one row per kit and per gear, is summarised in the
tables below. The gear-held types are listed, as they are in code, in
[the domain model split](../design/domain-model-split.md) §8.

## Considered Options

### Who records that a gear's type belongs to a kit

1. **The gear names its kit** in its `TypeNeed` (`kit: Some("delivery")`, a new field in
   `domain_model/port.rs` 35–55). One place, next to the gear's code. But a gear would
   know the slugs of kits, which are the product's cut, not a property of the gear. A
   re-cut would touch gears. A kit from outside Studio could never take a Studio gear's
   type.
2. **The kit claims the gear's types in its manifest.** The cut lives in one place, the
   kits. Re-cutting does not touch gears, and a kit from outside Studio that uses Studio's
   gears can claim them. It needs a completeness test: every gear type is claimed by one
   kit or is listed as core.
3. **A separate type → kit table** next to `moved_to_kits`. Simple, but a third source of
   truth beside `moved_to_kits` and the design's §8, and §8 has already drifted from code.

**Chosen: 2.**

### What a claim covers

1. **Whole gears.** A kit claims `studio-environments` and everything in it. Simple, but
   `studio-artifact-ingest` serves the core, Git collaboration, Tests, Delivery and
   Product, and `studio-documents` serves Specs, Project model, Planning and the core. A
   whole-gear claim cannot express that.
2. **By type, tool and write route.** A gear may serve several kits, and each claims what
   is its own.

**Chosen: 2.**

### Where the decision is written

1. **Amend ADR-0070** in place. ADR-0070 is about the seed's types and the layered model;
   claims, a new kit set and slug renames are a different decision, and rewriting a
   proposed record that issues #1030–#1039 already implement would make those issues read
   against text they were not written for.
2. **A new record** that says exactly which parts of ADR-0070 and ADR-0068 it amends or
   supersedes.

**Chosen: 2.**

## Decision Outcome

### 1. A kit claims a gear's types, tools and write routes

A kit's manifest names, per gear, the types, MCP tools and write routes it claims. A
claim is **by type, not by gear**.

- **A claim does not declare a type.** The type, its fields, `held_by`, `searchable` and
  the relations the gear writes still come from the gear's `TypeNeed`, the gear's layer
  (ADR-0070 §3). The claim says one thing: this kit decides the type's state and its
  `meta.kit`. The kit's overlay may also declare the same id with descriptive fields, tabs
  and a lifecycle, as an adoption: the holder is kept (`docs/design/studio-kits.md`
  385–395).
- **One type, one kit.** Two kits that claim the same type are a manifest error,
  `KIT_MODEL_CONFLICT`, as two kits declaring the same field are today.
- **One tool or write route, one kit.** The same rule.
- **The layer order of ADR-0070 §5 does not change:** core ⊕ gears ⊕ base kits ⊕ the
  organization's kits ⊕ the organization. Only how `meta.kit` and the state are computed
  changes (§3).
- **A claim applies on the organization.** The model is the organization's
  (`studio-kits.md` 450–454, the second rule). A project kit that claims types behaves like a project kit
  with a model today: it may be installed for an organization only
  (`MODEL_KIT_NOT_FOR_PROJECT`).

### 2. The manifest's `gears` section

`KitManifest` (`kit_registry/manifest.rs` 51–96, `deny_unknown_fields`) gains `gears`
and `requires`. In `kit.json`:

```json
{
  "slug": "delivery",
  "name": "Builds, releases & environments",
  "levels": ["organization", "project"],
  "requires": [],
  "gears": [
    {
      "gear": "studio-environments",
      "types": [
        "deployment-environment",
        "environment-binding",
        "environment-config-secret",
        "deployment"
      ],
      "mcp_tools": ["deploy_request", "deployment_decide", "deployments", "infra_services"],
      "routes": [
        "POST /studio-environments/v1/environments",
        "PUT /studio-environments/v1/environments/{environment_id}",
        "POST /studio-environments/v1/deployments",
        "POST /studio-environments/v1/deployments/{deployment_id}/decisions"
      ],
      "sync_only_with_kit": false
    },
    {
      "gear": "studio-artifact-ingest",
      "types": ["product-build", "build-artifact", "release"],
      "mcp_tools": ["build_list"],
      "routes": ["POST /studio-artifact-ingest/v1/builds/dispatch"],
      "sync_only_with_kit": true
    }
  ]
}
```

And the same in `kit.gdl` (ADR-0068 §3):

```python
kit(
    slug = "constructor-research",
    requires = ["delivery"],
    gears = [
        # Research's routes are all reads today, so it claims tools only.
        kit_gear_claim(gear = "studio-environments",
                       mcp_tools = ["research_projects", "research_hardware"]),
    ],
)
```

The lists above are excerpts: the environments gear has 30 tools and about 25 write
routes today. The full lists are the implementation's, held by the test of §3.

- `types`: the ids of types the gear declares through `TypeNeed`, held or open.
- `mcp_tools`: tool names the gear's MCP serves.
- `routes`: **write** routes only, `METHOD path` as `permissions.writes` already writes
  them. Reads stay open (§4).
- `sync_only_with_kit`: optional, default `false` (§4).
- `requires`: the slugs of kits this kit cannot work without (§5).

`permissions` stays. A claimed route is also in `permissions.writes`. The claims are not
a second permission list: they say whose a route is, and `permissions` says what a kit's
code may call. Today most kits' permissions are in `contents.rs` and three kits'
(`project-lifecycle`, `product-releases`, `constructor-research`) in `kit.json`;
`contents.rs` 134–138 merges the two. Moving them all into `kit.json`, so that there is
one source, is part of migration step 1.

### 3. What the claiming kit decides

For a type a gear declares, in an organization:

| The type is | And | State | `meta.kit` |
|---|---|---|---|
| claimed by kit K | K applies (base, organization's, or a project's, ADR-0069 §4) | **installed** | K |
| claimed by kit K | K does not apply, and the gear holds the type or it has objects | **dormant**, `left_by = {kit: K, …}`; for a kit never installed here, `state = not_installed` | K |
| claimed by no kit | listed as a core gear type (§7) | shown as core | none |
| claimed by no kit | not listed | **a build failure** (test); at run time, administrators only | none |

- A member asking for a dormant or not-installed claimed type gets ADR-0070 §4's 404
  `DOMAIN_TYPE_NOT_INSTALLED`, naming K. An administrator sees it in Admin › Domain model,
  marked "comes with K", with the install.
- `declare_gear_type` (`gear_declarations.rs` 62–76) takes `meta.kit` from the claims of
  the built-in kits, after the seed's annotation and `moved_to_kits`.
- **The build test.** Every type a gear declares, `held_by` or open, is claimed by exactly
  one built-in kit or is in the core list of §7. Every MCP tool a gear serves is claimed
  by exactly one built-in kit or is marked a shell tool. Every alias of §8 resolves to
  existing kits.
- **Kit lifecycle.**
  - *Install* clears `left_by` on the claimed types and applies the overlay.
  - *Uninstall* makes the claimed types dormant. A type a linked gear holds is never
    absent.
  - *Upgrade*: a type the new version no longer claims is unclaimed. If another kit of the
    same shipment claims it, it moves there. Otherwise it is a build failure for a
    built-in kit and administrators only for any other.

### 4. The gear without its kit

| What | Behaviour |
|---|---|
| The gear's writes (sync, `put_objects`) | Go on (ADR-0070 §7, decision 7). The gear's layer keeps the fields valid |
| Where its types live | In the organization's effective model, from the gear's layer, dormant or not installed, with `meta.kit = K` |
| Members: `/query`, `/objects`, generic screens | 404 `DOMAIN_TYPE_NOT_INSTALLED` with `kit = K` |
| Administrators: Admin › Domain model | See the type, "comes with K", and the install |
| The gear's MCP tools that K claims | `KIT_NOT_INSTALLED` with `kit = K` |
| The gear's REST reads | Open: shell summaries and other kits' `needs` read them |
| The gear's REST writes that K claims | `KIT_NOT_INSTALLED` with `kit = K` |

**`KIT_NOT_INSTALLED` is one check, not per-gear code.** `studio-mcp` builds a map from
tool to kit from the claims, and the REST layer a map from write route to kit. A call
whose kit does not apply where the caller acts answers `failed_precondition` with
`KIT_NOT_INSTALLED` and the kit, as `research_kit_gate` does now
(`environments/service.rs` 3758–3763). `research_kit_gate` then goes. The tool list stays
per connection (ADR-0070 §7, decision 5). **Reads are not claimed in this record.** If
they were, the organization Overview and other kits' screens would fail where they now
degrade. Claiming reads waits until every reader names its kit and degrades.

**A gear may skip expensive sync for an organization without the claiming kit.** This is
opt-in per gear and per claim (`sync_only_with_kit: true`). The gear asks
`KitPresence::applies` (`kit_registry/port.rs` 102–119) before the work and skips it where
no claiming kit applies. Example: `studio-artifact-ingest` does not fetch CI jobs or
builds where neither Tests nor Delivery applies. Without the flag the gear writes as
before, and a reinstall finds current data. With it, a reinstall finds data only from the
next sync on. That cost is stated in the kit's install summary.

### 5. Declared dependencies: `requires` and `needs`

- **`requires`** (this answers ADR-0068 open question 2): a kit that cannot work without
  another kit names it. The installer refuses an install whose required kits do not apply,
  and an uninstall that would leave a kit that applies without what it requires. It
  offers to install or uninstall both. Two kits declare it:
  - `constructor-research` requires `delivery`. Research is a delivery target; the code
    already asks about research inside delivery (`environments/service.rs` 2826).
  - `project-domain-model` requires `project-specs`. The project model is read out of the
    specs.
- **`needs`** stays per section (ADR-0070 §2), and is a **GTS id**
  (`gts.cf.studio.domain.pull_request.v1~`), not a bare entity id. The portal's check
  (`useInstalledKits.ts` 72–80) compares GTS ids. The Tests tab's open pull requests
  section declares `needs` on `pull-request`. Timeline no longer needs anything, because it
  moves to the kit that brings `milestone` (§6).
- **A relation between two kits** still needs no dependency. It is unresolved and not
  offered while its target's kit is absent (ADR-0070 §2).

### 6. The built-in kits, cut by function

13 kits. Each owns one functional area: its screens, the types those screens show, the
gear types behind them, and the tools and write routes that change them.

| # | Kit (slug) | Name | Area | Types: its own and claimed from gears | Screens | Gears | Inbox |
|---|---|---|---|---|---|---|---|
| 1 | `project-specs` | Specs | A project's documents, their quality and review | `document`, `policy`, `review-request`, `approval`; claimed: `studio-document`, `document-binding`, `document-type`, `document-analysis`, `spec-upload`, `decision` | project Specs; workspace Document types | studio-documents (documents, reviews, types); studio-spec-quality | `review-requests` |
| 2 | `project-domain-model` | Project model | What the documents say about the product: facts, glossary, open questions, traceability | `finding`; claimed: `spec-extraction`, `spec-judgement`, `fact-review`, `finding-decision`, `glossary-decision`, `application-part`, `capability` | project Domain model; project Issues (moved from `project-issues`) | studio-documents (`/project-domain-model/*`); studio-spec-mapping | — |
| 3 | `project-lifecycle` | Planning | Phases, project templates, milestones, risks, delivery scope | `phase`, `risk`, `dependency`, `milestone`, `lifecycle-stage`; claimed: `project-type`, `delivery-scope`, `delivery-limit`, `delivery-scope-version` | workspace Project templates; project Phases; project Timeline (moved from `project-activity`) | studio-kits (`phase.rs`); studio-organizations (project types); studio-documents (process, delivery scope) | `phase-waiting` |
| 4 | `project-git` | Git collaboration | Work on the Git host: pull requests, tracker issues, discussion | `pull-request`, `work-item`, `comment` | project Activity (moved from `project-activity`) | studio-artifact-ingest (`/activity`, `/open-pull-requests`) | `pull-requests` |
| 5 | `project-tests` | Tests | CI and conformance checks | `check`; claimed: `ci-run`, `ci-job` | project Tests (its open pull requests section `needs` `pull-request`) | studio-artifact-ingest (`/runs`); studio-documents (pull-request checks); studio-spec-mapping (conformance, read only) | — |
| 6 | `project-product` (new) | Product | What the product is made of: the map, the configurator, the description, its frontend | claimed: `project-product`, `project-gear-repository`, `gear-explanation`, `mapping-decision` | project Product; project Components (moved from `components`) | studio-product; reads of studio-components-catalog and studio-spec-mapping | — |
| 7 | `delivery` (new) | Builds, releases & environments | From a build to a running environment | claimed: `deployment-environment`, `environment-binding`, `environment-config-secret`, `deployment`, `product-build`, `build-artifact`, `release` | org Infrastructure; project Releases | studio-environments (without research); studio-artifact-ingest (builds) | `deploys-awaiting-approval` |
| 8 | `constructor-research` | Constructor Research | Constructor Research as a delivery target. Opt-in (`service.rs` 72), **requires `delivery`** | — | org Constructor Research | studio-environments (research) | `deploy-failed`, `sign-in-expires` |
| 9 | `components` | Catalogue | The platform's and the organization's catalogue and registry of gears, and publication | `approval-request`; claimed: `gear`, `gear-version`, `gear-profile`, `catalog-kit`, `frontx-package`, `catalog-service`, `component-field-schema`, `component-snapshot`, `roadmap-item`, `catalog-source`, `registry-entry`, `registry-occurrence`, `registry-read`, `registry-settings`, `registry-decision` | platform Components, Repositories, Publication requests; org Components | studio-components-catalog. It no longer writes connections | — |
| 10 | `org-costs` | Costs | Costs, prices and budgets | claimed: `budget`, `model-price` | org Costs | studio-usage | — |
| 11 | `org-reports` | Reports | An organization's reports | `report`; claimed: `report-source` | org Reports | studio-reports | — |
| 12 | `assistant` | Assistant | The chat assistant | `model`, `tool`, `message` | sidebar Studio AI | studio-llm | — |
| 13 | `studio-api-docs` | Docs & API | The API reference, on the platform level | — | product menu Docs & API | `GET /openapi.json` | — |

`studio-api-docs` gets its own `kit.json`, like every other built-in kit.

**The MCP tools follow the area.** Specs claims `review_requests`, `review_verdict`,
`spec_check` and `spec_check_result`. Project model claims the 14
`project_domain_model_*` tools and `project_capabilities`, `project_findings`,
`project_plan` and `project_requirements`. Planning claims `project_phase`,
`project_phase_set` and `project_phases` (the last is added to the manifest). Product
claims the `product_*` tools and `gdl_file`. Delivery claims the environments tools other
than `research_*`, and `build_list`. Constructor Research claims `research_*`. The
`kit_*`, `kits_*`, `domain_*`, `project_create*`, `project_status` and connection tools are
the shell's.

**To the shell** (ADR-0068 §1):

- **Connections** (`org-connections`). Connections are Sources. The tab becomes the
  shell's organization tab, and `organization.connectors → connector` goes back to the
  core. The connection writes leave `components` (`contents.rs` 434–436).
- **Team** (`project-team`). Team is People on the project level. `project.people →
  person` goes back to the core. The `assignment` type, which nothing writes, leaves the
  kits and is dropped from the core as left by Studio, the way ADR-0070 phase 5 dropped
  `gears`: it is added to `dropped_from_core`, and an organization whose members created
  `assignment` objects keeps them as a dormant type.
- **Artifacts** (`project-artifacts`). The tab becomes a shell tab beside Sources, and
  `project.artifacts → repository-file` goes back to the core. What its builds produce is
  Delivery's `build-artifact`: the shell's tab shows that part only where Delivery
  applies, as the Overview shows pull requests only where Git collaboration applies.

**Today → target:**

| Today (18) | Target |
|---|---|
| `project-specs` | `project-specs` (Specs), plus the claimed document types |
| `project-domain-model` | `project-domain-model`, renamed **Project model**; takes the Issues screen and `finding` |
| `project-issues` | **merged:** the Issues screen and `finding` to `project-domain-model`; `work-item` to `project-git` |
| `project-lifecycle` | `project-lifecycle`, renamed **Planning**; takes Timeline |
| `project-activity` | **merged:** Activity and `comment` to `project-git`; Timeline to `project-lifecycle` |
| `project-git` | `project-git`, renamed **Git collaboration**; takes `work-item`, `comment`, Activity |
| `project-tests` | `project-tests`, plus `ci-run`, `ci-job` |
| `product-releases` | **split:** Product to `project-product`; Releases, builds and `deployment` to `delivery` |
| `components` | `components`, renamed **Catalogue**; project Components to `project-product`; connection writes to the shell |
| `org-infrastructure` | **merged** into `delivery` |
| `constructor-research` | `constructor-research`, requires `delivery` |
| `org-costs` | `org-costs`, plus `budget`, `model-price` |
| `org-reports` | `org-reports`, plus `report-source` |
| `assistant` | `assistant` |
| `studio-api-docs` | `studio-api-docs`, with a `kit.json` |
| `org-connections` | **the shell** |
| `project-team` | **the shell**; `assignment` dropped as left by Studio |
| `project-artifacts` | **the shell** |

Slugs that survive keep their slug and change only their name, so that `meta.kit`,
`left_by` and installations stay valid. Only two new slugs appear: `project-product` and
`delivery`.

**Relations between kits after the cut.** Two of ADR-0070's crossings become internal to
`project-git`: `pull-request.has_comments → comment` and `work-item.implemented_by →
pull-request`. The others stay crossings, unresolved and not offered without their
target's kit: `report.contains → finding`, `check.produced → finding`,
`milestone.tracks_2 → work-item`, `risk.mitigated_by → work-item`,
`pull-request.requests_reviews → review-request`, `document.has_comments → comment`,
`check.belongs_to → report`, `approval-request.collects_decisions → approval`, and
`project.parts → gear` from Product to Catalogue.

### 7. The gear types that are core

The core's 44 types stay as ADR-0070 §1 lists them. These gear-declared types are core
too, and the test of §3 accepts them unclaimed:

| Type | Declared by | Why core |
|---|---|---|
| `repository`, `commit`, `repository-file`, `text-content` | studio-artifact-ingest | Seed core types: Sources and the editor (ADR-0070 §7, decision 2) |
| `source-account` | studio-artifact-ingest | Who an author is on a Git host: identity and Sources |
| `connector-connection` | studio-connector | Connections are the shell's Sources |
| `kit-installation` | studio-kits | The kit library and the installer |
| `tenant-document` | studio-backend (`model_metadata.rs`) | Every gear's settings document |
| `record-chunk` | studio-documents (`documents/model_table.rs` 47, 96) | Storage: any table row longer than graph-storage's limit, whatever kit it serves |

### 8. Renamed and merged kits: slug aliases for one release

Type ids and GTS ids do not change. Nothing in graph-storage or the read model is
rewritten. What changes is kit slugs, in `meta.kit`, `left_by`, installation records,
`organizations/status.rs` 40–45, `organizations/overview.rs` 55–57 and the portal's
`mfe.json` files.

- **An alias table** maps each retired slug to the slugs that replace it:

  | Retired slug | Resolves to |
  |---|---|
  | `project-issues` | `project-domain-model`, `project-git` |
  | `project-activity` | `project-git`, `project-lifecycle` |
  | `product-releases` | `project-product`, `delivery` |
  | `org-infrastructure` | `delivery` |
  | `org-connections`, `project-team`, `project-artifacts` | the shell (no kit) |

  The installer, `kit_overlay` (`meta.kit`, `left_by.kit`), `KitPresence` and
  `GET /installed-kits` read it. An installation of a retired slug counts as an
  installation of every kit it resolves to. `GET /installed-kits` also returns the retired
  slugs in `effective` during the alias release, so that an old portal or desktop does not
  hide its screens.
- **The rewrite.** In the same release a sweep (the `model_sweep` pattern of ADR-0070 §5)
  rewrites each organization's `meta.kit` and `left_by.kit` to the kit that now claims
  the type, not to the alias. It is recorded as a model version `op = "kit-rename"`, with
  no inverse. Installation records are rewritten the same way.
- **The equality check ignores the rename.** ADR-0070 §5's check compares the effective
  model with the stored one entity by entity (`domain_model/core_layer.rs` 127–130,
  `differing` 446–462). A `meta.kit` or `left_by.kit` that differs only because the slug
  was renamed through the alias table is not a difference. Without this every
  organization would stay on its stored copy.
- **Merging kits whose states differ.** Where an organization had one source kit
  uninstalled and the other installed (for example `project-issues` removed,
  `project-domain-model` installed), the merged kit is installed and the organization's
  administrators get a report naming what is now shown again. Nothing changes silently.
- **Back into the core.** `organization.connectors`, `project.people` and
  `project.artifacts` were moved from the core to a kit by ADR-0070; now they return.
  A relation that a retired kit brought, and that the core now declares, is adopted by the
  core (`meta.adopted_from = <kit>`), never made dormant.
- **Then the aliases go.** One release after the rewrite, when the sweep has run in every
  organization and no client reads a retired slug, the alias table and the extra
  `effective` slugs are removed.

### 9. What this changes in ADR-0070 and ADR-0068

| Record, part | Change |
|---|---|
| ADR-0070 §1, the owner table | `work-item` and `comment` go to `project-git`; `finding` to `project-domain-model`; `assignment` is dropped as left by Studio. The tab-only kits `project-artifacts` and `org-connections` leave for the shell; `org-infrastructure` and `product-releases` give way to `delivery` and `project-product`. The core's 44 types are unchanged |
| ADR-0070 §2, a section that needs another kit's type | `needs` stays, as a GTS id; the Timeline example no longer applies. "ADR-0068 open question 2 is not needed" is replaced by `requires` (§5) for the two hard dependencies |
| ADR-0070 §3, the gear layer | Unchanged in what it declares. **Added:** the claiming kit, not the gear, decides the state and `meta.kit` of a gear's type (§3) |
| ADR-0070 §5, the equality check | Also ignores `meta.kit` and `left_by.kit` changed by a slug rename (§8) |
| ADR-0070 §6 and §7 decision 5, `KIT_NOT_INSTALLED` | Covers a gear's tools and write routes through the claims, by one shared check, not only a kit's own tools |
| ADR-0070 §7 decision 1 | **Superseded:** Timeline moves to `project-lifecycle`, and has no `needs` |
| ADR-0070 §7 decision 2 ("`comment` does not go with it") | **Superseded:** Activity and `comment` join `project-git` |
| ADR-0070 §7 decision 7 (the sync keeps writing) | Still the default. **Amended:** a gear may opt in to skip expensive sync where no claiming kit applies (§4) |
| ADR-0068 §3, the manifest | **Extended** with `gears` and `requires` |
| ADR-0068 §7, the table of built-in kits | **Superseded** by §6 |
| ADR-0068 open question 2 | **Answered** by `requires` (§5) |

ADR-0070's phases (#1030–#1039) stand as written. The migration below starts from where
they leave the code.

## Migration order

Each step is one change and ships alone. Each leaves every organization reading the same
types, fields, relations and tabs, except where the step says otherwise.

| Step | Delivers | Depends on |
|---|---|---|
| 1 | **Claims under current slugs.** `gears` in every built-in manifest, against today's kits (`ci-*` → `project-tests`; environments → `org-infrastructure`, `deployment` → `product-releases`; usage → `org-costs`; …). The core gear types list (§7). The build test (§3). `declare_gear_type` takes `meta.kit` from claims. `studio-api-docs.kit.json`. `project_phases` in the Planning manifest. Permissions move from `contents.rs` into `kit.json`. The equality check ignores `meta.kit` set by a claim | ADR-0070 phase 4 |
| 2 | **One shared `KIT_NOT_INSTALLED`** for MCP tools and write routes, from the claims; `research_kit_gate` goes. The opt-in `sync_only_with_kit` over `KitPresence` | 1 |
| 3 | **`requires` and `needs`.** `requires` in the manifest and the installer (`constructor-research` → `org-infrastructure` until step 5 makes it `delivery`; `project-domain-model` → `project-specs`). `needs` as GTS ids in `mfe.json`, `kit.json` and the shell's check; the Tests tab's pull-request section declares `needs` | 1 |
| 4 | **Screen moves inside today's kits, no slug changes.** Timeline → `project-lifecycle` (its `needs` goes); Issues and `finding`, `project.issues`, `kit.introduces_type_22` → `project-domain-model`; project Components → `product-releases` | 3 |
| 5 | **Merges with aliases.** The alias table, the `kit-rename` sweep and the equality rule for renames. `project-activity` and `project-issues`' `work-item` → `project-git`; `org-infrastructure` and Releases → `delivery`; Product → `project-product`; the old `kit.json` files go after the sweep. Status and Overview constants, and the generated per-kit clients | 4 |
| 6 | **Connections, Team and Artifacts to the shell.** The three tabs become the shell's; their relations go back to the core with `adopted_from`; `assignment` is added to `dropped_from_core`; the connection writes leave `components` | 5 |
| 7 | **Aliases removed**, one release after step 5 is on every environment | 5, 6 and one release |

Moving `phase.rs` out of `studio-kits` into a kit function (ADR-0068 §9) is not part of
this order.

## Consequences

- Good, because uninstalling a kit now does what ADR-0068's Confirmation asks for the
  gear types too: without Costs, `budget` is dormant, not a type with no kit that the
  generic screens still show.
- Good, because `domain_model_types` names a kit for every type a screen shows, and an
  agent calling a gear's tool in an organization without its kit learns which kit to
  install.
- Good, because a re-cut of the kits is a change to manifests, not to gears, and a kit
  from outside Studio can claim a Studio gear's types.
- Good, because each functional area is one kit. A delivery change touches one kit, and
  `infra-services.ts` stops being copied.
- Good, because the only hard dependencies left are declared ones (`requires`), and the
  one `needs` the cut caused (Timeline) goes.
- Bad, because the completeness test makes every new gear type a two-place change: the
  gear's `TypeNeed` and a kit's claim, or the core list.
- Bad, because renames touch every organization's stored `meta.kit`, `left_by` and
  installations, through a sweep and an alias release.
- Bad, because the shell takes back three tabs (Connections, Team, Artifacts) that
  ADR-0070 had moved to kits, and the core learns the reverse move it did not have.
- Bad, because a gear that opts into `sync_only_with_kit` can come back stale on reinstall.

## Risks

- **The equality check fails everywhere.** If step 1 or step 5 changes `meta.kit` and the
  comparison still sees it, every organization stays on its stored copy. Mitigation: the
  rule ships in the same change as the claims (step 1) and the renames (step 5).
- **Clients that read slugs.** The desktop, Theia, Orca and scripts may read
  `installed-kits` or call `kit_project_install` with retired slugs. The alias release
  covers them; the cleanup (step 7) waits until none does.
- **`left_by` with a retired slug** after "Remove what *kit* left" (ADR-0070 §7, decision
  8). The removal reads aliases until the rewrite has run.
- **A split slug.** `product-releases` resolves to two kits. An organization that removed
  it removed both; one that kept it keeps both. Any other reading (one of the two) is an
  administrator's choice after the move, not the migration's.
- **Backend and portal out of step.** An old `mfe.json` against the new backend names
  kits that are no longer installed and hides its screens. The retired slugs in
  `effective` cover this during the alias release; backend and portal still deploy
  together.
- **`sync_only_with_kit` switched on by mistake** leaves no data for a reinstall. It is
  off by default and named in the kit's install summary.
- **The shell's Artifacts tab reads a Delivery type** (`build-artifact`). It has to
  degrade the way the Overview does for pull requests; otherwise the shell depends on a
  kit.
- **Merged kits with different states** may show again something an organization had
  removed. The administrator report of §8 is the guard; it has to run before the merged
  kit's screens mount.

## Confirmation

- The build test fails when a gear declares a type that no built-in kit claims and the
  core list does not name, and when two kits claim the same type, tool or write route.
- With `org-costs` uninstalled in an organization: `budget` and `model-price` are dormant;
  a member's `domain_model_query` on `budget` answers `DOMAIN_TYPE_NOT_INSTALLED` with
  `org-costs`; a write to a claimed `studio-usage` route answers `KIT_NOT_INSTALLED`;
  `studio-usage` still meters.
- Without `delivery`, every environments MCP tool other than `research_*` answers
  `KIT_NOT_INSTALLED` with `delivery`, and `constructor-research` cannot be installed.
- No gear has code of its own that answers `KIT_NOT_INSTALLED`.
- After step 5, an organization that had every base kit reads the same types, fields,
  relations and tabs as before; only `meta.kit` values differ, and the equality check
  accepts it.
- After step 7, no code, manifest or `mfe.json` names a retired slug.

## Open questions

1. **Product and Catalogue.** Does `project-product` require `components`? The product
   is composed of catalogue gears (ADR-0061), so in practice yes; the default here is a
   `needs` on `gear` for the Components screen and no `requires`.
2. **The Issues screen's name.** Under Project model it shows open questions, not tracker
   issues. Renaming the tab ("Open questions") is a portal change left to step 4.
3. **Activity as the project's feed.** Activity is meant to grow into a project-wide feed
   (documents, deploys). If it does, it may have to leave Git collaboration again, as a
   shell tab that kits contribute sections to.
4. **The `phase.rs` move** into a kit function (ADR-0068 §9) stays open and outside this
   order.
5. **Claimed reads.** When every reader of a gear's routes names its kit and degrades,
   should reads be claimed too?

## More Information

- The built-in kits: `studio-backend/src/kit_registry/service.rs` `builtin_catalogue()`,
  `kit_registry/contents.rs`, `kit_registry/builtin/*.kit.json`, `kit_registry/manifest.rs`;
  `KitPresence`: `kit_registry/port.rs`.
- The gear declarations: `TypeNeed` in `domain_model/port.rs`; `declare_gear_type` in
  `domain_model/gear_declarations.rs`; the moves in `ontology.studio.json` `moved_to_kits`
  and `dropped_from_core`; the equality check in `domain_model/core_layer.rs`.
- The gears' types, as code declares them: [the domain model split](../design/domain-model-split.md) §8.
- The portal's kit sections: `studio-frontend-prototype/src-app/mfe_packages/*/mfe.json`;
  the shell's check: `app/layout/useInstalledKits.ts`.
- Issues: #998 (the portal backlog), #1025 (ADR-0070) and its phases #1030–#1039.

## Traceability

- Amends `cpt-studio-adr-domain-model-split` (ADR-0070) and
  `cpt-studio-adr-shell-and-kits` (ADR-0068).
- Corrects `cpt-studio-design-domain-model-split` §8.
