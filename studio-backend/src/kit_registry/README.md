# studio-kits

The catalogue of kits, and which kits a project wants installed.

The design — why kit bytes stay in Git, what the gear records and what `cfs`
does, scope and reconciliation, the REST surface and where installations are
stored — is [`docs/design/studio-kits.md`](../../../docs/design/studio-kits.md).
This README is what you need to work in the directory.

## In the assembly

- Gear `studio-kits`, capabilities `[rest]`, deps `account_management`.
- `STUDIO_KIT_CATALOGUE`: the catalogue, as a JSON array of kits
  (`slug`, `name`, `repository_url`, `default_version` required;
  `description`, `publisher`, `visibility` = `public`, `source` = `github`,
  `manifest_path` = `.cf-studio-kit.toml` optional). Unset, it is
  `official_catalogue()` in `service.rs`, Constructor's own kits; moving their
  pinned default commits is a change there. A value that does not read stops
  the gear at start rather than offering other kits; `[]` offers none. Each
  entry must be a kit the IDE's installer allow-lists (`sdlc`, `compete`),
  from that kit's own repository: the installer installs by slug.
- Materialize, reconcile and the repository list call the project's session
  through the core's IDE port (`ide_bridge.rs`, filled by
  [`../studio_theia`](../studio_theia)), so they need a backend built
  with the `theia-bridge` feature and a running session; without either they
  answer 503.
- A project's installations are one tenant-metadata document,
  `cf.studio.project.kit_installations.v1~`, declared in `config/*.yaml`.
