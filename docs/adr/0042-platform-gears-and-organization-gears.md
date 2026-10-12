---
type: adr
status: proposed
date: 2026-10-12
---

# ADR-0042: Platform gears and an organization's own gears

**ID**: `cpt-studio-adr-platform-and-organization-gears`

Status: **proposed** · Date: 2026-10-12 · Extends `cpt-studio-component-components-catalog` and `cpt-studio-component-product` · Builds on ADR-0041 (an organization's registry of its components), which it needs for the organization half

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [1. Two levels of gears](#1-two-levels-of-gears)
  - [2. The platform catalogue is server data, kept by the root tenant](#2-the-platform-catalogue-is-server-data-kept-by-the-root-tenant)
  - [3. An organization sees the platform and its own gears](#3-an-organization-sees-the-platform-and-its-own-gears)
  - [4. An organization may override a platform gear](#4-an-organization-may-override-a-platform-gear)
  - [5. A product picks a version of each gear](#5-a-product-picks-a-version-of-each-gear)
  - [6. Publishing to the platform is reviewed](#6-publishing-to-the-platform-is-reviewed)
  - [7. The engine's corpus follows the catalogue](#7-the-engines-corpus-follows-the-catalogue)
  - [Consequences](#consequences)
  - [Confirmation](#confirmation)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

Studio assembles a product from specs out of gears, and creates a gear where
the specs need one nobody has. Constructor Fabric plays two parts here. It owns
the platform's gears (`constructorfabric/gears-rust`, `gears-frontx`, the kits),
and it is an organization that makes gears, like any other. Every
organization should be able to build on the platform's gears, make its own,
or do both.

The code knows only one level, the organization:

- The catalogue is one per tenant. `catalog.sync` runs as the caller's
  tenant (`components_catalog/rest.rs`, "One catalog per tenant") and writes
  tenant-scoped graph nodes. Nothing is inherited from the root tenant. Only
  field schemas are layered, and only over built-ins.
- The platform's gears are no shared dataset. The prototype pre-fills
  `gears-rust`, `gears-frontx` and two kits as catalogue sources, but in the
  browser's localStorage (`components-catalog.tsx`, `cf.components.sources`),
  off by default. So each organization syncs the platform into its own graph,
  by hand, from one person's browser.
- The Gearbox engine has one corpus per backend process
  (`product/gearbox.rs`). It is hardcoded to `MikeFalcon77/gears-rust` at
  `feature/gearbox`. `adopt_if_described` repoints it to whichever gears repo
  any organization's sync finds with `gear.gdl` files, so one organization
  can change what every other one previews. This is read from the code and
  has not been reproduced.
- `product.gdl` has one source (`source(id = "gears-rust", at = <rev>)`) and
  `use_gear(id, source = "gears-rust")` for every gear. A project's or an
  organization's gear cannot be composed beside a platform gear. A product
  gets whatever versions of gears that one commit holds.
- An organization's own gears are found (project gears, #700), but are not
  kept. ADR-0041 proposes the registry that keeps them. Its last phase, P4,
  is publishing to the shared corpus, as a separate act.

## Considered Options

1. **One catalogue per organization, as today.** Each organization syncs
   whatever it likes, the platform included. Simple. But there is no
   platform: every organization has its own copy of it, at its own moment,
   and nothing says which gears are the platform's.
2. **One global catalogue for everyone.** Simple to read. An organization's
   own gears then become visible to all, or need per-row visibility, which
   puts the PDP in front of every catalogue read.
3. **Two levels.** The platform catalogue is kept once, by the root tenant.
   Each organization keeps its own gears (ADR-0041). A read inside an
   organization returns both, marked by level.

## Decision Outcome

Chosen option: **3**.

### 1. Two levels of gears

- **Platform gears** belong to the root tenant. They come from sources a
  platform administrator configures (`gears-rust`, `gears-frontx`, the kits,
  crates.io by keyword). Every organization sees them, read-only.
- **Organization gears** belong to one organization. They are the gears its
  projects build and its registry keeps (ADR-0041), plus repositories the
  organization adds as sources of its own. Only that organization sees them.

Constructor Fabric's own work on `gears-rust` is platform work. The repository
is a platform source. A gear Constructor Fabric builds in one of its projects
is an organization gear until it is published (§6), the same as anyone else's.

### 2. The platform catalogue is server data, kept by the root tenant

Catalogue sources move from the browser to the server, at two levels:

- the root tenant's sources, which define the platform;
- each organization's sources, which ADR-0041 already moves to the server.

A scheduled sync keeps the platform catalogue current, and a platform
administrator can also run it on demand. An organization never syncs the
platform into its own graph again. The prototype's `DEFAULT_SOURCES` go away.

### 3. An organization sees the platform and its own gears

A catalogue read in an organization returns the platform's gears and the
organization's gears. Each row carries `level: platform | organization`.
Spec mapping (`cpt-studio-component-spec-mapping`) ranks candidates from both
levels. On a tie, it prefers the organization's own gear, because that is
the one the organization has chosen to own.

### 4. An organization may override a platform gear

An organization can fork a platform gear, which makes an organization gear
with the same gear id and a recorded `overrides: <platform gear>@<version>`.
Inside that organization, the override replaces the platform gear in
mapping and composition. Every other organization keeps the platform one.
The catalogue shows both, and how far the fork has fallen behind the
version it forked.

### 5. A product picks a version of each gear

A product no longer takes "whatever one commit of the corpus holds". Each
gear a product uses is pinned to a version of its own:

- a platform gear, to a released version: a crates.io version or a release
  tag of its source repository;
- an organization gear, to a tag or commit of the organization's repository.

`product.gdl` therefore names one `source` per repository a product draws on,
and each `use_gear` names its source and the version. Upgrading one gear in a
product is a recorded decision, like any other product change.

### 6. Publishing to the platform is reviewed

An organization gear reaches the platform only by publication: a request
from the organization, reviewed by a platform administrator or by a person
holding a platform role for this (`platform-gear-curator`, granted by a
platform administrator). Approving it adds the gear's repository at a version
to the platform's sources. Rejecting it records the reason. Until then, the
gear stays the organization's. This is ADR-0041's P4, with its reviewer
named.

### 7. The engine's corpus follows the catalogue

The Gearbox engine no longer has one corpus per process:

- The platform corpus is the root tenant's platform sources, at their
  pinned versions, read from configuration, not hardcoded.
- An organization's previews read the platform corpus plus that
  organization's sources.
- No sync swaps a corpus for everybody. `adopt_if_described` is removed.

### Consequences

- There is one platform catalogue, current, with a name and an owner. An
  organization starts with the platform's gears and no setup.
- An organization's gears stay private until published, and publishing has an
  accountable reviewer.
- Products are reproducible per gear: a product's `product.gdl` says exactly
  which version of each gear it is built from.
- The platform's sources are configured once, so the hardcoded corpus URL and
  branch go away.
- New dependencies:
  - the Gearbox engine has to accept several sources and a version per
    `use_gear`. To be confirmed in the engine; if it cannot, that is
    gearbox work, and it comes first;
  - a released version of a platform gear has to exist (crates.io or tags)
    for a product to pin it.
- Graph reads gain a second tenant (the root) for catalogue nodes. The PDP
  is not involved: the platform level is readable by every authenticated
  member, and the organization level by its members, as today.

### Confirmation

The decision holds when, on the stand:

1. An organization that has synced nothing sees the platform's gears, marked
   `platform`.
2. A gear one organization registers is invisible to another.
3. A product composed from one platform gear and one organization gear
   validates in Gearbox, with a version on each `use_gear`.
4. A forked platform gear replaces the original in its organization's
   mapping and nowhere else.
5. A publication approved by a platform administrator makes the gear appear
   in a second organization's catalogue.
6. One organization's sync does not change what another previews.

## More Information

### Order of work

1. Remove the corpus swap (`adopt_if_described`) and read the platform
   corpus from configuration. This is small and stands alone.
2. Platform sources on the server at the root tenant, with a scheduled sync,
   and catalogue reads returning both levels.
3. ADR-0041 P1–P3, which give the organization level its kept registry.
4. Several sources and per-gear versions in `product.gdl`, after the engine
   check.
5. Overrides (§4).
6. Publication with review (§6, ADR-0041 P4).

Building and running an assembled product outside the IDE (today only the
desktop's `cargo build` / `cargo run`) is a separate decision.

### What this does not decide

- How a platform gear is released (crates.io, tags, or both). It decides only
  that a product pins a released version.
- Whether an organization can share gears with another organization without
  publishing to the platform.
- The catalogue UI in `studio-frontend`. Today it exists only in the
  prototype.

## Traceability

- **PRD**: [PRD](../prd/constructor-studio.md)
- **DESIGN**: [studio-components-catalog](../design/studio-components-catalog.md), [studio-product](../design/studio-product.md), [studio-spec-mapping](../design/studio-spec-mapping.md)

This decision directly addresses the following requirements or design elements:

* `cpt-studio-fr-gear-catalogue`
* `cpt-studio-fr-gearbox-product`
* `cpt-studio-fr-spec-gear-mapping`
* `cpt-studio-fr-gear-scaffold`
* `cpt-studio-component-components-catalog`
* `cpt-studio-component-product`
* `cpt-studio-component-spec-mapping`
