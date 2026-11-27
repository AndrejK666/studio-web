# Glasshouse as a Studio installation: the plan

A proposal, not accepted. Written on 2026-11-26 from the *Glasshouse Vision*
deck (November 2026) and the ADRs current on `main` at `3cb52e424`. Nothing
here was checked on a stand. Each section is to be taken apart in detail
before any of it becomes an ADR.

## What Glasshouse is

A vendor opens its proprietary product to partner companies without the code
ever leaving. A company works on the vendor's code in a secured browser with AI
coding agents, on the vendor's infrastructure. It can:

1. **Customise** the vendor's product in its own copy, feature by feature.
2. **Build its own services** around the product; they stay its property.
3. **Test** on a full copy of the platform.
4. **Ship** signed releases to its own installations, still upgradable.
5. **Give back**: the vendor takes the best changes into its product, on request.

Five rules: the vendor's code stays inside (getting it out is deliberate and
hard, never trivial); IP is governed by signed terms; improvements flow back by
request, never by push; usage is metered and budgeted per company; the vendor
sets the level of control (read-only or full, with or without proctoring).

The first case: Constructor opens Learn to EBAC. By the end of December 2026
EBAC wants a course in Learn, a "product" concept and single sign-on. Most of
it is EBAC's own services.

The deck's delivery phases: **Phase 0** proves the path on one hand-built
workspace; **Phase 1** is EBAC; **Phase 2** closes the loop (self-service
onboarding, vendor release updates, read-only review, inclusion requests,
signed releases through the CT installer).

## The idea: Glasshouse is a set of kits

ADR-0079 §5 makes which kits run a setting. Glasshouse is then not a separate
product but **a Studio installation with a different set of kits**: some new,
some extended, and the ones it does not need (spec mapping, gears-matcher,
insight) switched off.

The deck's build-or-buy slide asks management to choose the workspace layer
between Coder and Citrix SecurSpaces. Studio is a third option: it already has
the browser IDE with agents, secrets kept on the server, one way out to LLM
providers, organizations as tenants, environments, previews, builds, the
organization's registry and per-organization budgets.

## Where Studio's architecture disagrees today

| Glasshouse needs | Studio today |
|---|---|
| One organization opens its code to another | The organization boundary is absolute: an organization sees only its own (ADR-0042 §2, the PDP reasons inside one tenant subtree) |
| The vendor's code never sits at the company as an external repository | `sources[]` name external repositories through connections; the session clones them itself (ADR-0060) |
| No Git credentials in the developer's session | The session container gets repository tokens as environment for its credential helper (`theia/docker/git-credentials.mjs`, ADR-0027) |
| No terminal; commands run in sandboxes | The terminal is on, and Claude Code and Codex run shell inside the session |
| A zone per company, no internet | Sessions of every organization share one namespace; egress is open to Git hosts (`deploy/helm/studio-web/templates/backend/sessions-netpol.yaml`) |
| Every AI conversation audited; the vendor's code refused in prompts | `studio-llm-proxy` routes requests and neither inspects nor records them (ADR-0039) |
| An audit trail exported to a SIEM | Metering only |

## New kits

| Kit | Level | What it brings |
|---|---|---|
| `partnership` | organization | The central kit. Types: the opening (vendor → company: repositories, access level, proctoring level, budget and quotas, agreement status), the agreement (NDA, IP terms), the invitation. The eight onboarding steps, each with a status, retryable and safe to run twice; leaving runs them in reverse. The vendor console and the company's home page. Access rules: a company member sees the vendor's resources only through an opening. |
| `vendor-code` | organization, project | A snapshot of the vendor's code per release, scrubbed of secrets and internal paths, approved by the code owner. The company's copy, recorded as based on snapshot vX; a branch per feature; a merge queue. Moving onto a new vendor release, with a plain-language description of what changed and the agent helping on conflicts. |
| `contributions` | project | The inclusion request: a company's change becomes a task in the vendor's tracker; the code owner adopts, reworks or declines it. Read-only review: questions to the vendor and a findings report that leaves without code. |
| `audit` | organization | An append-only trail of actions and AI conversations per company; SIEM export. |
| `proctoring` | organization | A connector driver for Constructor Proctor: identity check, camera and screen for a session. Only for the restricted level. |
| `device-trust` | organization | A connector driver for Construct Browser: only enrolled devices pass. |

## Existing kits to extend

