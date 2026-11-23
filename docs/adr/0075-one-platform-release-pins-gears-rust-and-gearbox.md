---
type: adr
status: proposed
date: 2026-11-23
---

# ADR-0075: One platform release pins gears-rust and Gearbox

**ID**: `cpt-studio-adr-one-platform-release`

Status: **proposed** · Date: 2026-11-23

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [1. The file](#1-the-file)
  - [2. Every other pin is derived](#2-every-other-pin-is-derived)
  - [3. The gate](#3-the-gate)
  - [4. Moving the platform](#4-moving-the-platform)
- [Consequences](#consequences)
- [Confirmation](#confirmation)

<!-- /toc -->

## Context and Problem Statement

Studio reads gears-rust and runs the Gearbox engine in many places, and each
place chose its own version: the crates in `studio-backend/Cargo.lock`, the
engine in three Dockerfiles, the desktop's engine archives, the corpus the
backend's catalogue reads on Dev and the stand (a branch, `feature/gearbox`),
the `gears-rust` source of `product.gdl`, and the gears matcher's catalogue
with the fixture Studio keeps of it. Nothing tied them together, so one of
them moved ahead of another and something broke on Dev, not in review:

- the corpus outran the engine twice (2026-10-17, 2026-10-23) and emptied the
  catalogue;
- `Cargo.lock` outran the corpus, and a build linked two copies of a platform
  crate (GBX0714);
- Studio's code outran the engine's reading of `#[toolkit::gear]`:
  `gts_publication(...)` (toolkit-macros 0.8) failed every Studioweb build with
  GBX0102;
- the desktop's engine hashes were left empty, so the desktop silently kept an
  older engine than the portal.

## Considered Options

1. **One release file, everything else derived and checked** (chosen).
2. Gearbox as the one catalogue and id that the matcher and the component
   catalogue read. It removes the last duplicate (matcher ids, directories),
   but its catalogue would still move with a branch; it is the step after this.
3. Gearbox as one pinned service, with Studio's passports generated. Larger,
   and only worth it if 1 and 2 leave pain.

## Decision Outcome

### 1. The file

`platform-release.toml` at the repository's root says, once:

- `[gears_rust]`: the repository and the **commit** the Gearbox corpus is read
  at -- never a branch;
- `[gearbox]`: the engine's repository, release, version, commit, and the
  SHA-256 of its Linux, Windows and macOS archives;
- `[toolkit]`: the `cf-gears-toolkit` version studio-backend links;
- `[gears_matcher]`: the commits the matcher's catalogue is read at.

### 2. Every other pin is derived

`node scripts/platform-release.mjs --write` writes them: the engine `ARG`s of
`studio-backend/Dockerfile`, `studio-backend/Dockerfile.src` and
`theia/Dockerfile` (with the desktop's hashes, which `gearbox-engine.yml` reads),
the corpus of `docker-compose.yml` and `deploy/helm/values-dev.example.yaml`,
the toolkit in `studio-backend/Cargo.toml`, and the `gears-rust` source of
`product.gdl` (which `scripts/product-gdl.mjs` also writes from the file).
`Cargo.lock` (cargo writes it) and the matcher's fixture (a snapshot of its
catalogue) are checked, not written. The matcher's own Helm values live with the
matcher and follow `[gears_matcher]` by hand until the matcher is in this
repository's deploy.

### 3. The gate

`node scripts/check-platform-release.mjs` fails when any pin disagrees with the
file, when a commit is a branch or a short id, or when a desktop hash is empty.
`gearbox-engine.yml` fails, instead of skipping a platform, when a hash is
empty. CI runs the check with the documents' checks.

### 4. Moving the platform

A change of the file is one pull request: set the new values, run
`--fetch-sha256 --write` for an engine release, then prove the engine reads the
corpus and composes Studio's own product with `gearbox generate` -- no error,
and no GBX0714 "two copies" warning, which a cluster build refuses. Real
environment values outside the repository (Dev's Helm values) follow the
example file in the same change.

## Consequences

- A drift between the engine, the corpus, the lock and `product.gdl` is a red
  pull request, not a broken catalogue or build on Dev.
- Moving the platform is an explicit step; nothing follows a branch on its own.
- While gears-rust#4793 is open, the corpus is a commit of a fork branch, and
  matching it to the crates.io release in `Cargo.lock` stays a manual judgement
  the gate cannot make: it checks that the pins agree, not that the corpus's
  toolkit equals the lock's.

## Confirmation

`node scripts/check-platform-release.mjs` passes on `main`, and
`node --test scripts/platform-release.test.mjs` shows it refuses a branch, an
empty desktop hash and a drifted pin.
