---
type: adr
status: proposed
date: 2026-11-25
---

# ADR-0079: The core knows no kit, and kits contribute to it through the core's ports

**ID**: `cpt-studio-adr-core-knows-no-kit`

Status: **proposed** · Date: 2026-11-25 · Builds on `cpt-studio-adr-shell-and-kits` (ADR-0068: Studio is a shell), `cpt-studio-adr-domain-model-split` (ADR-0070: the core model), `cpt-studio-adr-kit-claims` (ADR-0071: kits claim gear types, tools and routes), `cpt-studio-adr-kit-gears-at-runtime` (ADR-0077: a kit gear beside Studio)

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [1. The core is an empty Studio](#1-the-core-is-an-empty-studio)
  - [2. Kits bring everything else](#2-kits-bring-everything-else)
  - [3. Dependencies go one way: kit to core](#3-dependencies-go-one-way-kit-to-core)
  - [4. The core's ports](#4-the-cores-ports)
  - [5. Which kits run is a setting](#5-which-kits-run-is-a-setting)
  - [6. Partner kits are services beside Studio](#6-partner-kits-are-services-beside-studio)
  - [7. Where today's gears go](#7-where-todays-gears-go)
- [Migration order](#migration-order)
- [Consequences](#consequences)
- [Confirmation](#confirmation)

<!-- /toc -->

## Context and Problem Statement

ADR-0068 made Studio a shell, ADR-0070 split the model into a core and kits,
and ADR-0071 let a kit claim the gear types, tools and routes it stands for.
The backend's code has not followed. Every gear is linked into one binary, and
the gears that would be the core name the kits' gears directly: on 2026-11-25,
11 core-side modules name a kit's gear in 30 places (module → gear pairs,
outside tests and comments). studio-mcp lists seven kits' tools by hand;
organizations, the PDP plugin, studio-kits and studio-session each reach into
three or more.

So no kit can be left out of a build or switched off in a deployment: the
core does not compile, or does not start, without it. And every new kit adds
lines to the core.

## Considered Options

1. **The core knows no kit; kits contribute through the core's ports.** Each
   place where the core lists kits' work becomes a port the core declares and
   kits fill.
2. **Keep the core naming kits, and gate each reference on whether the kit is
   installed.** Simple at first, but every kit keeps a line in the core and
   the core keeps growing.
3. **Split the core and kits into separate crates now.** The final shape, but
   too much in one step; the ports are needed first either way.

## Decision Outcome

Chosen: **1**, with 3 as where it ends.

### 1. The core is an empty Studio

The core works with no kit installed. It holds:

- sign-in, people, organizations, workspaces, projects, members and roles;
- the kit registry and kit installation;
- the domain-model mechanism and `/query`, with no types of its own beyond
  the core model (ADR-0070);
- the MCP endpoint, with no tools of its own;
- connections and secrets storage;
- tasks and events; notifications and presence.

### 2. Kits bring everything else

A kit brings its screens (MFE), its model types, optionally its own backend
gear, and its **contributions to the core through the core's ports** (§4).

### 3. Dependencies go one way: kit to core

A kit's gear may use the core's ports and SDKs. The core never names a kit's
gear: not its types, functions or tables. A test holds the code to this
(see Confirmation).

### 4. The core's ports

Each port is a registration the core reads, not a list the core writes. A
kit's gear registers in its own module, so adding a kit changes no core file.

| Port | What a kit contributes | Today |
|---|---|---|
| **MCP tools** | its tools, in a stable order | studio-mcp lists every gear's tools |
| **Overview blocks** | the blocks on a project's and an organization's Overview | organizations composes them from kits' gears |
| **Access rules** | the PDP's rules for its own resource types | ported: kits register `ServiceRule`, `GearHeldMetadata` (inventory) and `MirrorSyncSubject` (ClientHub); studio-authz-plugin names no kit |
| **Connector drivers** | a driver behind a connection kind | studio-connector names llm-proxy |
| **Background work** | task kinds and schedules | studio-session, studio-kits start kits' work |
| **Cost metering** | what it meters and how it is priced | organizations ported: kits register `CostMeter` (inventory, studio-usage); sessions still read usage by name |
| **Project status** | its facts about a project's status and delivery path | ported: kits register `StatusContributor` (inventory) answering a `StatusPart`; organizations merges them in `order` |
| **Project creation** | a step of a project's creation run, or a field its configuration starts with | ported: kits register `CreationStep` and `CreationField` (inventory); the plan keeps the step keys and their order |
| **Rollup counts** | per-project counts for the portfolio and the projects table | ported: organizations declares `DocumentCounter`, `ArtifactCounter` and `RowSignalSource`; kits publish them on the ClientHub |
| **Repository metrics** | the metrics board's git, CI and task half | ported: the analysing kit registers `RepositoryMetricsSource` (inventory, studio-insight) |
| **Kit parts** | which status steps, signals and path stages its tab owns, and the tab a step or signal opens | ported: kits register `ProjectKitParts` (inventory), `opens` names the tab (`("kind", "components")`) |
| **API domains** | the first path segment of its REST API, for the API-contract lint | ported: kits register `ApiDomain` (inventory); `api_contract::DOMAINS` lists only the core's |
| **Command line** | a `studio-backend` subcommand that runs before the configuration is read | ported: kits register `CliCommand` (inventory): the build Job's steps, `research-emulator` |
| **Catalogue model types** | the model types its catalogue node types become | ported: `HeldNodeTypes.entities` (inventory, studio-product's two) |
| **Kit runtime** | a built-in kit's function: its routes on studio-kits, what it registers on the hub | ported: `mna` and `project_lifecycle` register `KitFunction` (inventory, `kit_registry/runtime.rs`) and read the kits and the project's object through `KitRuntime`; studio-kits mounts a function's routes only where its `kit.json` claims them (a write in its `gears`, a read in `permissions.reads`) and refuses to start otherwise |

In process a port is a static registration (`inventory`); for a kit's gear
beside Studio it is the directory (ADR-0077 §6).

Two choices in the organizations ports. The rollup counts are ports of
their own, published on the ClientHub, not Overview blocks: blocks answer
an Overview with tiles, while a rollup is one row per project whose JSON
fields are pinned, so the core declares the counts and the kits answer
them. And the delivery path's stage ids and their order (`STAGES` in
`project_path.rs`) stay in the core: they number the stages the same on
every tab. A kit declares only a stage's title, its tab and that the stage
is its own.

### 5. Which kits run is a setting

Our own kits are in the binary and switched on by configuration. A switched-off
kit's gear does not start: no database, no tasks, no routes. Switching it on
needs a restart, not a rebuild. Cost management is a kit for now and its own
gear later.

The setting is `vendor.studio.kits` in the backend's configuration
(`src/composition.rs`):

```yaml
vendor:
  studio:
    kits:
      enabled: all     # default; `none`, or a list of kit slugs
      disabled: []     # default; kit slugs taken out of `enabled`
```

Both keys take a YAML list or one comma-separated string. `config/k8s.yaml`
and `config/docker.yaml` read them from `STUDIO_KITS_ENABLED` (default `all`)
and `STUDIO_KITS_DISABLED` (default empty); the Helm chart renders those from
`backend.kits.enabled` and `backend.kits.disabled`. With neither set every kit
runs, so a deployment that does not mention it behaves as before. A slug no
kit has stops the boot, so a typo cannot leave running a kit that was meant
off.

**Editions (amended 2026-11-27).** A third key, `edition` (`studio`, the
default, or `glasshouse`; `STUDIO_EDITION`, Helm `backend.kits.edition`),
names a set of kits. Each built-in kit lists the editions it runs in
(`editions` in its `kit.json`); a kit that lists none is `studio`'s. `all`
and an unset `enabled` mean every kit of the edition; a list in `enabled`
names kits of any edition, on purpose. Every kit that predates editions is
`studio`'s, so a deployment that names no edition runs what it ran before. An
edition the build does not know stops the boot. Why: Glasshouse is a Studio
installation with its own set of kits (`docs/glasshouse-plan.md`).

How it is held:

- A kit's gear registers its kit in its own module
  (`crate::composition::KitGear { gear, kit }`) and asks the composition first
  in `init`, `register_rest` and `migrations`: switched off, it starts nothing,
  mounts no route and runs no migration. A gear no kit registers is the core's
  and always starts. No core gear depends on a kit's gear (`deps`), so the core
  starts with no kit.
- Every port drops the contributions of a switched-off kit's gear: MCP tools
  and instructions, Overview blocks, status contributors, project creation
  steps and fields, cost meters, the repository metrics source, inbox sources,
  service access rules, schedules and catalogue model types.
- A kit without a gear of its own (`gears-matcher` in studio-product,
  `constructor-research` in studio-environments) is switched off through its
  claims (ADR-0071): its claimed MCP tools leave `tools/list`, and its claimed
  routes and tools answer `KIT_NOT_INSTALLED`, saying the deployment does not
  run it. Its status steps and signals are hidden even where every kit
  applies.

### 6. Partner kits are services beside Studio

A partner's kit never enters our binary. It runs as a service beside Studio,
as gears-matcher and spec-graph do, and joins through the directory and the
same ports (ADR-0077).

### 7. Where today's gears go

By folder under `studio-backend/src/`:

- **Core**: `user_profile`, `organizations`, `studio_session`, `kit_registry`,
  `domain_model`, `tasks`, `studio_events`, `scheduler`, `identity_directory`,
  `studio_authz_plugin`, `credstore_pg`, `secrets_bootstrap`, `connectors`,
  `mcp`, `notify`, `presence`, `assembly`, and the shared root modules
  (`org_scope`, `pagination`, `idempotency`, `plural`, `model_metadata`,
  `model_sweep`, `derived_view`, `project_path`, `project_sources`,
  `catalog_graph`, `data_places`, …).
- **Kit gears**: `artifact_ingest`, `git_proxy` (project-git), `documents`,
  `spec_quality` (project-specs), `spec_mapping`, `spec_graph`,
  `environments` (delivery), `product` (project-product),
  `components_catalog` (components), `reports` (org-reports), `usage`
  (org-costs), `insight` (a new kit, insight), `llm_proxy` (assistant),
  `studio_theia` (ide), `gears_matcher` (gears-matcher: the Studio side of
  the gears-matcher service, ADR-0076; its routes and tools are claimed in
  studio-product), `research_emulator` (constructor-research: the stand-in
  for Constructor Research, ADR-0049, contributed as a `CliCommand`), and
  `mna` (mna) and `project_lifecycle` (project-lifecycle), the built-in
  kits' functions on the kit-runtime port.

Each kit is described by its built-in `kit.json` (`kit_registry/builtin/`:
screens, model, inbox, MCP tools, claims), and reaches the core only through
the ports of §4.

## Migration order

1. **MCP tools.** Each gear registers its own tools; studio-mcp collects them.
2. **Overview blocks.** organizations stops composing kits' blocks.
3. **Access rules.** The PDP plugin takes kits' rules from a registry.
4. **The rest**: connector drivers, background work, cost metering, and the
   single references (studio-kits, studio-session, notify, project paths and
   sources, catalog graph, derived views).
5. **The composition switch**: a kit's gear starts only when the
   configuration turns it on (§5: `vendor.studio.kits`, Helm
   `backend.kits`). Built: every kit gear and port asks
   `crate::composition`; `src/composition_tests.rs` starts the core with no
   kit and takes one kit out.

## Consequences

- Good: a kit can be left out of a deployment, and adding one changes no core
  file.
- Good: the core's size stops following the number of kits.
- Bad: a port is one more indirection to read; the order of contributions has
  to be stated (an `order` key), not read off a list.
- Bad: every kit is still linked into the binary; step 5 decides which start,
  not which are built.

## Confirmation

- `studio-backend/src/assembly/core_kit_tests.rs` fails when a core-side
  module names a kit's gear unless the pair is in
  `studio-backend/src/assembly/core_kit_allowlist.txt`, and fails when a
  listed pair is gone, so the list only shrinks. It is empty when the
  migration is done. On 2026-11-27 it holds two pairs, both the kit
  registry's mna part, which is moving out of the registry.
- `studio-backend/src/composition_tests.rs` holds the switch: the core starts
  with no kit (no kit gear mounts a route or keeps a table, every port answers
  with the core's contributions), and one kit off takes its routes, tools,
  block and meter out while the other kits keep theirs.
- Step 1 leaves `tools/list` unchanged, name for name and in order.