| Kit (gear) | What it gains |
|---|---|
| `ide` (`studio_theia`) | A locked profile: terminal, file export, extension marketplace and SSH off; a watermark with name and time. The agent runs in a separate sandbox pod. |
| `project-git` (`git_proxy`) | The Git broker becomes the only way to the code: no token in the session, rights down to the feature branch. The companies' copies live in the Glasshouse Git, reached through the `gitlab` connection (see "Studio does not host Git"). |
| `assistant` (`llm_proxy`) | A guardrail that recognises the vendor's code in prompts; every conversation recorded into `audit`. |
| `delivery` (`environments`) | A staging per company, asleep nights and weekends. Release signing, vendor approval, publishing to the CT installer as a channel. |
| `org-costs` (`usage`) | Budgets and quotas per opening, that is per company; split per developer and per staging. |

## What the core is missing

Six things the kits cannot be built without. The first three come first.

1. **Access across organizations.** The access-rule port exists (`ServiceRule`),
   but the PDP reasons inside one tenant subtree. A resource must be visible
   through a relation between two organizations.
2. **A session profile port.** `studio_session` is core. A kit (`ide`,
   `partnership`) must be able to set the image, the policy, the sandbox pod
   and the network rules of a session.
3. **Placement per organization.** A company's sessions, sandboxes, build
   runners and stagings run in its own zone (a namespace or a cluster). Today
   sessions share one namespace.
4. **An audit port**, on the pattern of cost metering: kits write events,
   `audit` keeps and exports them.
5. **An access gate**: until a condition holds (agreements signed), an
   organization sees only onboarding. `partnership` sets the condition.
6. **A request hook in `assistant`.** A kit-to-kit extension point, not a core
   port: `audit` and the guardrail see every request through it.

## Editions: which kits run where

A kit carries one or more **editions**, the installations it runs in. For now
there are two: `studio` and `glasshouse`. The core is not a kit, carries no
edition and runs everywhere.

How it is kept (a proposal):

- `kit.json` gains `editions: ["studio", "glasshouse"]`. `KitManifest` is
  `deny_unknown_fields`, so the field is added to the struct.
- An installation sets `edition = "glasshouse"`; a kit without that edition
  does not start there. This is ADR-0079 §5 ("which kits run is a setting"),
  chosen by edition instead of by list.
- A kit that names no edition is `studio`, so no existing manifest has to
  change.
- `editions`, not `labels`: the value switches a kit on, it is not a free tag.

### The built-in kits

From `studio-backend/src/kit_registry/builtin/`, 19 kits.

| Kit | Editions | What it does in Glasshouse |
|---|---|---|
| `assistant` | studio, glasshouse | The developer's agent; the guardrail and the audit through its request hook |
| `delivery` | studio, glasshouse | Builds, the company's staging, signed releases |
| `ide` | studio, glasshouse | The locked session profile |
| `project-git` | studio, glasshouse | The Git broker, feature branches, review |
| `org-costs` | studio, glasshouse | Budgets and quotas per company |
| `project-tests` | studio, glasshouse | Test results of the company's builds |
| `mna` | studio, glasshouse? | Technical due diligence is close to Glasshouse's read-only review; it may replace that part of `contributions` |
| `org-reports` | studio, glasshouse? | Reports to the vendor per company, if we draw them |
| `components` | studio | |
| `constructor-research` | studio | |
| `gears-matcher` | studio | |
| `gears-project` | studio | |
| `project-domain-model` | studio | |
| `project-lifecycle` | studio | |
| `project-product` | studio | |
| `project-specs` | studio, glasshouse | The PRD, DESIGN, decomposition and ADRs written with the agent (DV-7 to DV-9, DV-22; added after the user-stories walk) |
| `spec-graph` | studio | |
| `spec-mapping` | studio | |
| `studio-api-docs` | studio | Studio's own API reference; a partner does not need it |

### The new kits

| Kit | Editions |
|---|---|
| `partnership` | glasshouse |
| `vendor-code` | glasshouse |
| `contributions` | glasshouse |
| `device-trust` | glasshouse |
| `proctoring` | glasshouse |
| `audit` | glasshouse, studio? (an audit trail is useful to any organization) |

Glasshouse runs 14 kits: 6 shared with Studio, 2 in question, 6 new.

### To decide

- `mna` and `org-reports` in Glasshouse: yes or no.
- Whether `audit` is also `studio`.

## User stories: the first walk (2026-11-27)

The Glasshouse team sent user stories for five roles, written from their
implementation proposal (`a-t-13595-implementation-proposal.md`, not in this
repository):

