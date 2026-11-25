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
| **Access rules** | the PDP's rules for its own resource types | studio-authz-plugin names kits' resources |
| **Connector drivers** | a driver behind a connection kind | studio-connector names llm-proxy |
| **Background work** | task kinds and schedules | studio-session, studio-kits start kits' work |
| **Cost metering** | what it meters and how it is priced | usage is read by name from organizations and sessions |

In process a port is a static registration (`inventory`); for a kit's gear
beside Studio it is the directory (ADR-0077 §6).

### 5. Which kits run is a setting

Our own kits are in the binary and switched on by configuration. A switched-off
kit's gear does not start: no database, no tasks, no routes. Switching it on
needs a restart, not a rebuild. Cost management is a kit for now and its own
gear later.

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
  `studio_theia` (a new kit, ide).

## Migration order

1. **MCP tools.** Each gear registers its own tools; studio-mcp collects them.
2. **Overview blocks.** organizations stops composing kits' blocks.
3. **Access rules.** The PDP plugin takes kits' rules from a registry.
4. **The rest**: connector drivers, background work, cost metering, and the
   single references (studio-kits, studio-session, notify, project paths and
   sources, catalog graph, derived views).
5. **The composition switch**: a kit's gear starts only when the
   configuration turns it on.

## Consequences

- Good: a kit can be left out of a deployment, and adding one changes no core
  file.
- Good: the core's size stops following the number of kits.
- Bad: a port is one more indirection to read; the order of contributions has
  to be stated (an `order` key), not read off a list.
- Bad: until step 5, every kit is still linked and started.

## Confirmation

- `studio-backend/src/assembly/core_kit_tests.rs` fails when a core-side
  module names a kit's gear unless the pair is in
  `studio-backend/src/assembly/core_kit_allowlist.txt`, and fails when a
  listed pair is gone, so the list only shrinks. It is empty when the
  migration is done.
- Step 1 leaves `tools/list` unchanged, name for name and in order.
