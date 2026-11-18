//! A kit's manifest as Studio reads it from a repository, until `kit.gdl`
//! exists (ADR-0068 §3).
//!
//! Two files are read, in this order, in the kit's directory:
//!
//! - **`kit.json`**: Studio's interim manifest. It declares the same sections
//!   a kit brings ([`super::contents::KitContents`]) — `screens`, `model` (its
//!   types and the overlay on the organization's model), `rules`,
//!   `functions`, `services`, `inbox`, `mcp_tools`, `permissions`,
//!   `material`, `kinds`, `docs` — beside who the kit is (`slug`, `name`,
//!   `levels`, ...) and the built micro-frontends it carries (`mfe`, as
//!   `kit.gdl`'s `mfe = [path("mfe/<package>")]`). Unknown keys are refused, so a typo is a diagnostic
//!   before anything is added rather than a section quietly missing. When
//!   `kit.gdl` lands, its `kit(...)` call takes the same names.
//! - **`.cf-studio-kit.toml`**: the installer's manifest `cfs` reads. A kit
//!   described only by it brings working material: its resources'
//!   `install_path`s and its artifact kinds, read line by line as the
//!   official kits' copies are ([`super::contents`]).
//!
//! Nothing here fetches; the shelf reads the file through a connection and
//! hands its text over.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::contents::{
    KitContents, KitField, KitFunction, KitInboxSource, KitMaterial, KitModel, KitModelTab,
    KitNamed, KitPermissions, KitRelation, KitScreen, KitType, ORIGIN_CORE, ORIGIN_KIT,
};
use super::service::normalize_slug;
use crate::domain_model::port::{KitOverlay, OverlayType, validate_kit_overlay};

/// Studio's interim manifest.
pub const KIT_JSON: &str = "kit.json";
/// The installer's manifest.
pub const CF_STUDIO_KIT_TOML: &str = ".cf-studio-kit.toml";
/// The files a kit's directory is read for, in order.
pub const MANIFEST_FILES: [&str; 2] = [KIT_JSON, CF_STUDIO_KIT_TOML];

/// The levels an organization's own kit may name: not `platform`, which is
/// the base kits' and installed for everybody.
pub const ORGANIZATION_LEVELS: [&str; 3] = ["organization", "workspace", "project"];

/// The most a manifest file may weigh: a description, not a payload.
pub const MAX_MANIFEST_BYTES: usize = 256 * 1024;

/// What a `kit.json` says, as written. Also what an organization's shelf
/// keeps of a kit: the manifest at the pinned commit, so describing the kit
/// later reads nothing.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KitManifest {
    /// `"1"`; absent reads as 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest_version: Option<String>,
    pub slug: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub publisher: String,
    /// The kit's own version, for people; the pin is the commit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default)]
    pub levels: Vec<String>,
    /// This built-in kit can be selected as the project's type at creation.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub project_type: bool,
    /// The kit's icon (#1081): `lucide:<name>`, as a screen's `mfe.json`
    /// names one, or an SVG inside one of its bundles,
    /// `mfe/<package>/<file>.svg`, served through the kit bundle route
    /// ([`kit_icon`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// The kit's built micro-frontends, each a directory beside the manifest,
    /// `mfe/<package>` (as `kit.gdl`'s `mfe = [path(...)]`): served to the
    /// shell from the repository at the pinned commit
    /// ([`super::shelf_bundles`]).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mfe: Vec<String>,
    #[serde(default)]
    pub screens: Vec<ManifestScreen>,
    /// The model overlay (ADR-0067 §6): types, fields, relations, tabs and
    /// lifecycles. Kept as written here; the domain model reads it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<Value>,
    #[serde(default)]
    pub rules: Vec<ManifestNamed>,
    #[serde(default)]
    pub functions: Vec<ManifestFunction>,
    #[serde(default)]
    pub services: Vec<ManifestNamed>,
    #[serde(default)]
    pub inbox: Vec<ManifestInboxSource>,
    #[serde(default)]
    pub mcp_tools: Vec<ManifestNamed>,
    #[serde(default)]
    pub permissions: ManifestPermissions,
    #[serde(default)]
    pub material: Vec<ManifestMaterial>,
    #[serde(default)]
    pub kinds: Vec<String>,
    #[serde(default)]
    pub docs: Vec<String>,
    /// What the kit claims of each gear it stands for (ADR-0071 §1, §2):
    /// the gear's types whose state and `meta.kit` the kit decides, the
    /// gear's MCP tools and its write routes, which answer
    /// `KIT_NOT_INSTALLED` where the kit does not apply. A claim declares
    /// nothing: the type still comes from the gear's `TypeNeed`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub gears: Vec<ManifestGearClaim>,
    /// The slugs of the kits this kit cannot work without (ADR-0071 §5,
    /// answering ADR-0068 open question 2): the installer refuses an install
    /// where one of them does not apply, and an uninstall that would leave a
    /// kit that applies without one (`KIT_REQUIRES_KIT`, `KIT_REQUIRED_BY`).
    /// A relation to another kit's type needs no such declaration: it is
    /// unresolved while that kit is absent (ADR-0070 §2).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub requires: Vec<String>,
}