| File | Role | Stories | P1 |
|---|---|---|---|
| 1 | Operator (installs and runs the instance) | OP-1…OP-10 | 3 |
| 2 | Code owner (vendor, owns part of the code) | CO-1…CO-11 | 4 |
| 3 | Account manager (vendor, owns the relationship) | AM-1…AM-9 | 3 |
| 5 | Company admin | CA-1…CA-15 | 3 |
| 6 | Developer | DV-1…DV-35 | 21 |

80 stories, 34 of them P1 (Phases 0–1). File 4 was not sent; its role is not
known yet.

This walk supersedes the sections above where they disagree. The sections above
stay as the first cut, so the difference can be read.

### What the stories change in the plan

1. **The vendor is the instance, not a peer organization.** The vendor's people
   (operator, code owner, account manager) work in "vendor pages" of the one
   instance the vendor runs. Companies are the tenants. In Studio terms the vendor
   is the **platform tier** and a company is an **organization**. The vendor's
   repos are platform resources that the account manager enables for an
   organization, which is ADR-0042's pattern: the platform tier is read by
   organizations. Core point 1 shrinks from "access between two organizations"
   to "a platform resource granted to one organization".
2. **No agreements in Glasshouse.** NDA and IP terms are signed outside;
   Glasshouse records none (AM-1). What it records is the **acceptance of the
   terms and conditions** by the company admin (CA-1) and of the terms of use by
   each developer (DV-1), with the version accepted. The access gate stays, and
   it gates on that acceptance.
3. **Vendor code arrives by push only.** The code owner pushes each release from
   the vendor's own pipeline, with a description of what changed; Glasshouse
   never connects to or pulls from the vendor's Git (CO-4). `vendor-code`
   receives pushes; it does not take snapshots.
4. **Glasshouse hosts the code.** A company main per company, a feature fork per
   feature, a thread per parallel piece of work (its own branch, checkout, agent
   chat and sandbox), merge requests, review rules, a merge queue, nobody pushes
   to the company main (DV-6, DV-13, DV-18, DV-19, CA-4). That is a forge inside
   the instance. `project-git` today works against an external host's pull
   requests; here it drives the Glasshouse Git, a self-managed GitLab, through the same driver (see "Studio does not host Git").
5. **A workspace is one person's.** One workspace per developer, never shared
   (DV-5); several features and threads in it, each thread with its own
   checkout and sandbox. Studio's session is per project workspace and may be
   shared (ADR-0030). The session model changes for this edition.
6. **No vendor approval on a company release.** A company release publishes once
   its automatic checks pass, with no approval step (CA-6). The deck said the
   vendor approves; the stories win until told otherwise.
7. **Limits are in units, not money.** vCPU-hours, GB-RAM-hours, storage GB-days,
   CI runner-minutes, AI tokens, the number and size of stagings, active threads
   (AM-3, CA-8, DV-21). A global default, a per-company override, and the company
   admin's split per user. `org-costs` today keeps a price list and monthly
   budgets in money.
8. **Defaults with overrides everywhere.** Limits, code access level, access
   restriction level, access restriction settings and workspace settings each
   have a global default and a per-company override that can be returned to the
   default (AM-3, AM-4, AM-7, AM-8).
9. **Planning is Studio's strength.** The developer writes the PRD, DESIGN,
   decomposition and ADRs with the agent, as files in the feature fork, reviewed
   in the merge request (DV-7, DV-8, DV-9, DV-22). That is Studio's spec pipeline:
   `project-specs` runs in Glasshouse too.

### Components the plan did not have

- A **package proxy**: builds and sandboxes fetch packages only through it; the
  code owner adds packages and registries (CO-1, CO-6).
- A **sandbox per thread**: the changed services with mocks from the vendor's
  mock pack, each service's database with migrations and seed data, a debugger
  (DV-23, DV-24, CO-5, CO-9).
- **Staging data**: a Data panel through a database proxy, the company's own
  tables open, the platform's closed unless the code owner opened chosen ones
  read-only (DV-27, CO-7).
- **Logs** of a staging's services in an IDE panel (DV-26).
- A staging that may reach **chosen outside systems** (DV-20).
- **Own services**: own-service repos inside, a push-only target for services
  built outside, a scan of each pushed artifact, an export approved by the
  company admin and checked for the vendor's code (CA-11, DV-32, DV-33).
- **Attachments** to the agent chat, scanned for malware and secrets (DV-13);
  paste allowed only into the agent chat.
- The **Glasshouse AI review** of a merge request, advisory or required (DV-25,
  CA-4).
- **Device enrolment** by a one-time code, a device policy the company may make
  stricter than the vendor's minimum (DV-2, DV-29, CA-14).
