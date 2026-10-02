---
type: adr
status: accepted
date: 2026-10-01
---

# ADR-0033: A report is a definition over a source, and reports are their own gear

**ID**: `cpt-studio-adr-a-report-is-a-definition-over-a-source`

Status: accepted · 2026-10-01 · amended 2026-10-02 (§4, schedules) · Builds on #509, #543 and #586 (the roadmap workbook)

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Decision Drivers](#decision-drivers)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [1. studio-reports owns reports; the catalogue keeps reading the board](#1-studio-reports-owns-reports-the-catalogue-keeps-reading-the-board)
  - [2. A report is drawn by a definition](#2-a-report-is-drawn-by-a-definition)
  - [3. A source is configured once per organization, and the plan is a file](#3-a-source-is-configured-once-per-organization-and-the-plan-is-a-file)
  - [4. A refresh is a task, and a schedule keeps a report current](#4-a-refresh-is-a-task-and-a-schedule-keeps-a-report-current)
  - [Consequences](#consequences)
  - [Confirmation](#confirmation)
- [Pros and Cons of the Options](#pros-and-cons-of-the-options)
- [More Information](#more-information)

<!-- /toc -->

## Context and Problem Statement

#586 ported the planning team's `back_roadmap_to_xls.py` into
`studio-components-catalog`. Against the script's own output for the same
board and day, the workbook matches cell for cell and shape for shape. Getting
there left the report hard to configure:

- **The plan was a browser upload.** It was a `gears.yaml` snapshot from a
  private repository, kept in one person's `localStorage` and sent with every
  catalogue sync. Nothing showed when it went stale.
- **The configuration was per browser.** The board, its eight root issues and
  the consumer letters lived in the Components page's local source picker, so
  two people could draw two different reports.
- **The layout was code.** Columns, their order, formulas, red cells and
  sheet names were Rust. Every change to the report meant a backend PR, and
  formulas were hard-wired to column letters (`M*(1-K)`, `$P2`).
- **Reporting lived in the catalogue.** The catalogue owned the plan, the
  workbook, the writer and two routes. None of that is about components.

## Decision Drivers

* An organization configures a report once, and everyone reads the same.
* The plan stays where the planning team keeps it, and the report reads it from
  there.
* A report changes without a backend change, as long as it uses the
  building blocks the code already has.
* The workbook stays identical to the planning team's for their definition.
* Another report is another definition or another data set, not another
  module.

## Considered Options

1. Keep the report in the catalogue, and move the plan to a server-side setting.
2. **A reports gear: definitions drawn over sources, each configured per
   organization.**
3. A general report designer (arbitrary sheets, charts and formulas).

## Decision Outcome

Chosen option: **2**.

### 1. studio-reports owns reports; the catalogue keeps reading the board

`studio-backend/src/reports` is the `studio-reports` gear, under
`/studio-reports/v1/reports`. It owns:

- the report list;
- each report's source (one `gts.cf.studio.reports.report_source.v1~` node per
  report per organization);
- definitions, the plan and drawing;
- the xlsx writer.

The catalogue keeps reading the board. Stage, ETA and demand are component
facts, and a gear's card shows them whether or not anyone draws a report. The
two gears meet through one narrow port, `components_catalog::port::RoadmapCatalog`,
which answers three things:

- the planned gears;
- the components' values;
- "queue a sync of this board".

The plan left the catalogue entirely: there is no `plan_yaml` on a sync and no
`roadmap_plan` type. `/studio-components-catalog/v1/roadmap-report[/workbook]`
became `/studio-reports/v1/reports/{report_id}/summary` and `…/workbook`.

### 2. A report is drawn by a definition

A definition (`reports/definition.rs`) lists the report's sheets in order.
There are five kinds:

- `summary`
- `timeline`
- `gantt`
- `people`
- `table`

The code knows how to draw each kind; the definition chooses which ones appear,
names them, and lays out the table. A table column is one of three things:

- **a value by key**: `impl`, `milestone`, `card.Description`, or
  `field.<board column>` for any column of the board;
- **a formula** that refers to other columns as `{id}` and to the row as
  `{row}`;
- **the plan's consumer projects**, which become as many columns as the plan
  has.

The summary, the metrics block and the conditional formats find their columns
by what they hold (the title, the progress axes, the effort, the column with
id `remaining`), never by letter. A column can therefore move without breaking
anything that refers to it.

The planning team's workbook is the built-in `back_roadmap`
(`reports/presets/back_roadmap.yaml`). A plan selects a definition in one of
two ways:

- `report: <id>` names a built-in;
- `report:` with a definition of its own carries it inline.

Definitions are validated where they are read: unknown values, missing
columns, self-references, two tables or duplicate sheet names are each refused
with the column or sheet named.

### 3. A source is configured once per organization, and the plan is a file

A report's source is:

- a GitHub connection;
- the plan file, written `owner/repo:path@ref` or as a GitHub link.

It is read through the same connection as the board. The plan can carry
everything else:

- `board: owner/48`
- `roots: [3342, 4507]`. A bare number is resolved through the board, either
  as the root itself or through one of its sub-issues.
- `consumers: { A: Acronis }`
- `report`

The same keys saved on the source override the plan's, for a plan that does
not carry them yet. Uploading the text remains the fallback when the
connection cannot read the file.

The plan is kept as **text**, as last read, with where it came from and its
blob sha. Its key order is meaningful: it sets the project-column, lane and
People order, and JSON/JSONB keeps none. It is parsed the way PyYAML reads it:
a key written twice keeps its first position and its last value.

### 4. A refresh is a task, and a schedule keeps a report current

`POST …/{report_id}/sync` queues `reports.refresh`, which does three things:

- reads the plan file again;
- stores what it read;
- queues a `catalog.sync` of the board the plan names.

What it did, or why it failed, is recorded on the source, and the report keeps
being drawn from the last plan that read. A refresh of an organization that
saved no source fails and writes nothing.

A schedule keeps a report current on its own, with one subtlety. Schedules are
platform-level: they live in, and fire in, the platform tenant, while a source
lives in its organization's. So:

- the schedule is managed through this gear (`GET`/`PUT …/{report_id}/schedule`,
  over a narrow in-process port, `scheduler::port::Schedules`);
- the gear writes the caller's organization into the payload
  (`{"report": "roadmap", "organization_id": "…"}`), so a client never names a
  tenant;
- a run that fires in another tenant hands itself on: it queues the same
  refresh in the named organization's tenant, where the worker reads and
  writes as that organization.

The Reports screen switches an hourly one on and off.

*Amended 2026-10-02.* As first written, this section said a schedule with
payload `{"report": "roadmap"}` keeps a report current. Fired in the platform
tenant, such a schedule refreshed the platform's (empty) source every hour and
never the organization's, as dev showed.

### Consequences

* Good: one configuration per organization; the plan is never a stale copy;
  the Components page no longer configures reports.
* Good: a column, a sheet name or a whole second report is a definition, with
  no backend change.
* Good: the planning team's workbook is unchanged, verified by comparing
  against their script's output.
* Neutral: the timeline and Gantt kinds stay parameterised building blocks
  (name and title) rather than primitives; their layout is the planning team's.
* Bad: one more gear in the assembly, with one GTS type and seven routes.

### Confirmation

- `reports::definition` tests: every value key, every refusal, the formula
  references.
- `reports::source` tests: plan files, boards, precedence.
- `reports::service` tests: save, refresh, failure, definition choice.
- `components_catalog::port` tests: a board sync reads the board and nothing
  else.
- The workbook comparison against `back_roadmap_to_xls.py`'s output for the
  same board and day.

## Pros and Cons of the Options

**1. Plan as a server-side setting in the catalogue.** Smallest change. But the
catalogue keeps owning reports, the layout stays code, and the next report
lands in the same module.

**2. A reports gear with definitions (chosen).** Separates "what the board
says" from "how a report shows it". Adding a report costs a definition.

**3. A general designer.** Would let anyone draw anything. But a Gantt or a
swimlane timeline built from primitives is a layout engine, and none of the
reports anyone has asked for needs one.

## More Information

- The planning team's handoff: `back_roadmap_to_xls.py` and `gears.yaml`
  (cf-internal, snapshot 2fd52d5).
- `studio-backend/src/reports/mod.rs` — the gear and its parts.
- `studio-frontend-prototype/src/reports.tsx` — the Reports screen.