/// The GTS id a screen's `needs` names a domain type by (ADR-0071 §5):
/// `gts.cf.studio.domain.<type>.v1~`, the type's id with `-` as `_`, or a
/// kit's own type, `gts.cf.studio.kit.<slug>.<type>.v1~`.
pub fn needs_id_ok(id: &str) -> bool {
    let Some(rest) = id
        .strip_prefix("gts.cf.studio.")
        .and_then(|r| r.strip_suffix(".v1~"))
    else {
        return false;
    };
    let tokens: Vec<&str> = rest.split('.').collect();
    let well_formed = |t: &str| {
        !t.is_empty()
            && t.starts_with(|c: char| c.is_ascii_lowercase())
            && t.chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    };
    match tokens.as_slice() {
        ["domain", leaf] => well_formed(leaf),
        ["kit", slug, leaf] => well_formed(slug) && well_formed(leaf),
        _ => false,
    }
}

/// The GTS id of the domain type `entity_id` (`pull-request` →
/// `gts.cf.studio.domain.pull_request.v1~`), as a screen's `needs` names it.
pub fn domain_type_gts(entity_id: &str) -> String {
    crate::domain_model::port::node_type_id(entity_id)
}

/// What a kit claims of one gear (ADR-0071 §2). One type, tool or write
/// route belongs to one kit: two kits claiming the same is
/// `KIT_MODEL_CONFLICT`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestGearClaim {
    /// The gear's name, `studio-<name>`.
    pub gear: String,
    /// Ids of types the gear declares through its `TypeNeed`, held or open.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub types: Vec<String>,
    /// Names of tools the gear's MCP serves.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcp_tools: Vec<String>,
    /// The gear's **write** routes, `METHOD /path` as `permissions.writes`
    /// names them (and each is also there). Reads are never claimed: shell
    /// summaries and other kits' screens keep reading them (ADR-0071 §4).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub routes: Vec<String>,
    /// The gear may skip its expensive sync of these types where the kit does
    /// not apply (ADR-0071 §4). Off by default: with it, a reinstall finds
    /// data only from the next sync on.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub sync_only_with_kit: bool,
}

/// `requires` as written: kit slugs, each once, never the kit's own.
fn check_requires(m: &KitManifest) -> Result<(), String> {
    let mut seen: Vec<&str> = Vec::new();
    for r in &m.requires {
        let slug = normalize_slug(r).map_err(|e| format!("{KIT_JSON}: requires: {e}"))?;
        if slug != *r {
            return Err(format!(
                "{KIT_JSON}: requires: `{r}` must be a lowercase slug"
            ));
        }
        if *r == m.slug {
            return Err(format!(
                "{KIT_JSON}: requires: a kit does not require itself"
            ));
        }
        if seen.contains(&r.as_str()) {
            return Err(format!("{KIT_JSON}: requires: `{r}` is named twice"));
        }
        seen.push(r);
    }
    if m.requires.len() > 16 {
        return Err(format!("{KIT_JSON}: requires: at most 16 kits"));
    }
    Ok(())
}

/// The methods of a write route a kit may claim.
pub const WRITE_METHODS: [&str; 4] = ["POST", "PUT", "PATCH", "DELETE"];

/// `(method, path)` of a claimed route, `METHOD /path`, when it is a write
/// route of `gear`'s own (`/<gear>/v1/…`); the error says why not.
pub fn claimed_route<'a>(route: &'a str, gear: &str) -> Result<(&'a str, &'a str), String> {
    let Some((method, path)) = route.split_once(' ') else {
        return Err(format!("`{route}` is not `METHOD /path`"));
    };
    if !WRITE_METHODS.contains(&method) {
        return Err(format!(
            "`{route}` is not a write route ({}): reads are not claimed",
            WRITE_METHODS.join(", ")
        ));
    }
    let prefix = format!("/{gear}/v1/");
    if !path.starts_with(&prefix) || path.contains(['?', '#', ' ']) || path.contains("//") {
        return Err(format!("`{route}` is not a route of `{gear}` ({prefix}…)"));
    }
    Ok((method, path))
}