- A **company identity provider** per company, SAML or OIDC (CA-10), and the
  vendor's own for the vendor pages (OP-5).
- **Suspend and offboard** a company, with a retention period for its company
  main (AM-9).
- **Instance setup**: a configuration wizard (Virtuozzo, Token Factory, the
  vendor identity provider), a rehearsal with a test company and a "ready" mark
  (OP-3, OP-6), workspace image versions (OP-7).

### Kits, second cut

| Kit | New or existing | Editions | Stories |
|---|---|---|---|
| `partnership` | new | glasshouse | AM-1, AM-2, AM-3, AM-4, AM-7, AM-8, AM-9, CA-1, CA-2, CA-3, CA-9, DV-1 |
| `instance-setup` | new | glasshouse | OP-3, OP-4, OP-6, OP-7 |
| `vendor-code` | new | glasshouse | CO-3, CO-4, CO-5, CO-7 (documentation), CO-9, OP-10, CA-7 |
| `features` | new | glasshouse, studio? | DV-6, DV-10, DV-11, DV-12, DV-14, DV-15, DV-30, DV-31, DV-34 |
| `sandbox` | new | glasshouse | DV-23, DV-24 |
| `staging-data` | new | glasshouse | DV-27, CO-7 (vanilla data) |
| `package-proxy` | new | glasshouse | CO-6, CO-1 (criterion 3) |
| `own-services` | new | glasshouse | CA-11, DV-32, DV-33 |
| `contributions` | new | glasshouse | CA-12, CA-13, CO-10, CO-11, DV-35 |
| `audit` | new | glasshouse, studio? | AM-5, AM-6, CA-15, and an audit criterion in most stories |
| `device-trust` | new | glasshouse | DV-2, DV-29, CA-14, DV-4 (criterion 1) |
| `proctoring` | new | glasshouse | DV-28, DV-4 (criterion 4), AM-7 |
| `ide` | existing | studio, glasshouse | DV-4, DV-5, DV-13, DV-16, DV-17, DV-26; the locked profile |
| `project-git` | existing | studio, glasshouse | DV-18, DV-19, CA-4, CO-8; a hosted-forge driver, the merge queue |
| `assistant` | existing | studio, glasshouse | OP-2, OP-9, DV-13 (attachments), DV-25 (AI review) |
| `delivery` | existing | studio, glasshouse | CO-1, CO-2, CA-5, CA-6, DV-20 |
| `org-costs` | existing | studio, glasshouse | AM-3, AM-4, CA-3, CA-8, DV-21; limits in units |
| `project-specs` | existing | studio, glasshouse | DV-7, DV-8, DV-9, DV-22 |
| `project-tests` | existing | studio, glasshouse | DV-17 (results against the thread) |

`features` is ADR-0047's change, the unit that walks the delivery stages, with
threads added. It may be worth having in Studio too.

Left to the core and to connections: OP-1 and OP-8 (a Virtuozzo connection and
its keys, beside the `kubernetes` driver), OP-5 and CA-10 (an identity provider
per organization and for the platform).

### The core, second cut

