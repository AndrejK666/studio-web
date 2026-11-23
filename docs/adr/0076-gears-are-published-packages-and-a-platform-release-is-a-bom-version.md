---
type: adr
status: proposed
date: 2026-11-23
---

# ADR-0076: Gears are published packages; a platform release is a BOM version

**ID**: `cpt-studio-adr-gears-are-packages`

Status: **proposed** · Date: 2026-11-23 · Refines `cpt-studio-adr-one-platform-release` (ADR-0075: what the release file names) · Amends `cpt-studio-adr-gear-repositories` (ADR-0046: a gear source can be a registry) · Design: `cpt-studio-design-gears-as-packages`

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [1. A gear is a package with its passport](#1-a-gear-is-a-package-with-its-passport)
  - [2. Two registries, a name in one](#2-two-registries-a-name-in-one)
  - [3. A platform release is a BOM version](#3-a-platform-release-is-a-bom-version)
  - [4. Nothing reads a corpus](#4-nothing-reads-a-corpus)
  - [5. Versions](#5-versions)
- [Consequences](#consequences)
- [Confirmation](#confirmation)

<!-- /toc -->

## Context and Problem Statement

ADR-0075 put every pin of gears-rust and Gearbox in one file and checks that
they agree. Two of those pins name different kinds of thing:

- the platform crates Studio links are crates.io versions in
  `studio-backend/Cargo.lock`;
- the Gearbox corpus the catalogue, `product.gdl`, the matcher and the desktop
  read is a commit of a fork branch.

The gate can check that the pins agree with the file. It cannot check that the
commit *is* the release the lock links, and the drift between those two is
behind GBX0714 ("two copies"), the hand-placed lock anchor for
`cf-gears-rg-tr-plugin`, and the workaround for `weftgraph`.

The inventory of 2026-11-23
([gears as packages, inventory](../design/gears-as-packages-inventory.md))
found that the corpus is no longer needed for what it was kept for:

- gears-rust#4793 merged upstream on 2026-10-24;
- every gear crate published since 2026-10-28 carries its `gear.gdl`;
- all 25 gears-rust gears of Studio's product have the passport inside the
  version Studio's lock links;
- the corpus commit is *older* than the lock for every one of them.

## Considered Options

1. **Gears are packages; one BOM version is the platform release** (chosen).
   The package, read from a registry, is the one copy of a gear for every
   reader.
2. **Keep the corpus, generate it from the lock.** Check out, for each locked
   crate, the commit its `.cargo_vcs_info.json` names. This keeps checkouts,
   clones per reader and the 11 s catalogue read, and has no answer for
   organizations' gears.
3. **Only ADR-0075** with a stricter gate (the corpus's toolkit equals the
   lock's). This narrows the drift but keeps two kinds of pin and five readers
   of git.

## Decision Outcome

### 1. A gear is a package with its passport

A gear is distributed as a cargo package whose root holds `gear.gdl` beside
`Cargo.toml`. A package may hold several gears (`cf-gears-mini-chat` holds
three). Its catalogue key is the package name, or `<package>#<gear id>` when it
holds several. The engine keeps the gear id. A product's own gears (Studio's 47
in `cf-studio-backend`) are its own code, a `path(...)` source, and are not
packages.

### 2. Two registries, a name in one

- **`crates-io`** holds what upstream publishes.
- **`gears`** is a git index (`AndrejK666/gears-index`) with `.crate` files
  as GitHub release assets, published by a local script. It holds:
  - the gears upstream does not publish (7 gears, 17 crates today);
  - passports for crates.io packages without one (`cf-gears-passports`;
    today only `event-broker`);
  - the BOM.
- **An organization's private gears** go to a registry it chooses: Kellnr
  first, connected as a `gear-registry` (ADR-0046's connection, a new kind).

A package name exists in exactly one registry. Code is never republished
under a crates.io name.

### 3. A platform release is a BOM version

`cf-gears-platform` in `gears`, versioned `YYYY.M.N`, pins every gear, SDK and
toolkit crate of one upstream release train by exact version (`platform.toml`,
plus `=`-pinned optional dependencies as a cargo-level guard), and carries the
platform's `GEARS.md`. `platform-release.toml` names it in a `[platform]`
section. `[gears_rust]`, `[toolkit]` and `[gears_matcher]` are removed, and
everything they set is derived from the BOM: Studio's `Cargo.toml` versions,
`product.gdl`, and the Helm and compose values.

### 4. Nothing reads a corpus

- Gearbox builds its catalogue from the BOM and the registries. It reads
  passports from the `.crate` files and caches the result by package version.
- `gearbox generate` writes products whose gears are
  `{ version = "=X", registry }`.
- The component catalogue, the gears matcher and the desktop read the same
  BOM, by the same keys.
- `prepare` clones only the project's own repository.

### 5. Versions

- A version in `gears` is immutable and follows semver.
- Build metadata (`+fork.N`) and pre-releases (`-fork.N`) are not used to
  mark forks: cargo ignores the first when it resolves, and the second escapes
  `^` requirements, so a second copy gets linked.
- A fix to a crates.io crate that upstream has not released is a visible
  `[patch.crates-io]` to a fork commit in the product, never a registry
  version.
- A broken version is yanked, and the BOMs naming it are re-cut.

## Consequences

- The lock, the catalogue, the product and the matcher name the same thing,
  so the GBX0714 class, the lock anchor and the `weftgraph` workaround go
  away.
- A catalogue read is a cache lookup per package version after the first
  time.
- The fork of gears-rust shrinks from "the corpus" to the 17 crates upstream
  does not publish. It still has to be rebased and republished for each
  release train.
- GitHub release assets cannot serve private packages, so an organization's
  private gears need Kellnr (or a SaaS registry) before they can leave git
  sources.
- The engine fork gains the registry path (the design's E1–E17). Each change
  is an upstream PR.
- Documents and charts are not in packages. A passport's documents resolve to
  its source URL, and a chart it names must be inside the crate.

## Confirmation

- **Phase 1** (pilot: `rg-tr-plugin`, `admission-control`, `graph-storage`):
  - `gearbox catalogue` lists the three gears with no `--root`;
  - `gearbox generate` writes only version and registry dependencies;
  - GBX0713 reports three of three from registries.
- **Phase 2**: a Studioweb build composes on Dev with no corpus, and the
  `cf-gears-rg-tr-plugin` anchor is deleted.
- **Phase 3**: no deploy or compose file names a corpus.
