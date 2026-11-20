---
type: adr
status: proposed
date: 2026-11-19
---

# ADR-0074: Spec mapping is a kit too, and the assembly strategies come from the installed kits

**ID**: `cpt-studio-adr-spec-mapping-kit`

Status: **proposed** · Date: 2026-11-19 · **Amends** ADR-0072 (§3, §4: the strategies and their default) and ADR-0071 §6 (a fifteenth built-in kit; tools and a route move out of `project-domain-model` and `project-product`) · Design: [`docs/design/product-gear-match.md`](../design/product-gear-match.md) §8, [`docs/design/studio-spec-mapping.md`](../design/studio-spec-mapping.md)

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Decision Outcome](#decision-outcome)
  - [1. The Spec mapping kit](#1-the-spec-mapping-kit)
  - [2. A base kit an organization may uninstall](#2-a-base-kit-an-organization-may-uninstall)
  - [3. A kit provides a strategy](#3-a-kit-provides-a-strategy)
  - [4. Which strategy a product is assembled by](#4-which-strategy-a-product-is-assembled-by)
- [Amendment (2026-11-19): the open questions answered, and plug-in strategies](#amendment-2026-11-19-the-open-questions-answered-and-plug-in-strategies)
  - [A. The capabilities and requirements tools go back to the Project model](#a-the-capabilities-and-requirements-tools-go-back-to-the-project-model)
  - [B. The mapping decisions are Spec mapping's](#b-the-mapping-decisions-are-spec-mappings)
  - [C. An organization's kit may provide a strategy a service runs](#c-an-organizations-kit-may-provide-a-strategy-a-service-runs)
- [Consequences](#consequences)
- [Confirmation](#confirmation)
- [Open questions](#open-questions)

<!-- /toc -->

## Context and Problem Statement

ADR-0072 made the gears matcher a kit and gave a product two assembly strategies,
`spec_mapping` and `gears_matcher`. Only one of them was a kit's: `spec_mapping`
was hard-wired as Studio's default, offered everywhere, and the strategies were a
list in studio-product's code. An organization that wants only the matcher, or
neither, could not say so, and the organization page offered a "Studio's default"
choice that was nothing but `spec_mapping` under another name.

The question: **how does spec mapping become something an organization chooses,
and how does a product learn which strategies it may use without a list in code?**

## Decision Outcome

### 1. The Spec mapping kit

A fifteenth built-in kit, `spec-mapping` ("Spec mapping"), levels organization and
project, no `requires`, no model overlay (as first decided it claimed no type; the
amendment, §B, gives it `mapping-decision`).
As with ADR-0072 only ownership moves; studio-spec-mapping's code stays where it is.

- **Claims** (ADR-0071 §1) on `studio-spec-mapping`: the MCP tools
  `project_findings` and `project_plan` (until now `project-domain-model`'s; the
  amendment, §A, leaves `project_capabilities` and `project_requirements` with it)
  and the write route `POST /studio-spec-mapping/v1/decisions` (until now
  `project-product`'s).
- **Reads** that are the plan answer `KIT_NOT_INSTALLED` naming the kit where it
  does not apply to the project: `GET plan`, `GET findings`, `GET decisions`. Not
  a claim (claims are writes, ADR-0071 §2): studio-spec-mapping asks the shared
  check itself, once the caller is shown to reach the project. `GET capabilities`,
  `GET requirements` and `POST conformance` stay open: other kits read them as
  what the specifications say (Tests, the project domain model).
- **No screen of its own.** The plan is drawn inside other kits' screens:
  Project › Components' plan, Project › Gear match's "also in the spec plan",
  the domain model's map, Releases' spec count, the product's `spec_mapping`
  proposals. Each of them leaves the plan out where it answers
  `KIT_NOT_INSTALLED`; Components says why.
- **A split, not a rename.** No slug is retired, so the alias table (ADR-0071 §8)
  and `migrate` see nothing, and no installation document is rewritten.

### 2. A base kit an organization may uninstall

To leave every existing organization as it was, `spec-mapping` is a base kit by
default (not in `OPT_IN_BUILTIN`). Unlike the other base kits, an organization
administrator may uninstall it **for that organization alone**
(`ORGANIZATION_REMOVABLE_BASE`): the organization's installation document records
it in `removed_base`, the base kits that apply to it leave it out, and installing
the kit for the organization again takes the entry back (no organization record
is added; the base kit applies again). A project of an organization without it may
still install it for itself. `GET /installed-kits` marks such a base kit
`removable_by_organization`, and Organization › Kits offers its uninstall.

### 3. A kit provides a strategy

A kit's manifest may declare the strategy it provides, one optional section:

```json
"assembly_strategy": { "id": "spec_mapping", "name": "Spec mapping", "description": "…" }
```

`id` is `snake_case` (at most 40), `name` 1 to 80 characters, `description` at
most 400; `manifest.rs` checks it. `spec-mapping` declares `spec_mapping`,
`gears-matcher` declares `gears_matcher`. studio-product reads the strategies from
the kits that apply where the product is (`kit_registry::port::assembly_strategies`
over `KitPresence::effective`) and offers those it knows how to run; there is no
list of strategies to offer in its code. Built-in kits only: an organization's own
kit cannot bring a strategy studio-product does not run.

### 4. Which strategy a product is assembled by

- **Offered**: the strategies the installed kits provide. The organization's
  default picker lists only them; there is no "Studio's default" choice.
- **Nobody chose**: `spec_mapping` when it is installed, else the only strategy
  installed. With exactly one installed it is the default with nothing to choose.
- **None installed**: the product is assembled by hand in the configurator. The
  read answers `strategy: "manual"`; the panel proposes nothing, says so and
  points to Kits.
- **A choice whose kit went** (a project's or the organization's) falls back,
  `spec_mapping` first, else by hand, with `KIT_NOT_INSTALLED`, as ADR-0072 did for
  the matcher. Choosing a strategy whose kit does not apply is refused with
  `KIT_NOT_INSTALLED` naming it, for a project and for the organization's default.
- While the installed kits cannot be read, `spec_mapping` is assumed (free and
  deterministic) and `gears_matcher` is refused with `KIT_UNKNOWN`.

The usage statistics on Organization › Gears matcher count projects by these
strategies, `manual` included (design §9).

## Amendment (2026-11-19): the open questions answered, and plug-in strategies

The owner answered yes to the three open questions this record had.

### A. The capabilities and requirements tools go back to the Project model

`project_capabilities` and `project_requirements` read what a project's documents
say, not the plan, so they are the Project model's (`project-domain-model`) again,
which also names `GET /studio-spec-mapping/v1/capabilities` and `GET .../requirements`
among its reads. The routes stay open, as §1 has them: Tests reads them.
Spec mapping keeps `project_plan` and `project_findings`.

### B. The mapping decisions are Spec mapping's

The gear type `mapping-decision` (studio-artifact-ingest's) moves from the Product
kit's claims to Spec mapping's. Nothing is renamed, so no alias is involved: the
`kit-rename` sweep (ADR-0071 §8) moves a stored `meta.kit = project-product` on the
type to `spec-mapping`, because the built-in kits' owners table now says so
(`owners.rs`), on its first pass after start or at the organization's next
reconciliation. Where Spec mapping does not apply the type is **dormant**, left by
it: a person's write is refused (and `POST decisions` answers `KIT_NOT_INSTALLED`
already), the gear keeps writing through its own path, and **every decision row
stays, readable**: nothing is deleted, and installing the kit again wakes the type
with the same rows. Uninstalling Product no longer touches them, and no Product read
depends on them (the plan that ranks by them is Spec mapping's own read). Spec
mapping now has a model in the ADR-0070 §5 sense (one claimed type, no overlay);
its install and uninstall reconcile it as any claiming kit's do.

### C. An organization's kit may provide a strategy a service runs

A kit's `assembly_strategy` may declare `service: {contract: "gears-matcher/v1"}`:
a plug-in service runs the strategy, with no code of it inside Studio. The contract
is the gears-matcher's API (`gears-matcher/schemas/service/matcher-service.openapi.yaml`:
`GET /v1/info`, `POST /v1/runs` with an `Idempotency-Key`, `GET /v1/runs/{id}`,
`GET /v1/runs/{id}/report`, `POST /v1/runs/{id}/cancel`, a bearer).

- **The manifest section is checked** when a kit is put on an organization's shelf
  (and for every built-in kit): the contract is one Studio speaks
  (`STRATEGY_CONTRACTS`); a strategy without `service` is only Spec mapping's
  `spec_mapping`; `spec_mapping` and `gears_matcher` stay their kits' ids; and a
  service strategy's kit **requires `gears-matcher`**, whose gear-match routes,
  screens and Inbox run and read every service strategy (its claimed writes answer
  `KIT_NOT_INSTALLED` without it). Built-in Gears matcher declares
  `service: {contract: "gears-matcher/v1"}` too: `gears_matcher` is the first
  instance, not a special case.
- **The organization binds the endpoint and the secret as a connection**, never in
  the manifest: a new connection kind `assembly-service` (driver
  `assembly-service-connector-plugin`, in `KNOWN_DRIVERS`, category `service`) with
  one option, `strategy`, the id it serves. Verifying it asks `GET /v1/info` with
  the secret. Organization › Gears matcher offers the connect form per strategy;
  the secret goes to credstore like any connection's. Like every connection's
  address it must be public HTTPS (`url_guard`). A person's own connection never
  serves a strategy: a match runs for everybody in the project.
- **studio-product runs it through the same pipeline** (client, task, report,
  decisions), keyed by the strategy id: matches carry their `strategy`
  (`m0005`; earlier rows are `gears_matcher`), `POST/GET gear-matches` take
  `?strategy=` (default `gears_matcher`), and the run asks for the strategy's
  service: the organization's connection, else, for `gears_matcher` only, the
  deployment's `config.gears_matcher` as before. The members' decisions and
  answers stay per project, shared across strategies (a decision is about a gear
  for a requirement, whoever proposed it).
- **Offered** where the kit applies (`KitPresence::strategies` reads an
  organization's own kit's manifest at its pin). Without a connection the strategy
  falls back with `STRATEGY_NOT_CONNECTED` and its sentence, as `gears_matcher` does
  with `MATCHER_NOT_CONFIGURED`.
- **The Organization page** shows one service block per service strategy (live
  `/v1/info`, cached 30 s per organization and strategy; its runs and model use in
  the period), and the usage statistics count runs and tokens per strategy.

## Consequences

- Good, because an organization decides which ways of assembling it uses, and the
  choice is the kits it installs, as for everything else in Studio.
- Good, because a third strategy is a kit with one section in its manifest and a
  runner in studio-product, not an edit of a list.
- Good, because nothing changes for an organization that does nothing: the kit is
  a base kit, and its default is what Studio's was.
- Bad, because `removed_base` is a second way a base kit stops applying (the
  platform's `removed_builtin` is the first); it is limited to the kits listed in
  `ORGANIZATION_REMOVABLE_BASE`.
- Bad, because an organization without the kit loses the plan on Components and
  the domain-model tools; that is what uninstalling it means.

## Confirmation

- `kit_registry`: `spec-mapping` is built in, a base kit, claims the four tools and
  the decision route; an organization uninstalls it for itself and takes it back
  (`installed_tests.rs`); the manifest section is checked (`manifest.rs`).
- `product::assembly`: the resolution from the installed strategies — both, one,
  none, a choice whose kit went, unknown kits (`assembly_tests.rs`).
- `product-mfe`: the panel by hand, with one strategy and with two; the
  organization page lists only installed strategies; Components without the plan.

## Open questions

- Answered by the amendment: `project_capabilities` and `project_requirements` are
  the Project model's (§A); `mapping-decision` is Spec mapping's (§B).
- Whether the Gear match tab should offer a strategy picker where an organization
  has more than one service strategy (today it shows `gears_matcher`'s matches;
  another strategy's are run and proposed from Project › Product).
- Whether a second contract (a strategy speaking something other than the
  gears-matcher's API) is worth a second client.
