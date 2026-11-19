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
project, no `requires`, no model (it claims no type; `mapping-decision` stays the
Product kit's type, so an install or uninstall changes no organization's model).
As with ADR-0072 only ownership moves; studio-spec-mapping's code stays where it is.

- **Claims** (ADR-0071 §1) on `studio-spec-mapping`: the MCP tools
  `project_capabilities`, `project_findings`, `project_plan`,
  `project_requirements` (until now `project-domain-model`'s) and the write route
  `POST /studio-spec-mapping/v1/decisions` (until now `project-product`'s).
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

- Whether `project_capabilities` and `project_requirements` belong to the Project
  model kit rather than to Spec mapping: they read what the documents say, not
  the plan.
- Whether `mapping-decision` should become the Spec mapping kit's type.
