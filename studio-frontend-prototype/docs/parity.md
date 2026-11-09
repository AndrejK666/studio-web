# Parity with the prototype

ADR-0069 §3: this app replaces the prototype on Dev once every row below is
**done**. The reference is the prototype at `00828880`
(`git show 00828880:studio-frontend-prototype/src/…`). Dev keeps serving the
prototype from its last image tag until then.

**Who takes it**:
- **shell** is the host app (`src-app/app`).
- A kit name is a built-in kit (ADR-0068 §7). Built-in kits become **base
  kits**, installed by the platform for every organization (ADR-0069 §4).

**Here today** says what this app already has (from the `studio-frontend`
copy).

**State** is one of:
- `todo`
- `partial`: the screen exists here, without everything the prototype's has
- `done`

## The shell

| Prototype | Who takes it | Here today | State |
|---|---|---|---|
| Sign-in page: e-mail and password, GitHub, forgot password, Create account | shell | the prototype's page | done |
| Organization access gate and pending requests | shell | `OrganizationAccessGate`, `OrganizationRequests` | partial |
| Levels: platform, organization, workspace, project, Admin; path bar and pickers | shell | organization, workspace, project (`screenLevels.ts`) | partial |
| Level tab bars, with the order a person keeps (`tab-order.ts`, `/me/ui-preferences`) | shell | tabs from `mfe.json`, fixed order | partial |
| Tabs from the domain model's `shows` relations and hidden tabs per level (ADR-0066) | shell | — | todo |
| Kit library: Platform › Kits (base kits), Organization › Kits | shell | `kits-mfe` placeholder | todo |
| Pins in the rail (`pins.ts`) | shell | — | todo |
| Inbox: work waiting on me, pull requests waiting, review requests (`work-inbox`, `waiting-on-me`, `pull-request-waits`) | shell, with sources from kits (ADR-0068 §6) | — | todo |
| Notifications | shell | — | todo |
| Saved views and list filters (`views-model`, `list-state`) | shell | — | todo |
| Search | shell | `search-mfe` | partial |
| Presence | shell | — | todo |
| Studio AI chat panel | Assistant kit | — | todo |
| Event channel `studio-events` (live updates) | shell | doc only (`docs/studio-events.md`) | todo |
| Profile: the person, identities, keys | shell | user menu | todo |
| Open in IDE, the IDE frame and the desktop hand-off | shell | `space-mfe` (Editor) | partial |
| Theme and organization logo | shell | themes | partial |

## Platform

| Prototype | Who takes it | Here today | State |
|---|---|---|---|
| Components (platform catalogue) | Product & Releases | — | todo |
| Repositories (platform sources) | shell (Sources) | — | todo |
| Publication requests | Product & Releases | — | todo |
| System (raw types, JSON, test notifications) | shell (administration) | — | todo |

## Organization

| Prototype | Who takes it | Here today | State |
|---|---|---|---|
| Overview (dashboard for leaders) | shell | `organization-mfe` Overview: tiles, needs attention for others (rows open Connections, Workspaces, People), workspaces; no metrics board, no "for you" (Inbox) | partial |
| Workspaces | shell | `organization-mfe` | partial |
| People | shell | `people-mfe` | partial |
| Connections | shell (Sources) | `connections-mfe` | partial |
| Infrastructure (places, environments) | Product & Releases | — | todo |
| Costs | `org-costs` kit (`costs-mfe`) | Report by project, person, model, source or payer over this month, last month or 30 days, with the own-keys switch; price list editor (`may_manage`; read-only otherwise, price list only without `may_view_costs`); Budgets dialog with standings, warnings and editor; header chips for no prices and budgets that warn. Not yet: the model-composed sentences (row names, standings, validation) are English only | done |
| Components (registry, catalogue, gear repositories) | Product & Releases | — | todo |
| Reports | `org-reports` kit (`reports-mfe`) | A card per report with its state, hourly chip, Refresh (saves the source, queues `reports.refresh`, waits for it and the board sync it queues), Download .xlsx; Configure dialog: GitHub connection, plan file or uploaded `gears.yaml`, board/roots/consumers, Save, Refresh every hour; plan editor (teams, people with their Studio links and unplanned members, projects linked to the organization's workspaces, needs, lanes; per-section save against the revision, 409 → Reload; Publish teams; Export gears.yaml); the roadmap's tables under its card. Not yet: live refresh on domain changes (`useDomainRefresh` over studio-events — the shell has no event channel yet), and the Components screen's roadmap dialog (`RoadmapReportDialog`, part of the Components screen). The model-composed sentences (source state, publish outcome, demand) are English only | partial |
| Background work (tasks, schedules) | shell | `organization-mfe` Background work: runs (failed + running by default, state and type filters, retry, cancel, details), schedules (run now); refreshes by polling, not studio-events | partial |
| Domain-model tabs of the organization (`type:<name>`) | shell (generic screens) | — | todo |
| Settings | shell | `organization-mfe` | partial |

## Workspace

| Prototype | Who takes it | Here today | State |
|---|---|---|---|
| Projects | shell | `projects-mfe` | partial |
| Attributes (what the domain model records about it) | shell (generic card) | — | todo |
| Project templates | Project lifecycle | — | todo |
| Document types | Specs | — | todo |

## Project

| Prototype | Who takes it | Here today | State |
|---|---|---|---|
| Overview | shell | `projects-mfe` Overview | partial |
| Issues | Issues | — (needs the spec-model resolve queue and fact keys on the backend first) | todo |
| Specs, with Spec quality | Specs | `projects-mfe` Specs | partial |
| Domain model (editor, questions, graph) | Domain model | — | todo |
| Product (map, configurator, frontend, gear config) | Product & Releases | — | todo |
| Components (inventory) | Product & Releases | — | todo |
| Releases (environments ladder, builds, deploys) | Product & Releases | — | todo |
| Tests | Tests (`tests-mfe`) | Tests kit: mainline, pull requests, spec ↔ code, runs | done |
| Kits (IDE kits) | shell (installer, working material) | — | todo |
| Artifacts (outputs, documents) | Artifacts | `projects-mfe` Artifacts | partial |
| Sources | shell (Sources) | `projects-mfe` Sources | partial |
| Activity | Activity | `projects-mfe` Activity | partial |
| Timeline (ADR-0066) | Activity | `projects-mfe` Timeline | partial |
| Team | shell | `projects-mfe` Team | partial |
| Status and phases | Project lifecycle | — | todo |

## Admin

| Prototype | Who takes it | Here today | State |
|---|---|---|---|
| Organizations | shell | — | todo |
| People | shell | — | todo |
| Access | shell | — | todo |
| Integrations | shell (Sources) | — | todo |
| Secrets | shell | — | todo |
| Domain model (model administration, ADR-0066) | shell | — | todo |
| Objects | shell | — | todo |
| Views | shell | — | todo |
| All identities (platform) | shell | — | todo |
| Project tenants (platform) | shell | — | todo |

## Extra pages of the image

| Prototype | Who takes it | Here today | State |
|---|---|---|---|
| `/api-docs/` (the backend's API reference) | open (ADR-0069, open question 2) | — | todo |
| `/architecture/` (how the running backend is built) | open (ADR-0069, open question 2) | — | todo |
