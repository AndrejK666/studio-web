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
| Components (platform catalogue) | `components` kit (`components-mfe`) | The platform tier of the catalogue as a table: component and purpose with its source chips, type, release (declared or published), build readiness, downloads, review, profile completeness with its findings and better/worse since a window, source link; search, category, sort, Hide SDKs, kind chips, a 30/90/365-day window; Repositories & sync for a platform administrator. A component's page: Empty / Filled / Sources views, completeness ring, health strip, size (composition and facts), quality, responsibility, what changed since the window, the schema's groups, published versions, the profile editor (or our annotation). Not yet: the tiles (cards) view and the graph view, delivery activity from Constructor Insight (column, page panel and the window's activity), the domain model's fields on the page (`ModelFields`), the architecture diagram and UML (mermaid), the open component in the address (`?component=`), live refresh on domain changes (studio-events); the slug `components` is not in the backend's built-in kit catalogue on this branch, so the tab shows once the backend adds it | partial |
| Repositories (platform sources) | `components` kit (`components-mfe`) | The platform's catalogue sources for a platform administrator (`PlatformSourcesPanel`): repositories with mode, ref and connection, the crates.io keyword, Save, Save and sync (waits on the run); anyone else is told only an administrator sees them. Not yet: the platform's gear repositories list above them (ADR-0046: `gear-repository` connections in the root tenant with their roles, test, delete, add, the deployment-corpus note) — that part is the shell's Sources | partial |
| Publication requests | `components` kit (`components-mfe`) | Every organization's requests with who asked and when, the reason, Preview (the pull request it would open), the target repository when there are several, Publish, Decline with a reason; a 403 says only a curator answers; the gear curators with Add and Remove for a platform administrator (the organization in context's members are offered). The sentences the model composes (preview lines) are English only | done |
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
| Components (registry, catalogue, gear repositories) | `components` kit (`components-mfe`) | The registry beside the organization's catalogue, one row each: component, state and publish status, projects and who uses it, where it is declared, release and downloads; search, state chips, type and project filters; Needs a decision (candidates, strongest first, with their evidence); a row opens with evidence and Declare it, capabilities, owner, category, aliases, merge and deprecation, contribution, consumers, Suggest a description, Ready to leave its project? with Extract and Complete, where it was found, the decisions history and the moves its state allows (register, reject, deprecate, restore, request publication, mark published, merge, edit); the projects the registry reads with exclude; Read the projects now; Sources (the four repository pickers and crates.io, kept in this browser) and Sync; a component's page as on the platform. Not yet: the Organization and projects pane (`CatalogueLevelsPanel`: platform pins, project publications), the Repositories pane's gear repositories (`OrgSources`: the organization's gear repository, create it, Create a gear) and the shadowed-sources hint there, the Roadmap report dialog, the Activity column; the projects the registry reads are the ones its last walk saw plus the excluded ones (the prototype listed the organization's workspaces); no live refresh (studio-events) | partial |
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