/// The `gears` section's own rules: gear names, ids and write routes as
/// written, each claimed route also in `permissions.writes`, and nothing
/// claimed twice. Whether two kits claim the same thing is checked where
/// both are known (the built-in kits' test, the shelf).
fn check_claims(m: &KitManifest) -> Result<(), String> {
    let name_ok = |s: &str, sep: char| {
        !s.is_empty()
            && s.len() <= 80
            && s.starts_with(|c: char| c.is_ascii_lowercase())
            && s.chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == sep)
    };
    let mut gears: Vec<&str> = Vec::new();
    let mut types: Vec<&str> = Vec::new();
    let mut tools: Vec<&str> = Vec::new();
    let mut routes: Vec<&str> = Vec::new();
    for claim in &m.gears {
        if !claim.gear.starts_with("studio-") || !name_ok(&claim.gear, '-') {
            return Err(format!(
                "{KIT_JSON}: gears: `{}` is not a gear's name (`studio-<name>`)",
                claim.gear
            ));
        }
        if gears.contains(&claim.gear.as_str()) {
            return Err(format!(
                "{KIT_JSON}: gears: `{}` is named twice; one entry per gear",
                claim.gear
            ));
        }
        gears.push(&claim.gear);
        if let Some(t) = claim.types.iter().find(|t| !name_ok(t, '-')) {
            return Err(format!(
                "{KIT_JSON}: gears: `{t}` is not a type id (lowercase letters, digits, `-`)"
            ));
        }
        if let Some(t) = claim.mcp_tools.iter().find(|t| !name_ok(t, '_')) {
            return Err(format!(
                "{KIT_JSON}: gears: `{t}` is not a tool name (lowercase letters, digits, `_`)"
            ));
        }
        for r in &claim.routes {
            claimed_route(r, &claim.gear).map_err(|why| format!("{KIT_JSON}: gears: {why}"))?;
            if !m.permissions.writes.contains(r) {
                return Err(format!(
                    "{KIT_JSON}: gears: `{r}` is claimed and `permissions.writes` does not name \
                     it; a claimed route is one the kit writes"
                ));
            }
        }
        types.extend(claim.types.iter().map(String::as_str));
        tools.extend(claim.mcp_tools.iter().map(String::as_str));
        routes.extend(claim.routes.iter().map(String::as_str));
    }
    for (what, list) in [
        ("type", &mut types),
        ("tool", &mut tools),
        ("route", &mut routes),
    ] {
        list.sort_unstable();
        if let Some(w) = list.windows(2).find(|w| w[0] == w[1]) {
            return Err(format!(
                "{KIT_JSON}: gears: the {what} `{}` is claimed twice",
                w[0]
            ));
        }
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestScreen {
    /// `tab` or `section`.
    pub kind: String,
    pub level: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot: Option<String>,
    /// The domain types the screen shows that another kit brings (`milestone`
    /// for a timeline): where one is not installed, the shell hides it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub needs: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestNamed {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestFunction {
    pub name: String,
    /// `wasm` or `agent`.
    pub runtime: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// An Inbox source (ADR-0068 §6): a query over the kit's objects that says
/// what waits on whom.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestInboxSource {
    pub id: String,
    pub label: String,
    /// How its items are read: [`INBOX_KIND_QUERY`] (the default),
    /// [`INBOX_KIND_ENDPOINT`] or [`INBOX_KIND_STUDIO`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// For a `query` source: the body `POST /studio-domain-model/v1/query`
    /// takes; the string `"$me"` anywhere in it is the person whose Inbox is
    /// read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<Value>,
    /// For an `endpoint` source: a gear's route, `GET` without a query
    /// string, that answers `{items: [{id, title?, …}]}` for the person who
    /// calls it. The kit's `permissions.reads` names it (`GET <path>`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// The item's title: `{field}` is the field of the object.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The object's field naming the workspace an item is in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_field: Option<String>,
    /// Which tool answers an item (ADR-0068 §6): the kit's screen it opens
    /// and the kit's MCP tool that acts on it. Without one an item opens the
    /// kit's workspace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination: Option<ManifestInboxDestination>,
}

/// Where an Inbox item is answered.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestInboxDestination {
    /// The portal route of the kit's screen that answers it, one of its
    /// `screens[].route` (`/projects/issues`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route: Option<String>,
    /// One of the kit's `mcp_tools`, for an agent working the Inbox.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_tool: Option<String>,
}

/// An Inbox source whose items are a domain query's rows over the kit's
/// objects (ADR-0068 §6).
pub const INBOX_KIND_QUERY: &str = "query";
/// An Inbox source whose items a gear's route answers for the person, from
/// records that are not domain objects (a deploy, a sign-in).
pub const INBOX_KIND_ENDPOINT: &str = "endpoint";
/// An Inbox source Studio's Inbox reads itself, known by its id (one of
/// [`STUDIO_INBOX_SOURCES`]), that a built-in kit brings: the kit says
/// whether it applies, the Inbox how it is read (ADR-0070 §7). A kit of an
/// organization's shelf that declares one brings nothing.
pub const INBOX_KIND_STUDIO: &str = "studio";
/// The sources a [`INBOX_KIND_STUDIO`] source may name: review requests
/// (studio-documents, project-specs) and pull requests (studio-artifact-
/// ingest, project-git).
pub const STUDIO_INBOX_SOURCES: &[&str] = &["review-requests", "pull-requests"];

impl ManifestInboxSource {
    /// The source's kind; a source that names none is a `query`.
    pub fn kind(&self) -> &str {
        self.kind.as_deref().unwrap_or(INBOX_KIND_QUERY)
    }
}

