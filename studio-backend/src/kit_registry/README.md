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
  through [`../studio_theia`](../studio_theia), so they need a backend built
  with the `theia-bridge` feature and a running session; without either they
  answer 503.
- A project's installations are one tenant-metadata document,
  `cf.studio.project.kit_installations.v1~`, declared in `config/*.yaml`.
- The library has three shelves (`shelf` on each catalogue entry):
  `builtin` (`builtin_catalogue()` in `service.rs`, compiled in, at Studio's
  own version, empty `repository_url`), `official` (the catalogue above) and
  `organization` (none yet: ADR-0068 phase 7). `?shelf=` filters
  `GET /catalog`; the IDE asks for `official` only, the kits `cfs` can install.
  The built-in kits are the portal's features, each arriving as a kit:
  `project-lifecycle`, `project-issues`, `project-tests`, `project-artifacts`,
  `project-activity`, `project-specs`, `org-costs`, `org-reports` and
  `studio-api-docs` (level `platform`). A feature ported into the portal is
  added here, with its contents in `contents.rs`.
- What is inside a kit before anyone installs it (ADR-0068 §4), `contents.rs`:
  `GET /studio-kits/v1/catalog/{kit_slug}` (any signed-in user; 404 for a
  slug the library does not hold) answers `{kit, contents, manifest}`;
  `contents` holds every section of a kit manifest (`screens`, `types`,
  `rules`, `functions`, `services`, `inbox`, `mcp_tools`, `permissions`,
  `material`, `kinds`, `docs`), each present and possibly empty. Where it
  comes from, in `manifest`:
  - `built-in`: declared in `builtin_contents()`, only what Studio has today
    (the tab, its route, the gears' routes its screen calls). Change it when
    the screen changes.
  - `.cf-studio-kit.toml`: an official kit, read from the copy of its
    manifest in `manifests/` at the commit `official_catalogue()` pins
    (material = each resource's `install_path`, kinds = the
    `[kits.resources.artifacts.<KIND>]` keys). Nothing is fetched on request.
    **Moving a pin means replacing that copy** — a test holds the two
    together. A deployment that pins another commit or repository gets empty
    contents and `null`.
  - `null`: nothing reliable describes the kit (organization kits, re-pinned
    kits).
  Also the MCP tool `kits_describe`.
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
- The prototype flow and the installer inside the session are in the
  repository-root [`docs/kit-registry-prototype.md`](../../../docs/kit-registry-prototype.md).
