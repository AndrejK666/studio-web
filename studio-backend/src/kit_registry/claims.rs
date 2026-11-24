//! What the built-in kits claim of the gears (ADR-0071 §1–§4, §7).
//!
//! A kit's manifest names, per gear, the types, MCP tools and write routes it
//! stands for (`gears`, [`super::manifest::ManifestGearClaim`]). Read from the
//! compiled-in `kit.json` of every built-in kit, the claims answer three
//! questions for the rest of Studio:
//!
//! - **whose a gear's type is** ([`Claims::type_claim`]): the domain model
//!   sets `meta.kit` on a gear-declared type from it, and the type is dormant
//!   where that kit does not apply;
//! - **whose a gear's MCP tool or write route is** ([`Claims::tool_claim`],
//!   [`Claims::route_match`]): called where that kit does not apply, it
//!   answers `KIT_NOT_INSTALLED` (one shared check, `port`);
//! - **whether a gear may skip a sync** ([`Claims::sync_kit`]): only for a
//!   claim that opts in (`sync_only_with_kit`).
//!
//! What no kit claims is the shell's: the gear types of [`CORE_GEAR_TYPES`]
//! and the tools of [`SHELL_MCP_TOOLS`]. The build tests
//! (`claims_tests.rs`) hold every type a gear declares and every tool a gear
//! serves to exactly one of the two.
//!
//! Only the built-in kits' claims count here. An organization's own kit may
//! not claim what a built-in kit or the shell already has
//! ([`Claims::conflict_with`], `KIT_MODEL_CONFLICT`).

use std::collections::BTreeMap;
use std::sync::OnceLock;

use super::manifest::{KitManifest, builtin_manifest, claimed_route};
use super::service::builtin_catalogue;

/// The gear types that are core (ADR-0071 §7), with why: no kit claims them,
/// and the build test accepts them unclaimed. Studio's running core types
/// (the seed's types without a kit) are core too, whichever gear also
/// declares them.
pub const CORE_GEAR_TYPES: &[(&str, &str)] = &[
    (
        "repository",
        "a seed core type: Sources and the editor (ADR-0070 §7, decision 2)",
    ),
    ("commit", "a seed core type: Sources and the editor"),
    (
        "repository-file",
        "a seed core type: Sources and the editor",
    ),
    ("text-content", "a seed core type: Sources and the editor"),
    (
        "source-account",
        "who an author is on a Git host: identity and Sources",
    ),
    (
        "connector-connection",
        "connections are the shell's Sources",
    ),
    ("kit-installation", "the kit library and the installer"),
    (
        "project-status",
        "the project Overview's status, kept by the shell (status_view.rs)",
    ),
    (
        "project-status-view",
        "when the project Overview's status was computed",
    ),
    ("tenant-document", "every gear's settings document"),
    (
        "record-chunk",
        "storage: any table row longer than graph-storage's limit, whatever kit it serves",
    ),
];

/// The gears' MCP tools that are the shell's, not a kit's (ADR-0071 §6): the
/// kit library, the Studio domain model, a project's creation, status and
/// sources, connections, the Inbox and background runs.
pub const SHELL_MCP_TOOLS: &[&str] = &[
    // studio-kits: the library and the installer.
    "kits_catalog",
    "kits_describe",
    "kit_gdl",
    "kits_installed",
    "kits_inbox_sources",
    "kits_shelf",
    "kit_base_install",
    "kit_base_uninstall",
    "kit_organization_install",
    "kit_organization_uninstall",
    "kit_project_install",
    "kit_project_uninstall",
    "kit_shelf_preview",
    "kit_shelf_add",
    "kit_shelf_refresh",
    "kit_shelf_remove",
    // studio-domain-model: Studio's own model.
    "domain_model_types",
    "domain_type",
    "domain_type_conformance",
    "domain_model_query",
    "domain_model_graph",
    "domain_model_versions",
    "domain_type_add_field",
    "domain_type_edit_field",
    "domain_type_remove_field",
    "domain_model_revert",
    // studio-organizations: a project's creation and status.
    "project_status",
    "project_create",
    "project_create_status",
    // A project's sources and the connections they are read through.
    "project_sources",
    "project_sources_set",
    "project_source_detach",
    "project_connections",
    "connection_repositories",
    // studio-user: the Inbox.
    "inbox",
    "me_inbox",
    "inbox_mark",
    // studio-tasks: background runs.
    "task_run",
    "task_retry",
];

/// Who claims one type, tool or route.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Claim {
    /// The kit's slug.
    pub kit: String,
    /// The gear the claim is on.
    pub gear: String,
    /// Whether the gear may skip its sync where the kit does not apply.
    pub sync_only_with_kit: bool,
}

/// A claimed write route: its method and path template.
#[derive(Clone, Debug, PartialEq, Eq)]
struct RouteClaim {
    method: String,
    /// The template's segments after the leading `/`.
    segments: Vec<String>,
    claim: Claim,
}

