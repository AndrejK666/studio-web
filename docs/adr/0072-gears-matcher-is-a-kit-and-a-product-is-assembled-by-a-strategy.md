---
type: adr
status: proposed
date: 2026-11-18
---

# ADR-0072: The gears matcher is a kit of its own, and a product is assembled by a strategy

**ID**: `cpt-studio-adr-gears-matcher-kit`

Status: **proposed** · Date: 2026-11-18 · **Amended by** [ADR-0074](0074-spec-mapping-is-a-kit-and-strategies-come-from-kits.md) (§3–§4: `spec_mapping` is the Spec mapping kit's, and the strategies offered are the installed kits') · Builds on ADR-0068 (Studio is a shell; kits), ADR-0071 (a kit claims its gear's tools and write routes; `requires`; built-in kits cut by function) · **Amends** ADR-0071 §6 (the Product kit no longer stands for gear matches; a fourteenth built-in kit) · Design: [`docs/design/product-gear-match.md`](../design/product-gear-match.md)

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
  - [Where gear matches belong](#where-gear-matches-belong)
  - [How the matcher joins the product's assembly](#how-the-matcher-joins-the-products-assembly)
  - [Where the choice is kept](#where-the-choice-is-kept)
- [Decision Outcome](#decision-outcome)
  - [1. The Gears matcher kit](#1-the-gears-matcher-kit)
  - [2. What moves out of the Product kit](#2-what-moves-out-of-the-product-kit)
  - [3. The assembly strategy](#3-the-assembly-strategy)
  - [4. Default and override](#4-default-and-override)
  - [5. Interfaces](#5-interfaces)
- [Consequences](#consequences)
- [Confirmation](#confirmation)
- [Open questions](#open-questions)

<!-- /toc -->

## Context and Problem Statement

The gears-matcher service reads a project's specifications and says, requirement by
requirement, which gears of the catalogue cover it. Studio asks it through studio-product
(`gear_match`): a run, a kept report, decisions, answers, an Inbox source and two MCP
tools. The Product kit (`project-product`, ADR-0071 §6) claimed all of it, and its Product
page showed it as one more section, Gear match.

That made the matcher part of every organization's product, although it is an optional,
paid service that most deployments do not run: without it the section answered 503 for
everybody. And it stood beside the product's assembly without joining it. The gears a
product is made of were proposed only by studio-spec-mapping's plan (the Functional
Requirements' capabilities, matched by words and contracts), and the matcher's proposals
were a second list the person carried over by hand, gear by gear.

The question: **how does the matcher become something an organization chooses, and how
does a product get assembled with it, or without it, by choice and with a default?**

## Considered Options

### Where gear matches belong

1. **Stay in the Product kit**, gated at run time by the service's configuration. No kit
   change, but every organization sees a tab that answers 503, and the matcher cannot be
   switched off for one organization while another uses it.
2. **A kit of its own, opt-in, that requires the Product kit**, with the code staying in
   studio-product. The claims (ADR-0071 §1) move, the code does not.
3. **A gear of its own** (studio-gear-match). The design (§1 of the design document)
   already rejected it: the match has no data that outlives the product, and every action
   would need a port back into the product.

### How the matcher joins the product's assembly

1. **Replace spec-mapping by the matcher where it is installed.** Loses the instant, free,
   deterministic plan, which the Components tab and the product map also draw from.
2. **Feed the matcher's verdicts into spec-mapping's decisions.** They share no key
   (a capability against a requirement id; design §4).
3. **Two strategies side by side, one chosen per project.** Each strategy only proposes
   picks; the engine's completion and the person's confirmation stay the one way gears
   enter the product.

### Where the choice is kept

1. **The project's configuration** (account-management metadata). Per project only; an
   organization default would need a second store.
2. **A domain-model tenant document** (`model_metadata`). Brings a held type, a claim and
   the PDP's held-metadata list for two values.
3. **A table in studio-product's own database**, beside the gear matches: one row for the
   organization's default, one per project that chose.

**Chosen:** a kit of its own (2), two strategies (3), kept in the gear's database (3).

## Decision Outcome

### 1. The Gears matcher kit

A fourteenth built-in kit, `gears-matcher` ("Gears matcher"):

- **Opt-in** (`OPT_IN_BUILTIN`), as `constructor-research` is: in the library, installed
  nowhere until an organization (or one project) installs it, or a platform administrator
  makes it a base kit.
- **Levels** organization and project. **`requires: ["project-product"]`**: its
  proposals go into the product, whose completion and save are the Product kit's.
- **No model.** It claims no type: gear matches are rows of studio-product's database,
  not domain objects. Its install and uninstall change no organization's model, so the
  ADR-0070 §5 equality check and the ADR-0071 §8 `kit-rename` sweep see nothing.
- **Screens**, the second entry of `product-mfe`: Project › Gear match (`/gear-match`,
  until now a section of Project › Product) and Organization › Gears matcher
  (`/gears-matcher`), the service's state and the organization's default strategy.
- **Claims** (ADR-0071 §2) on `studio-product`: the MCP tools `project_gear_match` and
  `project_gear_match_report`; the write routes `POST gear-matches`,
  `POST gear-matches/{match_id}/cancel`, `PUT gear-match-decisions`,
  `PUT gear-match-answers` and `PUT assembly-strategy` (the organization's default).
  Where the kit does not apply they answer `KIT_NOT_INSTALLED` naming it, by the one
  shared check (ADR-0071 §4). Reads stay open.
- **Inbox:** the endpoint source `gear-match-questions`.

### 2. What moves out of the Product kit

The Product kit keeps the product: its map, configurator, description, frontend and
Components, and the assembly strategy's project-level read and write (§5). It gives the
Gears matcher kit the four gear-match write routes and the two tools it claimed, the Inbox
source, and the Gear match section of its page.

**This is a split, not a rename.** No slug is retired, so the alias table of ADR-0071 §8
does not change, `migrate` finds nothing to rewrite, and no installation document gets a
`renamed` or `shown_again` report. What an organization sees changes in one way only, and
by design: Gear match is no longer on the Product page; it comes back as its own tab where
the Gears matcher kit is installed. A member who opens `/gear-match` without it gets the
shell's "comes with a kit" screen, as for any kit not installed. No mechanism was added for
it.

### 3. The assembly strategy

How a project's product is assembled is one of two strategies. Either only **proposes**
gears; the engine's completion (`POST /gearbox/complete`) shows what they bring, and the
person's confirmation saves them into the product. Nothing is applied silently (design §3).

| Strategy | Proposes | Cost |
|---|---|---|
| `spec_mapping` | per capability the specifications name that no pick answers, the first gear spec-mapping's plan offers with a contract, a declaration or a member's confirmation behind it, built and in the catalogue the product reads | instant, free, deterministic |
| `gears_matcher` | every gear the project's latest finished gear match proposes that nobody rejected and that the catalogue holds; the decisions are recorded `accepted` when the person confirms | a match run: minutes, paid model calls, varies between runs |

`gears_matcher` is **offered** only where the Gears matcher kit applies and the service is
configured (the gear-match routes' 503 check). Where it is chosen but not offered, the
product is assembled by `spec_mapping`, and the read says why: `fallback.code` is
`KIT_NOT_INSTALLED`, `KIT_UNKNOWN` (the kits could not be read) or
`MATCHER_NOT_CONFIGURED`, with a sentence.

### 4. Default and override

> **Amended by [ADR-0074](0074-spec-mapping-is-a-kit-and-strategies-come-from-kits.md).** The
> strategies offered are the ones the installed kits provide (`spec_mapping` is the Spec
> mapping kit's, a base kit by default); nobody's choice is `spec_mapping` when installed,
> else the only strategy installed, else the product is assembled by hand. There is no
> "Studio's default" choice on the organization page any more.

- **Studio's default** is `spec_mapping`.
- **The organization's default** is set on Organization › Gears matcher by an organization
  or platform administrator (`kit.manage`, the privilege that installs kits). It is the
  Gears matcher kit's setting: its write is claimed by that kit.
- **A project's choice** ("organization default", `spec_mapping` or `gears_matcher`) is
  made on Project › Product beside the header's action. Choosing `gears_matcher` where the
  kit does not apply is refused with `KIT_NOT_INSTALLED`; choosing it where the service is
  not configured is kept, and falls back until it is.
- The effective strategy is: the project's choice, else the organization's default, else
  Studio's; then the fallback of §3.
- Kept in `studio_product_assembly_strategies` (`m0004`): one row per organization default
  (`scope_id` = the organization) and per project choice, keyed by the organization the
  project hangs under. Without the gear's database every read answers Studio's default
  with `settable: false`, and the writes answer 503.

### 5. Interfaces

| Method | Path | Claimed by |
|---|---|---|
| `GET` | `/studio-product/v1/project-assembly-strategy` | read |
| `PUT` | `/studio-product/v1/project-assembly-strategy` | `project-product` |
| `GET` | `/studio-product/v1/assembly-strategy` (`?organization_id=`) | read |
| `PUT` | `/studio-product/v1/assembly-strategy` | `gears-matcher` |

The read answers `strategy` (used), `chosen`, `source` (`project`, `organization`,
`studio`), `project`, `organization_default`, `fallback`, `gears_matcher`
(`kit_installed`, `configured`, `missing`, `offered`), `settable` and `may_set_default`.
It is its own route rather than a field of `GET projects/{project_id}/product`: that read
is on every product screen's path, and the strategy costs a kit and a database read the
others do not need.

MCP: `product_assembly_strategy` (the read; the Product kit's).

## Consequences

- Good, because an organization without the service no longer has a Gear match section
  that answers 503, and one that wants it installs one kit.
- Good, because the matcher's proposals reach the product the same way spec-mapping's do:
  proposed, completed by the engine, confirmed.
- Good, because the choice is data: an organization's default, a project's override, and
  the reason the product falls back, all readable by the portal and agents.
- Good, because no gear moved: the claims did, and ADR-0071's checks hold them.
- Bad, because an organization that used Gear match before this change finds it gone from
  the Product page until it installs the kit. Nothing is lost: the matches stay in the
  gear's database and reappear with the kit.
- Bad, because `spec_mapping`'s proposal rule (first strong, built candidate per
  uncovered capability) is new and simple; the plan may name several equally good gears.

## Confirmation

- `kit_registry`: the built-in catalogue lists `gears-matcher`, opt-in, with its two
  screens, two tools, one Inbox source and `requires`; the claims tests hold every
  gear-match tool and write route to exactly one kit.
- `product::assembly`: the resolution (project over organization over Studio; fallback
  with its code) and the store against PostgreSQL.
- `product-mfe`: the strategy panel (choice, fallback, propose and confirm for both
  strategies) and the proposal rules.

## Open questions

- Whether `spec_mapping`'s proposals should become the Components tab's "add the
  recommended gears" too, so there is one rule.
- Whether a project's choice should need more than reaching the project (today any member
  who may save the product may choose its strategy).
