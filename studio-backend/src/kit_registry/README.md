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
- Who installs a kit (ADR-0069 §4), `installed.rs`: **base kits** for every
  organization, by a platform administrator, kept on the platform root
  (`00000000-…-0001`); **organization kits**, by the organization's
  administrators (owner, a role with `kit.manage`, or a platform
  administrator), kept on the organization. Both are tenant metadata
  `cf.studio.kits.installed.v1~` (`config/*.yaml`, `override_only`), written
  only by this gear as its service identity (`GEAR_HELD_METADATA`). A built-in
  kit is a base kit until a platform administrator removes it
  (`removed_builtin`). An organization cannot uninstall a base kit (400
  `failed_precondition`, `BASE_KIT`); a kit that is both applies at the newer
  version (dotted numbers compare as numbers, anything else by install time).

  | Method | Path | Who |
  | --- | --- | --- |
  | `GET` | `/studio-kits/v1/installed-kits?organization_id=` | any member: `{organization_id, base, organization, effective}` |
  | `PUT` / `DELETE` | `/studio-kits/v1/base-kits/{kit_slug}` | platform administrator (`PLATFORM_ADMIN_REQUIRED`) |
  | `PUT` / `DELETE` | `/studio-kits/v1/organization-kits/{kit_slug}?organization_id=` | organization administrator (`KIT_ADMIN_REQUIRED`) |

  `PUT` takes `{version?}` and answers the installation; `DELETE` answers 204.
  Each is also an MCP tool (`mcp.rs`): `kits_catalog`, `kits_installed`,
  `kit_base_install`, `kit_base_uninstall`, `kit_organization_install`,
  `kit_organization_uninstall`.
- The prototype flow and the installer inside the session are in the
  repository-root [`docs/kit-registry-prototype.md`](../../../docs/kit-registry-prototype.md).
