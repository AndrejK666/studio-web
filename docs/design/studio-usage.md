---
type: design
status: accepted
owner: studio-team
---

# Technical Design — studio-usage

- [x] `p2` - **ID**: `cpt-studio-design-usage`

The gear-level design of `cpt-studio-component-usage`. The product-level view
is in [Constructor Studio's design](constructor-studio.md). The code is
[`studio-backend/src/usage/`](../../studio-backend/src/usage/); the storage
plugin is
[`studio-backend/plugins/postgres-usage-collector-plugin/`](../../studio-backend/plugins/postgres-usage-collector-plugin/).
The issue is constructorfabric/studio-web#781.

## Table of Contents

- [1. Architecture Overview](#1-architecture-overview)
- [2. Principles & Constraints](#2-principles--constraints)
- [3. Technical Architecture](#3-technical-architecture)
- [4. Additional context](#4-additional-context)

## 1. Architecture Overview

### 1.1 Architectural Vision

What an organization spends on models and IDE sessions, recorded as quantities
by the gears that spend it and priced only when somebody asks. The model calls
and the running sessions are recorded with the platform's usage collector; the
organization keeps a price list; a report reads the collector's sums across the
organization's tenants, prices them and groups them by person, project, model,
source or payer, with or without what people spent on their own keys.

Recording belongs to the gears that know what was used: studio-llm-proxy reads
the tokens a provider reports in each answer, studio-session meters each
running pod in five-minute windows. Both hand their records to
`usage::sdk::Usage`, which writes them to `usage-collector`. This gear owns
what the records mean in money.

### 1.2 Architecture Drivers

| Requirement | Design Response |
|---|---|
| Costs per organization (issue #781) | A report over the organization, its workspaces and projects, priced with the organization's price list |
| With and without personal keys | Every record carries `payer` (`personal`, `workspace`, `organization`); the report filters it, never the records |
| Real billing as the truth for environments | Not in this gear yet: the report covers model calls and IDE sessions |
| `cpt-studio-nfr-tenant-isolation` | Every collector query is asked as the caller acting in one tenant of the organization, after the caller has been shown to administer it |

## 2. Principles & Constraints

### 2.1 Design Principles

#### Records are quantities, money is a reading

- [x] `p2` - **ID**: `cpt-studio-principle-usage-quantities-not-money`

A record holds tokens or seconds, never an amount. The price list is applied
when the report is read, so a price set today reprices the past, and usage
recorded before any price existed is not lost. Something without a price is
counted, marked unpriced, and named in the report; it is never priced at zero.

#### Metering never stands in the way

- [x] `p2` - **ID**: `cpt-studio-principle-usage-metering-never-blocks`

A model call's answer is served whether or not its usage can be recorded, and
a session is reaped whether or not it can be metered. A record that fails is a
log line.

### 2.2 Constraints

#### The storage is a stand-in

The collector's published storage plugin needs TimescaleDB, and the shared
Postgres is a 19 beta TimescaleDB does not support. The plugin's code runs on
a plain table instead (its README lists every difference); when the shared
Postgres is a release with TimescaleDB, the published plugin replaces it.

#### One tenant at a time

The Studio PDP answers the collector's query with the tenant it is asked in
and the caller's organizations, not their subtrees. A report therefore asks
each tenant of the organization separately — eight at a time — as the caller
acting in it.

## 3. Technical Architecture

### 3.1 Domain Model

| Entity | Where | What it is |
|---|---|---|
| `UsageRecord` | `port.rs` | One model call or one five-minute window of a session: tenant, person, payer, provider, model, tokens or seconds at a size |
| Usage type | `types.rs` | Seven collector counters: `cf.studio.llm.{input,output,cache_read,cache_write}_tokens.v1`, `cf.studio.session.{seconds,cpu_millicore_seconds,memory_mib_seconds}.v1` |
| `PriceList` | `prices.rs` | Per model, prices per million tokens of each kind; per hour, a requested CPU core and GiB; a currency |
| `Report` | `costs.rs` | Rows of quantities and cost, a total, what was unpriced |
| `Budgets` | `budgets.rs` | Monthly amounts for the organization, a workspace or a project, and the share at which they warn |
| `Standing` | `budgets.rs` | A budget against this month's spend: spent, forecast, `ok` / `warning` / `over`, whether only the forecast reaches it |

### 3.2 Component Model

#### Costs

- [x] `p2` - **ID**: `cpt-studio-component-usage-costs`

##### Why this component exists

Recorded usage says what was used; an organization needs what it cost.

##### Responsibility scope

`service.rs` and `rest.rs`: the price list, read by anybody who reaches the
organization and written by its administrators; the report, read by its
administrators or holders of `cost.view`.

##### Responsibility boundaries

Records nothing and stops nothing: a budget warns, it never refuses a call or a
session.

##### Related components (by ID)

- `cpt-studio-component-usage` — is part of

### 3.3 API Contracts

All under `/studio-usage/v1`, the organization named with `?organization_id=`.

| Method + path | Who | Does |
|---|---|---|
| `GET /prices` | member | the price list, `may_manage`, `may_view_costs` |
| `PUT /prices` | `cost.manage` | replace the price list |
| `GET /costs?from=&to=&group_by=&include_personal=` | `cost.view` | the report for `[from, to)` |
| `GET /budgets` | `cost.view` | the budgets, the warning share, the places a budget can be set on, `may_manage` |
| `PUT /budgets` | `cost.manage` | replace the budgets |
| `GET /budget-status?include_personal=` | `cost.view` | this month's standing against each budget, worst first |

### 3.4 Internal Dependencies

| Dependency | Interface | Purpose |
|---|---|---|
| `studio-user` | `OrgAuthority` | Whether the caller holds `cost.view` / `cost.manage` |
| `studio-organizations` | `organizations::port::ProjectsOf` | The organization's workspaces and projects |
| account-management | `AccountManagementClient` | The price list and budgets rows |
| `usage-collector` (platform) | `UsageCollectorClientV1` | The sums the report is made of |

### 3.5 External Dependencies

None.

### 3.6 Interactions & Sequences

A report: check `cost.view` → read the price list → list the organization's
tenants → for each, as the caller acting in it, sum each usage type over the
period grouped by person, provider, model and payer (calls) or driver and payer
(sessions) → price → group → sort by cost.

A budget standing: check `cost.view` → read the budgets (none: stop, nothing is
read from the collector) → this calendar month's report by project → a
workspace's spend is its own row plus its projects', the organization's the
total → from the fourth day, the month's forecast at the pace so far → the
level each reaches, now or by forecast. People's own keys count only when asked
(`include_personal`, default false: a budget is the organization's money).
Amounts are in the price list's currency; changing the currency does not
convert them.

### 3.7 Database schemas & tables

None of its own. The records are the collector's (`usage_records`,
`usage_type_catalog` in `studio_usage`, owned by the storage plugin); the price
list and the budgets are account-management metadata rows,
`gts.cf.core.am.tenant_metadata.v1~cf.studio.usage.prices.v1~` and
`…~cf.studio.usage.budgets.v1~`, held by this gear
(`studio_authz_plugin::GEAR_HELD_METADATA`).

## 4. Additional context

Not yet: limits that stop spending (`quota-enforcement` upstream, unpublished —
budgets only warn), notifications when a budget is crossed,
environments' estimate and real billing (step 3), and calls made outside a
workspace, which land in the caller's home tenant rather than an
organization's.