1. **A platform resource granted to one organization** (replaces "access between
   organizations"): the vendor's repos, documentation and releases, enabled per
   company.
2. **A session profile and a workspace per person**, with threads as checkouts
   and sandboxes inside it.
3. **Placement per organization.**
4. **An audit port.**
5. **An access gate on accepted terms**, versioned, per person.
6. **Defaults with overrides**, platform → organization → person, for limits,
   levels and settings.
7. **An identity provider per organization.**
8. **Organization lifecycle**: suspended and offboarded, with a retention period.

The `assistant` request hook stays a kit-to-kit extension point.

### What the P1 slice asks for

The 34 P1 stories are Phases 0–1, the EBAC deadline:

- **Operator:** the Virtuozzo and Token Factory connections and the wizard
  (OP-1, OP-2, OP-3).
- **Code owner:** build recipes, the staging definition, available repos, the
  release push (CO-1 to CO-4).
- **Account manager:** provisioning, enabling repos, usage and limits (AM-1 to
  AM-3).
- **Company admin:** terms, inviting developers with presets, permissions and
  limits per user (CA-1 to CA-3).
- **Developer:** DV-1 to DV-21: terms, Construct Browser, documentation, the
  session and workspace, features and threads, the PRD, DESIGN and
  decomposition, the agent on parallel threads, build, tests, review, the merge
  queue, staging, usage.

The heaviest P1 parts are the Glasshouse Git with Studio's merge queue (DV-18, DV-19), the
workspace per person with parallel threads (DV-5, DV-13), and the locked IDE
with Build and Run tests in place of a terminal (DV-16, DV-17). Studio already
has close to: planning with the agent (DV-7 to DV-9), builds and test results,
previews as stagings (DV-20), usage (DV-21), the Token Factory connection as an
LLM provider (OP-2).

### Contradictions and gaps in the stories

- **Release approval:** the deck has the vendor approve a company release; CA-6
  publishes with no approval.
- **Agreements:** the deck has NDA and IP signed in Glasshouse before access;
  AM-1 keeps them outside.
- **Changes back to the vendor:** CO-11 asks how accepted changes reach the
  vendor's source Git when nothing is copied out of Glasshouse and Glasshouse
  never connects to the vendor's Git. Answered on 2026-11-27: the code owner's
  pipeline pulls them (see "Studio does not host Git").
- **The first sign-in:** CA-1 and OP-4 both ask how the first person signs in
  (no invitation is sent, the device is not enrolled yet, the identity provider
  is not connected yet).
- **The test company:** OP-6 needs one, and the operator never provisions a
  company.
- **File 4** is missing.

## Decision: Studio does not host Git (2026-11-27)

Studio does not become a Git host. The code lives in a Git server the
organization runs, and Studio works with it through a connection, as it works
with GitHub and GitLab today. This holds for both editions.

### What it means for Glasshouse

- **A "Glasshouse Git" beside Studio.** The vendor (the operator) runs a Git
  server inside the instance's perimeter. It is not the vendor's source Git: the
  code owner pushes releases into it from the vendor's pipeline (CO-4), and
  Glasshouse never reaches the source Git. It is installed with the instance and
  is one more connection in the operator's setup (OP-3).
- **GitLab self-managed first.** Studio's `gitlab` driver already serves
  self-hosted installations, merge requests and their reviews, CI and writes
  (`studio-backend/src/connectors/gitlab/`). Forgejo or Gitea would need a new
  driver. Spike S2 checks the choice instead of picking a forge to host.
- **No person reaches the Git server.** It sits in the perimeter with no route
  from people's devices; only Studio's connection reaches it. People act through
  Studio, and the connection acts on their behalf (GitLab's `Sudo` with an admin
  token, so a merge request, a comment or an approval carries the person's name).
  The Git broker (`git_proxy`) stays the only way a workspace reaches the code.
- **One group per company.** Provisioning a company (AM-1) creates its group;
  enabling a repo (AM-2) forks the vendor's repo into it as the company main. A
  feature fork is a branch or a fork inside the company's group. The company's
  connection is scoped to its group, and is held by the platform, not by the
  company.
- **The rules Studio keeps.** Required approvals and merge trains are paid
  GitLab features. Studio enforces them instead: the company main is protected,
  only Studio's connection merges, and it merges only what passed the company's
  review rules and the merge queue (DV-18, DV-19). The merge queue is Studio's,
  in `project-git`.
- **Builds are Studio's (decided 2026-11-27).** CI runs as Studio's builds
  (ADR-0062) in the company's zone, not on the Git server's runners. Studio
  already places, meters and audits its builds; runners would be one more system
  to lock down. A push to a feature fork or a merge request starts a Studio
  build, which counts in the company's CI runner-minutes.
- **What Studio gains.** Nothing here is Glasshouse-only: a self-hosted GitLab,
  acting on a person's behalf, a merge queue and review rules enforced by Studio
  serve any organization that connects its own Git.

### What leaves the plan

- The hosted forge in WP3 and the "Studio Git" box in the diagram: replaced by
  the Glasshouse Git and the `gitlab` connection.
- The push intake in `vendor-code`: the code owner pushes to the Glasshouse Git;
  `vendor-code` reads the push from the Git server's events and records the
  release and its description, refusing one without a description.

### Accepted changes go back by the code owner's pull (decided 2026-11-27)

CO-11: when the code owner accepts an inclusion request, the vendor's own
pipeline pulls the accepted changes from the Glasshouse Git into the vendor's
source Git. It is the release push (CO-4) in reverse, started from the vendor's
side. Glasshouse still never connects to the vendor's source Git, and no person
copies code out of Glasshouse. `contributions` marks the request accepted and
names the commits to take; the vendor's pipeline needs read access to them in
the company's group, through a credential the vendor holds, scoped to that pull.

### Out of scope

- **Which Git server, its licence and how it installs on Virtuozzo.** That is
  the operator's. Studio supports what its connections drive; GitLab
  self-managed works today through the `gitlab` driver.

### Open

- Whether code owners get read access to the Git server directly for CO-8, or
  review only through Studio. The stories forbid copying out of Glasshouse, so
  through Studio.
- Whether the vendor's pull credential for CO-11 is one per company or one for
  the instance, and who issues it.

## Core adaptations to start (2026-11-27)

What the core needs before the Glasshouse kits can be built, read off the code
at `3cb52e424`. In the order that unblocks the most.

**Status on fork `main` (34bc5841e), checked 2026-11-27.** Fork `main` had
moved on since `3cb52e424`: the composition switch (`src/composition.rs`) and
every core port are in, and `core_kit_allowlist.txt` is empty; the IDE runtime
port (ADR-0080, `src/ide_runtime.rs`) lets a kit register an IDE's image, env
and capabilities; the metering port (`src/metering.rs`) records quantities
(tokens, pod-seconds), never money. So:

- **A1 done** (branch `AndrejK666/glasshouse-core`): `editions` in `kit.json`,
  `vendor.studio.kits.edition` (`STUDIO_EDITION`, Helm
  `backend.kits.edition`), default `studio`. Seven built-in kits are
  `studio, glasshouse`; ADR-0079 §5 amended.
- **A5 done** (same branch): `src/audit.rs`, the audit port, shaped like
  metering; the kit installer is its first writer. No recorder yet, so nothing
  is kept until the `audit` kit exists.
- **B1** shrinks to a Glasshouse IDE runtime on the ADR-0080 port, plus what
  the port lacks: whether repository tokens go into the container, and the
  sandbox pod.
- **C2** shrinks to reading the metered quantities as units and limits: the
  `org-costs` kit's work, not the core's.

### A. Before any kit

| # | Change | Today | Unblocks |
|---|---|---|---|
| A1 | **The composition switch and editions.** A kit's gear starts only when its kit is on (ADR-0079 step 5); `editions` in `KitManifest`; the installation's `edition`. The six remaining `organizations -> <kit>` pairs in `assembly/core_kit_allowlist.txt` go through ports, so `organizations` runs with those kits off. | Every kit is linked and started; `KitManifest` is `deny_unknown_fields` with no editions | Every kit; a Glasshouse installation without the constructor kits |
| A2 | **Roles on the platform tier.** Operator, code owner and account manager as platform roles, and the vendor pages as a shell area for them. | One platform administrator; roles narrow a member inside an organization (ADR-0019) | `instance-setup`, `partnership`, `vendor-code` |
| A3 | **A platform resource granted to an organization.** A PDP rule kind: an organization reaches a platform resource only through a grant (a repo, its documentation, a release). | The platform tier is read by every organization or by none (ADR-0042) | `partnership`, `vendor-code` |
| A4 | **The access gate on accepted terms.** Versioned terms per role; until a person accepted the current version, only the onboarding page answers. | None | `partnership` (CA-1, DV-1) |
| A5 | **The audit port.** Kits write events (who, what, organization, time; never code); the `audit` kit keeps them. | Cost metering only | Every kit writes audit from its first day |

### B. Before the `ide` kit

| # | Change | Today | Unblocks |
|---|---|---|---|
| B1 | **Session profiles.** A kit registers a profile: image, IDE policy (terminal, export, paste, watermark), a sandbox pod beside the editor, network rules, whether repository tokens are injected. | One `image` in `studio_session/config.rs`; repository tokens go into the container for the credential helper | The locked profile; Build and Run tests in the sandbox |
| B2 | **A workspace per person, threads inside.** A session keyed by workspace and person; a thread is a branch and a checkout (and later a sandbox) in it. | One session per workspace, shared by members (ADR-0030) | `features` (DV-5, DV-6, DV-13) |
| B3 | **Placement per organization.** Sessions, sandboxes and builds of an organization run in its namespace or cluster, with its quota and default-deny egress. | One `k8s_namespace` for all sessions; builds get a namespace per project (ADR-0062) | The company's zone; `delivery` stagings in it |

### C. Governance, in parallel

| # | Change | Today | Unblocks |
|---|---|---|---|
| C1 | **Defaults with overrides**, platform → organization → person, for limits, levels and settings, each returnable to the default. | Annotations override platform facts per organization (ADR-0042), not settings | `partnership` (AM-3, CA-3), `org-costs` |
| C2 | **Metering in units.** The metering port reports vCPU-hours, GB-RAM-hours, storage GB-days, CI runner-minutes, AI tokens; money becomes units times a price list. | `studio_session/metering.rs` measures millicores and mebibytes, `usage` prices them | `org-costs` in units (AM-3, CA-8, DV-21) |

### D. After P1

- An identity provider per organization (CA-10, P3) and the vendor's for the
  platform (OP-5, P2).
- Organization lifecycle: suspended, offboarded, a retention period (AM-9, P2).

### Not core

- The `assistant` request hook, the Git broker as the only path, acting on a
  person's behalf in GitLab, the merge queue: they live in the kits that own
  them (`assistant`, `project-git`).

## P1 work plan

Only P1: the 34 stories of Phases 0–1, the minimum for a company to deliver its
first feature. EBAC wants its work by the end of December 2026, about five weeks
from 2026-11-27. Sizes are a first guess (S up to 3 days, M about a week, L two
weeks or more for one person) and are to be revised after the spikes.

### Spikes first (week 1, in parallel)

Each one decides how a work package is built. None of them builds the product.

| Spike | Question | Decides |
|---|---|---|
| S1 Locked IDE | Can Theia run with no terminal, no export or download, paste only into the agent chat, a watermark, and Build and Run tests as IDE actions executed in a separate sandbox pod? | WP4, WP7 |
| S2 Glasshouse Git | A self-managed GitLab in the perimeter through the existing `gitlab` driver: acting on a person's behalf, a protected company main merged only by Studio, Studio's builds started by pushes, in the company's zone. The merge queue is ours (see "Studio does not host Git"). | WP3, WP5, WP7 |
| S3 Construct Browser | Can it block copy, screenshots and downloads on our pages, enrol a device by a one-time code, and prove an enrolled device to our proxy? | WP4 (DV-2, DV-4) |
| S4 Virtuozzo | Is it a Kubernetes cluster Studio can run on, with a namespace or cluster per company, default-deny egress, and metering in vCPU-hours and GB-RAM-hours? | WP1, WP4, WP9 |

### Work packages

| WP | What | P1 stories | Kits | Studio has | To build | Depends on | Size |
|---|---|---|---|---|---|---|---|
| WP0 | Edition switch | — | core | ADR-0079 §5, kits switched by configuration | `editions` in `kit.json`, `edition` of the installation | — | S |
| WP1 | Instance and vendor pages | OP-1, OP-2, OP-3 | `instance-setup`, `assistant` | connections and credstore; the LLM provider table (ADR-0039); platform administration | vendor roles on the platform tier (operator, code owner, account manager); a Virtuozzo connection; Token Factory as a provider with a model allow-list; the wizard | WP0, S4 | M |
| WP2 | Companies | AM-1, AM-2, AM-3, CA-1, CA-2, CA-3, DV-1 | `partnership`, `org-costs` | organizations, members, roles, invitations (ADR-0051, ADR-0040) | provisioning a company with its first admin; enabling platform repos for an organization; levels and limits with defaults and overrides; the gate on accepted terms; presets and per-user permissions | WP0, WP1 | L |
| WP3 | Vendor code in | CO-1, CO-3, CO-4 | `vendor-code`, `delivery`, `package-proxy` | builds in the builder image (ADR-0062) | the Glasshouse Git and its `gitlab` connection; recording a pushed release and refusing one without a description; repo availability; a company main per enabled repo; build recipes per repo; a minimal package proxy (builds fetch only through it, CO-1 criterion 3) | S2 | L |
| WP4 | The developer's workspace | DV-2, DV-3, DV-4, DV-5 | `ide`, `device-trust` | Theia sessions, the session proxy, the Git broker, the LLM proxy | a workspace per person; the locked profile; an editor pod and a sandbox pod; no tokens in the container; placement in the company's zone with no egress; enrolment and the device check; the home page with the guide and the vendor's documentation for enabled repos | S1, S3, S4, WP2 | L |
| WP5 | Features and threads | DV-6, DV-10, DV-11, DV-12, DV-13, DV-14, DV-15 | `features`, `project-git`, `assistant` | the change unit (ADR-0047), the agent in the session | New feature makes a fork of the company main; threads as a branch and checkout with their own agent chat; the Threads panel; the description as the agent's brief; close and abandon; attachments to the agent chat | WP3, WP4 | L |
| WP6 | Planning with the agent | DV-7, DV-8, DV-9 | `project-specs` | the spec pipeline, document types, the agent | that it works inside the locked IDE on forge repos; files under `docs/` in the feature fork | WP5 | S |
| WP7 | Build, test, review, merge | DV-16, DV-17, DV-18, DV-19 | `delivery`, `project-tests`, `project-git` | build records, test runs, review in a shared session | Build and Run tests in the IDE; CI on every push in the company's zone; merge requests with reviewers from the company; one approval by default, none from the author; the merge queue | S1, S2, WP5 | L |
| WP8 | Staging | CO-2, DV-20 | `delivery` | environments, previews in their own namespace (ADR-0055), the chart in the organization's registry (ADR-0048) | the code owner's staging definition; one staging per company at provisioning; a feature's changed services replacing the company main's; an allow-list of outside destinations; opening only in Construct Browser | WP3, WP7 | M |
| WP9 | Usage in units | AM-3, CA-3, DV-21 | `org-costs` | metering (#781), budgets, AI tokens from the LLM proxy | metering in vCPU-hours, GB-RAM-hours, storage GB-days, CI runner-minutes, AI tokens, stagings, active threads; the company's limits and the admin's split per user; the developer's view in the portal and the IDE status bar | S4, WP2 | M |
| WP10 | Audit events | the audit criterion of most P1 stories | `audit`, core | metering only | the audit port; every kit above writes its events; AI conversations recorded through the `assistant` hook. Viewing the audit is P2 (AM-6, CA-15). | WP0 | M |

### Order

- **Week 1:** S1 to S4; WP0; WP10's port, so every package writes audit events
  from the start.
- **Weeks 2–3:** WP1, WP2, WP3 and WP4 in parallel. They do not depend on each
  other beyond the spikes.
- **Weeks 3–4:** WP5, then WP6 and WP7; WP9.
- **Week 4:** WP8.
- **Week 5:** a rehearsal on one EBAC task, end to end; the Phase 0 red team;
  fixes.

**Critical path:** S2 (Glasshouse Git) → WP3 → WP5 → WP7 → WP8. The Glasshouse Git and the merge
queue decide the date.

### What P1 can do by hand, as the deck allows

- **AM-1 provisioning** and **AM-2 enabling repos**: the operator runs the steps
  with a script; the account manager's pages come after.
- **AM-3 limits**: shown, not enforced. What happens at a limit is still open.
- **OP-3 wizard**: the three connections set in the vendor pages one by one,
  without the wizard.
- **CA-2 presets**: one preset, Developer, until the presets are defined.

Doing these by hand takes about two weeks of work off WP1 and WP2 and keeps the
critical path as it is.

### Not in P1, though a P1 story leans on it

- **DV-3** shows the vendor's documentation, which the code owner sets in CO-7
  (P2): P1 shows the documentation in the company main's repos.
- **DV-18** follows the company's review rules, which CA-4 sets (P2): P1 has one
  fixed rule, one approval and none from the author.
- **The guardrail** that recognises the vendor's code in prompts is in no story.
  The deck's Phase 1 has it. Ask the Glasshouse team.

## What does not change

Tenants and roles; projects and `sources[]`; builds and environments; previews
as stagings; budgets and metering; shared sessions for review; the kit model.

## Order

- **Phase 0:** core points 2 and 3; the locked `ide` profile; the Git broker in
  `project-git`; a minimal `vendor-code` (snapshot and copy by hand).
  Exit (the deck's): a developer changes one Learn service and gets a green
  build, and a red team fails to get code out by any simple route.
- **Phase 1 (EBAC):** core point 1; `partnership` without self-service
  onboarding (the operator runs the steps by hand); the `assistant` hook and
  `audit`; a staging in `delivery`; budgets per opening. Exit: EBAC delivers one
  of its three tasks, tested on its staging and merged.
- **Phase 2:** `contributions`; moving onto vendor releases; signing and the
  installer; self-service onboarding; `proctoring` and `device-trust`.

## Open questions

- **The agent without a terminal.** The heaviest change: Claude Code runs bash
  inside the session today. It moves into the sandbox pod, and the editor keeps
  only the agent's UI. Whether Theia can be locked this far is the first spike.
- **Which Git server** is the Glasshouse Git: out of scope, the operator's choice; GitLab self-managed works today (see "Studio does not host Git").
- **The guardrail's owner:** our `studio-llm-proxy` or Token Factory, and when.
- **Construct Browser:** can it enforce the copy, screenshot and download
  blocks on our pages, and how does the session proxy recognise an enrolled
  device.
- **The upgrade promise:** a spike before telling companies their
  customisations stay upgradable (the deck's decision 5).
- **The deadline:** the end of December 2026 fits Phase 0 and a trimmed
  Phase 1, with onboarding and releases done by hand and EBAC's own services
  built in their own repositories.