/// The claims of a set of kits, each type, tool and route once.
#[derive(Clone, Debug, Default)]
pub struct Claims {
    types: BTreeMap<String, Claim>,
    tools: BTreeMap<String, Claim>,
    routes: Vec<RouteClaim>,
}

fn is_param(segment: &str) -> bool {
    segment.starts_with('{') || segment.starts_with(':')
}

impl Claims {
    /// The claims of `kits`; two kits claiming the same type, tool or route
    /// is the error, as `KIT_MODEL_CONFLICT` says it.
    pub fn of(kits: &[KitManifest]) -> Result<Self, String> {
        let mut out = Self::default();
        for m in kits {
            for g in &m.gears {
                let claim = Claim {
                    kit: m.slug.clone(),
                    gear: g.gear.clone(),
                    sync_only_with_kit: g.sync_only_with_kit,
                };
                for t in &g.types {
                    if let Some(other) = out.types.insert(t.clone(), claim.clone()) {
                        return Err(format!(
                            "the type `{t}` is claimed by `{}` and `{}`",
                            other.kit, m.slug
                        ));
                    }
                }
                for t in &g.mcp_tools {
                    if let Some(other) = out.tools.insert(t.clone(), claim.clone()) {
                        return Err(format!(
                            "the tool `{t}` is claimed by `{}` and `{}`",
                            other.kit, m.slug
                        ));
                    }
                }
                for r in &g.routes {
                    let (method, path) = claimed_route(r, &g.gear)?;
                    let segments: Vec<String> = path
                        .trim_start_matches('/')
                        .split('/')
                        .map(str::to_owned)
                        .collect();
                    if let Some(other) = out
                        .routes
                        .iter()
                        .find(|o| o.method == method && o.segments == segments)
                    {
                        return Err(format!(
                            "the route `{r}` is claimed by `{}` and `{}`",
                            other.claim.kit, m.slug
                        ));
                    }
                    out.routes.push(RouteClaim {
                        method: method.to_owned(),
                        segments,
                        claim: claim.clone(),
                    });
                }
            }
        }
        Ok(out)
    }

