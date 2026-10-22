---
type: adr
status: proposed
date: 2026-10-22
---

# ADR-0047: A change is the unit that walks the delivery stages, and every object it rests on comes through a connection

**ID**: `cpt-studio-adr-change-unit`

Status: **proposed** · Date: 2026-10-22 · Issue #859 · Builds on `cpt-studio-adr-one-model-for-a-project` (ADR-0037: every fact has one owner, the graph holds the links) · Uses `cpt-studio-adr-deployment-environments` (ADR-0043), `cpt-studio-adr-gear-extraction` (ADR-0044) and `cpt-studio-adr-project-builds` (ADR-0045)

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [1. A change is anchored on a work item](#1-a-change-is-anchored-on-a-work-item)
  - [2. Studio speaks normalized objects, never a provider](#2-studio-speaks-normalized-objects-never-a-provider)
  - [3. Links come from the connections, in one vocabulary](#3-links-come-from-the-connections-in-one-vocabulary)
  - [4. What a change contains is derived, not declared](#4-what-a-change-contains-is-derived-not-declared)
  - [5. The route follows from what the gears can do](#5-the-route-follows-from-what-the-gears-can-do)
  - [6. A stage is judged for a change](#6-a-stage-is-judged-for-a-change)
  - [7. Where a change runs is computed from git](#7-where-a-change-runs-is-computed-from-git)
  - [8. Studio does not write links back](#8-studio-does-not-write-links-back)
- [Consequences](#consequences)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

Building software is iterative. A feature arrives, its documents are written,
its requirements become capabilities, the capabilities are met by gears that
already exist, by configuring them, by extending them or by a new gear; then
code, tests, a build and a deploy follow, and what production says comes back
as the next feature.

Studio stores most of these facts already, but nothing ties them to the
feature that caused them:

- **The delivery stages are judged for a whole project.** `builtin_stages()`
  (`documents/model.rs`) lists `intent` to `review` with `requires`, `gates`
  and `checks`, and an organization may add its own. `stage_status` is
  computed per request for `(workspace, project)`; there is no smaller scope
  (`documents/service.rs`).
- **The project's tabs show one kind of object each** (Specs, Product,
  Builds, Tests, Deploys…). No view shows one feature moving through them.
- **The links that would tie a feature together are missing.** The artifact
  graph has twelve edge types (`artifact_ingest/gts.rs`); none goes from a
  pull request to the issue it closes, and a pull request carries no head or
  merge commit. An issue's milestone and parent are read only by the roadmap
  report, outside the graph (`components_catalog/roadmap.rs`). A build knows
  its commit but not its pull request; a deployment knows its commit
  (`environments/model.rs`) but nobody asks which features that commit holds.
  There is no order between environments, only an approval on a protected one.
- **The composition keeps no history.** `project_product` is overwritten by
  merge-patch; only git keeps the history of `product.gdl`.
- **spec-mapping answers per capability for a whole project.** `POST /plan`
  accepts a list of capabilities, but nothing says which capabilities one
  feature adds.
- **Hypotheses live only in the prototype**, and the model's `Objective`
  (metric, target) links to nothing.

And these objects do not all live in GitHub. Work items may come from GitHub
or GitLab issues, Jira or YouTrack; documents from a repository or from
Confluence; pipelines from Actions, GitLab CI or Jenkins. The connector driver
contract (`connectors/driver.rs`) is already provider-neutral
(`RemoteIssue`, `RemotePullRequest`, `RemoteWorkflowRun`…), but its only
categories are `SourceCode`, `Ai`, `Notification`, `Cluster` and `Gears`:
an issue exists only as part of a repository, and a document only as a file.

## Considered Options

1. **A change: a unit derived from a work item, judged stage by stage, over
   objects that connections bring in.** Studio keeps the links, not a copy of
   the tracker.
2. **Studio's own tracker.** Features, states and transitions stored in
   Studio. Teams already have a tracker; a second one is either kept in step
   by hand or ignored.
3. **Keep the project as the unit, add filters to each tab.** Every tab
   learns its own idea of "this feature" (a label, a branch prefix), and the
   stages still cannot be judged for one feature.

## Decision Outcome

Chosen option: **1**.

### 1. A change is anchored on a work item

A **change** is a unit of delivery: a feature, a fix or a reconfiguration.
It is anchored on one **work item** from any connected tracker. A work item
with children (an epic and its sub-issues, a Jira epic and its stories) is a
change made of changes. A project without a tracker gets Studio-native work
items of the same type; the source is then Studio itself.

A change's identity is its work item's. Studio stores nothing about a change
that the work item or the objects linked to it already say.

### 2. Studio speaks normalized objects, never a provider

| Object | Comes from (examples) |
|---|---|
| Work item | GitHub or GitLab issues, Jira, YouTrack, Studio itself |
| Document and its revision | a file in a repository (revision: commit), a Confluence page (revision: page version) |
| Change request | GitHub pull request, GitLab merge request, Bitbucket pull request |
| Pipeline run | GitHub Actions, GitLab CI, Jenkins; IDE builds are reported to Studio (ADR-0045) |
| Deployment | studio-environments (ADR-0043), an external CD system |

An external object is known by `(connection, kind, native id)`. Its owner is
the ingest of its connection (ADR-0037). The connector categories grow two:
**`Tracker`** (work items) and **`Documents`** (documents outside a
repository). A source host may serve the tracker category too, as GitHub and
GitLab do today.

### 3. Links come from the connections, in one vocabulary

A driver returns an object together with its links, in a vocabulary Studio
owns:

| Link | Between | Read from (examples) |
|---|---|---|
| `closes` | change request → work item | GitHub closing references, GitLab `closes_issues`, Jira development panel |
| `references` | any → work item or document | mentions in a title, body, branch name or commit message |
| `parent` | work item → work item | sub-issues, epic links |
| `iteration` | work item → iteration | milestone, sprint, fix version |
| `documents` | work item → document | Jira and YouTrack links to pages |

Links cross systems: a GitHub pull request names `PROJ-123` from Jira. Each
driver says how its references are written (`#42`, `group/repo#42`,
`PROJ-123`); one resolver in Studio finds them in text and turns each into an
edge to the object of whichever connection owns it. A reference no connection
owns stays a dangling reference and is shown as one.

### 4. What a change contains is derived, not declared

Nobody fills in what a change contains. From its work item:

- **change requests**: those that `close` or `reference` it;
- **documents**: those its change requests modify, and those its work item
  links to;
- **requirements**: the sections that differ between the documents' revision
  before and after the change, whatever the revision is (a commit, a page
  version);
- **capability delta**: what spec-mapping infers from those sections;
- **composition delta**: the difference in `product.gdl` its change requests
  make;
- **runs, builds and deployments**: those of its change requests' commits.

Documents are read as written; a change never asks for a marker in a spec.

### 5. The route follows from what the gears can do

For each capability in a change's delta, spec-mapping's candidates decide one
of four routes:

| Verdict | Route | Stages that apply |
|---|---|---|
| A gear provides it | composition | documents → composition → conformance → deploy |
| A gear provides it once configured | configuration | as composition, plus the gear's settings |
| A gear exists but lacks it | extension | architecture → code (in the gear's repository) → tests → build → deploy |
| No gear | new gear | Create a gear (ADR-0044), the gear's own maturity path, then extension |

A change's route is the set of its capabilities' routes. A stage the route
does not need is **not applicable** to the change, which is different from
not passed. A route that rests on a platform gear's repository becomes a
request to that repository.

### 6. A stage is judged for a change

A stage keeps `requires`, `gates` and `checks`, and gains:

- **applicability**, from the route (§5);
- **scope**: a stage is judged for a project, as today, or for a change, over
  the change's own documents and change requests. For a change, `code` means
  its change requests are merged, `tests` that the runs of their merge
  commits passed, `review` that none of them waits on a reviewer;
- **the tail**: `build`, `deploy` per environment, and `observe`.

The gates that exist become the conditions between stages: a document's
maturity, contract compatibility (G4), a capability resting on experimental
gears, a protected environment's approval. The workspace automation level
says whether a person or an agent takes a step.

### 7. Where a change runs is computed from git

A change runs in an environment when the merge commit of each of its change
requests is an ancestor of the commit the environment's last successful
deployment carries. Studio computes this on its own clone of the repository
(`git merge-base --is-ancestor`), so the answer does not depend on the host.
Environments get an order per profile, and a protected environment may
require that a deployment's commit has been deployed to the one before it.

### 8. Studio does not write links back

The links Studio finds exist only as edges in its graph. It does not comment
in Jira or edit a pull request to record them. Writing back may come later,
per connection and opt-in.

## Consequences

- One view can follow a feature from its work item to production: a Flow
  board (columns are stages, cards are changes) and a change page made of the
  project tabs filtered to it. The tabs stay as they are, grouped by phase
  (define, compose, build, run, observe).
- Adding a provider stays local: a driver, its reference syntax and its link
  mapping. Nothing above the driver knows the provider.
- Two changes that edit the same `product.gdl` or the same gear are a finding
  on both, not a lock.
- Ancestry needs a clone of every repository a change touches; Studio already
  clones for Gearbox and checks.
- The more a team links its work in its own tools, the more Studio can say;
  where nothing is linked, Studio shows the change requests it could not
  place, rather than guessing.

## More Information

**Phases:**

1. **Links in the driver contract.** `RemoteIssue` gains `parent` and
   `iteration`; `RemotePullRequest` gains `head_sha` and `merge_sha`. One
   resolver of references (`connectors::references`), each driver declaring
   its syntax (`reference_syntax`). The artifact graph keeps the new fields
   and three edges: `closes`, `references`, `part_of`. *Built for GitHub, the
   one driver that lists issues and pull requests today; GitLab and Bitbucket
   fill the same fields when their listings land. Mentions in commit messages
   and a provider's own closing links (GitLab `closes_issues`) are not read
   yet.*
2. **The `Tracker` and `Documents` categories**, with a first provider that
   is not a git host (YouTrack), then Confluence for documents.
3. **The change and its stages.** A change derived from a work item, its
   contents (§4), `stage_status` for a change, the Flow board and the change
   page.
4. **Routes.** The capability delta and its verdicts decide the route and the
   applicable stages; Create a gear becomes a step of a change.
5. **Environments.** Where a change runs (§7) and the order of environments.
6. **Observe.** A change's hypothesis is an `Objective` with its metric, read
   back as the last stage.

## Traceability

- **PRD**: [PRD](../prd/constructor-studio.md)
- **DESIGN**: [DESIGN](../design/constructor-studio.md)

This decision directly addresses the following requirements or design elements:

* `cpt-studio-adr-one-model-for-a-project`
* `cpt-studio-adr-deployment-environments`
* `cpt-studio-adr-project-builds`
