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
| Levels: platform, organization, workspace, project, Admin; path bar and pickers | shell | organization, workspace, project, Admin (`screenLevels.ts`; Admin's sections from `admin-mfe`) | partial |
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
| Project templates | `project-lifecycle` kit (`project-templates-mfe`) | The editor: whose list is shown (the workspace's, the organization's, built-in), presets (built-in, Learning), add, move up, remove, offer none; per template the title, key, description, sources (none, new, attached; starter gear), brief, tabs shown, the tab it opens on, kits ticked from the catalogue; save for the organization or only this workspace, use the inherited list, discard; the model's checks block saving. Not yet: the tabs offered are the prototype's project tab list taken as data (`model/project-tabs.ts`), not the project screens registered in this portal (needs the shell to hand that list to a kit); no live refresh when someone else changes the list (studio-events not in the shell yet); the sentences the model composes (what a template fills in, why it cannot be saved) are English only | partial |
| Document types | `project-specs` kit (`document-types-mfe`) | The concept strip; the table of the workspace's effective types (name, key, owner, sections, front-matter, whether the spec-quality analyser accepts the key); the editor (identity, template, section checklist with required and minimum words, conformance rules) with the live "conforms when" summary; save as a workspace-owned type. Not yet: no live refresh when someone else changes a type (studio-events not in the shell yet); the slug `project-specs` is not in the backend's built-in kit catalogue on this branch, so the tab shows once the backend adds it | partial |

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
| Organizations | shell | `admin-mfe` Organizations: all organizations (id, workspaces, owners, members, same-name flag; shown to a platform administrator or to someone with more than one), the path bar's organization: rename, logo, managed ↔ self-managed request, delete; access map; conversions waiting on consent; New organization. Not: a table row does not switch the organization (the path bar does), and the path bar's switcher shows a new organization only on its next read | partial |
| People | shell | `admin-mfe` People: members with role, standing, last seen, how they joined; role change, suspend/resume, remove (the last owner guarded); under a row the description form, addresses, sign-ins (with the directory for a platform administrator) and attributed accounts; add someone with an identity (when the directory answers), invite by e-mail, withdraw an invitation | done |
| Access | shell | `admin-mfe` Access: access model, roles (privileges from the served catalogue), grants to members or teams on the organization or one workspace, self Owner grant seeded, self-managed notice; `access.ts` moved with its tests. Privilege names stay `access.ts`'s English | done |
| Integrations | shell (Sources) | — not in `admin-mfe`: the prototype's `ConnectorsView` (categories, health, add/edit, OAuth sign-in, repository browser; ~1 100 lines) was not ported in this pass. The organization's connections are listed by Organization › Connections (`connections-mfe`) | todo |
| Secrets | shell | `admin-mfe` Secrets: references named by the workspace settings and the connections behind the sources, health probe, rotate (create, else unconditional overwrite), delete. Only the path bar's organization's workspaces, where the prototype listed every organization's at once | partial |
| Domain model (model administration, ADR-0066) | shell | — not in `admin-mfe`: needs the domain runtime (`domain-runtime`, `domain-live`, the generated model) this app does not have yet | todo |
| Objects | shell | `admin-mfe` Objects: every graph type with lens filters and counts, the component mark, titles from types-registry | done |
| Views | shell | — not in `admin-mfe`: the saved views editor needs the domain runtime, the domain query and the model graph (`views-model.ts`, `domain-model-graph.tsx`), which this app does not have yet | todo |
| All identities (platform) | shell | `admin-mfe` All identities: Keycloak identities, access from Studio's memberships with Keycloak's drift, assign to an organization with a role; offered to everyone, the backend's refusal shown to anybody but a platform administrator | done |
| Project tenants (platform) | shell | `admin-mfe` Project tenants: every organization's workspace tenants with search, organization, self-managed and sort filters; open (the shell enters the workspace), create, delete; refusal shown to others. Not: Open in Web IDE | partial |

## Extra pages of the image

| Prototype | Who takes it | Here today | State |
|---|---|---|---|
| `/api-docs/` (the backend's API reference) | open (ADR-0069, open question 2) | — | todo |
| `/architecture/` (how the running backend is built) | open (ADR-0069, open question 2) | — | todo |
