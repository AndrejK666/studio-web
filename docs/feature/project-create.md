---
type: feature
status: accepted
owner: studio-team
---

# Feature: Create a project


- [ ] `p1` - **ID**: `cpt-studiofrontend-featstatus-project-create`

- [x] `p1` - `cpt-studio-feature-project-create`

## Table of Contents

<!-- toc -->

- [1. Feature Context](#1-feature-context)
  - [1.1 Overview](#11-overview)
  - [1.2 Purpose](#12-purpose)
  - [1.3 Actors](#13-actors)
  - [1.4 References](#14-references)
- [2. Actor Flows (CDSL)](#2-actor-flows-cdsl)
  - [Create a project of a type](#create-a-project-of-a-type)
  - [Create a project from an existing repository](#create-a-project-from-an-existing-repository)
  - [Follow the type's next steps](#follow-the-types-next-steps)
  - [Abandon the wizard](#abandon-the-wizard)
- [3. Processes / Business Logic (CDSL)](#3-processes--business-logic-cdsl)
  - [Resolve the applicable step sequence](#resolve-the-applicable-step-sequence)
  - [Write the project](#write-the-project)
  - [Read the repository catalogue](#read-the-repository-catalogue)
- [4. States (CDSL)](#4-states-cdsl)
  - [Wizard State Machine](#wizard-state-machine)
  - [Project Status State Machine](#project-status-state-machine)
- [5. Definitions of Done](#5-definitions-of-done)
  - [The wizard is an overlay extension, not a dialog](#the-wizard-is-an-overlay-extension-not-a-dialog)
  - [A project always has an owner](#a-project-always-has-an-owner)
  - [Steps are declared data](#steps-are-declared-data)
  - [The draft never survives a close](#the-draft-never-survives-a-close)
  - [Creation is two writes and is not atomic](#creation-is-two-writes-and-is-not-atomic)
  - [One or more sources, capped](#one-or-more-sources-capped)
  - [The type decides what comes next](#the-type-decides-what-comes-next)
  - [Each root resolves the organization for itself](#each-root-resolves-the-organization-for-itself)
  - [The list learns without polling](#the-list-learns-without-polling)
- [6. Acceptance Criteria](#6-acceptance-criteria)

<!-- /toc -->

## 1. Feature Context

### 1.1 Overview

A one-step wizard, opened from the Projects list, that asks for a project's
name, its type, a goal and shows its owner, and creates it. The type decides the
rest: what the creation does, and the next steps the project's Overview then
shows until each is done or dismissed
([ADR-0073](../adr/0073-a-project-type-is-a-kits-subtype-of-project.md)). It is
rendered by the projects MFE into the shell's overlay domain, not as a dialog
the MFE draws itself.

**Superseded**: the wizard had a second question, the starting point (Start
from scratch or Import existing work), and with Import a second step that picked
repositories. The type answers what the starting point did: connecting existing
repositories is one of a type's next steps, done in the project's Sources
(Connect source, Change branch). The FrontX portal (`studio-frontend`) still has
the old two steps until it follows; the flow and the repository picker below
describe it and Connect source.

### 1.2 Purpose

Projects are the unit the whole portal is organised around, and until now they
could only be seeded by hand. The `studio-project` gear that was going to own
their creation has been retired: a project is an account-management tenant, and
its attributes are tenant metadata (ADR-0010). This feature is the first write
path in the portal against that model.

**Assumptions fixed here**, both because the mockups are silent and the choice
changes the code:

- A project is created under the **workspace** in scope. **Superseded**: this
  feature originally created a project under the organization. The tenant type
  does accept both parents, so that was never refused — but the workspace is the
  level a project belongs in, and it did not exist in the portal until
  [Workspaces in scope](workspace-scope.md) introduced it. The wizard still has
  no workspace field: the workspace is the one in the shell's top bar, and
  `cpt-studiofrontend-dod-workspace-scope-project-parent` owns that decision.
- A new project starts with the stages the workspace's catalogue marks
  **required**, read from `GET /studio-documents/v1/workspaces/{id}/stages`. The
  wizard has no stage picker. **Superseded**: this was originally the literal
  list `['intent']`, taken from a `JOURNEY_STAGES` constant that was itself a
  copy of the retired gear's catalogue. ADR-0014 section 7 moved the catalogue
  back to the server, so an organization may mark a different set and the wizard
  asks rather than assumes. Reading it is best-effort: a project is created with
  no stages rather than not created at all, because an empty stage list is
  something a user can fix and a missing project is not.
- *(Connect source, and the FrontX portal's wizard)* A modernization takes **one or more** repositories, at most 100 in total. The
  mockup's checkboxes and "3 selected" counter are literal, and the selection
  spans connection tabs — a project may be seeded from a GitHub repository and a
  GitLab one. ADR-0010 lists "modernize carries exactly one source" among the
  invariants that became advisory when the `studio-project` gear was retired;
  this feature widens it and the ADR records the change.
- The repositories step starts from the **source-code providers**, as the
  prototype's source flow does: a chip per source-code provider the
  organization has a connection to, and nothing listed until one is chosen. The provider's connections sit under it, because an
  organization may hold several connections to one provider: one connection is
  named in a line, several get a tab each. Connect source in a project's Sources
  section draws the same picker ([The project's sources](project-sources.md)).
  The step's card is small with the chips, the hint and Back alone (no count, no
  Create project), then keeps one height for every connection, the one the
  tallest empty state needs whole, so only a longer list scrolls. The details
  step keeps its own height. Back from the repositories returns to the
  provider choice and keeps the picks; Back from there returns to the details
  step. While the connections load, a skeleton as tall as
  the chips stands in for them and the hint already shows, so the card does not
  grow when they come.

**Requirements**: `cpt-studio-fr-workspace-project-tenants`, `cpt-studio-fr-connections`

**Principles**: `cpt-studio-principle-project-is-unit`

### 1.3 Actors

Actor ids are defined in the [PRD](../prd/constructor-studio.md); a gear taking part is cited by its design component id.

| Actor | Role in Feature |
|-------|-----------------|
| **Member** (`cpt-studio-actor-member`) | A signed-in member of the organization in scope. Opens the wizard from the Projects list, fills it in, and confirms creation. |
| **Shell** (`cpt-studio-actor-shell`) | The portal shell. Owns the overlay frame: mounts and unmounts the wizard, draws the scrim, and handles Escape and click-outside without consulting the wizard. |

### 1.4 References

- **PRD**: [PRD](../prd/constructor-studio.md)
- **Design**: [DESIGN](../design/constructor-studio.md)
- **Decomposition**: [DECOMPOSITION](../decomposition/constructor-studio.md), entry `cpt-studio-feature-project-create`
- **ADR**: [ADR-0010 — a project is an AM tenant](../adr/0010-projects-are-am-tenants.md)
- **ADR**: [ADR-0008 — simplified navigation shell](../adr/0008-simplified-navigation-shell.md) (no router; steps are state, not routes)
- **Mockups**: Figma `Constructor Studio mockups`, nodes `40001737:12397` and `40001737:12442`
- **Dependencies**: account-management (`/cf/account-management/v1`), studio-connector (`/studio-connector/v1`)

## 2. Actor Flows (CDSL)

The three flows below stay unchecked on purpose, and not because they are
unimplemented. A checked flow obliges every one of its CDSL instructions to
carry a `@cpt-begin`/`@cpt-end` block, and these span the list header, the overlay
plumbing, both steps, the write effect and — for "Abandon the wizard" — the
shell's own dismissal code, which is outside this system's codebase scope. Their
evidence is the acceptance criteria in section 6, exercised against a running
stack; the implementation claims they rest on are the Definitions of Done, which
are traced.

**Use case**: create a project of a type, then do what the type says comes next.

### Create a project of a type

- [ ] `p1` - **ID**: `cpt-studiofrontend-flow-project-create-greenfield`

**Actor**: Member

**Success Scenarios**:
- A project appears in the list with status Draft and the given name, and opens on its Overview with its type's next steps.

**Error Scenarios**:
- The name duplicates a sibling; account-management refuses and the wizard keeps the draft.
- The tenant is created but its metadata write fails; the project exists with no attributes.

**Steps**:
1. [ ] - `p1` - Member activates "New project" in the list header - `inst-1`
2. [ ] - `p1` - Mount the overlay extension in the shell's overlay domain - `inst-2`
3. [ ] - `p1` - Reset the draft so no earlier attempt is carried in - `inst-3`
4. [ ] - `p1` - Member enters a name, picks the project type and an optional goal; the owner is shown - `inst-4`
5. [ ] - `p1` - **IF** a type is picked, say under the types what its next steps are - `inst-5`
   1. [ ] - `p1` - The details are the only step, so the primary action reads "Create project" - `inst-6`
6. [ ] - `p1` - Run `cpt-studiofrontend-algo-project-create-write` - `inst-7`
7. [ ] - `p1` - Announce the created project on the MFE event bus so the list refetches - `inst-8`
8. [ ] - `p1` - **RETURN** unmount the overlay extension; the shell opens the project on its Overview - `inst-9`

### Create a project from an existing repository

- [ ] `p1` - **ID**: `cpt-studiofrontend-flow-project-create-modernize`

**Superseded** in the prototype portal: its wizard has no starting point and no
repositories step; a Gears project's first next step opens Sources, where Connect
source draws the same picker. The FrontX portal's wizard still takes this flow.

**Actor**: Member

**Success Scenarios**:
- A project appears in the list with status Draft and records every chosen repository as a source.

**Error Scenarios**:
- The organization has no source connection; the step says so and offers nothing to pick.
- The provider rejects the catalogue read; the step reports it and the member can go Back.

**Steps**:
1. [ ] - `p1` - Member fills the details step and picks "Import existing work" - `inst-1`
2. [ ] - `p1` - Advance to the repositories step, now applicable - `inst-2`
3. [ ] - `p1` - `API: GET /studio-connector/v1/connections (a chip per source-code provider, its connections under it)` - `inst-3`
4. [ ] - `p1` - Member picks a provider; its connections show, one in a line or several as tabs - `inst-3a`
5. [ ] - `p1` - `API: GET /studio-connector/v1/connections/{id}/repositories?search=&limit= (rows for the active connection)` - `inst-4`
6. [ ] - `p1` - Member picks one or more repositories, across providers and connections if needed, up to the cap - `inst-5`
7. [ ] - `p1` - Run `cpt-studiofrontend-algo-project-create-write` - `inst-6`
8. [ ] - `p1` - **RETURN** unmount the overlay extension and announce the created project - `inst-7`

### Follow the type's next steps

- [ ] `p1` - **ID**: `cpt-studiofrontend-flow-project-create-next-steps`

**Actor**: Member

**Success Scenarios**:
- The Overview of a typed project lists what its type says to do next, opens the screen for each, and stops listing a step once it is done or dismissed.

**Error Scenarios**:
- The dismissal cannot be written; the row stays and the card says why.

**Steps**:
1. [ ] - `p1` - `API: GET /cf/studio-organizations/v1/project-creation-types (the type's next_steps) and the project's project.config (project_type_kit, next_steps_dismissed)` - `inst-1`
2. [ ] - `p1` - Leave out a step whose `done_when` path step is done in `GET /cf/studio-organizations/v1/project-status`, and one dismissed - `inst-2`
3. [ ] - `p1` - Member opens a step's screen (Sources, Product, Constructor Research, Releases), or dismisses it - `inst-3`
4. [ ] - `p1` - `API: PUT /cf/account-management/v1/tenants/{id}/metadata/{type} (project.config with the id added to next_steps_dismissed)` - `inst-4`
5. [ ] - `p1` - **RETURN** the steps left; none, and the card is not drawn - `inst-5`

### Abandon the wizard

- [ ] `p1` - **ID**: `cpt-studiofrontend-flow-project-create-abandon`

**Actor**: Shell

**Success Scenarios**:
- The overlay closes and nothing is written.

**Error Scenarios**:
- None. Dismissal cannot fail and cannot be refused.

**Steps**:
1. [ ] - `p1` - Member presses Escape, clicks the scrim, or activates Cancel - `inst-1`
2. [ ] - `p1` - **IF** the trigger was Cancel - `inst-2`
   1. [ ] - `p1` - The wizard unmounts itself through the overlay domain - `inst-3`
3. [ ] - `p1` - **ELSE** - `inst-4`
   1. [ ] - `p1` - The shell unmounts it without consulting the wizard; there is no confirmation and no veto - `inst-5`
4. [ ] - `p1` - **RETURN** the draft is discarded with the React root - `inst-6`

## 3. Processes / Business Logic (CDSL)

### Resolve the applicable step sequence

- [x] `p2` - **ID**: `cpt-studiofrontend-algo-project-create-steps`

**Input**: the draft and the current step key

**Output**: the step to render, its neighbours, and whether it is the last one

**Steps**:
1. [x] - `p1` - Filter the declared steps by `isApplicable(draft)` - `inst-1`
2. [x] - `p1` - **IF** the current key is not in the applicable set - `inst-2`
   1. [x] - `p1` - Fall back to the first applicable step, because editing the draft can strand the wizard - `inst-3`
3. [x] - `p1` - Derive previous and next by position in the applicable set, never by a stored index - `inst-4`
4. [x] - `p1` - **RETURN** the resolved step, its neighbours, and whether next is absent - `inst-5`

### Write the project

- [x] `p2` - **ID**: `cpt-studiofrontend-algo-project-create-write`

**Input**: a complete draft and the workspace tenant in scope

**Output**: the created tenant's id, or the reason it was refused

The steps are one background run of studio-organizations
(`organizations.project_create`, `docs/design/studio-organizations.md`,
"A project is created by one run, on behalf of whoever asked"): the server
checks the request as the member, then creates the tenant, writes its
configuration (mode, the workspace's required stages, status, brief, owner,
the picked repositories as sources) and, with a brief, its PRD, each step
recorded so a retry continues where it stopped. The wizard no longer makes
those requests itself.

The project type is a kit's subtype of Project
([ADR-0073](../adr/0073-a-project-type-is-a-kits-subtype-of-project.md)): a
kit whose model derives a type of its own from the core Project type.
`GET /cf/studio-organizations/v1/project-creation-types?organization_id=`
lists the organization's types: the built-in ones (Gears, then Constructor
Research), then the kits the organization installed from its own shelf whose
model derives a subtype of Project (ADR-0073 Amendment 2), with the type's id,
name and description, the `mode` and optional creation steps it takes, its next
steps, its `shelf` and the kit `version` a project of it gets. Without
`organization_id` it lists the built-in ones only. The wizard offers them as one choice and the request names the pick as
`project_type_kit`, with no `mode` and no sources: the type decides. The run
records `project_type_kit` and the type's id (`project_type_id`) in the
configuration, takes the type's `mode`, writes a PRD from the brief only when
the type takes `prd`, refuses a step the type does not take, and its `kits`
step installs that kit in the new project, as studio-organizations' service,
after checking the project sits in the organization the request was approved
for, at the version the organization installed (an organization's own kit is
never taken at its shelf's newer commit); its last step, `model`, stores the
project's object in the domain model as the type's subtype of Project
(ADR-0073 Amendment 1). The organization need not have the kit itself; what the kit `requires`
must already apply to the organization, or the request is refused. Gears takes
the repository, sources, starter gear and PRD steps; Constructor Research takes
sources and the PRD.

**Steps**:
1. [x] - `p1` - Trim the name; reject an empty one before any request - `inst-1`
2. [x] - `p1` - `API: POST /cf/studio-organizations/v1/project-creations (workspace, name, brief, owner, the type kit, an idempotency key)` - `inst-2`
3. [x] - `p1` - **IF** the server refuses (the workspace, a connection) - `inst-3`
   1. [x] - `p1` - **RETURN** the refusal; the draft survives so the member can correct it - `inst-4`
4. [x] - `p1` - `API: GET /cf/studio-organizations/v1/project-creations/{run_id}?organization_id= (the run's state and each step's), shown in the dialog until it ends` - `inst-5`
5. [x] - `p1` - **IF** the run fails or is cancelled - `inst-6`
   1. [x] - `p1` - Report why with the step that stopped; the run stays in Background work, where a retry continues it - `inst-7`
6. [x] - `p1` - **RETURN** the tenant id the run created - `inst-8`

### Read the repository catalogue

Two known gaps, both in the gear rather than here, recorded so the screen is not
blamed for them:

- **`@cpt-gap`** — the listing is wider than the connection suggests. The GitHub
  driver calls `GET /user/repos?sort=updated&per_page=N` with no `affiliation`
  parameter, and that endpoint defaults to
  `owner,collaborator,organization_member` — so every organization the
  credential's owner belongs to contributes repositories. Narrowing it needs
  `affiliation` on the driver call or in `RepoQuery`; it cannot be done from the
  client, because one page is clamped to 100 rows and a local filter would hide
  repositories that exist beyond it.
- **`@cpt-gap`** — no repository carries a timestamp anywhere in the connector
  API, so the design's UPDATED column has no data source, and the step does not
  show it.

- [x] `p2` - **ID**: `cpt-studiofrontend-algo-project-create-repos`

**Input**: the chosen provider, the active connection and the search text

**Output**: the providers, the chosen provider's connections, and the rows to show

**Steps**:
1. [x] - `p1` - `API: GET /studio-connector/v1/connections?tenant= and GET /studio-connector/v1/providers (source-code drivers only)` - `inst-1`
   1. [x] - `p1` - **IF** the organization has no source connection, **RETURN** the empty state that says so - `inst-1c`
   2. [x] - `p1` - Offer a chip per source-code provider the organization has a connection to, in catalogue order - `inst-1a`
   3. [x] - `p1` - **IF** no provider is chosen yet, list nothing and say what to do - `inst-1b`
   4. [x] - `p1` - Name the provider's one connection in a line, or give each of several a tab captioned with the provider and its label - `inst-1d`
2. [x] - `p1` - Pass the search text to the endpoint rather than filtering a page, since it narrows server-side where the provider supports it - `inst-2`
3. [x] - `p1` - Show each repository's name and visibility, and no Updated column: the connector API carries no timestamp for a repository - `inst-3`
4. [x] - `p1` - **RETURN** the rows - `inst-4`

## 4. States (CDSL)

### Wizard State Machine

- [ ] `p2` - **ID**: `cpt-studiofrontend-state-project-create-wizard`

**States**: Details, Creating

**Initial State**: Details

The FrontX portal's wizard keeps its Repositories state (Details to Repositories
when the starting point is Import existing work); the prototype's has none.

**Transitions**:
1. [ ] - `p1` - **FROM** Details **TO** Creating **WHEN** Create project is used; the run's steps replace the form - `inst-1`
2. [ ] - `p1` - **FROM** Creating **TO** Details **WHEN** the run stops; the draft is kept, and Create project again continues the run - `inst-2`

### Project Status State Machine

- [ ] `p2` - **ID**: `cpt-studiofrontend-state-project-create-status`

**States**: Draft, Active, Archived

**Initial State**: Draft

**Transitions**:
1. [ ] - `p1` - **FROM** Draft **TO** Active **WHEN** the project is started from the project screen - `inst-1`
2. [ ] - `p1` - **FROM** Active **TO** Archived **WHEN** the project is archived; Archived is terminal - `inst-2`

## 5. Definitions of Done

### The wizard is an overlay extension, not a dialog

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-create-overlay`

The system **MUST** render the wizard as a second extension of the projects MFE
in the shell's overlay domain, mounted and unmounted through the extension
lifecycle actions, with its own entry and lifecycle instance.

**Implements**:
- `cpt-studiofrontend-flow-project-create-greenfield`
- `cpt-studiofrontend-flow-project-create-abandon`

**Touches**:
- Entities: `mfe.json`, `overlayLifecycle`, `wizardActions`

### A project always has an owner

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-create-owner`

The system **MUST** set the owner to the member creating the project, writing it
to `owner_id` in the project's metadata, and **MUST** show who that is without
offering a choice.

One owner, not a list, and not selectable at creation: transferring a project is
a decision about a project that already exists, and there is no screen yet where
it could be undone. The mockup draws a picker with a chevron; this screen shows
the member instead, as plain content rather than a control that refuses clicks.

Only the subject id is stored. It comes from the session profile the shell
publishes as a shared property — `/me`'s `subject_id`, with the display name and
address from the token claims — so this screen reads no user list of its own. It
is applied once, when the profile arrives, which may be after the wizard has
mounted.

**Implements**:
- `cpt-studiofrontend-flow-project-create-greenfield`

**Touches**:
- Property: `constructor_studio.session.user.profile.v1~` (published by the shell)
- Entities: `DetailsStep`, `NewProjectWizard`, `ProjectConfig`

### Steps are declared data

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-create-steps`

The system **MUST** derive which step is shown, what the footer buttons read,
and whether the primary action submits, from the declared step list and the
draft — not from a step index and not from per-screen markup.

**Implements**:
- `cpt-studiofrontend-algo-project-create-steps`

**Touches**:
- Entities: `wizardSteps`, `NewProjectWizard`

### The draft never survives a close

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-create-reset`

The system **MUST** reset step and draft when the wizard mounts, because the
store outlives the overlay root and the shell offers no affordance for resuming
an abandoned attempt.

**Implements**:
- `cpt-studiofrontend-flow-project-create-abandon`

**Touches**:
- Entities: `createSlice`

### Creation is two writes and is not atomic

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-create-write`

The system **MUST** create the tenant first and write its attributes second, and
**MUST NOT** attempt to undo the tenant when the second write fails.

**Implements**:
- `cpt-studiofrontend-algo-project-create-write`

**Touches**:
- API: `POST /cf/account-management/v1/tenants`
- API: `PUT /cf/account-management/v1/tenants/{id}/metadata/{type}`

### One or more sources, capped

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-create-many-sources`

The system **MUST** add each picked repository to the selection rather than
replacing what is already there, **MUST** keep the selection across connection
tabs and providers, **MUST** let a picked row be removed by activating it again, and **MUST
NOT** let the selection exceed 100 repositories in total — at the cap the
unpicked rows are inert and the footer says so.

A repository is identified by its connection together with its provider-native
id: that id is unique only within one connection, and the selection spans them.

Each pick keeps the repository's default branch, and the write records it as the
source's `branch`, with `share_mode: branch`, as Connect source does for a
repository attached later. A provider that reports no default branch gets no
`branch`.

The picker is shared with Connect source in the project's Sources section
(`cpt-studiofrontend-dod-project-sources-picker`). It holds no state; the
wizard passes it the selection, the search and the chosen connection from its
slice.

**Implements**:
- `cpt-studiofrontend-flow-project-create-modernize`

**Touches**:
- Entities: `createSlice`, `projectDraft`, `RepositoryPicker`, `RepositoriesStep`

### The type decides what comes next

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-create-type-next`

The system **MUST NOT** ask for a starting point or repositories in the wizard,
**MUST** leave the project's `mode` and optional creation steps to the type
(the request sends neither), and **MUST** show on the project's Overview the
type's next steps that are neither done (their `done_when` path step is done)
nor dismissed, each opening the screen its `route` names where this portal has
it for the project. A dismissal **MUST** be kept in `project.config`
`next_steps_dismissed` with everything else in the configuration written back
as it was. A project without a type (created before them) shows no next steps.

**Implements**:
- `cpt-studiofrontend-flow-project-create-greenfield`
- `cpt-studiofrontend-flow-project-create-next-steps`

**Touches**:
- API: `GET /cf/studio-organizations/v1/project-creation-types`
- Entities: `DetailsStep`, `wizardEffects`, `NextSteps`, `nextSteps`

### Each root resolves the organization for itself

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-create-org-scope`

The system **MUST** resolve the organization in scope independently in each
mounted root, from one shared derivation, and the wizard **MUST** refuse to
submit without one.

Handing it over is not available. `MfeHandlerMF` loads every expose into its own
blob-URL module graph, so the two entries have separate stores and separate event
buses; a value published by the list is unreachable from the wizard. The
QueryClient is shared (`queryCacheShared` retains the host's off `globalThis`),
so resolving twice costs cache hits rather than requests.

**Implements**:
- `cpt-studiofrontend-algo-project-create-write`

**Touches**:
- Entities: `shared/organization`, `shared/workspace`, `projectTree`, `NewProjectWizard`

### The list learns without polling

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-create-announce`

The system **MUST** make a created project appear in the list without a manual
refresh, by invalidating the workspace's children page on the shared
QueryClient.

Not by an event the list listens to: the two roots do not share an event bus.
Only the current workspace's own page is invalidated — a project is created as
its direct child, and that page is the list's root, so no other branch gained a
row.

**Implements**:
- `cpt-studiofrontend-flow-project-create-greenfield`

**Touches**:
- Entities: `wizardEffects`, `NewProjectWizard`

## 6. Acceptance Criteria

- [ ] Activating "New project" opens the overlay; the projects list stays visible behind the scrim.
- [ ] Escape, a click on the scrim, and Cancel all close the overlay and write nothing.
- [ ] Reopening the wizard after abandoning a filled-in draft shows an empty first step.
- [ ] The wizard asks for a name, the project type and a goal and shows the owner; there is no starting point and no second step, and the primary action reads "Create project".
- [ ] Picking a type says under the types what its next steps are.
- [ ] Create project is disabled until the name is not empty and a type is picked.
- [ ] A created project opens on its Overview, which lists its type's next steps: Gears — connect the repositories (Sources), compose the product (Product); Constructor Research — connect a Research project (Constructor Research), build and run it there (Releases).
- [ ] A next step leaves the Overview once its path step is done (a Gears project with a repository no longer lists Connect your repositories) or once anybody dismisses it; a dismissal survives a reload and is the same for the whole team.
- [ ] A project created before project types, or of a type with nothing left, shows no Next steps card.
- [ ] A created project's `project.config` carries `project_type_kit`, `project_type_id` (`gts.cf.studio.domain.project.v1~cf.studio.kit_<kit>.project.v1~`) and the type's `mode`; its object in the domain model is stored as the type's subtype of Project and carries `project_type_id` and `project_type`.
- [ ] A request that names a type and asks for a step the type does not take (sources on a type without `sources`) is refused; one that sends `mode` and `sources` without a type still works.
- [ ] An organization that installed its own kit deriving a subtype of Project from its shelf sees it in the wizard after the built-in types; another organization does not, and neither does it while the kit is only on its shelf.
- [ ] A project created with an organization's own type gets the kit at the version the organization installed even after the shelf kit was refreshed, and its object in the domain model is that kit's subtype.
- [ ] Installing an organization kit whose next step opens no screen Studio or the kit has is refused with the route and the screens it may open.
- *(Connect source and the FrontX portal's wizard)* The criteria below about picking repositories.
- [ ] Picking a second repository keeps the first; picking a selected one removes it; the footer counts what is selected.
- [ ] The selection survives switching providers and connection tabs, and a created project records every picked repository.
- [ ] Each recorded repository carries its default branch as `branch` and `share_mode: branch`.
- [ ] At 100 selected the unpicked checkboxes are inert and the footer states the maximum.
- [ ] The repositories step opens on a chip per source-code provider the organization has a connection to, with nothing listed, and says to choose one; a provider with no connection has no chip.
- [ ] Back with a provider chosen returns the repositories step to the provider choice and keeps the picks; Back from the provider choice returns to the details step.
- [ ] The repositories step's card is small until a provider is chosen, with Back alone in its footer, no count and no Create project; choosing one brings both back and keeps one height for every connection: an empty state shows whole without a scroll, and only a longer list scrolls.
- [ ] Choosing a provider with one connection names it in a line; with several, each gets a tab captioned with the provider and its label.
- [ ] An organization with no source connection sees an empty state that says so instead of chips.
- [ ] A GitLab or Bitbucket connection that exposes no repositories offers Try GitHub sample, which chooses the GitHub provider, when the organization has a GitHub connection.
- [ ] A connection whose repositories cannot be read shows, in place of the table and centred under the search, the empty state's icon and "Could not read this connection.", with no title and no action.
- [ ] A model provider (an API key) is offered neither as a chip nor as a connection on the repositories step.
- [ ] A created project is a tenant of the project type whose parent is the workspace in scope, with `status = draft`, an `owner_id`, and the stages its workspace's catalogue marks required.
- [ ] A workspace whose catalogue marks a different stage required seeds new projects with that one, and no code change is involved.
- [ ] The details step offers the project types as one choice, Gears first, and Create project stays disabled until one is picked.
- [ ] A project created as Gears has the `gears-project` kit installed in it, one created as Constructor Research the `constructor-research` kit; neither installs the other.
- [ ] A creation that stops shows the stopped step as stopped, and Create project again (or Retry in Background work) continues from that step without a second tenant.
- [ ] The owner field names the signed-in member and offers no way to change them; the created project carries their subject id as `owner_id`.
- [ ] A refused creation leaves the wizard open with the draft intact and shows what was refused.
- [ ] The created project appears in the list without a manual refresh.
- [ ] The repositories step has no Updated column: the connector API carries no timestamp for a repository.
- [ ] The chosen provider's chip shows as pressed, and pressing it again keeps it chosen.
- [ ] A repository search that matches nothing says so under the column headers and offers to clear the search; a connection with no repositories, and an organization with no connections, each say what to do next.