/// Why `path` cannot be an endpoint source's route: a gear's own route
/// (`/studio-<gear>/v1/…`), literal, with no query string, no `..` and no
/// parameter. `None` when it can.
pub fn endpoint_path_problem(path: &str) -> Option<&'static str> {
    if !path.starts_with("/studio-") || !path.contains("/v1/") {
        return Some("a gear's own route, /studio-<gear>/v1/…");
    }
    if path.contains(['?', '#', '{', '}', '\\', ' ']) || path.contains("..") || path.contains("//")
    {
        return Some("a literal path: no query string, parameter, `..` or empty segment");
    }
    if path.len() > 200 {
        return Some("at most 200 characters");
    }
    None
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestPermissions {
    #[serde(default)]
    pub reads: Vec<String>,
    #[serde(default)]
    pub writes: Vec<String>,
    #[serde(default)]
    pub listens: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestMaterial {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// The GTS id a kit's type is catalogued under (ADR-0068 §8):
/// `gts.cf.studio.kit.<slug>.<type>.v1~`, each token with `-` as `_`.
pub use crate::domain_model::port::kit_type_gts;

/// The `kit.json` of the built-in kits that bring more than a screen: a
/// model, an Inbox source, MCP tools. Compiled in, read like any other.
const BUILTIN_MANIFESTS: &[(&str, &str)] = &[
    (
        "project-lifecycle",
        include_str!("builtin/project-lifecycle.kit.json"),
    ),
    // `report` and the organization's Reports tab, moved out of the core
    // (ADR-0070 phase 5): declared with their existing ids.
    ("org-reports", include_str!("builtin/org-reports.kit.json")),
    ("assistant", include_str!("builtin/assistant.kit.json")),
    ("project-git", include_str!("builtin/project-git.kit.json")),
    // From a build to a running environment (ADR-0071 §6): org-infrastructure
    // and product-releases' Releases, merged.
    ("delivery", include_str!("builtin/delivery.kit.json")),
    ("org-costs", include_str!("builtin/org-costs.kit.json")),
    // What the product is made of (ADR-0071 §6): product-releases' Product
    // and the project's Components.
    (
        "project-product",
        include_str!("builtin/project-product.kit.json"),
    ),
    (
        "project-domain-model",
        include_str!("builtin/project-domain-model.kit.json"),
    ),
    ("components", include_str!("builtin/components.kit.json")),
    (
        "project-specs",
        include_str!("builtin/project-specs.kit.json"),
    ),
    (
        "project-tests",
        include_str!("builtin/project-tests.kit.json"),
    ),
    // The two project types, in the order the New project wizard offers
    // them (`project_type_kits`): Gears, then Constructor Research.
    (
        "gears-project",
        include_str!("builtin/gears-project.kit.json"),
    ),
    (
        "constructor-research",
        include_str!("builtin/constructor-research.kit.json"),
    ),
    // What the gears-matcher service reads in a project's specifications
    // (ADR-0072): the gear-match screens, routes, tools and Inbox source,
    // out of project-product; opt-in.
    (
        "gears-matcher",
        include_str!("builtin/gears-matcher.kit.json"),
    ),
    // The API reference: a screen (`contents.rs`) and the route it reads.
    (
        "studio-api-docs",
        include_str!("builtin/studio-api-docs.kit.json"),
    ),
];

/// Built-in kit `slug`'s `kit.json`, when it has one.
pub fn builtin_manifest(slug: &str) -> Option<KitManifest> {
    builtin_manifest_text(slug).map(|body| read_kit_json(body).expect("a built-in kit.json reads"))
}

pub(crate) fn project_type_kit(slug: &str) -> Option<KitManifest> {
    builtin_manifest(slug).filter(|kit| kit.project_type)
}

pub(crate) fn project_type_kits() -> impl Iterator<Item = KitManifest> {
    BUILTIN_MANIFESTS
        .iter()
        .filter_map(|(slug, _)| project_type_kit(slug))
}

/// Built-in kit `slug`'s compiled-in `kit.json` as written, for a kit's
/// page and its archive.
pub fn builtin_manifest_text(slug: &str) -> Option<&'static str> {
    BUILTIN_MANIFESTS
        .iter()
        .find(|(s, _)| *s == slug)
        .map(|(_, body)| *body)
}

/// A manifest's model overlay, read and checked; `None` when it brings no
/// model.
pub fn overlay_of(m: &KitManifest) -> Result<Option<KitOverlay>, String> {
    let Some(model) = &m.model else {
        return Ok(None);
    };
    let overlay: KitOverlay = serde_json::from_value(model.clone())
        .map_err(|e| format!("{KIT_JSON}: `model` does not read: {e}"))?;
    validate_kit_overlay(&m.slug, &overlay).map_err(|e| format!("{KIT_JSON}: `model`: {e}"))?;
    let empty = overlay.types.is_empty()
        && overlay.fields.is_empty()
        && overlay.relations.is_empty()
        && overlay.tabs.is_empty()
        && overlay.lifecycles.is_empty()
        && overlay.properties.is_empty();
    Ok((!empty).then_some(overlay))
}

/// Read a `kit.json`, and check what can be checked without the model:
/// the slug, the name, the levels, the screens and the functions.
pub fn read_kit_json(body: &str) -> Result<KitManifest, String> {
    if body.len() > MAX_MANIFEST_BYTES {
        return Err(format!(
            "{KIT_JSON} is {} bytes; a manifest is at most {MAX_MANIFEST_BYTES}",
            body.len()
        ));
    }
    let manifest: KitManifest =
        serde_json::from_str(body).map_err(|e| format!("{KIT_JSON} does not read: {e}"))?;
    check(&manifest)?;
    Ok(manifest)
}

fn check(m: &KitManifest) -> Result<(), String> {
    if let Some(v) = m.manifest_version.as_deref()
        && v.trim() != "1"
    {
        return Err(format!(
            "{KIT_JSON}: manifest_version {v} is not one this Studio reads (1)"
        ));
    }
    let slug = normalize_slug(&m.slug).map_err(|e| format!("{KIT_JSON}: {e}"))?;
    if slug != m.slug {
        return Err(format!(
            "{KIT_JSON}: the slug `{}` must be lowercase",
            m.slug
        ));
    }
    let name = m.name.trim();
    if name.is_empty() || name.chars().count() > 120 {
        return Err(format!("{KIT_JSON}: `name` is 1..=120 characters"));
    }
    for level in &m.levels {
        if !ORGANIZATION_LEVELS.contains(&level.as_str()) {
            return Err(format!(
                "{KIT_JSON}: level `{level}` is not one an organization's kit may name ({})",
                ORGANIZATION_LEVELS.join(", ")
            ));
        }
    }
    if m.project_type && !m.levels.iter().any(|level| level == "project") {
        return Err(format!(
            "{KIT_JSON}: a project type must name the project level"
        ));
    }
    for s in &m.screens {
        if !matches!(s.kind.as_str(), "tab" | "section") {
            return Err(format!(
                "{KIT_JSON}: screen `{}` is a `{}`; a screen is a `tab` or a `section`",
                s.label, s.kind
            ));
        }
        if !m.levels.contains(&s.level) {
            return Err(format!(
                "{KIT_JSON}: screen `{}` is on the {} level, which `levels` does not name",
                s.label, s.level
            ));
        }
    }
    for path in &m.mfe {
        if super::bundles::package_name(path).is_none() {
            return Err(format!(
                "{KIT_JSON}: mfe \"{path}\" is not `mfe/<package>` (lowercase letters, digits, `-`, `_`)"
            ));
        }
    }
    if m.mfe.len() > 16 {
        return Err(format!("{KIT_JSON}: at most 16 `mfe` packages"));
    }
    if let Some(icon) = m.icon.as_deref() {
        kit_icon(icon, &m.mfe)
            .map_err(|why| format!("{KIT_JSON}: icon \"{icon}\" is not {why}"))?;
    }
    for f in &m.functions {
        if !matches!(f.runtime.as_str(), "wasm" | "agent") {
            return Err(format!(
                "{KIT_JSON}: function `{}` runs as `{}`; a function is `wasm` or `agent`",
                f.name, f.runtime
            ));
        }
    }
    let mut ids: Vec<&str> = m.inbox.iter().map(|s| s.id.as_str()).collect();
    ids.sort_unstable();
    if ids.windows(2).any(|w| w[0] == w[1]) {
        return Err(format!("{KIT_JSON}: two inbox sources share an id"));
    }
    for s in &m.inbox {
        if let Some(d) = &s.destination {
            if let Some(route) = d.route.as_deref()
                && !m.screens.iter().any(|x| x.route.as_deref() == Some(route))
            {
                return Err(format!(
                    "{KIT_JSON}: inbox source `{}`: destination route `{route}` is none of the \
                     kit's `screens[].route`",
                    s.id
                ));
            }
            if let Some(tool) = d.mcp_tool.as_deref()
                && !m.mcp_tools.iter().any(|t| t.name == tool)
            {
                return Err(format!(
                    "{KIT_JSON}: inbox source `{}`: destination tool `{tool}` is none of the \
                     kit's `mcp_tools`",
                    s.id
                ));
            }
        }
        match s.kind() {
            INBOX_KIND_QUERY => {
                if s.path.is_some() {
                    return Err(format!(
                        "{KIT_JSON}: inbox source `{}`: a `query` source has no `path`",
                        s.id
                    ));
                }
                if let Some(q) = &s.query
                    && q.get("type")
                        .and_then(Value::as_str)
                        .is_none_or(str::is_empty)
                {
                    return Err(format!(
                        "{KIT_JSON}: inbox source `{}`: `query` is a domain query naming its `type`",
                        s.id
                    ));
                }
            }
            INBOX_KIND_ENDPOINT => {
                if s.query.is_some() || s.workspace_field.is_some() {
                    return Err(format!(
                        "{KIT_JSON}: inbox source `{}`: an `endpoint` source has no `query` or \
                         `workspace_field`: its route answers the items",
                        s.id
                    ));
                }
                let Some(path) = s.path.as_deref() else {
                    return Err(format!(
                        "{KIT_JSON}: inbox source `{}`: an `endpoint` source names its `path`",
                        s.id
                    ));
                };
                if let Some(why) = endpoint_path_problem(path) {
                    return Err(format!(
                        "{KIT_JSON}: inbox source `{}`: `path` {path} is not a route it may \
                         name: {why}",
                        s.id
                    ));
                }
                let read = format!("GET {path}");
                if !m.permissions.reads.contains(&read) {
                    return Err(format!(
                        "{KIT_JSON}: inbox source `{}`: `permissions.reads` does not name \
                         `{read}`; the administrator approves the routes a kit calls",
                        s.id
                    ));
                }
            }
            INBOX_KIND_STUDIO => {
                if !STUDIO_INBOX_SOURCES.contains(&s.id.as_str()) {
                    return Err(format!(
                        "{KIT_JSON}: inbox source `{}`: a `{INBOX_KIND_STUDIO}` source is one \
                         Studio reads itself: {}",
                        s.id,
                        STUDIO_INBOX_SOURCES.join(", ")
                    ));
                }
                if s.query.is_some()
                    || s.path.is_some()
                    || s.workspace_field.is_some()
                    || s.title.is_some()
                {
                    return Err(format!(
                        "{KIT_JSON}: inbox source `{}`: a `{INBOX_KIND_STUDIO}` source has no \
                         `query`, `path`, `title` or `workspace_field`: Studio reads it",
                        s.id
                    ));
                }
            }
            other => {
                return Err(format!(
                    "{KIT_JSON}: inbox source `{}` is a `{other}`; a source is a `{INBOX_KIND_QUERY}`, \
                     an `{INBOX_KIND_ENDPOINT}` or a `{INBOX_KIND_STUDIO}`",
                    s.id
                ));
            }
        }
    }
    if m.model.as_ref().is_some_and(|v| !v.is_object()) {
        return Err(format!("{KIT_JSON}: `model` is an object"));
    }
    for s in &m.screens {
        if let Some(n) = s.needs.iter().find(|n| !needs_id_ok(n)) {
            return Err(format!(
                "{KIT_JSON}: screen `{}` needs `{n}`, which is not a domain type's GTS id \
                 (`gts.cf.studio.domain.<type>.v1~`, the type's id with `-` as `_`)",
                s.label
            ));
        }
    }
    check_requires(m)?;
    check_claims(m)?;
    // The overlay's own rules (ADR-0067 §6); the organization's model is
    // checked against it when the kit is installed.
    overlay_of(m)?;
    Ok(())
}

/// A lucide icon's prefix, as a screen's `presentation.icon` takes it.
pub const LUCIDE_ICON_PREFIX: &str = "lucide:";

/// A kit's icon, read ([`kit_icon`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KitIcon<'a> {
    /// A lucide glyph by name (`package`), which the shell draws itself.
    Lucide(&'a str),
    /// An SVG file in one of the kit's bundles: the `<package>` of
    /// `mfe/<package>` and the file's path inside it.
    Bundled { package: &'a str, file: &'a str },
}

/// Read a kit's `icon` against the bundles the kit declares (`mfe`):
/// `lucide:<name>` (lowercase letters, digits and `-`), or
/// `mfe/<package>/<path>.svg` where `mfe/<package>` is one of `mfe` and the
/// path is one the bundle route serves (relative, no `..`, no hidden part).
/// The error says what an icon is.
pub fn kit_icon<'a>(icon: &'a str, mfe: &[String]) -> Result<KitIcon<'a>, String> {
    if let Some(name) = icon.strip_prefix(LUCIDE_ICON_PREFIX) {
        let ok = !name.is_empty()
            && name.len() <= 64
            && name.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
            && name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
        return if ok {
            Ok(KitIcon::Lucide(name))
        } else {
            Err("a lucide name: `lucide:` and lowercase letters, digits and `-`".to_owned())
        };
    }
    let bundled =
        "`lucide:<name>` or an SVG in one of the kit's bundles, `mfe/<package>/<file>.svg`";
    let Some((package_path, file)) = icon
        .strip_prefix("mfe/")
        .and_then(|rest| rest.split_once('/'))
        .map(|(package, file)| (&icon[..4 + package.len()], file))
    else {
        return Err(bundled.to_owned());
    };
    let Some(package) = super::bundles::package_name(package_path) else {
        return Err(bundled.to_owned());
    };
    if !mfe.iter().any(|p| p == package_path) {
        return Err(format!(
            "in a bundle the kit declares: `mfe` does not name \"{package_path}\""
        ));
    }
    match super::bundles::BundleFile::parse(file) {
        Some(parsed) if parsed.content_type() == "image/svg+xml" => {
            Ok(KitIcon::Bundled { package, file })
        }
        _ => Err(format!(
            "{bundled}: \"{file}\" is not a relative `.svg` path without `..` or hidden parts"
        )),
    }
}

