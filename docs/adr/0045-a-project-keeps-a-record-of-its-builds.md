---
type: adr
status: proposed
date: 2026-10-14
---

# ADR-0045: A project keeps a record of its product's builds; the portal manages them and does not build

**ID**: `cpt-studio-adr-project-builds`

Status: **proposed** · Date: 2026-10-14 · Feeds `cpt-studio-adr-deployment-environments` (what a deploy takes) · Uses `cpt-studio-adr-studio-events-push-channel` (how the IDE reports a build)

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [1. A build](#1-a-build)
  - [2. Where builds come from](#2-where-builds-come-from)
  - [3. The project's Builds tab](#3-the-projects-builds-tab)
  - [4. Starting a build, and taking one to Deploy](#4-starting-a-build-and-taking-one-to-deploy)
- [Consequences](#consequences)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

A project goes from its documents to a product: the Product tab picks the
gears, Gearbox generates the product, and something builds it. ADR-0043 then
deploys "this product, at this commit, built into these images" to an
environment.

The step in the middle is invisible to Studio:

- **A build in the IDE stays on the member's machine.** Build and Run in the
  desktop's Generate view run `cargo` in a terminal. When the build fails --
  on 2026-10-13 a member's build stopped at "Could not find protoc" -- nobody
  else knows, and the next member hits the same wall.
- **CI runs are not read.** The artifact sync reads a project's issues, pull
  requests and commits. It does not read the workflow runs on them, so the
  portal cannot say whether `main` builds.
- **Deploy has nothing to choose from.** ADR-0043 takes images that "come
  before the deploy, from CI or the desktop". No record says which images a
  commit was built into, or whether that build passed.

The portal is not where code compiles: a session or a desktop builds, and so
does CI. What is missing is a place that knows what was built, where, and with
what result.

## Considered Options

1. **Builds are records the portal keeps.** CI and the IDE build; each build
   is reported and kept as a record of the project's product. The portal shows
   them, starts a build in CI or opens one in the IDE, and hands a good one
   to Deploy.
2. **The portal builds.** A backend task checks out the project and runs
   `cargo build` and `docker build`.
3. **Only CI, read through.** The portal links to the repository's CI and
   reads nothing.

## Decision Outcome

Chosen option: **1, builds are records the portal keeps.**

Option 2 puts a Rust toolchain, Docker and the product's build time into the
backend; ADR-0043 already decided the backend does not build products.
Option 3 leaves out the builds that fail most often, the ones on a member's
machine, and gives Deploy nothing to choose from.

### 1. A build

A build belongs to the **project's product**, not to a repository: a project
can have several repositories, and it has one product.

| Field | Meaning |
|---|---|
| commit, branch | what was built, in the repository the product lives in |
| product | the `product.gdl` revision and the lock hash: which gears, at which versions |
| where | `ci` (with the workflow and run), `desktop` (whose machine) or `session` |
| who | the member who started it; for CI, the commit's author or the dispatcher |
| status | `running`, `passed`, `failed` or `cancelled` |
| started, finished | when |
| failure | the first error, when it failed: a line, and the step it was in |
| outputs | the images it pushed, with their tags or digests |
| link | the CI run's page, or nothing for a local build |

A build is a record, written by what reported it and never edited. Builds are
kept per project, newest first.

### 2. Where builds come from

- **CI.** The artifact sync reads the workflow runs of the project's
  repositories, beside the pull requests and commits it reads already, as a
  new kind of artifact. A run that builds the product's images is a build
  (its workflow is named in the project's settings, or found by the images it
  pushes). Read only; nothing in the repository changes.
- **The IDE.** Build and Run in the desktop and in a session report a build's
  start and end through the Studio events channel (ADR-0026): the commit, the
  product revision, the result, and the first error. The member's machine
  sends only that; the build output stays on it.

### 3. The project's Builds tab

Between Product and Kits, in the order the work goes: what the product is
made of, what was built, where it runs.

- One row per build: commit and branch, product revision, where, status,
  duration, outputs.
- A failed build shows its first error, so the next member does not have to
  rebuild to find it.
- The tab says what the newest build of `main` is, passed or not.

### 4. Starting a build, and taking one to Deploy

- **Build** starts the project's CI workflow (`workflow_dispatch`, through
  the repository's connection), or opens the product in the IDE to build
  there.
- **Deploy** on a passed build with outputs opens ADR-0043's deploy with
  those images, that commit and that lock hash. A deploy names the build it
  came from.

## Consequences

- Good: a failed build on one machine is visible to the team, with its error.
- Good: Deploy chooses a build, not a tag typed by hand.
- Good: the portal stays out of compiling; CI and the IDE keep doing it.
- Bad: the artifact sync reads more: workflow runs are frequent. It reads
  only the ones that build the product, and only as far back as it reads
  commits.
- Bad: a desktop that is offline reports nothing, and a build it ran is not
  in the record. The IDE sends the report when it reconnects.
- Bad: which CI workflow builds the product is a project setting someone has
  to make, until the generated product ships its own workflow.

## More Information

**Phases:**

1. **CI runs in the sync, and the Builds tab, read only.** Nothing in the
   IDE changes, so this shows the moment it is deployed. *Built.*
2. **Builds reported by the IDE**, desktop and session. *Built: Build and
   Run in the Generate view read how the build ended off their terminal
   (`gearbox-studio` `common/build-report.ts`: cargo's `Finished`, `Running`,
   `error: could not compile`, the first `error` line, a missing protoc) and
   report its start and end through the Studio extension
   (`gearbox-build-reports.ts`) to
   `POST /studio-artifact-ingest/v1/projects/{id}/builds`, a `build` node per
   build; the Builds tab lists them under "In the IDE", a failed one with its
   first error. Reported over REST rather than the events channel: the
   channel carries the portal's pushes to the IDE, and a report needs an
   answer. Outputs are not read yet: the IDE does not know which images a
   build pushed.*
3. **Build and Deploy actions**: dispatch CI, open in the IDE, hand a passed
   build to Deploy. *Built: the project's build workflow is a setting
   (`project.config` `build`, `{repo, workflow}`), made from the Builds tab;
   **Build in CI** dispatches it (`workflow_dispatch`) through the connection
   of that project repository, the organization's own only; **Open in the
   IDE** opens the project. Deploy stays in the IDE's Generate view, which
   makes the chart a deploy needs; a deploy from there names the newest
   build that passed at that commit (`build` on the deployment, ADR-0043).
   Left: a portal Deploy of a CI build, which needs the chart from CI's
   outputs.*

**From the engine:** a generated product that carries its own CI workflow
(build, push to the environment's registry) would make phase 1 work without
a setting. That belongs beside the build context ADR-0043 asks the engine
for (constructorfabric/gearbox#8).

## Traceability

- **PRD**: [PRD](../prd/constructor-studio.md)
- **DESIGN**: [DESIGN](../design/studio-artifact-ingest.md)

This decision directly addresses the following requirements or design elements:

* `cpt-studio-adr-deployment-environments`
* `cpt-studio-adr-studio-events-push-channel`