- The library has three shelves (`shelf` on each catalogue entry):
  `builtin` (`builtin_catalogue()` in `service.rs`, compiled in, at Studio's
  own version, empty `repository_url`), `official` (the catalogue above) and
  `organization` (each organization's own, `shelf.rs`: see below). `?shelf=` filters
  `GET /catalog`; the IDE asks for `official` only, the kits `cfs` can install.
  The built-in kits are the portal's features, cut by function (ADR-0071
  §6): `project-specs` (Specs), `project-domain-model` (Project model),
  `project-lifecycle` (Planning), `project-git` (Git collaboration),
  `project-tests` (Tests), `project-product` (Product), `delivery` (Builds,
  releases & environments), `constructor-research`, `gears-matcher`
  (Gears matcher, ADR-0072), `spec-mapping` (Spec mapping, ADR-0074),
  `components` (Catalogue), `org-costs`, `org-reports`, `studio-api-docs` (level
  `platform`) and `assistant`
  (Studio AI, the chat panel the shell docks in its sidebar; no route, its
  permissions are studio-llm-proxy's client settings and chat completions) and
  `constructor-research`. Every built-in kit is a base kit by default except
  those in `OPT_IN_BUILTIN` (`service.rs`): `constructor-research` and
  `gears-matcher` apply only where an organization (or one project) installs
  them (or a platform administrator makes one a base kit). The base kits of
  `ORGANIZATION_REMOVABLE_BASE` (`spec-mapping`) an organization administrator
  may uninstall for that organization alone: its document's `removed_base`,
  taken back by installing the kit for it again (ADR-0074). A kit's manifest
  may declare the assembly strategy it provides (`assembly_strategy`,
  `port::assembly_strategies`, `KitPresence::strategies` for an organization's
  own kit at its pin); a strategy a service runs declares
  `service: {contract: "gears-matcher/v1"}` and requires `gears-matcher`
  (ADR-0074 amendment). A feature ported into the portal is added here,
  with everything in its compiled-in `builtin/<slug>.kit.json` — every
  built-in kit has one, `studio-api-docs` too: its `screens` (a route only
  once the portal has one; `mfe`, the package that draws it, whose
  `mfe.json` names the kit as `presentation.kit`, which a test holds both
  ways; a built-in kit may put a screen on the `platform` level), its model, what it claims
  (`gears`) and, in `permissions`, the routes its screens call — a test
  holds every one to `docs/api-contract.json`.
- What a kit claims of the gears (ADR-0071 §1–§3, step 1), `claims.rs`: the
  `gears` section of a `kit.json`, per gear `{gear, types, mcp_tools,
  routes, sync_only_with_kit}`. The built-in kits claim (`ci-run`/`ci-job` →
  `project-tests`, the environments types, `deployment` and the builds →
  `delivery`, the product types → `project-product`, `work-item`/`comment`/
  `pull-request` → `project-git`, `finding` → `project-domain-model`,
  `budget`/`model-price` → `org-costs`, `report-source` → `org-reports`, the
  catalogue types → `components`, the documents types → `project-specs`,
  `project-domain-model` and `project-lifecycle`, `project-type` →
  `project-lifecycle`). `Claims::builtin()` (also in `port`) is the one table:
  the domain model sets `meta.kit` on a gear's type from it, and a claimed
  type is dormant where its kit does not apply (`kit_overlay::sync`). What no
  kit claims is the shell's: `CORE_GEAR_TYPES` (ADR-0071 §7) and
  `SHELL_MCP_TOOLS`. The build tests (`claims_tests.rs`) fail on a gear type
  or MCP tool no kit claims and the shell does not name, on a type, tool or
  route claimed twice, and on a claim of something no gear declares or
  serves. A shelf kit claiming a built-in kit's, the core's or the shell's
  is refused, `KIT_MODEL_CONFLICT`.
- One shared `KIT_NOT_INSTALLED` (ADR-0071 §4, step 2), `gate.rs`, from the
  claims. A gear puts `port::with_claimed_routes(router, hub, "<gear>")` on
  its router as the last thing `register_rest` does (studio-environments,
  -artifact-ingest, -product, -spec-mapping, -components-catalog,
  -documents, -usage, -reports, -organizations, -kits): a claimed **write**
  route of that gear, called where its kit does not apply, answers 400
  `failed_precondition` `KIT_NOT_INSTALLED` with the kit's slug as the
  violation's `subject`, before the handler. studio-mcp asks
  `port::tool_refusal` before a claimed tool runs and answers the tool's
  error `KIT_NOT_INSTALLED (kit <slug>): …`. Where: the most specific tenant
  the call names (`project_id`, `workspace_id`, `organization_id`/`org_id`
  in the path, the query, a JSON body or the tool's arguments), else the
  caller's own; a named tenant the caller cannot reach is left to the
  handler. Reads are never claimed. A gear checking something only a kit
  brings inside its own logic (Research in studio-environments, a project's
  phase here) asks `port::require_kit` and answers its `KitRefusal`; no gear
  writes the answer itself. `port::sync_wanted`: a gear asks before an
  expensive sync whether the claim on that type opted in to
  `sync_only_with_kit` and its kit does not apply (studio-artifact-ingest
  asks for its CI runs and jobs, build outputs and releases). Every built-in
  claim leaves the flag off today, so every gear writes as before; a kit
  that sets it says so in `GET /catalog/{slug}` (`gears[].note`).
- Slug aliases (ADR-0071 §8, step 5), `aliases.rs`: `project-issues` →
  `project-domain-model` + `project-git`, `project-activity` →
  `project-git` + `project-lifecycle`, `product-releases` →
  `project-product` + `delivery`, `org-infrastructure` → `delivery`;
  `org-connections`, `project-team`, `project-artifacts` → the shell (step
  6: Connections, the project's People and Artifacts are shell tabs, their
  relations back in the core, `assignment` dropped as left by Studio). Every
  installed-kits document is read through them (`installed::MigratingStore`):
  an installation of a retired slug counts as one of each kit it resolves
  to, and a merged kit stays removed (`removed_builtin`) only where every
  slug merged into it was removed; otherwise it applies and the document's
  `renamed` report names it (`GET /installed-kits` `renamed`,
  `shown_again`). The first write of a document stores it migrated; the
  start-up `kit-rename` sweep (`sweep.rs`, a `model_sweep` mover) writes
  every tenant's and reconciles every organization's model. A request
  naming a retired slug acts on what it resolves to. `GET /installed-kits`
  and `KitPresence` also list a retired slug in `effective` (`retired:
  true`) wherever everything it resolves to applies, so an old portal or
  desktop keeps its screens. **Step 7 (#1089) removes the table** one
  release after this reached every environment: `aliases_tests.rs` lists
  the aliases with that note and fails on a Studio past `REMOVE_AFTER`.
- Who brings a piece of the model now (ADR-0071 §6, §8), `owners.rs`:
  `KitOwners::builtin()` reads every built-in kit's overlay and claims
  into one table (type, field/relation/tab, lifecycle → kit). The
  `kit-rename` sweep (`DomainObjects::rename_kit_marks`,
  `domain_model/kit_rename.rs`) runs first and last in every kit
  reconciliation (`models.rs`): a `meta.kit`, `left_by.kit` or a
  property's `kit` of Studio's own kits that names a kit which no longer
  brings the piece moves to the kit that does, with its property source
  and the organization's overrides, as one model version `op = "kit-rename"`
  with no inverse; an organization's own kit is never touched. The ADR-0070
  §5 equality check compares marks as the sweep would leave them. Step 4
  moved, inside today's kits: Issues (now "Open questions", `/issues`),
  `finding`, `project.issues`, `kit.introduces_type_22` →
  `project-domain-model`; Timeline → `project-lifecycle` (no `needs`);
  project Components and `project.parts` → `product-releases` (both `project-product` since step 5).
- Declared dependencies between kits (ADR-0071 §5, step 3), `requires.rs`:
  a manifest's `requires` names the kits it cannot work without
  (`constructor-research` → `delivery`, `project-domain-model` →
  `project-specs`, `gears-matcher` → `project-product`). Each install (base, organization, project) computes
  what would apply afterwards on its level and refuses a kit whose
  requirement is not among it (400 `failed_precondition`,
  `KIT_REQUIRES_KIT`, one violation per missing kit); each uninstall refuses
  where a kit that still applies on that level requires it
  (`KIT_REQUIRED_BY`, one violation per requiring kit). Nothing is
  installed or uninstalled for the caller: the client offers both. A
  screen's `needs` is a domain type's GTS id
  (`gts.cf.studio.domain.<type>.v1~`, `manifest::needs_id_ok`); a bare
  entity id is refused when a manifest is read. The Tests tab's open pull
  requests section `needs` `pull-request`; Timeline `milestone`.
- What is inside a kit before anyone installs it (ADR-0068 §4), `contents.rs`:
  `GET /studio-kits/v1/catalog/{kit_slug}` (any signed-in user; 404 for a
  slug the library does not hold) answers `{kit, contents, manifest}`;
  `contents` holds every section of a kit manifest (`screens`, `types`,
  `rules`, `functions`, `services`, `inbox`, `mcp_tools`, `gears`, `requires`,
  `permissions`, `material`, `kinds`, `docs`), each present and possibly
  empty (`gears[].note` says when a claim's data starts from the next sync
  after an install). The kit
  page draws its model from them (#1099): each of `types` names its model
  `id`, whether it `adopts` a type the core has, and its `fields` (`origin`
  `kit` or `core`); `model` lists the fields and relations it adds on other
  types and the tabs it shows (`shows` relations), all by model id
  (`manifest.rs`, `model_contents`). Where it comes from, in `manifest`:
  - `built-in`: everything from its compiled-in `kit.json`, only what Studio has today (the tab, its route,
    the gears' routes its screen calls). Change it when the screen changes.
  - `.cf-studio-kit.toml`: an official kit, read from the copy of its
    manifest in `manifests/` at the commit `official_catalogue()` pins
    (material = each resource's `install_path`, kinds = the
    `[kits.resources.artifacts.<KIND>]` keys). Nothing is fetched on request.
    **Moving a pin means replacing that copy** — a test holds the two
    together. A deployment that pins another commit or repository gets empty
    contents and `null`.
  - `null`: nothing reliable describes the kit (organization kits, re-pinned
    kits).
  Also the MCP tool `kits_describe`. Its MCP tools carry their descriptions
  from the MCP registry (`archive::with_tool_descriptions`).
- A kit's type (`kind.rs`): every catalogue entry has `kind` (`runtime`,
  `gears`, `model`, `material`: the strongest tier it brings) and `brings`
  (every tier, strongest first), computed from its contents. Every built-in
  kit is `gears` (plus `model` with types or fields), the official kits
  `material`, a bundle kit `runtime`. Design: `docs/design/studio-kits.md`
  §3.14.
- A kit's files (`gdl.rs`, `archive.rs`): `GET /catalog/{kit_slug}/kit.gdl`
  (text; the MCP tool `kit_gdl`) renders its manifest in the GDL 1.7 shape of
  ADR-0068 §3, or serves a bundle kit's authored one; `/manifest` is the
  source manifest as written; `/archive` a `.tar.gz` of manifests, model,
  claims, working material (read at the pinned commit through a connection,
  `shelf::KitSourceReader::list_at` / `read_at`) and bundles, partial with a
  README note when a read fails. The rendering's golden files are in
  `golden/`; `UPDATE_GOLDEN=1 cargo test kit_registry::gdl` rewrites them.
- Who installs a kit (ADR-0069 §4), `installed.rs`: **base kits** for every
  organization, by a platform administrator, kept on the platform root
  (`00000000-…-0001`); **organization kits**, by the organization's
  administrators (owner, a role with `kit.manage`, or a platform
  administrator), kept on the organization; **project kits**, for one project,
  by whoever may install kits for the project's organization (a project has
  no access config of its own), kept on the project, and only a kit whose
  `levels` include `project` (400 `failed_precondition`,
  `NOT_A_PROJECT_KIT`). All are tenant metadata
  `cf.studio.kits.installed.v1~` (`config/*.yaml`, `override_only`, so a
  project never inherits its organization's document), written only by this
  gear as its service identity (`GEAR_HELD_METADATA`). A built-in kit is a
  base kit until a platform administrator removes it (`removed_builtin`). An
  organization cannot uninstall a base kit (400 `failed_precondition`,
  `BASE_KIT`); a project neither a base kit nor an organization kit
  (`BASE_KIT`, `ORGANIZATION_KIT`). A kit on more than one level applies at
  the newest version (dotted numbers compare as numbers, anything else by
  install time): `effective` = (base ∪ organization) ∪ project.

  | Method | Path | Who |
  | --- | --- | --- |
  | `GET` | `/studio-kits/v1/installed-kits?organization_id=` or `?project_id=` | any member: `{organization_id, project_id, base, organization, project, effective}` (`project` empty and `project_id` null without a project) |
  | `PUT` / `DELETE` | `/studio-kits/v1/base-kits/{kit_slug}` | platform administrator (`PLATFORM_ADMIN_REQUIRED`) |
  | `PUT` / `DELETE` | `/studio-kits/v1/organization-kits/{kit_slug}?organization_id=` | organization administrator (`KIT_ADMIN_REQUIRED`) |
  | `PUT` / `DELETE` | `/studio-kits/v1/project-kits/{kit_slug}?project_id=` | the project's organization administrator (`KIT_ADMIN_REQUIRED`) |

  `PUT` takes `{version?}` and answers the installation; `DELETE` answers 204.
  Each is also an MCP tool (`mcp.rs`): `kits_catalog`, `kits_describe`,
  `kits_installed`, `kit_base_install`, `kit_base_uninstall`,
  `kit_organization_install`, `kit_organization_uninstall`,
  `kit_project_install`, `kit_project_uninstall`. The project-scoped
  `/projects/{project_id}/installations` routes (what the IDE materializes)
  are a separate record and unchanged.
- An organization's own kits (ADR-0068 phase 7), `shelf.rs` and
  `manifest.rs`: a source is `{connection_id, repository, path, ref, slug?}`
  through one of the organization's own non-personal connections
  (studio-connector's `Repository`). It is pinned to the newest commit that
  touched `path` on `ref`, its manifest read there (`kit.json`, else
  `.cf-studio-kit.toml`) and checked, and the manifest kept in the
  organization's installed-kits document under `shelf`. Routes
  (`?organization_id=`): `GET /organization-shelf` (members),
  `POST /organization-shelf/preview`, `POST /organization-shelf`,
  `POST /organization-shelf/{kit_slug}/refresh`,
  `DELETE /organization-shelf/{kit_slug}` (kit administrators). Refusals:
  `KIT_SLUG_TAKEN` (a built-in or official slug), `KIT_INSTALLED` (removing an
  installed kit). `GET /catalog?organization_id=` adds the shelf;
  `GET /catalog/{kit_slug}` describes a shelf kit with `origin`. MCP:
  `kits_shelf`, `kit_shelf_preview`, `kit_shelf_add`, `kit_shelf_refresh`,
  `kit_shelf_remove`. `kit.json` is documented in
  `docs/design/studio-kits.md` §3.9.
- A kit's model overlay (ADR-0067 §6), `models.rs`: the overlay is `model` in
  a `kit.json` (a built-in kit's in `builtin/<slug>.kit.json`, compiled in;
  format in `docs/design/studio-kits.md` §3.10 and
  `domain_model/kit_overlay.rs`). It goes into the organization's model
  through the domain model's port (`sync_kit_model`, `kit_models`) as this
  gear's service identity: before an organization install is recorded (a
  conflict is 400 `KIT_MODEL_CONFLICT` and nothing is recorded), after an
  organization uninstall, and for base kits when an organization's installed
  kits are read (`models_in_step`: only when the kits that apply differ from
  the ones last reconciled, or after 30 minutes; a read never writes
  otherwise). Same-version reconciliation is idempotent
  and captures/adopts known property sources and organization tombstones.
  Overlays are still projected into each
  organization's stored model, not layered; a kit that brings a model is not
  installed for one project (`MODEL_KIT_NOT_FOR_PROJECT`). Without the domain
  model in the assembly, kits install and the model is left alone.
- Whether a kit applies, for another gear (`port.rs` `KitPresence`,
  registered in the ClientHub): for a project its effective kits (base ∪
  organization ∪ its own), for an organization base ∪ its own, as
  `GET /installed-kits` answers. studio-environments asks it for
  `constructor-research` (levels organization and project, opt-in, a
  compiled-in `builtin/constructor-research.kit.json`): the project's answer
  before a build, deploy or rollback or a project's own Research environment,
  the organization's before an organization's Research environment or its
  Research projects/hardware listing (400 `failed_precondition`,
  `KIT_NOT_INSTALLED`, through `port::require_kit`); status, logs, uninstall
  and removal stay. Design:
  `docs/design/studio-kits.md` §3.13. studio-product asks it for
  `gears-matcher` (ADR-0072): a project choosing the `gears_matcher` assembly
  strategy, and the strategy read, which falls back where the kit does not
  apply; studio-spec-mapping asks it for `spec-mapping` before the plan,
  findings and decisions are read (ADR-0074). The gear-match writes and tools that kit claims
  answer `KIT_NOT_INSTALLED` through the shared check.
- `project-lifecycle` is the first built-in kit with a model: the type
  `project-lifecycle-phase`, `project.phase` / `phase_owner` / `phase_since`,
  the tab `project.phases` and the phase lifecycle. Its function is
  `src/project_lifecycle` (a kit gear on the kit-runtime port, `runtime.rs`):
  `GET`/`PUT /project-phase?project_id=` (moves only along a
  declared transition, `NO_SUCH_TRANSITION`; `KIT_NOT_INSTALLED` where it
  does not apply; written as the caller, `DOMAIN_EDIT_REQUIRED` when the PDP
  refuses) and `GET /project-phases?organization_id=`. MCP: `project_phase`,
  `project_phase_set`, `project_phases`.
- Inbox sources (ADR-0068 §6), `inbox.rs`: a kit's `inbox` in its
  `kit.json`, of two kinds. `query` (default): `{id, label, query, title?,
  workspace_field?}`, the query a domain query naming its `type`, `"$me"` the
  person. `endpoint`: `{id, label, kind: "endpoint", path, title?}`, `path` a
  literal `GET` route of Studio's own that the kit's `permissions.reads`
  names, answering `{items: [{id, title?, workspace_id?, url?, due_at?,
  overdue?}]}` for the caller. `GET /inbox-sources` (`?organization_id=`,
  members) lists those of the kits installed for the whole organization at
  their installed version, plus the `endpoint` sources of a built-in kit a
  project may install alone; studio-user's `GET /me/inbox` runs them as the
  person (a query, or a call of the route). MCP `kits_inbox_sources`.
  Project lifecycle brings `phase-waiting`; Constructor Research
  `deploy-failed` and `sign-in-expires`.

- A kit's micro-frontends at run time (ADR-0068 phase 5), `bundles.rs`:
  `STUDIO_KIT_BUNDLES_DIR` names a directory whose every subdirectory with a
  `kit.gdl` naming bundles (`mfe = [path("mfe/<package>")]`, GDL 1.7) is a
  kit on the `organization` shelf (`source` = `bundle-dir`), at the version
  its passport states; a slug the library already holds is left out, and so
  is a kit whose passport does not read (a warning, not a stop). A named
  directory that cannot be read stops the gear at start.
  `GET /studio-kits/v1/mfe-manifests?organization_id=|project_id=` (any member,
  scope as `installed-kits`) lists each package of the effective kits with
  bundles at their installed version: `mfe-manifest.json` as `config` (null
  with `error` when it does not read) and `base_path`;
  `GET /studio-kits/v1/kits/{kit_slug}/{version}/mfe/{grant}/{package}/{*file}`
  serves the files, anonymous (the shell's loader sends no token) and guarded
  by `grant`, an HMAC of slug and version under `STUDIO_KIT_BUNDLE_KEY` (else a
  key drawn at start: set it when there is more than one replica). Only a
  bundle's own file types, never HTML, hidden files or anything outside the
  package. The demo is `studio-frontend/examples/kits/hello-kit`;
  the design is `docs/design/studio-kits.md` §3.12.
- The prototype flow and the installer inside the session are in the
  repository-root [`docs/kit-registry-prototype.md`](../../../docs/kit-registry-prototype.md).