/// The kits a `.cf-studio-kit.toml` names, `(slug, name)` in its order.
pub fn toml_kits(body: &str) -> Vec<(String, String)> {
    let mut kits: Vec<(String, String)> = Vec::new();
    let mut in_kit = false;
    for raw in body.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') {
            in_kit = line == "[[kits]]";
            if in_kit {
                kits.push((String::new(), String::new()));
            }
            continue;
        }
        if !in_kit {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim().trim_matches('"').to_owned();
        if let Some(last) = kits.last_mut() {
            match key.trim() {
                "slug" => last.0 = value,
                "name" => last.1 = value,
                _ => {}
            }
        }
    }
    kits.retain(|(slug, _)| !slug.is_empty());
    kits
}

/// A `.cf-studio-kit.toml` as a manifest: the kit `want` names (the only
/// one when it names none), with what it brings into a checkout.
pub fn read_cf_studio_kit(body: &str, want: Option<&str>) -> Result<KitManifest, String> {
    if body.len() > MAX_MANIFEST_BYTES {
        return Err(format!(
            "{CF_STUDIO_KIT_TOML} is {} bytes; a manifest is at most {MAX_MANIFEST_BYTES}",
            body.len()
        ));
    }
    let kits = toml_kits(body);
    let (slug, name) = match want {
        Some(want) => kits
            .into_iter()
            .find(|(slug, _)| slug == want)
            .ok_or_else(|| format!("{CF_STUDIO_KIT_TOML} names no kit `{want}`"))?,
        None => match kits.as_slice() {
            [one] => one.clone(),
            [] => return Err(format!("{CF_STUDIO_KIT_TOML} names no kit")),
            many => {
                return Err(format!(
                    "{CF_STUDIO_KIT_TOML} names several kits ({}): say which with `slug`",
                    many.iter()
                        .map(|(s, _)| format!("`{s}`"))
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
        },
    };
    let contents = super::contents::read_manifest(body, &slug)
        .ok_or_else(|| format!("{CF_STUDIO_KIT_TOML} names no kit `{slug}`"))?;
    let manifest = KitManifest {
        name: if name.trim().is_empty() {
            slug.clone()
        } else {
            name
        },
        slug,
        levels: vec!["project".to_owned()],
        material: contents
            .material
            .into_iter()
            .map(|m| ManifestMaterial {
                path: m.path,
                description: m.description,
            })
            .collect(),
        kinds: contents.kinds,
        ..KitManifest::default()
    };
    check(&manifest)?;
    Ok(manifest)
}

/// What a manifest says a kit brings, by the sections of [`KitContents`].
pub fn contents_of(m: &KitManifest) -> KitContents {
    let named = |items: &[ManifestNamed]| {
        items
            .iter()
            .map(|n| KitNamed {
                name: n.name.clone(),
                description: n.description.clone(),
            })
            .collect()
    };
    let (types, model) = model_contents(&m.slug, m.model.as_ref());
    KitContents {
        screens: m
            .screens
            .iter()
            .map(|s| KitScreen {
                kind: if s.kind == "section" {
                    "section"
                } else {
                    "tab"
                },
                level: s.level.clone(),
                label: s.label.clone(),
                route: s.route.clone(),
                slot: s.slot.clone(),
                needs: s.needs.clone(),
            })
            .collect(),
        types,
        rules: named(&m.rules),
        functions: m
            .functions
            .iter()
            .map(|f| KitFunction {
                name: f.name.clone(),
                runtime: if f.runtime == "agent" {
                    "agent"
                } else {
                    "wasm"
                },
                description: f.description.clone(),
            })
            .collect(),
        services: named(&m.services),
        inbox: m
            .inbox
            .iter()
            .map(|s| KitInboxSource {
                id: s.id.clone(),
                label: s.label.clone(),
                destination: s.destination.clone(),
            })
            .collect(),
        // The tools it names, and the gears' tools it claims (ADR-0071 §2).
        mcp_tools: {
            let mut tools: Vec<KitNamed> = named(&m.mcp_tools);
            for name in m.gears.iter().flat_map(|g| &g.mcp_tools) {
                if !tools.iter().any(|t| &t.name == name) {
                    tools.push(KitNamed {
                        name: name.clone(),
                        description: None,
                    });
                }
            }
            tools
        },
        gears: m.gears.clone(),
        permissions: KitPermissions {
            reads: m.permissions.reads.clone(),
            writes: m.permissions.writes.clone(),
            listens: m.permissions.listens.clone(),
        },
        material: m
            .material
            .iter()
            .map(|x| KitMaterial {
                path: x.path.clone(),
                description: x.description.clone(),
            })
            .collect(),
        kinds: m.kinds.clone(),
        docs: m.docs.clone(),
        mfe: m.mfe.clone(),
        requires: m.requires.clone(),
        model,
    }
}

/// The relation type of a tab in Studio's model (ADR-0066).
const SHOWS: &str = "shows";

/// `key` of `v` as text, `None` when absent or blank.
fn text<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// What a manifest's model overlay brings, read as leniently as its types
/// always were (a model that does not validate still describes): its types
/// with their fields, and the fields, relations and tabs it adds elsewhere.
/// `on` and `target` name one of the kit's types by its `name` and any other
/// by its model id; both come out as model ids.
fn model_contents(slug: &str, model: Option<&Value>) -> (Vec<KitType>, KitModel) {
    let mut out = KitModel::default();
    let Some(model) = model else {
        return (Vec::new(), out);
    };
    let list = |key: &str| -> &[Value] {
        model
            .get(key)
            .and_then(Value::as_array)
            .map_or(&[], Vec::as_slice)
    };
    let ids: Vec<(String, String)> = list("types")
        .iter()
        .filter_map(|t| {
            let name = text(t, "name")?;
            // A kit's own type is the entity `<slug>-<name>` (kit_overlay).
            let id = text(t, "id").map_or_else(|| format!("{slug}-{name}"), str::to_owned);
            Some((name.to_owned(), id))
        })
        .collect();
    let resolve = |x: &str| {
        ids.iter()
            .find(|(name, _)| name == x)
            .map_or_else(|| x.to_owned(), |(_, id)| id.clone())
    };

    let mut types = Vec::new();
    for t in list("types") {
        let Some(name) = t.get("name").and_then(Value::as_str) else {
            continue;
        };
        let declared: Option<OverlayType> = serde_json::from_value(t.clone()).ok();
        let id = resolve(name);
        let mut fields: Vec<KitField> = t
            .get("fields")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|f| field(None, f, ORIGIN_KIT))
            .collect();
        // A type moved out of the core carries its whole definition.
        let moved = t
            .get("entity")
            .and_then(|e| e.get("properties"))
            .and_then(Value::as_array);
        for p in moved.into_iter().flatten() {
            if let Some(f) = property(&id, p, ORIGIN_CORE, &mut out) {
                fields.push(KitField { on: None, ..f });
            }
        }
        types.push(KitType {
            gts: declared.map_or_else(|| kit_type_gts(slug, name), |d| d.gts(slug)),
            name: text(t, "label").unwrap_or(name).to_owned(),
            description: text(t, "description").map(str::to_owned),
            adopts: text(t, "id").is_some(),
            id,
            fields,
        });
    }
    for f in list("fields") {
        let Some(on) = text(f, "on") else { continue };
        out.fields.extend(field(Some(resolve(on)), f, ORIGIN_KIT));
    }
    for r in list("relations") {
        let (Some(on), Some(name), Some(target)) =
            (text(r, "on"), text(r, "name"), text(r, "target"))
        else {
            continue;
        };
        out.relations.push(KitRelation {
            on: resolve(on),
            name: name.to_owned(),
            target: resolve(target),
            label: text(r, "label").map(str::to_owned),
            verb: Some(text(r, "verb").unwrap_or("references").to_owned()),
            origin: ORIGIN_KIT,
        });
    }
    for tab in list("tabs") {
        let (Some(level), Some(name), Some(target)) =
            (text(tab, "level"), text(tab, "name"), text(tab, "target"))
        else {
            continue;
        };
        out.tabs.push(KitModelTab {
            level: level.to_owned(),
            name: name.to_owned(),
            label: text(tab, "label").unwrap_or(name).to_owned(),
            target: resolve(target),
        });
    }
    for p in list("properties") {
        let (Some(on), Some(written)) = (text(p, "on"), p.get("property")) else {
            continue;
        };
        let on = resolve(on);
        if let Some(f) = property(&on, written, ORIGIN_CORE, &mut out) {
            out.fields.push(f);
        }
    }
    (types, out)
}

/// A field as an overlay or a type declares it (`name`, `type`, ...).
fn field(on: Option<String>, f: &Value, origin: &'static str) -> Option<KitField> {
    Some(KitField {
        on,
        name: text(f, "name")?.to_owned(),
        type_name: text(f, "type").unwrap_or_default().to_owned(),
        description: text(f, "description").map(str::to_owned),
        required: f.get("required").and_then(Value::as_bool).unwrap_or(false),
        origin,
    })
}

/// A property of type `on` as Studio's model writes it: a `shows` relation
/// is a tab of the level `on`, another relation an edge (both go into
/// `model`), anything else a field, returned.
fn property(on: &str, p: &Value, origin: &'static str, model: &mut KitModel) -> Option<KitField> {
    let name = text(p, "name")?;
    let Some(target) = text(p, "relation") else {
        return field(Some(on.to_owned()), p, origin);
    };
    let label = text(p, "relationLabel");
    let verb = text(p, "relationType");
    if verb == Some(SHOWS) {
        model.tabs.push(KitModelTab {
            level: on.to_owned(),
            name: name.to_owned(),
            label: label.unwrap_or(name).to_owned(),
            target: target.to_owned(),
        });
    } else {
        model.relations.push(KitRelation {
            on: on.to_owned(),
            name: name.to_owned(),
            target: target.to_owned(),
            label: label.map(str::to_owned),
            verb: verb.map(str::to_owned),
            origin,
        });
    }
    None
}

#[cfg(test)]
#[path = "manifest_tests.rs"]
mod tests;
