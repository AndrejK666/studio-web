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
//!   `levels`, ...). Unknown keys are refused, so a typo is a diagnostic
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
    KitContents, KitFunction, KitInboxSource, KitMaterial, KitNamed, KitPermissions, KitScreen,
    KitType,
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
    /// How its items are read: [`INBOX_KIND_QUERY`] (the default) or
    /// [`INBOX_KIND_ENDPOINT`].
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
}

/// An Inbox source whose items are a domain query's rows over the kit's
/// objects (ADR-0068 §6).
pub const INBOX_KIND_QUERY: &str = "query";
/// An Inbox source whose items a gear's route answers for the person, from
/// records that are not domain objects (a deploy, a sign-in).
pub const INBOX_KIND_ENDPOINT: &str = "endpoint";

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
    ("project-artifacts", include_str!("builtin/project-artifacts.kit.json")),
    ("project-activity", include_str!("builtin/project-activity.kit.json")),
    ("project-team", include_str!("builtin/project-team.kit.json")),
    ("components", include_str!("builtin/components.kit.json")),
    ("project-specs", include_str!("builtin/project-specs.kit.json")),
    ("project-issues", include_str!("builtin/project-issues.kit.json")),
    ("project-tests", include_str!("builtin/project-tests.kit.json")),
    (
        "constructor-research",
        include_str!("builtin/constructor-research.kit.json"),
    ),
];

/// Built-in kit `slug`'s `kit.json`, when it has one.
pub fn builtin_manifest(slug: &str) -> Option<KitManifest> {
    BUILTIN_MANIFESTS
        .iter()
        .find(|(s, _)| *s == slug)
        .map(|(_, body)| read_kit_json(body).expect("a built-in kit.json reads"))
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
        && overlay.lifecycles.is_empty();
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
            other => {
                return Err(format!(
                    "{KIT_JSON}: inbox source `{}` is a `{other}`; a source is a `{INBOX_KIND_QUERY}` \
                     or an `{INBOX_KIND_ENDPOINT}`",
                    s.id
                ));
            }
        }
    }
    if m.model.as_ref().is_some_and(|v| !v.is_object()) {
        return Err(format!("{KIT_JSON}: `model` is an object"));
    }
    // The overlay's own rules (ADR-0067 §6); the organization's model is
    // checked against it when the kit is installed.
    overlay_of(m)?;
    Ok(())
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
    let types = m
        .model
        .as_ref()
        .and_then(|model| model.get("types"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|t| {
            let declared: Option<OverlayType> = serde_json::from_value(t.clone()).ok();
            let name = t.get("name")?.as_str()?;
            Some(KitType {
                gts: declared.map_or_else(|| kit_type_gts(&m.slug, name), |d| d.gts(&m.slug)),
                name: t
                    .get("label")
                    .and_then(Value::as_str)
                    .unwrap_or(name)
                    .to_owned(),
                description: t
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            })
        })
        .collect();
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
            })
            .collect(),
        mcp_tools: named(&m.mcp_tools),
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
    }
}

#[cfg(test)]
#[path = "manifest_tests.rs"]
mod tests;
