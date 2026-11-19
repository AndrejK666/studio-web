---
type: adr
status: proposed
date: 2026-11-19
---

# ADR-0073: A project type is a kit's subtype of Project

**ID**: `cpt-studio-adr-project-type-subtype`

Status: **proposed** · Date: 2026-11-19 · Builds on ADR-0070 (a kit brings the types its screens show, as an overlay on the organization's model), ADR-0071 (a kit claims its gear types; `requires`) · **Amends** ADR-0071 (how a kit is a project type) · Feature: [`docs/feature/project-create.md`](../feature/project-create.md)

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [1. The subtype](#1-the-subtype)
  - [2. A project type is found, not flagged](#2-a-project-type-is-found-not-flagged)
  - [3. Its model is every organization's](#3-its-model-is-every-organizations)
  - [4. What a creation of the type does](#4-what-a-creation-of-the-type-does)
  - [5. What comes next](#5-what-comes-next)
  - [6. What a project records](#6-what-a-project-records)
- [Consequences](#consequences)
- [Confirmation](#confirmation)
- [Open questions](#open-questions)

<!-- /toc -->

## Context and Problem Statement

The New project wizard offered a project type (Gears, Constructor Research: built-in
kits marked `project_type: true`) and, beside it, a starting point: Start from scratch or
Import existing work, the latter a second step that picked repositories. The two
questions overlapped. The type already says what the project is for and so what it needs
first; Import existing work was one of those needs (connecting repositories), and the
project's Sources section does it better (connect, Change branch) once the project
exists. A third type is coming (`mna`, studio-web#1024), so whatever a type decides has
to be data its kit carries, not wizard code (ADR-0068: everything outside the shell is a
kit; nothing is hardcoded per project).

A kit already extends the organization's domain model with its own types (ADR-0070
overlays). A project's type is the most natural such type: a kind of Project with
attributes of its own.

## Considered Options

- **Keep the flag, add the creation rules beside it.** Smallest change, but the type stays
  a word in `project.config` that the model does not know, and a kit is a project type
  because it says so.
- **The type is a subtype of Project in the kit's overlay** (chosen). The model knows each
  type, its attributes are fields, and "is a project type" follows from the model.
- **Put the creation rules on the overlay's type.** The overlay is the domain model's format
  (`deny_unknown_fields`, read by studio-domain-model); creation steps and screens to open
  are not the model's business. They go in the kit manifest, beside the overlay, as other
  kit sections (`inbox`, `screens`) do.

## Decision Outcome

### 1. The subtype

A project-type kit declares, in its `model.types`, one type of its own that
`extends: "project"` (the core Project type, `gts.cf.studio.domain.project.v1~`). The
overlay installer already resolves `extends` against the organization's model; the new
entity is `<slug>-project` and inherits Project's fields, adding its own. Its GTS id is
chained onto Project's: `gts.cf.studio.domain.project.v1~cf.studio.kit.<slug>.project.v1~`
(`OverlayType::gts_in`; any kit-own type that `extends` another is catalogued this way).
The subtype is the kit's own type, so it needs no claim (ADR-0071 claims are for a gear's
types).

### 2. A project type is found, not flagged

A kit is a project type when its overlay derives exactly one type from `project`
(`KitManifest::project_subtype`). `project_type: true` may still be written, as a cache: a
manifest that says it without the subtype is refused, and two subtypes in one kit are
refused. A project type names the `project` level. `GET
/studio-organizations/v1/project-creation-types` lists the built-in project types: each
type's id, its kit's slug, the type's name and description, and §4 and §5.

### 3. Its model is every organization's

A kit that brings a model is not installed for one project only (the model is the
organization's, ADR-0067 §6, `MODEL_KIT_NOT_FOR_PROJECT`). A
project type is installed for one project by definition, so the built-in project types are
the exception: their overlays are carried by every organization's model (the
reconciliation keeps and syncs them like base kits'), and installing one in a project
applies its overlay first when the organization's model lacks it.

### 4. What a creation of the type does

The manifest's `project_creation` section (only on a project type) says:

- `mode` — `greenfield` (default) or `modernize`, what `project.config` `mode` starts with;
- `steps` — which optional creation steps it takes, of `repository`, `sources`, `scaffold`,
  `prd` (`scaffold` needs `repository`). Absent section: all of them, as before.

`POST project-creations` with `project_type_kit` takes the type's mode when the request
sends none, refuses a request for a step the type does not take (`sources`, `repository`,
`starter_gear`, `prd: true`), and writes a PRD from the brief only when the type takes
`prd`. The wizard asks for a name, the type, a goal and shows the owner; nothing else.

### 5. What comes next

`project_creation.next_steps` lists, in order, what the person does once the project
exists: `id`, `label`, `description`, `route` (the shell screen where it is done) and,
optionally, `done_when`, a step of the project's path (`GET project-status`
`path[].step`) whose being done makes this one done. The project's Overview shows the
steps that are neither done nor dismissed; a dismissal is kept in `project.config`
`next_steps_dismissed`, for the whole team. Gears: connect the repositories (Sources, done
with `repos`), compose the product (Product, done with `product`). Constructor Research:
connect a Research project (Constructor Research, dismissed), build and run it there
(Releases, done with `build`).

### 6. What a project records

`project.config` gets `project_type_id` (the subtype's GTS id) beside `project_type_kit`
(the kit's slug, which existing readers know). The creation's last step, `model`, gives
the project's object in the model (`project`, keyed `self`, written as
studio-domain-model's tenant sweep writes it) `project_type_id` and `project_type` (the
subtype's entity), keeping whatever else is on it. Projects created before this keep no
type and stay plain Projects; nothing is migrated.

## Consequences

- A kit with only a manifest and an overlay becomes a project type; `mna` needs no code in
  the wizard, the run or the Overview.
- Every organization's model gains the built-in project types' subtypes on its next
  reconciliation.
- The project's object keeps the storage type `project`: every reader that queries
  `project` (the attributes cards, the tenant sweep, MCP) still finds it, and reads its
  subtype from `project_type`. The subtype's own fields are written onto that object.

## Confirmation

- `kit_registry/manifest_tests.rs`: a kit is a project type by its subtype; the creation
  section is checked.
- `domain_model/kit_overlay_tests.rs`: the subtype inherits Project and is catalogued
  under Project's GTS id.
- `organizations/project_create_tests.rs`, `project_create_rest.rs`: the `model` step and
  the type's answer.
- projects-mfe: the wizard has one step and sends no mode; the Overview's Next steps.

## Open questions

1. Should the project's object be stored as the subtype itself? Queries match the exact
   type, so that needs `type: project` to match subtypes (and the tenant sweep to look
   for them) first.
2. A project type on an organization's own shelf: `project-creation-types` lists built-in
   kits only.