    /// The built-in kits' claims, read once from their compiled-in
    /// `kit.json`. The build test holds them free of conflicts; a conflict
    /// that slipped through is logged and the later claim dropped rather
    /// than stopping the process.
    pub fn builtin() -> &'static Self {
        static CLAIMS: OnceLock<Claims> = OnceLock::new();
        CLAIMS.get_or_init(|| {
            let manifests = builtin_manifests();
            Self::of(&manifests).unwrap_or_else(|why| {
                tracing::error!(%why, "studio-kits: the built-in kits' claims conflict");
                let mut out = Self::default();
                for m in &manifests {
                    if let Ok(one) = Self::of(std::slice::from_ref(m)) {
                        for (k, v) in one.types {
                            out.types.entry(k).or_insert(v);
                        }
                        for (k, v) in one.tools {
                            out.tools.entry(k).or_insert(v);
                        }
                        for r in one.routes {
                            if !out
                                .routes
                                .iter()
                                .any(|o| o.method == r.method && o.segments == r.segments)
                            {
                                out.routes.push(r);
                            }
                        }
                    }
                }
                out
            })
        })
    }

    /// The kit that claims gear type `id`.
    pub fn type_claim(&self, id: &str) -> Option<&Claim> {
        self.types.get(id)
    }

    /// The kit that claims MCP tool `name`.
    pub fn tool_claim(&self, name: &str) -> Option<&Claim> {
        self.tools.get(name)
    }

    /// The kit that claims the write route a request reaches: `method` and
    /// its concrete `path` (`/studio-<gear>/v1/…`; anything before the gear's
    /// prefix, such as the gateway's `/cf`, is ignored). A template's
    /// parameter matches any one segment; a literal segment wins over a
    /// parameter where two templates match.
    #[cfg(test)]
    pub fn route_claim(&self, method: &str, path: &str) -> Option<&Claim> {
        self.route_match(method, path).map(|(c, _)| c)
    }

    /// [`Self::route_claim`], with the template's parameters bound to the
    /// path's segments (`{project_id}` → its value).
    pub fn route_match(
        &self,
        method: &str,
        path: &str,
    ) -> Option<(&Claim, BTreeMap<String, String>)> {
        let path = path.find("/studio-").map_or(path, |at| &path[at..]);
        let concrete: Vec<&str> = path
            .trim_start_matches('/')
            .trim_end_matches('/')
            .split('/')
            .collect();
        self.routes
            .iter()
            .filter(|r| r.method.eq_ignore_ascii_case(method))
            .filter(|r| r.segments.len() == concrete.len())
            .filter(|r| {
                r.segments
                    .iter()
                    .zip(&concrete)
                    .all(|(t, c)| (is_param(t) && !c.is_empty()) || t == c)
            })
            .min_by_key(|r| r.segments.iter().filter(|t| is_param(t)).count())
            .map(|r| {
                let params = r
                    .segments
                    .iter()
                    .zip(&concrete)
                    .filter(|(t, _)| is_param(t))
                    .map(|(t, c)| {
                        let name = t.trim_matches(['{', '}', ':', '*']).to_owned();
                        (name, (*c).to_owned())
                    })
                    .collect();
                (&r.claim, params)
            })
    }

    /// The kit whose claim on `gear`'s type `id` lets the gear skip its sync
    /// where that kit does not apply; `None` when the gear writes as before.
    pub fn sync_kit(&self, gear: &str, id: &str) -> Option<&str> {
        self.types
            .get(id)
            .filter(|c| c.gear == gear && c.sync_only_with_kit)
            .map(|c| c.kit.as_str())
    }

    /// Every claimed type, with its claim.
    #[cfg(test)]
    pub fn types(&self) -> impl Iterator<Item = (&str, &Claim)> {
        self.types.iter().map(|(k, v)| (k.as_str(), v))
    }

    /// Every claimed route, `METHOD /path`, with its claim.
    #[cfg(test)]
    pub fn routes(&self) -> impl Iterator<Item = (String, &Claim)> {
        self.routes
            .iter()
            .map(|r| (format!("{} /{}", r.method, r.segments.join("/")), &r.claim))
    }

    /// Why `m` (an organization's own kit) may not claim what it does: a
    /// type, tool or route a built-in kit already claims, a core gear type or
    /// a shell tool. `None` when it may.
    pub fn conflict_with(&self, m: &KitManifest) -> Option<String> {
        let mine = Claims::of(std::slice::from_ref(m)).err();
        if mine.is_some() {
            return mine;
        }
        for g in &m.gears {
            for t in &g.types {
                if let Some(c) = self.types.get(t).filter(|c| c.kit != m.slug) {
                    return Some(format!("the type `{t}` is claimed by the kit `{}`", c.kit));
                }
                if CORE_GEAR_TYPES.iter().any(|(id, _)| id == t) {
                    return Some(format!("the type `{t}` is Studio's core"));
                }
            }
            for t in &g.mcp_tools {
                if let Some(c) = self.tools.get(t).filter(|c| c.kit != m.slug) {
                    return Some(format!("the tool `{t}` is claimed by the kit `{}`", c.kit));
                }
                if SHELL_MCP_TOOLS.contains(&t.as_str()) {
                    return Some(format!("the tool `{t}` is the shell's"));
                }
            }
            for r in &g.routes {
                if let Some((method, path)) = r.split_once(' ')
                    && let Some(c) = self
                        .routes
                        .iter()
                        .find(|o| {
                            o.method == method
                                && o.segments.join("/") == path.trim_start_matches('/')
                        })
                        .map(|o| &o.claim)
                        .filter(|c| c.kit != m.slug)
                {
                    return Some(format!("the route `{r}` is claimed by the kit `{}`", c.kit));
                }
            }
        }
        None
    }
}

/// Every built-in kit's compiled-in `kit.json`, in the catalogue's order.
pub fn builtin_manifests() -> Vec<KitManifest> {
    builtin_catalogue()
        .iter()
        .filter_map(|k| builtin_manifest(&k.slug))
        .collect()
}

/// What one built-in kit claims of one gear: the kit, and the gear's types,
/// MCP tools and write routes it stands for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GearClaims {
    /// The kit's slug.
    pub kit: String,
    /// The kit's name, as the library shows it.
    pub kit_name: String,
    pub types: Vec<String>,
    pub mcp_tools: Vec<String>,
    pub routes: Vec<String>,
}

/// Every built-in kit's claims on `gear` (case-blind), in the catalogue's
/// order: what a component's page lists as the kits that stand for it.
pub fn builtin_gear_claims(gear: &str) -> Vec<GearClaims> {
    let gear = gear.trim();
    if gear.is_empty() {
        return Vec::new();
    }
    builtin_manifests()
        .into_iter()
        .flat_map(|m| {
            m.gears
                .into_iter()
                .filter(|g| g.gear.eq_ignore_ascii_case(gear))
                .map(|g| GearClaims {
                    kit: m.slug.clone(),
                    kit_name: m.name.clone(),
                    types: g.types,
                    mcp_tools: g.mcp_tools,
                    routes: g.routes,
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

/// Whether `id` is a core gear type ([`CORE_GEAR_TYPES`]).
#[cfg(test)]
pub fn is_core_gear_type(id: &str) -> bool {
    CORE_GEAR_TYPES.iter().any(|(t, _)| *t == id)
}

#[cfg(test)]
#[path = "claims_tests.rs"]
mod tests;
