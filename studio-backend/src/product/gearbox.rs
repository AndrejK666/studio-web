//! Product preview through the Gearbox engine.
//!
//! Gearbox (<https://github.com/constructorfabric/gearbox>) resolves a product out
//! of gears: which gears a selection really pulls in, which applications they
//! land in, and what cannot work, as `GBX…` diagnostics. Its input is a
//! `product.gdl` plus the `gear.gdl` descriptors beside the gears. This module
//! turns the gears a person picked into a `product.gdl`, runs the engine's CLI
//! over it against a checkout of the gear corpus, and hands back what the
//! engine said. It holds no composition rule of its own beyond one: a plugin is
//! written under the host whose extension point it fills, because that is how
//! `product.gdl` spells it and the engine refuses a plugin selected alone.
//!
//! The CLI's JSON is its stable contract for tooling, so this reads
//! `catalogue`, `validate` and `resolve` with `--format json` rather than
//! holding a JSON-RPC session: a preview is one question, not a conversation.
//!
//! Off unless `STUDIO_GEARBOX_WORKDIR` is set. Configuration:
//!
//! | Variable | Default |
//! |---|---|
//! | `STUDIO_GEARBOX_WORKDIR` | unset: previews are unavailable |
//! | `STUDIO_GEARBOX_BIN` | `gearbox` |
//! | `STUDIO_GEARBOX_CORPUS_URL` | unset: no corpus until the platform has a gear repository |
//! | `STUDIO_GEARBOX_CORPUS_REF` | `main` |
//! | `STUDIO_GEARBOX_REFRESH_SECS` | `600` |
//!
//! The corpus is the platform's gears (ADR-0042), read from the platform's
//! gear repositories (ADR-0046): connections of the `gear-repository` kind in
//! the root tenant, in the order they were added, each checked out and handed
//! to the engine as its own `--root`, under a directory named by its source
//! id. They are read together, because a gear in one may need a gear in
//! another. While the platform has none, the deployment's corpus
//! (`STUDIO_GEARBOX_CORPUS_URL` / `_REF`) is the one root, under the source id
//! `gears-rust`. No organization's settings or sync can change either.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context as _, anyhow, bail};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::Mutex;
use tracing::warn;

/// The source id every generated `product.gdl` names its gears from. It is
/// also the directory the gear corpus is checked out under in a session
/// workspace, which is what makes `path("../gears-rust")` resolve there.
pub const CORPUS_SOURCE_ID: &str = "gears-rust";

const DEFAULT_CORPUS_REF: &str = "main";
const DEFAULT_REFRESH: Duration = Duration::from_secs(600);
/// How often the platform's gear repositories are listed again. A list read
/// is one metadata row; a change is checked out on the next use.
const ROOTS_RECHECK: Duration = Duration::from_secs(60);
/// A catalogue load plus a resolve is well under a second on the corpus; a
/// minute is for a cold disk, not for a healthy run.
const ENGINE_TIMEOUT: Duration = Duration::from_secs(60);

/// The three deployment profiles a generated description declares, by id.
/// Every one is declared so the file can be resolved for any of them later;
/// the preview resolves the one asked for.
pub const PROFILES: [&str; 3] = ["dev", "local", "prod"];

#[derive(Debug, Clone)]
pub struct GearboxConfig {
    pub bin: PathBuf,
    pub workdir: PathBuf,
    pub corpus_url: String,
    pub corpus_ref: String,
    pub refresh: Duration,
}

impl GearboxConfig {
    /// `None` when `STUDIO_GEARBOX_WORKDIR` is unset: without a place for the
    /// corpus there is nothing to resolve against. A deployment that names no
    /// corpus has none until the platform connects a gear repository.
    pub fn from_env() -> Option<Self> {
        let var = |name: &str| {
            std::env::var(name)
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        };
        let workdir = PathBuf::from(var("STUDIO_GEARBOX_WORKDIR")?);
        let corpus_url = var("STUDIO_GEARBOX_CORPUS_URL").unwrap_or_default();
        Some(Self {
            bin: PathBuf::from(var("STUDIO_GEARBOX_BIN").unwrap_or_else(|| "gearbox".into())),
            workdir,
            corpus_url,
            corpus_ref: var("STUDIO_GEARBOX_CORPUS_REF")
                .unwrap_or_else(|| DEFAULT_CORPUS_REF.into()),
            refresh: var("STUDIO_GEARBOX_REFRESH_SECS")
                .and_then(|s| s.parse().ok())
                .map(Duration::from_secs)
                .unwrap_or(DEFAULT_REFRESH),
        })
    }
}

// ── The engine's catalogue, as much of it as composing needs ──────────────

#[derive(Debug, Clone, Deserialize)]
pub struct EngineCatalogue {
    #[serde(default)]
    pub gears: BTreeMap<String, EngineGear>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EngineGear {
    pub id: String,
    pub package: EnginePackage,
    /// Set on a plugin: the extension point it fills, named by its SDK crate.
    ///
    /// The engine calls it `implements` since gearbox#2 (`fills` renamed, no
    /// alias on its side). Both are read: under `serde(default)` an unknown
    /// name is not an error, it is every plugin silently becoming a gear.
    #[serde(default, alias = "implements")]
    pub fills: Option<EngineFills>,
    /// Set on a host: the extension points plugins fill.
    #[serde(default)]
    pub extension_points: Vec<EnginePoint>,
    /// The contracts it provides, projected from `#[toolkit::provides]`.
    #[serde(default)]
    pub provides: Vec<EngineProvide>,
    /// `rest`, `rest_host`, `grpc_hub`, … — projected from `#[toolkit::gear]`.
    #[serde(default)]
    pub runtime_caps: Vec<String>,
    /// Gears that must share a binary with this one, by engine id.
    #[serde(default)]
    pub colocated_deps: Vec<String>,
    /// Endpoints; their `config_key` is written by generation, not by a person.
    #[serde(default)]
    pub serves: Vec<EngineEndpoint>,
    #[serde(default)]
    pub config_schema: Option<EngineConfigSchema>,
    /// Set on a host: the vendor it selects among its plugins by default. A
    /// plugin registers under its own `vendor` (a config field with a
    /// default); the two must agree or the engine refuses (GBX0512).
    #[serde(default)]
    pub vendor_selector: Option<String>,
    /// The root (gear repository) the engine found it in, by source id.
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct EngineEndpoint {
    #[serde(default)]
    pub config_key: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct EngineConfigSchema {
    #[serde(default)]
    pub fields: Vec<EngineConfigField>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EngineConfigField {
    pub name: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub default: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EnginePackage {
    pub crate_name: String,
    #[serde(default)]
    pub lib_ident: Option<String>,
    /// Relative to the corpus root.
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EngineProvide {
    /// The engine's contract id, `<owner gear>/<Trait>@v<major>`.
    pub contract: String,
}

impl EngineGear {
    /// Everything the engine checks that this gear does for others:
    /// - the contracts it provides;
    /// - the spec of each extension point it hosts;
    /// - the spec of the point it implements, when it is a plugin.
    ///
    /// The composer matches a capability's contracts against these
    /// (`cpt-studio-fr-spec-gear-mapping`).
    pub fn contracts(&self) -> Vec<String> {
        let mut out: Vec<String> = self.provides.iter().map(|p| p.contract.clone()).collect();
        out.extend(self.extension_points.iter().filter_map(|p| p.spec.clone()));
        out.extend(self.fills.as_ref().and_then(|f| f.point.spec.clone()));
        out.sort();
        out.dedup();
        out
    }
}

impl EngineGear {
    /// The config fields generation writes from the topology: each endpoint's
    /// `config_key` (an address). A person never sets these.
    fn derived_config(&self) -> BTreeSet<&str> {
        self.serves
            .iter()
            .filter_map(|e| e.config_key.as_deref())
            .collect()
    }
}

/// One field of a gear's configuration, as a form asks for it.
#[derive(Debug, Clone, PartialEq)]
pub struct ConfigFieldInfo {
    pub name: String,
    pub required: bool,
    /// What the gear falls back to; `None` when it has none (a JSON `null`
    /// default is no default).
    pub default: Option<Value>,
    /// Written by generation from the topology (`serves[].config_key`), so
    /// not the product's to set.
    pub derived: bool,
}

/// One requested gear's configuration schema.
#[derive(Debug, Clone, PartialEq)]
pub struct GearConfigSchema {
    /// The name as it was asked for (crate name or engine id), so a caller
    /// joins it to its own picks and config keys unchanged.
    pub gear: String,
    /// The engine id; `None` when no `gear.gdl` in the corpus describes it.
    pub id: Option<String>,
    /// In the order the gear declares them.
    pub fields: Vec<ConfigFieldInfo>,
}

/// The config schema of each named gear, in the order asked, duplicates
/// dropped. A name the corpus does not describe answers with `id: None` and
/// no fields rather than failing the rest.
pub fn config_schemas(catalogue: &EngineCatalogue, names: &[String]) -> Vec<GearConfigSchema> {
    let mut seen = BTreeSet::new();
    names
        .iter()
        .filter(|n| seen.insert(n.as_str()))
        .map(|name| {
            let Some(g) = catalogue.find(name) else {
                return GearConfigSchema {
                    gear: name.clone(),
                    id: None,
                    fields: Vec::new(),
                };
            };
            let derived = g.derived_config();
            let fields = g
                .config_schema
                .as_ref()
                .map(|s| {
                    s.fields
                        .iter()
                        .map(|f| ConfigFieldInfo {
                            name: f.name.clone(),
                            required: f.required,
                            default: f.default.clone().filter(|v| !v.is_null()),
                            derived: derived.contains(f.name.as_str()),
                        })
                        .collect()
                })
                .unwrap_or_default();
            GearConfigSchema {
                gear: name.clone(),
                id: Some(g.id.clone()),
                fields,
            }
        })
        .collect()
}

#[derive(Debug, Clone, Deserialize)]
pub struct EngineFills {
    pub point: EnginePoint,
    /// Lower wins, as the runtime's plugin selector reads it.
    #[serde(default)]
    pub default_priority: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EnginePoint {
    pub sdk: EnginePackage,
    /// The full GTS type id of the plugin spec — the point's identity. Two
    /// points can share a trait; only their specs tell them apart.
    #[serde(default)]
    pub spec: Option<String>,
    /// The interface plugins register under, as written in the SDK.
    #[serde(default)]
    pub trait_ident: Option<String>,
}

impl EngineCatalogue {
    /// A gear by its engine id or its crate name. The portal knows gears by
    /// crate (`cf-gears-api-gateway`), the engine by `#[toolkit::gear(name)]`
    /// (`api-gateway`); both spellings are accepted so neither side translates.
    ///
    /// A crate can hold several gears (`cf-gears-mini-chat` is mini-chat and
    /// its two static plugins); its name then means the gear that is not a
    /// plugin, and the others are named by id -- see [`Self::pick_name`].
    fn find(&self, name: &str) -> Option<&EngineGear> {
        self.gears.get(name).or_else(|| {
            let mut same = self.gears.values().filter(|g| g.package.crate_name == name);
            let first = same.next()?;
            Some(if first.fills.is_none() {
                first
            } else {
                same.find(|g| g.fills.is_none()).unwrap_or(first)
            })
        })
    }

    /// How the portal names a gear: its crate when the crate finds it, else
    /// its engine id -- so the name finds this gear and no other, and a
    /// plugin sharing its host's crate never folds into the host.
    fn pick_name(&self, g: &EngineGear) -> String {
        if self
            .find(&g.package.crate_name)
            .is_some_and(|f| f.id == g.id)
        {
            g.package.crate_name.clone()
        } else {
            g.id.clone()
        }
    }

    /// The portal's name for an engine id; the id itself when unknown.
    fn pick_name_of(&self, id: &str) -> String {
        self.gears
            .get(id)
            .map_or(id.to_string(), |g| self.pick_name(g))
    }

    /// Every gear filling one of `host`'s extension points, by the portal's
    /// name for it, so an offer reads like a suggestion.
    fn implementers_of(&self, host: &EngineGear) -> Vec<String> {
        self.implementers(host)
            .into_iter()
            .map(|g| self.pick_name(g))
            .collect()
    }

    /// The gear whose extension point `plugin` fills.
    fn host_of(&self, plugin: &EngineGear) -> Option<&EngineGear> {
        self.gears.values().find(|g| {
            g.id != plugin.id && g.extension_points.iter().any(|p| fills_point(plugin, p))
        })
    }
}

// ── Composition: the picked gears as product.gdl declarations ─────────────

/// One `use_gear(...)` line, with the plugins written under it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GearUse {
    pub id: String,
    pub plugins: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Composition {
    pub gears: Vec<GearUse>,
    /// Hosts added because a picked plugin needs one: `(host, plugin)`.
    pub added_hosts: Vec<(String, String)>,
    /// Picked names no `gear.gdl` in the corpus declares. The engine cannot
    /// see these at all, so they are reported rather than written.
    pub not_described: Vec<String>,
    /// Picked hosts with an extension point nothing picked fills, and the
    /// corpus gears that could: `(host, [plugin, ...])`. The engine refuses
    /// such a host (GBX0511); this is the list to choose the fix from.
    pub plugin_options: Vec<(String, Vec<String>)>,
}

pub fn compose(catalogue: &EngineCatalogue, picked: &[String]) -> Composition {
    let mut out = Composition::default();
    let mut uses: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut order: Vec<String> = Vec::new();
    let mut add = |id: &str, uses: &mut BTreeMap<String, BTreeSet<String>>| {
        if !uses.contains_key(id) {
            uses.insert(id.to_string(), BTreeSet::new());
            order.push(id.to_string());
        }
    };
    for name in picked {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        let Some(gear) = catalogue.find(name) else {
            if !out.not_described.iter().any(|n| n == name) {
                out.not_described.push(name.to_string());
            }
            continue;
        };
        match catalogue.host_of(gear) {
            Some(host) => {
                if !uses.contains_key(&host.id)
                    && !picked
                        .iter()
                        .any(|p| catalogue.find(p).is_some_and(|g| g.id == host.id))
                {
                    out.added_hosts.push((host.id.clone(), gear.id.clone()));
                }
                add(&host.id, &mut uses);
                uses.get_mut(&host.id)
                    .expect("host was just added")
                    .insert(gear.id.clone());
            }
            // Not a plugin, or a plugin whose host is not in the corpus:
            // selected as itself, and the engine says what is wrong with that.
            None => add(&gear.id, &mut uses),
        }
    }
    out.gears = order
        .into_iter()
        .map(|id| GearUse {
            plugins: uses.remove(&id).unwrap_or_default().into_iter().collect(),
            id,
        })
        .collect();
    for g in &out.gears {
        let Some(host) = catalogue.gears.get(&g.id) else {
            continue;
        };
        if host.extension_points.is_empty() || !g.plugins.is_empty() {
            continue;
        }
        let available = catalogue.implementers_of(host);
        if !available.is_empty() {
            out.plugin_options.push((g.id.clone(), available));
        }
    }
    out
}

// ── Completion: from picks to a set the engine can resolve ────────────────

/// One thing [`complete`] did to a pick, and why — shown to the person, who
/// is entitled to undo any of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Change {
    /// Crate name, like every pick.
    pub gear: String,
    pub added: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Completion {
    /// The completed picks, by crate name, in pick order with additions last.
    pub gears: Vec<String>,
    pub changes: Vec<Change>,
    /// Configuration the product sets on its gears, by crate name: what was
    /// passed in, plus what completion had to set for the result to resolve.
    pub config: GearConfig,
}

/// A product's configuration of its gears: crate name -> field -> value.
/// Written into `product.gdl` as `use_gear(..., config = {...})` for a gear
/// and `plugin(..., config = {...})` for a plugin.
pub type GearConfig = BTreeMap<String, serde_json::Map<String, Value>>;

/// Read a `GearConfig` from JSON: an object of objects. Anything else is the
/// caller's mistake, named.
pub fn gear_config_from(value: Option<&Value>) -> anyhow::Result<GearConfig> {
    let Some(value) = value else {
        return Ok(GearConfig::new());
    };
    if value.is_null() {
        return Ok(GearConfig::new());
    }
    let Some(obj) = value.as_object() else {
        bail!("config is an object of gear name -> {{field: value}}");
    };
    let mut out = GearConfig::new();
    for (gear, fields) in obj {
        let Some(fields) = fields.as_object() else {
            bail!("config for `{gear}` is an object of field -> value");
        };
        if !fields.is_empty() {
            out.insert(gear.clone(), fields.clone());
        }
    }
    Ok(out)
}

/// The vendor a plugin registers under: its `vendor` config field, as the
/// product sets it or else as the gear defaults it.
fn plugin_vendor(
    plugin: &EngineGear,
    config: Option<&serde_json::Map<String, Value>>,
) -> Option<String> {
    if let Some(v) = config.and_then(|c| c.get("vendor")).and_then(Value::as_str) {
        return Some(v.to_string());
    }
    plugin
        .config_schema
        .as_ref()?
        .fields
        .iter()
        .find(|f| f.name == "vendor")?
        .default
        .as_ref()?
        .as_str()
        .map(str::to_string)
}

/// Whether the host would find this plugin by vendor. A host that selects no
/// vendor, or a plugin that declares none, agrees with anything.
fn vendor_agrees(
    host: &EngineGear,
    plugin: &EngineGear,
    config: Option<&serde_json::Map<String, Value>>,
) -> bool {
    match (
        host.vendor_selector.as_deref(),
        plugin_vendor(plugin, config),
    ) {
        (Some(want), Some(have)) => want == have,
        _ => true,
    }
}

/// Why a gear cannot be part of a product built from this corpus as it is.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Dead {
    /// Required configuration with no default; nobody has supplied it.
    NeedsConfig(Vec<String>),
    /// A host no gear in the corpus can plug into.
    NoPlugin,
    /// A plugin for an extension point no gear in the corpus hosts.
    NoHost,
    /// Must share a binary with a gear that is itself dead.
    Dep(String),
}

impl EngineCatalogue {
    /// Required fields a person would have to write: required, no default,
    /// and not an address generation writes from the topology.
    fn unset_config(&self, g: &EngineGear) -> Vec<String> {
        let derived = g.derived_config();
        g.config_schema
            .as_ref()
            .map(|s| {
                s.fields
                    .iter()
                    .filter(|f| f.required && f.default.as_ref().is_none_or(Value::is_null))
                    .filter(|f| !derived.contains(f.name.as_str()))
                    .map(|f| f.name.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn implementers(&self, host: &EngineGear) -> Vec<&EngineGear> {
        self.gears
            .values()
            .filter(|g| g.id != host.id && host.extension_points.iter().any(|p| fills_point(g, p)))
            .collect()
    }

    /// The gears filling this one point of `host`.
    fn implementers_at<'a>(
        &'a self,
        host: &EngineGear,
        point: &EnginePoint,
    ) -> Vec<&'a EngineGear> {
        self.gears
            .values()
            .filter(|g| g.id != host.id && fills_point(g, point))
            .collect()
    }

    /// Every gear that cannot run in a product from this corpus, and why,
    /// computed to a fixpoint: a gear is dead when its own facts say so, or
    /// when something it must share a binary with is, or — for a host — when
    /// every plugin it could take is.
    fn dead(&self) -> BTreeMap<String, Dead> {
        let mut dead: BTreeMap<String, Dead> = BTreeMap::new();
        for g in self.gears.values() {
            let unset = self.unset_config(g);
            if !unset.is_empty() {
                dead.insert(g.id.clone(), Dead::NeedsConfig(unset));
            } else if g.fills.is_some() && self.host_of(g).is_none() {
                dead.insert(g.id.clone(), Dead::NoHost);
            }
        }
        loop {
            let mut changed = false;
            for g in self.gears.values() {
                if dead.contains_key(&g.id) {
                    continue;
                }
                if let Some(dep) = g.colocated_deps.iter().find(|d| dead.contains_key(*d)) {
                    dead.insert(g.id.clone(), Dead::Dep(dep.clone()));
                    changed = true;
                    continue;
                }
                if let Some(host) = self.host_of(g).filter(|h| dead.contains_key(&h.id)) {
                    dead.insert(g.id.clone(), Dead::Dep(host.id.clone()));
                    changed = true;
                    continue;
                }
                if !g.extension_points.is_empty()
                    && self
                        .implementers(g)
                        .iter()
                        .all(|p| dead.contains_key(&p.id))
                {
                    dead.insert(g.id.clone(), Dead::NoPlugin);
                    changed = true;
                }
            }
            if !changed {
                return dead;
            }
        }
    }

    /// The plugin to put under `host` when nobody chose one: alive, then the
    /// runtime's own priority (lower wins), then a `static` one — it runs with
    /// no external service, which is what a first build needs — then by name.
    fn default_plugin<'a>(
        &'a self,
        host: &EngineGear,
        point: &EnginePoint,
        dead: &BTreeMap<String, Dead>,
    ) -> Option<&'a EngineGear> {
        let mut alive: Vec<&EngineGear> = self
            .implementers_at(host, point)
            .into_iter()
            .filter(|p| !dead.contains_key(&p.id))
            .collect();
        // A plugin registered under the vendor the host selects needs nothing
        // set to be found; prefer it over one that would need its vendor
        // overridden.
        alive.sort_by_key(|p| {
            (
                !vendor_agrees(host, p, None),
                p.fills
                    .as_ref()
                    .and_then(|f| f.default_priority)
                    .unwrap_or(i64::MAX),
                !p.id.contains("static"),
                p.id.clone(),
            )
        });
        alive.into_iter().next()
    }

    /// `ids` and everything they must share a binary with.
    fn closure(&self, ids: &[String]) -> BTreeSet<String> {
        let mut out: BTreeSet<String> = BTreeSet::new();
        let mut todo: Vec<String> = ids.to_vec();
        while let Some(id) = todo.pop() {
            if !out.insert(id.clone()) {
                continue;
            }
            if let Some(g) = self.gears.get(&id) {
                todo.extend(g.colocated_deps.iter().cloned());
            }
        }
        out
    }
}

fn dead_reason(catalogue: &EngineCatalogue, why: &Dead) -> String {
    match why {
        Dead::NeedsConfig(fields) => format!(
            "needs configuration nobody has given yet: {} — add it back and set it in product.gdl",
            fields.join(", ")
        ),
        Dead::NoPlugin => "no plugin in the corpus fills its extension point".to_string(),
        Dead::NoHost => "a plugin for an extension point no gear in the corpus hosts".to_string(),
        Dead::Dep(dep) => {
            let crate_name = catalogue
                .gears
                .get(dep)
                .map_or(dep.as_str(), |g| g.package.crate_name.as_str());
            format!("must run with {crate_name}, which cannot run here")
        }
    }
}

/// Turn picks into a set the engine can resolve, saying what changed and why.
///
/// Only what the catalogue proves: a gear is dropped when its own
/// descriptor, or one it must share a binary with, rules it out; a plugin
/// is added when a host in the product has none; a REST host when REST
/// gears have nothing to serve them. Nothing is guessed about what the
/// product is for. The engine still has the last word — the caller resolves
/// the result.
pub fn complete(catalogue: &EngineCatalogue, picked: &[String], config: &GearConfig) -> Completion {
    let dead = catalogue.dead();
    let mut config = config.clone();
    let crate_of = |id: &str| catalogue.pick_name_of(id);
    let mut changes: Vec<Change> = Vec::new();
    let mut set: Vec<String> = Vec::new();

    for name in picked {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        let Some(g) = catalogue.find(name) else {
            if !changes.iter().any(|c| c.gear == name) {
                changes.push(Change {
                    gear: name.to_string(),
                    added: false,
                    reason: "no gear.gdl describes it yet, so it cannot be composed".to_string(),
                });
            }
            continue;
        };
        if let Some(why) = dead.get(&g.id) {
            changes.push(Change {
                gear: catalogue.pick_name(g),
                added: false,
                reason: dead_reason(catalogue, why),
            });
            continue;
        }
        if !set.contains(&g.id) {
            set.push(g.id.clone());
        }
    }

    // Additions settle in a few rounds: a REST host brings its own deps,
    // which may be hosts wanting a plugin. Bounded, because each round only
    // adds from a finite catalogue.
    for _ in 0..catalogue.gears.len().max(1) {
        let mut added = false;
        let effective = catalogue.closure(&set);

        for host_id in &effective {
            let Some(host) = catalogue.gears.get(host_id) else {
                continue;
            };
            // Each point on its own: mini-chat's audit and model-policy
            // points live in one SDK, and a plugin for one fills not the other.
            for point in &host.extension_points {
                let filled = catalogue
                    .implementers_at(host, point)
                    .iter()
                    .any(|p| set.contains(&p.id));
                if filled {
                    continue;
                }
                if let Some(p) = catalogue.default_plugin(host, point, &dead) {
                    set.push(p.id.clone());
                    changes.push(Change {
                        gear: catalogue.pick_name(p),
                        added: true,
                        reason: format!(
                            "{} needs a plugin; this one runs with no configuration",
                            crate_of(host_id)
                        ),
                    });
                    added = true;
                }
            }
        }

        let effective = catalogue.closure(&set);
        let has = |cap: &str| {
            effective
                .iter()
                .filter_map(|id| catalogue.gears.get(id))
                .any(|g| g.runtime_caps.iter().any(|c| c == cap))
        };
        if has("rest") && !has("rest_host") {
            let host = catalogue.gears.values().find(|g| {
                g.runtime_caps.iter().any(|c| c == "rest_host") && !dead.contains_key(&g.id)
            });
            if let Some(h) = host {
                set.push(h.id.clone());
                changes.push(Change {
                    gear: catalogue.pick_name(h),
                    added: true,
                    reason: "the REST gears need a REST host to serve their routes".to_string(),
                });
                added = true;
            }
        }
        if !added {
            break;
        }
    }

    // Every plugin in the product registers under the vendor its host
    // selects, or the engine refuses the pair (GBX0512). A plugin whose own
    // default disagrees gets the host's vendor set -- unless the product
    // already sets a vendor on it, which is somebody's decision to keep.
    let effective = catalogue.closure(&set);
    for host_id in &effective {
        let Some(host) = catalogue.gears.get(host_id) else {
            continue;
        };
        let Some(want) = host.vendor_selector.clone() else {
            continue;
        };
        for p in catalogue.implementers(host) {
            if !set.contains(&p.id) {
                continue;
            }
            let crate_name = catalogue.pick_name(p);
            let set_here = config
                .get(&crate_name)
                .is_some_and(|c| c.contains_key("vendor"));
            if set_here || vendor_agrees(host, p, None) {
                continue;
            }
            config
                .entry(crate_name.clone())
                .or_default()
                .insert("vendor".to_string(), Value::String(want.clone()));
            changes.push(Change {
                gear: crate_name,
                added: true,
                reason: format!(
                    "vendor set to `{want}`: {} selects its plugins by that vendor, and this one \
                     registers under `{}` by default",
                    crate_of(host_id),
                    plugin_vendor(p, None).unwrap_or_default()
                ),
            });
        }
    }

    Completion {
        gears: set.iter().map(|id| crate_of(id)).collect(),
        changes,
        config,
    }
}

// ── What a candidate brings with it ───────────────────────────────────────

/// One gear a candidate would add to the product, and why it comes along.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Brought {
    /// Crate name.
    pub gear: String,
    pub reason: String,
    /// It keeps its own database (`db` among its runtime capabilities).
    pub database: bool,
}

/// A contract the product would get from two gears: one it has, one the
/// candidate brings — the second audit store a certified platform cannot
/// keep (interview problem 4.7).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Overlap {
    pub contract: String,
    /// Crate names already in the product that provide it.
    pub already: Vec<String>,
    /// Crate names the candidate brings that provide it too.
    pub brought: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Brings {
    /// The candidate as asked; `false` when no `gear.gdl` describes it.
    pub described: bool,
    /// What is new to the product, the candidate first.
    pub brought: Vec<Brought>,
    pub overlaps: Vec<Overlap>,
    /// What completing the product with the candidate would drop or change
    /// that completing it without would not.
    pub changes: Vec<Change>,
}

/// What adding `candidate` to a product of `current` would bring with it,
/// from the catalogue alone: the gears completion adds and those they must
/// share a binary with, the host a plugin needs, and the contracts the
/// product would then get twice. Nothing is written; the engine still has
/// the last word when the product is resolved.
pub fn brings(
    catalogue: &EngineCatalogue,
    current: &[String],
    candidate: &str,
    config: &GearConfig,
) -> Brings {
    let Some(cand) = catalogue.find(candidate.trim()) else {
        return Brings::default();
    };
    let crate_of = |id: &str| catalogue.pick_name_of(id);
    let ids_of = |completion: &Completion| -> Vec<String> {
        completion
            .gears
            .iter()
            .filter_map(|n| catalogue.find(n).map(|g| g.id.clone()))
            .collect()
    };
    let before_completion = complete(catalogue, current, config);
    let mut with: Vec<String> = current.to_vec();
    with.push(catalogue.pick_name(cand));
    let after_completion = complete(catalogue, &with, config);
    let mut before = catalogue.closure(&ids_of(&before_completion));
    let mut after = catalogue.closure(&ids_of(&after_completion));
    // A plugin runs under its host: `compose` writes the host in, so count it.
    for set in [&mut before, &mut after] {
        let hosts: Vec<String> = set
            .iter()
            .filter_map(|id| catalogue.gears.get(id))
            .filter_map(|g| catalogue.host_of(g).map(|h| h.id.clone()))
            .collect();
        let hosts: Vec<String> = catalogue.closure(&hosts).into_iter().collect();
        set.extend(hosts);
    }

    let reason_for = |id: &str| -> String {
        if id == cand.id {
            return "the gear you picked".to_string();
        }
        let name = crate_of(id);
        if let Some(c) = after_completion
            .changes
            .iter()
            .find(|c| c.added && c.gear == name)
        {
            return c.reason.clone();
        }
        if let Some(g) = after
            .iter()
            .filter_map(|o| catalogue.gears.get(o))
            .find(|g| g.colocated_deps.iter().any(|d| d == id))
        {
            return format!("{} must run with it", g.package.crate_name);
        }
        if let Some(p) = after
            .iter()
            .filter_map(|o| catalogue.gears.get(o))
            .find(|g| catalogue.host_of(g).is_some_and(|h| h.id == id))
        {
            return format!("hosts the extension point {} fills", p.package.crate_name);
        }
        "completion of the product".to_string()
    };
    let mut new: Vec<&String> = after.difference(&before).collect();
    new.sort_by_key(|id| (**id != cand.id, (*id).clone()));
    let brought: Vec<Brought> = new
        .iter()
        .map(|id| Brought {
            gear: crate_of(id),
            reason: reason_for(id),
            database: catalogue
                .gears
                .get(*id)
                .is_some_and(|g| g.runtime_caps.iter().any(|c| c == "db")),
        })
        .collect();

    let provides = |id: &str| -> Vec<String> {
        catalogue
            .gears
            .get(id)
            .map(|g| g.provides.iter().map(|p| p.contract.clone()).collect())
            .unwrap_or_default()
    };
    let mut by_contract: BTreeMap<String, (BTreeSet<String>, BTreeSet<String>)> = BTreeMap::new();
    for id in &before {
        for c in provides(id) {
            by_contract.entry(c).or_default().0.insert(crate_of(id));
        }
    }
    for id in &new {
        for c in provides(id) {
            by_contract.entry(c).or_default().1.insert(crate_of(id));
        }
    }
    let overlaps = by_contract
        .into_iter()
        .filter(|(_, (a, b))| !a.is_empty() && !b.is_empty())
        .map(|(contract, (a, b))| Overlap {
            contract,
            already: a.into_iter().collect(),
            brought: b.into_iter().collect(),
        })
        .collect();

    let changes = after_completion
        .changes
        .into_iter()
        .filter(|c| !before_completion.changes.contains(c))
        .filter(|c| !(c.added && brought.iter().any(|b| b.gear == c.gear)))
        .collect();

    Brings {
        described: true,
        brought,
        overlaps,
        changes,
    }
}

// ── Facts: what the engine knows, as component-profile fields ─────────────

fn fact(v: &str) -> Value {
    serde_json::json!({ "v": v, "b": v })
}

fn lamp(v: &str, s: &str) -> Value {
    serde_json::json!({ "v": v, "b": v, "s": s })
}

/// Profile fields for every gear the corpus describes, keyed by crate name.
/// The keys are the `gearbox` group of `field_schemas/gear.json`; a gear with
/// no `gear.gdl` gets none, and its page says so through the group's empty
/// cells rather than a false "no".
pub fn gear_facts(catalogue: &EngineCatalogue, corpus: &str) -> BTreeMap<String, Value> {
    let dead = catalogue.dead();
    let crate_of = |id: &str| catalogue.pick_name_of(id);
    let list = |items: Vec<String>| {
        if items.is_empty() {
            "—".to_string()
        } else {
            items.join(", ")
        }
    };
    catalogue
        .gears
        .values()
        .map(|g| {
            let role = if !g.extension_points.is_empty() {
                let plugins = catalogue.implementers_of(g);
                if plugins.is_empty() {
                    "host; no plugin in the corpus fills it".to_string()
                } else {
                    format!("host; plugins: {}", plugins.join(", "))
                }
            } else if g.fills.is_some() {
                match catalogue.host_of(g) {
                    Some(h) => format!("plugin of {}", catalogue.pick_name(h)),
                    None => "plugin; no gear in the corpus hosts it".to_string(),
                }
            } else {
                "—".to_string()
            };
            let runs = match dead.get(&g.id) {
                None => lamp("yes", "good"),
                Some(why) => lamp(&format!("no — {}", dead_reason(catalogue, why)), "bad"),
            };
            let fields = serde_json::json!({
                "gdl": lamp("yes", "good"),
                "gdl_id": fact(&g.id),
                "gdl_caps": fact(&list(g.runtime_caps.clone())),
                "gdl_deps": fact(&list(g.colocated_deps.iter().map(|d| crate_of(d)).collect())),
                "gdl_role": fact(&role),
                "gdl_contracts": fact(&list(g.contracts())),
                "gdl_config": fact(&list(catalogue.unset_config(g))),
                "gdl_runs": runs,
                "gdl_corpus": fact(corpus),
            });
            (g.package.crate_name.clone(), fields)
        })
        .collect()
}

// ── New gears: the engine's own scaffold ──────────────────────────────────

/// The three shapes the engine scaffolds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GearKind {
    Minimal,
    Service,
    Plugin,
}

impl GearKind {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim() {
            "minimal" => Some(Self::Minimal),
            "service" | "" => Some(Self::Service),
            "plugin" => Some(Self::Plugin),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Minimal => "minimal",
            Self::Service => "service",
            Self::Plugin => "plugin",
        }
    }
}

/// Where the SDK a plugin implements lives, as its `gear.gdl` writes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SdkLocator {
    /// The spec's own GTS segment (`cf.core.authn_resolver.plugin.v1~`), which
    /// the engine writes as `fills = "..."`: the declaration that makes a
    /// crate a plugin.
    pub spec: String,
    /// The trait the plugin implements.
    pub trait_ident: String,
    pub crate_name: String,
    pub lib_ident: String,
    /// Relative to the new gear's own directory.
    pub path: String,
}

#[derive(Debug, Clone)]
pub struct GearScaffold {
    /// The crate, which is also the id the engine names the package after.
    pub crate_name: String,
    pub name: String,
    pub kind: GearKind,
    pub plugin: Option<SdkLocator>,
}

/// A host a new plugin can fill, and the SDK its extension point is in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostPoint {
    pub host_id: String,
    pub host_crate: String,
    /// The point's full GTS spec id; a host may declare several.
    pub spec: String,
    pub trait_ident: String,
    pub sdk_crate: String,
    pub sdk_lib: String,
    /// Relative to the corpus root.
    pub sdk_path: String,
    /// Whether the host can run in a product from this corpus.
    pub runs: bool,
}

pub fn host_points(catalogue: &EngineCatalogue) -> Vec<HostPoint> {
    let dead = catalogue.dead();
    let mut out: Vec<HostPoint> = catalogue
        .gears
        .values()
        .flat_map(|g| {
            let runs = !dead.contains_key(&g.id);
            g.extension_points.iter().filter_map(move |p| {
                Some(HostPoint {
                    host_id: g.id.clone(),
                    host_crate: g.package.crate_name.clone(),
                    spec: p.spec.clone()?,
                    trait_ident: p.trait_ident.clone()?,
                    sdk_crate: p.sdk.crate_name.clone(),
                    sdk_lib: p.sdk.lib_ident.clone()?,
                    sdk_path: p.sdk.path.clone()?,
                    runs,
                })
            })
        })
        .collect();
    out.sort_by(|a, b| (!a.runs, &a.host_crate, &a.spec).cmp(&(!b.runs, &b.host_crate, &b.spec)));
    out
}

/// The SDK path as a new gear's `gear.gdl` must write it: from the gear's own
/// directory, `<parent_dir>/<slug>`, to the SDK, both in one repository.
///
/// One repository, because the engine resolves a `cargo(path = ...)` inside
/// the source root that declares it and refuses a `..` that climbs out
/// (`RelPath::resolve`, reported as GBX0102). A plugin written into its own
/// repository cannot name a corpus SDK by path at all, so it is never asked to.
pub fn sdk_path_in_repo(parent_dir: &str, sdk_path: &str) -> String {
    let depth = parent_dir
        .trim_matches('/')
        .split('/')
        .filter(|s| !s.is_empty())
        .count()
        + 1;
    format!(
        "{}{}",
        "../".repeat(depth),
        sdk_path.trim_start_matches('/')
    )
}

/// The SDK path from a gear in a project's own repository to the corpus
/// checkout beside it in a Studio workspace: `<checkout>/<parent_dir>/<slug>`
/// up to the workspace, then `gears-rust/`.
pub fn sdk_path_beside(parent_dir: &str, sdk_path: &str) -> String {
    let depth = parent_dir
        .trim_matches('/')
        .split('/')
        .filter(|s| !s.is_empty())
        .count()
        + 2;
    format!(
        "{}{CORPUS_SOURCE_ID}/{}",
        "../".repeat(depth),
        sdk_path.trim_start_matches('/')
    )
}

/// A plugin spec's own GTS segment: `cf.toolkit.plugins.plugin.v1~cf.core.x.plugin.v1~`
/// -> `cf.core.x.plugin.v1~`, the form a plugin's `fills = "..."` is written in.
pub fn spec_segment(spec: &str) -> &str {
    spec.strip_prefix("cf.toolkit.plugins.plugin.v1~")
        .unwrap_or(spec)
}

/// `https://github.com/Owner/Repo.git`, `owner/repo` -> `owner/repo`: the form
/// two spellings of one repository compare equal in.
pub fn repo_key(value: &str) -> String {
    let v = value.trim().trim_end_matches('/').trim_end_matches(".git");
    let v = v.split_once("://").map_or(v, |(_, rest)| rest);
    let parts: Vec<&str> = v.split('/').filter(|s| !s.is_empty()).collect();
    let tail = if parts.len() > 2 {
        &parts[parts.len() - 2..]
    } else {
        &parts[..]
    };
    tail.join("/").to_ascii_lowercase()
}

fn answer_gdl(result: &Value) -> anyhow::Result<String> {
    if let Some(error) = result.get("error") {
        bail!(
            "the engine refused the scaffold: {}",
            error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("no message")
        );
    }
    result
        .pointer("/result/gear_gdl")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| anyhow!("the engine's scaffold answer has no gear_gdl"))
}

/// One request to `gearbox rpc --stdio`: initialize (writes declared, because
/// the scaffold method refuses a read-only session even for a dry run), the
/// request, shut down. Returns the request's whole response. Blocking.
fn rpc_once(
    bin: &Path,
    root: &Path,
    workspace: &Path,
    method: &str,
    params: Value,
) -> anyhow::Result<Value> {
    use std::io::{BufRead, BufReader, Write};

    let mut child = Command::new(bin)
        .args(["rpc", "--stdio", "--root"])
        .arg(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| anyhow!("cannot run the Gearbox engine `{}`: {e}", bin.display()))?;
    let mut stdin = child.stdin.take().expect("stdin is piped");
    let stdout = child.stdout.take().expect("stdout is piped");

    let (tx, rx) = std::sync::mpsc::channel::<Value>();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut length = None;
            loop {
                let mut line = String::new();
                if reader
                    .read_line(&mut line)
                    .ok()
                    .filter(|n| *n > 0)
                    .is_none()
                {
                    return;
                }
                let line = line.trim_end();
                if line.is_empty() {
                    break;
                }
                if let Some(v) = line.strip_prefix("Content-Length:") {
                    length = v.trim().parse::<usize>().ok();
                }
            }
            let Some(n) = length else { return };
            let mut body = vec![0u8; n];
            if std::io::Read::read_exact(&mut reader, &mut body).is_err() {
                return;
            }
            if let Ok(v) = serde_json::from_slice::<Value>(&body)
                && tx.send(v).is_err()
            {
                return;
            }
        }
    });

    let mut send = |message: Value| -> anyhow::Result<()> {
        let body = serde_json::to_vec(&message)?;
        write!(stdin, "Content-Length: {}\r\n\r\n", body.len())?;
        stdin.write_all(&body)?;
        stdin.flush()?;
        Ok(())
    };
    let deadline = Instant::now() + ENGINE_TIMEOUT;
    let wait_for = |id: i64| -> anyhow::Result<Value> {
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let message = rx.recv_timeout(left).map_err(|_| {
                anyhow!(
                    "the Gearbox engine did not answer within {}s",
                    ENGINE_TIMEOUT.as_secs()
                )
            })?;
            if message.get("id").and_then(Value::as_i64) == Some(id) {
                return Ok(message);
            }
        }
    };

    let outcome = (|| {
        send(
            serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "roots": [root.to_string_lossy()],
                "workspace": workspace.to_string_lossy(),
                "allow_writes": true,
            }}),
        )?;
        let init = wait_for(1)?;
        if let Some(e) = init.get("error") {
            bail!("the engine refused to initialize: {e}");
        }
        send(serde_json::json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} }))?;
        send(serde_json::json!({ "jsonrpc": "2.0", "id": 2, "method": method, "params": params }))?;
        let answer = wait_for(2)?;
        let _ = send(
            serde_json::json!({ "jsonrpc": "2.0", "id": 3, "method": "shutdown", "params": null }),
        );
        let _ = send(serde_json::json!({ "jsonrpc": "2.0", "method": "exit" }));
        Ok(answer)
    })();
    let _ = child.kill();
    let _ = child.wait();
    outcome
}

/// A product id is a kebab-case id in GDL: lowercase letters, digits, single
/// interior hyphens, starting with a letter.
pub fn is_kebab_id(s: &str) -> bool {
    let bytes = s.as_bytes();
    !bytes.is_empty()
        && bytes[0].is_ascii_lowercase()
        && bytes.last().is_some_and(|b| *b != b'-')
        && !s.contains("--")
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// A JSON value as a GDL literal: strings quoted, `True`/`False`, lists and
/// maps nested. `null` has no GDL spelling and is left out by the caller.
fn gdl_value(v: &Value) -> String {
    match v {
        Value::String(s) => gdl_string(s),
        Value::Bool(true) => "True".to_string(),
        Value::Bool(false) => "False".to_string(),
        Value::Number(n) => n.to_string(),
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .filter(|i| !i.is_null())
                .map(gdl_value)
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Value::Object(map) => gdl_map(map),
        Value::Null => "None".to_string(),
    }
}

/// `{"key": value, ...}`, keys in order, nulls dropped.
fn gdl_map(map: &serde_json::Map<String, Value>) -> String {
    let body = map
        .iter()
        .filter(|(_, v)| !v.is_null())
        .map(|(k, v)| format!("{}: {}", gdl_string(k), gdl_value(v)))
        .collect::<Vec<_>>()
        .join(", ");
    format!("{{{body}}}")
}

fn gdl_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Which corpus a description names, and at which commit: one root, as a
/// test spells it ([`render_product_gdl_from`] takes several).
#[cfg(test)]
#[derive(Debug, Clone, Copy)]
pub struct CorpusPin<'a> {
    pub url: &'a str,
    pub rev: &'a str,
}

/// Where a new product's description goes in its project's repository:
/// `products/<id>/product.gdl`. The file keeps the name the engine and the IDE
/// look for, and the product's id names its directory, so a repository shows
/// which product it holds and can hold more than one. `product_id` must be a
/// kebab-case id ([`is_kebab_id`]), which keeps the path inside `products/`.
pub fn product_gdl_path(product_id: &str) -> String {
    format!("products/{product_id}/product.gdl")
}

/// One gear repository a `product.gdl` names: its source id, its clone URL,
/// and the commit it was checked against. Without a commit, the description
/// reaches the checkout beside the repository instead.
pub struct SourcePin<'a> {
    pub id: &'a str,
    pub url: &'a str,
    pub rev: Option<&'a str>,
}

/// The `product.gdl` for a composition, to be saved at `product_path` in the
/// project's repository. `default_profile` must be one of [`PROFILES`].
///
/// With a `pin`, the corpus is a git source at the commit the composition was
/// checked against, so the description says by itself what it was built from
/// and needs no checkout beside it; the IDE brings that commit in when it opens
/// the product. Without one (a corpus whose commit is unknown), the sibling
/// checkout, reached from where the description sits.
#[cfg(test)]
pub fn render_product_gdl(
    product_id: &str,
    product_path: &str,
    name: &str,
    composition: &Composition,
    default_profile: &str,
    pin: Option<CorpusPin<'_>>,
    config: &BTreeMap<String, serde_json::Map<String, Value>>,
) -> String {
    let source = SourcePin {
        id: CORPUS_SOURCE_ID,
        url: pin.as_ref().map_or("", |p| p.url),
        rev: pin.as_ref().map(|p| p.rev),
    };
    render_product_gdl_from(
        product_id,
        product_path,
        name,
        composition,
        default_profile,
        &[source],
        &BTreeMap::new(),
        config,
    )
}

/// [`render_product_gdl`] over several gear repositories (ADR-0046): one
/// `source` per repository, and each `use_gear` naming the repository the
/// engine found it in (`gear_source`, by engine id; the first repository when
/// unknown).
#[allow(clippy::too_many_arguments)]
pub fn render_product_gdl_from(
    product_id: &str,
    product_path: &str,
    name: &str,
    composition: &Composition,
    default_profile: &str,
    sources: &[SourcePin<'_>],
    gear_source: &BTreeMap<String, String>,
    config: &BTreeMap<String, serde_json::Map<String, Value>>,
) -> String {
    // `config` is keyed by engine id here; the caller maps crate names.
    let config_arg = |id: &str| {
        config
            .get(id)
            .filter(|c| c.values().any(|v| !v.is_null()))
            .map(|c| format!(", config = {}", gdl_map(c)))
            .unwrap_or_default()
    };
    let first = sources.first().map_or(CORPUS_SOURCE_ID, |s| s.id);
    let source_of = |id: &str| -> String {
        gear_source
            .get(id)
            .filter(|s| sources.iter().any(|p| p.id == s.as_str()))
            .map_or_else(|| first.to_string(), Clone::clone)
    };
    let mut gears = String::new();
    for g in &composition.gears {
        if g.plugins.is_empty() {
            gears.push_str(&format!(
                "        use_gear({}, source = {}{}),\n",
                gdl_string(&g.id),
                gdl_string(&source_of(&g.id)),
                config_arg(&g.id)
            ));
        } else {
            let plugins = g
                .plugins
                .iter()
                .map(|p| format!("plugin({}{})", gdl_string(p), config_arg(p)))
                .collect::<Vec<_>>()
                .join(", ");
            gears.push_str(&format!(
                "        use_gear({}, source = {}{}, plugins = [{plugins}]),\n",
                gdl_string(&g.id),
                gdl_string(&source_of(&g.id)),
                config_arg(&g.id)
            ));
        }
    }
    let id = gdl_string(product_id);
    let depth = product_path.split('/').filter(|s| !s.is_empty()).count();
    let up = "../".repeat(depth.max(1));
    let names = sources
        .iter()
        .map(|s| format!("`{}`", s.id))
        .collect::<Vec<_>>()
        .join(", ");
    let pinned = !sources.is_empty() && sources.iter().all(|s| s.rev.is_some());
    let from = if pinned {
        format!(
            "# gears come from {names} at the commit this was checked against;\n\
             # the Studio IDE brings that commit in when it opens the product. From a\n\
             # checkout of {names} at that commit, resolve it with"
        )
    } else {
        format!(
            "# gears come from the {names} checkout beside this repository in a\n\
             # Studio workspace. Resolve it with"
        )
    };
    let roots = sources
        .iter()
        .map(|s| format!("--root {up}{}", s.id))
        .collect::<Vec<_>>()
        .join(" ");
    let declared = sources
        .iter()
        .map(|s| {
            let at = match s.rev {
                Some(rev) => format!(
                    "git(url = {}, rev = {})",
                    gdl_string(s.url),
                    gdl_string(rev)
                ),
                None => format!("path({})", gdl_string(&format!("{up}{}", s.id))),
            };
            format!("source(id = {}, at = {at})", gdl_string(s.id))
        })
        .collect::<Vec<_>>()
        .join(",\n                   ");
    format!(
        "# The product this project ships, as Gearbox composes it.\n\
         #\n\
         # Written by Constructor Studio from the gears picked for the project. The\n\
         {from}\n\
         #\n\
         #   gearbox resolve {roots} --product product.gdl --profile dev\n\
         #\n\
         # Reference: https://github.com/constructorfabric/gearbox/blob/main/docs/gdl.md\n\
         \n\
         product(\n\
         \x20   id = {id},\n\
         \x20   name = {name},\n\
         \x20   version = \"0.1.0\",\n\
         \x20   sources = [{declared}],\n\
         \x20   profiles = [\n\
         \x20       embedded(id = \"dev\"),\n\
         \x20       self_hosted(id = \"local\", host = {id}, worker_discovery = \"directory\",\n\
         \x20                   target_dir = \"target\"),\n\
         \x20       kubernetes(id = \"prod\", discovery = \"static\", namespace = {id}),\n\
         \x20   ],\n\
         \x20   default_profile = {profile},\n\
         \x20   gears = [\n\
         {gears}\
         \x20   ],\n\
         )\n",
        name = gdl_string(name),
        profile = gdl_string(default_profile),
    )
}

// ── What the engine said ──────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineDiagnostic {
    pub code: String,
    pub severity: String,
    pub message: String,
    pub help: Option<String>,
    /// Where it points: `product.gdl` or a corpus-relative `gear.gdl`.
    pub file: Option<String>,
    /// One-based.
    pub line: Option<u32>,
}

impl EngineDiagnostic {
    pub fn is_error(&self) -> bool {
        self.severity == "error"
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineListen {
    pub name: String,
    pub gear: String,
    pub address: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineApplication {
    pub name: String,
    pub kind: String,
    pub anchor: Option<String>,
    pub gears: Vec<String>,
    pub replicas: u32,
    pub listens: Vec<EngineListen>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineResolvedGear {
    pub id: String,
    pub crate_name: String,
    /// Why it is in the product: `selected`, `colocated with api-gateway`,
    /// `plugin of authn-resolver`.
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Resolution {
    pub applications: Vec<EngineApplication>,
    pub gears: Vec<EngineResolvedGear>,
    pub diagnostics: Vec<EngineDiagnostic>,
}

/// Diagnostics as the engine serializes them, with locations made relative:
/// a URI inside the corpus becomes its corpus path, the product file becomes
/// `product.gdl`, and anything else keeps only its file name.
pub fn parse_diagnostics(v: &Value, corpus: &Path) -> Vec<EngineDiagnostic> {
    let corpus = corpus.to_string_lossy().replace('\\', "/");
    let corpus = corpus.trim_end_matches('/');
    v.as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|d| {
                    let s = |k: &str| d.get(k).and_then(Value::as_str).map(str::to_string);
                    let uri = d.pointer("/location/uri").and_then(Value::as_str);
                    let file = uri.map(|u| {
                        let path = u.strip_prefix("file://").unwrap_or(u);
                        match path.strip_prefix(corpus) {
                            Some(rel) => rel.trim_start_matches('/').to_string(),
                            None => path.rsplit('/').next().unwrap_or(path).to_string(),
                        }
                    });
                    let line = d
                        .pointer("/location/range/start/line")
                        .and_then(Value::as_u64)
                        .and_then(|l| u32::try_from(l + 1).ok());
                    Some(EngineDiagnostic {
                        code: s("code")?,
                        severity: s("severity").unwrap_or_else(|| "error".into()),
                        message: s("message").unwrap_or_default(),
                        help: s("help"),
                        file,
                        line,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn parse_resolution(v: &Value, corpus: &Path) -> Resolution {
    let str_list = |v: Option<&Value>| -> Vec<String> {
        v.and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    };
    let applications = v
        .get("applications")
        .and_then(Value::as_array)
        .map(|apps| {
            apps.iter()
                .map(|a| {
                    let s = |k: &str| a.get(k).and_then(Value::as_str).map(str::to_string);
                    EngineApplication {
                        name: s("name").unwrap_or_default(),
                        kind: s("kind").unwrap_or_default(),
                        anchor: s("anchor"),
                        gears: str_list(a.get("gears")),
                        replicas: a
                            .get("replicas")
                            .and_then(Value::as_u64)
                            .and_then(|n| u32::try_from(n).ok())
                            .unwrap_or(1),
                        listens: a
                            .get("listens")
                            .and_then(Value::as_array)
                            .map(|ls| {
                                ls.iter()
                                    .map(|l| {
                                        let s = |k: &str| {
                                            l.get(k)
                                                .and_then(Value::as_str)
                                                .unwrap_or_default()
                                                .to_string()
                                        };
                                        EngineListen {
                                            name: s("name"),
                                            gear: s("gear"),
                                            address: s("address"),
                                        }
                                    })
                                    .collect()
                            })
                            .unwrap_or_default(),
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    let gears = v
        .get("gears")
        .and_then(Value::as_object)
        .map(|gears| {
            gears
                .values()
                .map(|g| EngineResolvedGear {
                    id: g
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    crate_name: g
                        .pointer("/package/crate_name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    reasons: g
                        .get("selected_by")
                        .and_then(Value::as_array)
                        .map(|rs| rs.iter().map(reason).collect())
                        .unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default();
    Resolution {
        applications,
        gears,
        diagnostics: v
            .get("diagnostics")
            .map(|d| parse_diagnostics(d, corpus))
            .unwrap_or_default(),
    }
}

fn reason(r: &Value) -> String {
    let s = |k: &str| r.get(k).and_then(Value::as_str).unwrap_or_default();
    match s("reason") {
        "colocated_by" => format!("colocated with {}", s("gear")),
        "plugin_of" => format!("plugin of {}", s("host")),
        "" => "selected".to_string(),
        other => other.replace('_', " "),
    }
}

// ── Running it ────────────────────────────────────────────────────────────

pub struct PreviewInput {
    pub product_id: String,
    /// Where the description is saved, relative to the repository root
    /// ([`product_gdl_path`] for a new one). The engine is run on it laid out
    /// the same way, so a sibling corpus resolves as it will in the IDE.
    pub product_path: String,
    pub name: String,
    pub gears: Vec<String>,
    pub profile: String,
    /// The product's configuration of its gears, by crate name or engine id.
    pub config: GearConfig,
}

pub struct Preview {
    pub product_gdl: String,
    pub composition: Composition,
    pub resolution: Resolution,
    pub corpus_commit: Option<String>,
}

#[derive(Debug, Clone)]
pub struct GearboxStatus {
    pub engine_version: Option<String>,
    pub corpus_url: String,
    pub corpus_ref: String,
    pub corpus_commit: Option<String>,
    pub problem: Option<String>,
    /// Each root the engine reads, in its order.
    pub sources: Vec<SourceStatus>,
}

/// One gear repository as the engine last read it.
#[derive(Debug, Clone)]
pub struct SourceStatus {
    pub source_id: String,
    /// `owner/repo`, or the deployment's URL for its corpus.
    pub repo: String,
    pub git_ref: String,
    pub commit: Option<String>,
    /// Gears the engine attributes to it.
    pub gears: usize,
    /// The gear repository connection it comes from; `None` for the
    /// deployment's corpus.
    pub connection_id: Option<uuid::Uuid>,
}

/// A root of the corpus: a gear repository and the id the engine knows it by.
#[derive(Clone)]
pub struct GearRoot {
    pub id: String,
    pub source: CorpusSource,
    /// The connection it is read through; `None` for the deployment's corpus.
    pub connection_id: Option<uuid::Uuid>,
}

impl GearRoot {
    /// What decides whether a checkout is still the one asked for.
    fn same(&self, other: &Self) -> bool {
        self.id == other.id
            && self.connection_id == other.connection_id
            && self.source.key == other.source.key
            && self.source.url == other.source.url
            && self.source.git_ref == other.source.git_ref
            && self.source.token == other.source.token
    }
}

/// A root as it is checked out.
#[derive(Clone)]
struct Root {
    id: String,
    dir: PathBuf,
    commit: Option<String>,
}

struct Corpus {
    roots: Vec<Root>,
    /// The [`RootSet`] generation these roots were checked out for.
    generation: u64,
    refreshed: Instant,
    catalogue: Option<Arc<EngineCatalogue>>,
    /// The engine's answer verbatim, for a client that reads more of it than
    /// composing does: the IDE's catalogue renders every `GearDescriptor`.
    raw: Option<Arc<Value>>,
}

impl Corpus {
    /// The first root's commit: the one a single-corpus client shows.
    fn commit(&self) -> Option<String> {
        self.roots.first().and_then(|r| r.commit.clone())
    }
}

/// The roots asked for, and when the platform's list was last read.
struct RootSet {
    list: Vec<GearRoot>,
    generation: u64,
    checked: Option<Instant>,
}

/// A repository checked out under the engine's working directory: a root of
/// the corpus, or a catalogue source whose files the component catalogue
/// reads.
#[derive(Clone)]
pub struct CorpusSource {
    /// `owner/repo@ref`, as a person reads it.
    pub label: String,
    /// Namespaces the checkout directory, so two sources never share one.
    pub key: String,
    pub repo: String,
    pub url: String,
    pub username: String,
    /// Held in memory only, for the refresh fetch; never logged or returned.
    pub token: String,
    pub git_ref: String,
}

pub struct Gearbox {
    cfg: GearboxConfig,
    corpus: Mutex<Option<Corpus>>,
    roots: std::sync::Mutex<RootSet>,
}

/// The deployment's corpus as the one root, when it names one.
fn deployment_roots(cfg: &GearboxConfig) -> Vec<GearRoot> {
    if cfg.corpus_url.trim().is_empty() {
        return Vec::new();
    }
    vec![GearRoot {
        id: CORPUS_SOURCE_ID.to_string(),
        source: CorpusSource {
            label: format!(
                "{}@{}",
                cfg.corpus_url
                    .trim_end_matches(".git")
                    .trim_start_matches("https://github.com/"),
                cfg.corpus_ref
            ),
            key: "gearbox".to_string(),
            repo: CORPUS_SOURCE_ID.to_string(),
            url: cfg.corpus_url.clone(),
            username: "x-access-token".to_string(),
            token: String::new(),
            git_ref: cfg.corpus_ref.clone(),
        },
        connection_id: None,
    }]
}

impl Gearbox {
    pub fn new(cfg: GearboxConfig) -> Self {
        let list = deployment_roots(&cfg);
        Self {
            cfg,
            corpus: Mutex::new(None),
            roots: std::sync::Mutex::new(RootSet {
                list,
                generation: 0,
                checked: None,
            }),
        }
    }

    /// The roots the corpus is read from, in the engine's order.
    pub fn roots(&self) -> Vec<GearRoot> {
        self.roots.lock().expect("gearbox roots").list.clone()
    }

    /// Whether the platform's gear repositories are due to be read again.
    pub fn roots_due(&self) -> bool {
        self.roots
            .lock()
            .expect("gearbox roots")
            .checked
            .is_none_or(|t| t.elapsed() >= ROOTS_RECHECK)
    }

    /// Read the corpus from `repositories` (the platform's gear repositories,
    /// in order), or from the deployment's corpus while there are none. A
    /// list unlike the last one is checked out afresh on the next use.
    pub fn use_repositories(&self, repositories: Vec<GearRoot>) {
        let list = if repositories.is_empty() {
            deployment_roots(&self.cfg)
        } else {
            repositories
        };
        let mut set = self.roots.lock().expect("gearbox roots");
        set.checked = Some(Instant::now());
        let unchanged =
            set.list.len() == list.len() && set.list.iter().zip(&list).all(|(a, b)| a.same(b));
        if !unchanged {
            set.list = list;
            set.generation += 1;
        }
    }

    /// Note a failed read of the platform's list, so it is not retried on
    /// every request.
    pub fn mark_roots_checked(&self) {
        self.roots.lock().expect("gearbox roots").checked = Some(Instant::now());
    }

    fn first_source(&self) -> Option<CorpusSource> {
        self.roots().into_iter().next().map(|r| r.source)
    }

    /// Whether `repo_key` (`owner/repo`) is one of the corpus's repositories.
    pub fn is_corpus_repo(&self, repo_key: &str) -> bool {
        self.roots()
            .iter()
            .any(|r| self::repo_key(&r.source.url) == repo_key)
    }

    /// The directory the corpus is checked out under; also where the
    /// components reference keeps its last engine catalogue across restarts.
    pub fn workdir(&self) -> &Path {
        &self.cfg.workdir
    }

    /// The corpus the catalogue, previews and facts are read from, as a label:
    /// each root's `owner/repo@ref`.
    pub fn corpus_label(&self) -> String {
        let labels: Vec<String> = self.roots().into_iter().map(|r| r.source.label).collect();
        if labels.is_empty() {
            "no gear repository".to_string()
        } else {
            labels.join(", ")
        }
    }

    /// Where a client can clone the corpus's first root itself: its URL and
    /// ref, and whether reaching it takes the token this backend holds (which
    /// is never handed out, so such a corpus cannot be cloned from a laptop
    /// directly). One root for now: the relay per root is ADR-0046 phase 2.
    pub fn corpus_origin(&self) -> (String, String, bool) {
        self.first_source()
            .map(|s| (s.url, s.git_ref, !s.token.is_empty()))
            .unwrap_or_default()
    }

    /// The source id of the root [`Self::corpus_origin`] names.
    pub fn corpus_source_id(&self) -> String {
        self.roots()
            .into_iter()
            .next()
            .map_or_else(|| CORPUS_SOURCE_ID.to_string(), |r| r.id)
    }

    /// What the corpus Git relay sends upstream: the repository URL and the
    /// token it is read with (empty for a public corpus). Server-side only.
    pub(crate) fn corpus_fetch(&self) -> (String, String) {
        self.first_source()
            .map(|s| (s.url, s.token))
            .unwrap_or_default()
    }

    /// Check `source` out (or bring its checkout up to date) under the engine's
    /// working directory, and say where.
    ///
    /// The component catalogue reads its gears' files from here too, so one
    /// clone serves the catalogue, the previews and the IDE: the key namespaces
    /// the directory by source, and a second call for the same source is a
    /// fetch, not a download.
    pub async fn checkout(&self, source: &CorpusSource) -> anyhow::Result<PathBuf> {
        let workdir = self.cfg.workdir.clone();
        let s = source.clone();
        tokio::task::spawn_blocking(move || {
            // An empty ref is the repository's default branch.
            let git_ref = Some(s.git_ref.as_str()).filter(|r| !r.trim().is_empty());
            crate::connectors::sdk::git_checkout::clone_or_update(
                &workdir,
                &s.key,
                &s.repo,
                &s.url,
                &s.username,
                &s.token,
                git_ref,
            )
            .map(|c| c.dir)
        })
        .await
        .context("catalogue source checkout task")?
    }

    /// What the engine knows about every gear the corpus describes, keyed by
    /// crate name and shaped as component-profile fields (`{v, b, s}`), with
    /// the corpus they were read from.
    pub async fn facts(&self) -> anyhow::Result<(String, BTreeMap<String, Value>)> {
        let (_, commit, catalogue) = self.ensure_corpus().await?;
        let mut label = self.corpus_label();
        if let Some(c) = commit {
            label = format!("{label} ({})", &c[..c.len().min(7)]);
        }
        Ok((label.clone(), gear_facts(&catalogue, &label)))
    }

    pub async fn status(&self) -> GearboxStatus {
        let bin = self.cfg.bin.clone();
        let version =
            tokio::task::spawn_blocking(move || run_engine(&bin, &["--version".into()], None).ok())
                .await
                .ok()
                .flatten()
                .filter(|o| o.success)
                .map(|o| o.stdout.trim().to_string());
        let (commit, problem) = match self.ensure_corpus().await {
            Ok((_, commit, _)) => (commit, None),
            Err(e) => (None, Some(format!("{e:#}"))),
        };
        let roots = self.roots();
        let (commits, counts) = {
            let guard = self.corpus.lock().await;
            let commits: BTreeMap<String, Option<String>> = guard
                .as_ref()
                .map(|c| {
                    c.roots
                        .iter()
                        .map(|r| (r.id.clone(), r.commit.clone()))
                        .collect()
                })
                .unwrap_or_default();
            let mut counts: BTreeMap<String, usize> = BTreeMap::new();
            if let Some(raw) = guard.as_ref().and_then(|c| c.raw.clone()) {
                for g in raw
                    .get("gears")
                    .and_then(Value::as_object)
                    .into_iter()
                    .flat_map(|m| m.values())
                {
                    if let Some(src) = g.get("source").and_then(Value::as_str) {
                        *counts.entry(src.to_string()).or_default() += 1;
                    }
                }
            }
            (commits, counts)
        };
        let sources = roots
            .iter()
            .map(|r| SourceStatus {
                source_id: r.id.clone(),
                repo: repo_key(&r.source.url),
                git_ref: r.source.git_ref.clone(),
                commit: commits.get(&r.id).cloned().flatten(),
                gears: counts.get(&r.id).copied().unwrap_or(0),
                connection_id: r.connection_id,
            })
            .collect();
        let first = roots.first().map(|r| r.source.clone());
        GearboxStatus {
            problem: if version.is_none() {
                Some(format!(
                    "the Gearbox engine `{}` did not run",
                    self.cfg.bin.display()
                ))
            } else {
                problem
            },
            engine_version: version,
            corpus_url: first.as_ref().map(|s| s.url.clone()).unwrap_or_default(),
            corpus_ref: first.map(|s| s.git_ref).unwrap_or_default(),
            corpus_commit: commit,
            sources,
        }
    }

    /// The corpus's roots checked out, refreshed at most once per `refresh`
    /// and whenever the roots asked for change, and their catalogue, loaded
    /// once per set of commits. Returns each root's id and directory, the
    /// first root's commit, and the catalogue.
    async fn ensure_corpus(
        &self,
    ) -> anyhow::Result<(Vec<(String, PathBuf)>, Option<String>, Arc<EngineCatalogue>)> {
        let (wanted, generation) = {
            let set = self.roots.lock().expect("gearbox roots");
            (set.list.clone(), set.generation)
        };
        if wanted.is_empty() {
            bail!(
                "no gear repository: the platform has none connected, and the deployment names \
                 no corpus (STUDIO_GEARBOX_CORPUS_URL)"
            );
        }
        let mut guard = self.corpus.lock().await;
        let stale = guard.as_ref().is_none_or(|c| {
            c.generation != generation || c.refreshed.elapsed() >= self.cfg.refresh
        });
        if stale {
            let workdir = self.cfg.workdir.clone();
            let asked = wanted.clone();
            let cloned = tokio::task::spawn_blocking(move || {
                asked
                    .iter()
                    .map(|r| {
                        let s = &r.source;
                        let git_ref = Some(s.git_ref.as_str()).filter(|g| !g.trim().is_empty());
                        // `gearbox-roots/<key>/<source id>`: the engine names a
                        // root by its directory -- the real one, after links
                        // are followed -- so the checkout itself carries the
                        // id; the key keeps two connections apart.
                        crate::connectors::sdk::git_checkout::clone_or_update_into(
                            &workdir.join("gearbox-roots").join(&s.key).join(&r.id),
                            &s.url,
                            &s.username,
                            &s.token,
                            git_ref,
                        )
                    })
                    .collect::<Vec<_>>()
            })
            .await
            .context("corpus sync task")?;
            let previous = guard.as_ref().filter(|c| c.generation == generation);
            let mut roots = Vec::with_capacity(wanted.len());
            for (r, result) in wanted.iter().zip(cloned) {
                match result {
                    Ok(c) => roots.push(Root {
                        id: r.id.clone(),
                        dir: c.dir,
                        commit: c.commit,
                    }),
                    // Keep serving the checkout we have; a flaky fetch should
                    // not turn every preview into an error.
                    Err(e) => match previous.and_then(|p| p.roots.iter().find(|x| x.id == r.id)) {
                        Some(kept) => {
                            warn!(source = %r.id, error = %format!("{e:#}"), "gearbox: gear repository refresh failed; using the last checkout");
                            roots.push(kept.clone());
                        }
                        None => {
                            return Err(e.context(format!(
                                "cannot check out the gear repository `{}` ({})",
                                r.id, r.source.label
                            )));
                        }
                    },
                }
            }
            let same = previous.is_some_and(|p| {
                p.roots.len() == roots.len()
                    && p.roots
                        .iter()
                        .zip(&roots)
                        .all(|(a, b)| a.id == b.id && a.commit == b.commit)
            });
            let (catalogue, raw) = if same {
                previous
                    .map(|p| (p.catalogue.clone(), p.raw.clone()))
                    .unwrap_or_default()
            } else {
                (None, None)
            };
            *guard = Some(Corpus {
                roots,
                generation,
                refreshed: Instant::now(),
                catalogue,
                raw,
            });
        }
        let corpus = guard.as_mut().expect("corpus is set above");
        let named: Vec<(String, PathBuf)> = corpus
            .roots
            .iter()
            .map(|r| (r.id.clone(), r.dir.clone()))
            .collect();
        if corpus.catalogue.is_none() {
            let bin = self.cfg.bin.clone();
            let mut args: Vec<String> = vec!["catalogue".into()];
            // Each root under a directory named by its source id: the engine
            // takes a root's id from its directory's name when there are
            // several (`--source-id` names one root only).
            for (_, dir) in &named {
                args.push("--root".into());
                args.push(dir.to_string_lossy().into_owned());
            }
            args.extend(["--format".into(), "json".into()]);
            let out = tokio::task::spawn_blocking(move || run_engine(&bin, &args, None))
                .await
                .context("catalogue task")??;
            let raw: Value = serde_json::from_str(&out.stdout).with_context(|| {
                format!("the engine's catalogue is not JSON: {}", out.stderr_tail())
            })?;
            let parsed: EngineCatalogue = serde_json::from_value(raw.clone())
                .context("the engine's catalogue does not have the expected shape")?;
            corpus.catalogue = Some(Arc::new(parsed));
            corpus.raw = Some(Arc::new(raw));
        }
        Ok((
            named,
            corpus.commit(),
            corpus.catalogue.clone().expect("catalogue is set above"),
        ))
    }

    /// The corpus's catalogue as the engine printed it (`gearbox catalogue
    /// --format json`), and the commit it was read at. One checkout serves
    /// every project, so an IDE lists the gears without cloning the corpus.
    pub async fn catalogue_json(&self) -> anyhow::Result<(Arc<Value>, Option<String>)> {
        self.ensure_corpus().await?;
        let guard = self.corpus.lock().await;
        let corpus = guard.as_ref().context("the corpus is not checked out")?;
        let raw = corpus.raw.clone().context("the corpus has no catalogue")?;
        Ok((raw, corpus.commit()))
    }

    /// [`complete`] against the current corpus.
    pub async fn complete(
        &self,
        picked: &[String],
        config: &GearConfig,
    ) -> anyhow::Result<Completion> {
        let (_, _, catalogue) = self.ensure_corpus().await?;
        Ok(complete(&catalogue, picked, config))
    }

    /// [`brings`] against the current corpus.
    pub async fn brings(
        &self,
        current: &[String],
        candidate: &str,
        config: &GearConfig,
    ) -> anyhow::Result<Brings> {
        let (_, _, catalogue) = self.ensure_corpus().await?;
        Ok(brings(&catalogue, current, candidate, config))
    }

    /// [`config_schemas`] against the current corpus.
    pub async fn config_schemas(&self, names: &[String]) -> anyhow::Result<Vec<GearConfigSchema>> {
        let (_, _, catalogue) = self.ensure_corpus().await?;
        Ok(config_schemas(&catalogue, names))
    }

    /// The extension points a new plugin gear can fill, one per host.
    pub async fn extension_points(&self) -> anyhow::Result<Vec<HostPoint>> {
        let (_, _, catalogue) = self.ensure_corpus().await?;
        Ok(host_points(&catalogue))
    }

    /// The `gear.gdl` the engine writes for a new gear, from its own
    /// scaffold, so a gear Studio creates is described the way Gearbox Studio
    /// describes one. Dry run: nothing is written; the text is returned.
    pub async fn scaffold_gdl(&self, spec: GearScaffold) -> anyhow::Result<String> {
        let bin = self.cfg.bin.clone();
        let scratch =
            std::env::temp_dir().join(format!("studio-gearbox-scaffold-{}", uuid::Uuid::new_v4()));
        let result = tokio::task::spawn_blocking(move || {
            // **An empty root, named for the corpus, not the corpus checkout.**
            // The RPC takes a root's source id from its directory's name, and
            // the checkout lives at `gearbox__gears_rust` (`clone_or_update`'s
            // layout), which is not a valid id -- the engine refused every
            // scaffold with "no source root is open". The CLI calls pass
            // `--source-id`; the RPC has no such parameter. Nor does the
            // scaffold read the corpus: the host's spec, trait and SDK arrive
            // in the params, taken from the catalogue.
            let root = scratch.join(CORPUS_SOURCE_ID);
            std::fs::create_dir_all(&root)?;
            let params = serde_json::json!({
                "id": spec.crate_name,
                "name": spec.name,
                "version": "0.1.0",
                "kind": spec.kind.as_str(),
                "plugin": spec.plugin.as_ref().map(|p| serde_json::json!({
                    "spec": p.spec,
                    "trait_ident": p.trait_ident,
                    "crate_name": p.crate_name,
                    "lib_ident": p.lib_ident,
                    "path": p.path,
                })),
                "destination_dir": scratch.join("gear").to_string_lossy(),
                "dry_run": true,
            });
            let answer = rpc_once(&bin, &root, &scratch, "gearbox/gear/scaffold", params);
            let _ = std::fs::remove_dir_all(&scratch);
            answer
        })
        .await
        .context("scaffold task")??;
        answer_gdl(&result)
    }

    pub async fn preview(&self, input: PreviewInput) -> anyhow::Result<Preview> {
        if !is_kebab_id(&input.product_id) {
            bail!(
                "product id `{}` is not a kebab-case id (lowercase letters, digits, single hyphens)",
                input.product_id
            );
        }
        if !PROFILES.contains(&input.profile.as_str()) {
            bail!(
                "profile `{}` is not one of {}",
                input.profile,
                PROFILES.join(", ")
            );
        }
        let (named, commit, catalogue) = self.ensure_corpus().await?;
        let composition = compose(&catalogue, &input.gears);
        // Each root at the commit it was read at, so the description says by
        // itself what it was built from.
        let checked: BTreeMap<String, Option<String>> = {
            let guard = self.corpus.lock().await;
            guard
                .as_ref()
                .map(|c| {
                    c.roots
                        .iter()
                        .map(|r| (r.id.clone(), r.commit.clone()))
                        .collect()
                })
                .unwrap_or_default()
        };
        let roots = self.roots();
        let pins: Vec<SourcePin<'_>> = roots
            .iter()
            .map(|r| SourcePin {
                id: &r.id,
                url: &r.source.url,
                rev: checked.get(&r.id).and_then(|c| c.as_deref()),
            })
            .collect();
        let gear_source: BTreeMap<String, String> = catalogue
            .gears
            .values()
            .filter_map(|g| g.source.clone().map(|s| (g.id.clone(), s)))
            .collect();
        // Config arrives keyed as the picks are (crate names); the description
        // names gears by engine id.
        let by_id: BTreeMap<String, serde_json::Map<String, Value>> = input
            .config
            .iter()
            .filter_map(|(k, v)| catalogue.find(k).map(|g| (g.id.clone(), v.clone())))
            .collect();
        if !is_product_path(&input.product_path) {
            bail!(
                "`{}` is not a place for a product description: a relative path to a `product.gdl`",
                input.product_path
            );
        }
        let product_gdl = render_product_gdl_from(
            &input.product_id,
            &input.product_path,
            &input.name,
            &composition,
            &input.profile,
            &pins,
            &gear_source,
            &by_id,
        );
        // A product at its project's birth names no gears yet. There is nothing
        // for the engine to resolve, and the description is still the file the
        // project starts from: picking gears later rewrites it.
        if input.gears.is_empty() {
            return Ok(Preview {
                product_gdl,
                composition,
                resolution: Resolution::default(),
                corpus_commit: commit,
            });
        }

        let bin = self.cfg.bin.clone();
        let gdl = product_gdl.clone();
        let product_id = input.product_id.clone();
        let product_path = input.product_path.clone();
        let profile = input.profile.clone();
        let resolution = tokio::task::spawn_blocking(move || {
            evaluate(&bin, &named, &product_id, &product_path, &gdl, &profile)
        })
        .await
        .context("engine task")??;
        Ok(Preview {
            product_gdl,
            composition,
            resolution,
            corpus_commit: commit,
        })
    }
}

/// A relative path to a `product.gdl` that stays inside the repository: no
/// leading `/`, no `.` or `..` segment, no backslash.
pub(crate) fn is_product_path(path: &str) -> bool {
    let segments: Vec<&str> = path.split('/').collect();
    segments.last() == Some(&"product.gdl")
        && !path.contains('\\')
        && segments
            .iter()
            .all(|s| !s.is_empty() && *s != "." && *s != "..")
}

/// Lay the description out the way a session workspace does — the project's
/// repository, with the description at `product_path` in it, beside a
/// directory per gear repository, named by its source id — then validate and,
/// if that is clean, resolve. A diagnostic's file is `<source id>/<path>`.
/// Blocking.
fn evaluate(
    bin: &Path,
    roots: &[(String, PathBuf)],
    product_id: &str,
    product_path: &str,
    gdl: &str,
    profile: &str,
) -> anyhow::Result<Resolution> {
    let scratch = std::env::temp_dir().join(format!("studio-gearbox-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let product_file = scratch.join(product_id).join(product_path);
        if let Some(dir) = product_file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut root_args: Vec<String> = Vec::new();
        for (id, dir) in roots {
            let link = scratch.join(id);
            link_dir(dir, &link)?;
            root_args.push("--root".into());
            root_args.push(link.to_string_lossy().into_owned());
        }
        std::fs::write(&product_file, gdl)?;
        let product = product_file.to_string_lossy().into_owned();

        let mut args: Vec<String> = vec!["validate".into()];
        args.extend(root_args.iter().cloned());
        args.extend([
            "--product".into(),
            product.clone(),
            "--format".into(),
            "json".into(),
        ]);
        let validate = run_engine(bin, &args, Some(&scratch))?;
        let parsed: Value = serde_json::from_str(&validate.stdout).with_context(|| {
            format!(
                "the engine's validation is not JSON: {}",
                validate.stderr_tail()
            )
        })?;
        let diagnostics = parse_diagnostics(&parsed, &scratch);
        let diagnostics = relabel(diagnostics);
        if diagnostics.iter().any(EngineDiagnostic::is_error) {
            return Ok(Resolution {
                diagnostics,
                ..Resolution::default()
            });
        }

        let mut args: Vec<String> = vec!["resolve".into()];
        args.extend(root_args);
        args.extend([
            "--product".into(),
            product,
            "--profile".into(),
            profile.into(),
            "--format".into(),
            "json".into(),
        ]);
        let resolve = run_engine(bin, &args, Some(&scratch))?;
        let parsed: Value = serde_json::from_str(&resolve.stdout).with_context(|| {
            format!(
                "the engine's resolution is not JSON: {}",
                resolve.stderr_tail()
            )
        })?;
        let mut resolution = parse_resolution(&parsed, &scratch);
        let mut all = diagnostics;
        all.extend(relabel(resolution.diagnostics));
        resolution.diagnostics = all;
        Ok(resolution)
    })();
    let _ = std::fs::remove_dir_all(&scratch);
    result
}

/// The scratch product file is `<id>/product.gdl`; the person knows it as the
/// `product.gdl` at the root of their repository.
fn relabel(diagnostics: Vec<EngineDiagnostic>) -> Vec<EngineDiagnostic> {
    diagnostics
        .into_iter()
        .map(|mut d| {
            if d.file
                .as_deref()
                .is_some_and(|f| f.ends_with("product.gdl"))
            {
                d.file = Some("product.gdl".into());
            }
            d
        })
        .collect()
}

#[cfg(unix)]
fn link_dir(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn link_dir(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_dir(target, link)
}

struct EngineOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

impl EngineOutput {
    fn stderr_tail(&self) -> String {
        let t = self.stderr.trim();
        let skip = t.chars().count().saturating_sub(400);
        t.chars().skip(skip).collect()
    }
}

/// Run the engine with a deadline. Blocking. A non-zero exit is not an error
/// here: `validate` exits 1 exactly when it has something to say.
fn run_engine(bin: &Path, args: &[String], cwd: Option<&Path>) -> anyhow::Result<EngineOutput> {
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| anyhow!("cannot run the Gearbox engine `{}`: {e}", bin.display()))?;
    // Drain both pipes on their own threads so a large catalogue cannot fill
    // one while this waits on the other.
    let mut out_pipe = child.stdout.take().expect("stdout is piped");
    let mut err_pipe = child.stderr.take().expect("stderr is piped");
    let out_reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out_pipe.read_to_string(&mut s);
        s
    });
    let err_reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = err_pipe.read_to_string(&mut s);
        s
    });
    let deadline = Instant::now() + ENGINE_TIMEOUT;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!(
                "the Gearbox engine did not answer within {}s",
                ENGINE_TIMEOUT.as_secs()
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    Ok(EngineOutput {
        success: status.success(),
        stdout: out_reader.join().unwrap_or_default(),
        stderr: err_reader.join().unwrap_or_default(),
    })
}

/// Whether `plugin` fills `point`: by the point's GTS spec when both sides
/// state one -- two points can share an SDK crate, and only their specs tell
/// them apart -- else by the SDK crate the point lives in.
fn fills_point(plugin: &EngineGear, point: &EnginePoint) -> bool {
    let Some(f) = plugin.fills.as_ref() else {
        return false;
    };
    match (f.point.spec.as_deref(), point.spec.as_deref()) {
        (Some(a), Some(b)) => a == b,
        _ => f.point.sdk.crate_name == point.sdk.crate_name,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_plugin_is_read_under_the_engines_new_name_too() {
        let gear: EngineGear = serde_json::from_value(json!({
            "id": "static-authn-plugin",
            "package": {"crate_name": "cf-gears-static-authn-plugin"},
            "implements": {
                "spec": "cf.core.authn_resolver.plugin.v1~",
                "point": {"sdk": {"crate_name": "cf-gears-authn-resolver-sdk"}},
                "default_vendor": "constructorfabric"
            }
        }))
        .expect("an engine gear with `implements` deserializes");
        let point = gear
            .fills
            .expect("`implements` is the plugin's point")
            .point;
        assert_eq!(point.sdk.crate_name, "cf-gears-authn-resolver-sdk");
    }

    /// The corpus shape that matters: a host with an extension point, two
    /// plugins filling it, and a gear that is neither.
    fn catalogue() -> EngineCatalogue {
        serde_json::from_value(json!({
            "gears": {
                "api-gateway": {"id": "api-gateway", "package": {"crate_name": "cf-gears-api-gateway"}},
                "authn-resolver": {
                    "id": "authn-resolver",
                    "package": {"crate_name": "cf-gears-authn-resolver"},
                    "extension_points": [{"sdk": {"crate_name": "cf-gears-authn-resolver-sdk"}}]
                },
                "static-authn-plugin": {
                    "id": "static-authn-plugin",
                    "package": {"crate_name": "cf-gears-static-authn-plugin"},
                    "fills": {"point": {"sdk": {"crate_name": "cf-gears-authn-resolver-sdk"}}}
                },
                "oidc-authn-plugin": {
                    "id": "oidc-authn-plugin",
                    "package": {"crate_name": "cf-gears-oidc-authn-plugin"},
                    "fills": {"point": {"sdk": {"crate_name": "cf-gears-authn-resolver-sdk"}}}
                },
                "credstore": {
                    "id": "credstore",
                    "package": {"crate_name": "cf-gears-credstore"},
                    "fills": {"point": {"sdk": {"crate_name": "cf-gears-credstore-sdk"}}}
                }
            }
        }))
        .expect("catalogue fixture parses")
    }

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).to_string()).collect()
    }

    /// A product with an audit store, and a candidate that brings its own.
    fn audited() -> EngineCatalogue {
        serde_json::from_value(json!({"gears": {
            "audit": {"id": "audit", "package": {"crate_name": "cf-gears-audit"},
                      "provides": [{"contract": "audit/AuditLog@v1"}], "runtime_caps": ["db"]},
            "billing": {"id": "billing", "package": {"crate_name": "cf-gears-billing"},
                        "colocated_deps": ["billing-audit"]},
            "billing-audit": {"id": "billing-audit", "package": {"crate_name": "cf-gears-billing-audit"},
                              "provides": [{"contract": "audit/AuditLog@v1"}], "runtime_caps": ["db"]},
            "authn-resolver": {"id": "authn-resolver", "package": {"crate_name": "cf-gears-authn-resolver"},
                               "extension_points": [{"sdk": {"crate_name": "authn-sdk"}}]},
            "static-authn-plugin": {"id": "static-authn-plugin",
                                    "package": {"crate_name": "cf-gears-static-authn-plugin"},
                                    "fills": {"point": {"sdk": {"crate_name": "authn-sdk"}}}}
        }}))
        .expect("audited fixture parses")
    }

    #[test]
    fn a_candidate_shows_what_comes_with_it_and_the_contract_it_doubles() {
        let b = brings(
            &audited(),
            &names(&["cf-gears-audit"]),
            "cf-gears-billing",
            &GearConfig::new(),
        );
        assert!(b.described);
        let gears: Vec<&str> = b.brought.iter().map(|g| g.gear.as_str()).collect();
        assert_eq!(gears, ["cf-gears-billing", "cf-gears-billing-audit"]);
        assert_eq!(b.brought[0].reason, "the gear you picked");
        assert_eq!(b.brought[1].reason, "cf-gears-billing must run with it");
        assert!(b.brought[1].database);
        assert_eq!(
            b.overlaps,
            vec![Overlap {
                contract: "audit/AuditLog@v1".into(),
                already: vec!["cf-gears-audit".into()],
                brought: vec!["cf-gears-billing-audit".into()],
            }]
        );
    }

    #[test]
    fn a_plugin_brings_its_host_and_nothing_already_there_is_new() {
        let b = brings(&audited(), &[], "static-authn-plugin", &GearConfig::new());
        let gears: Vec<&str> = b.brought.iter().map(|g| g.gear.as_str()).collect();
        assert_eq!(
            gears,
            ["cf-gears-static-authn-plugin", "cf-gears-authn-resolver"]
        );
        assert_eq!(
            b.brought[1].reason,
            "hosts the extension point cf-gears-static-authn-plugin fills"
        );
        let again = brings(
            &audited(),
            &names(&["cf-gears-billing"]),
            "cf-gears-billing-audit",
            &GearConfig::new(),
        );
        assert!(again.brought.is_empty());
        assert!(again.overlaps.is_empty());
    }

    #[test]
    fn an_undescribed_candidate_brings_nothing() {
        let b = brings(&audited(), &[], "cf-gears-nowhere", &GearConfig::new());
        assert!(!b.described);
        assert!(b.brought.is_empty());
    }

    #[test]
    fn crate_names_and_engine_ids_both_select_a_gear() {
        let c = compose(
            &catalogue(),
            &names(&["cf-gears-api-gateway", "authn-resolver"]),
        );
        let ids: Vec<&str> = c.gears.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, ["api-gateway", "authn-resolver"]);
        assert!(c.not_described.is_empty());
    }

    /// mini-chat as the corpus has it: its two static plugins live in its
    /// own crate, and both of its points in one SDK.
    fn mini_chat() -> EngineCatalogue {
        let point =
            |spec: &str| json!({"spec": spec, "sdk": {"crate_name": "cf-gears-mini-chat-sdk"}});
        let plugin = |id: &str, spec: &str| json!({"id": id, "package": {"crate_name": "cf-gears-mini-chat"}, "fills": {"point": point(spec)}});
        serde_json::from_value(json!({"gears": {
            "mini-chat": {"id": "mini-chat", "package": {"crate_name": "cf-gears-mini-chat"},
                          "extension_points": [point("audit~"), point("model_policy~")]},
            "static-mini-chat-audit-plugin": plugin("static-mini-chat-audit-plugin", "audit~"),
            "static-mini-chat-model-policy-plugin": plugin("static-mini-chat-model-policy-plugin", "model_policy~"),
        }}))
        .unwrap()
    }

    #[test]
    fn a_crate_shared_by_a_host_and_its_plugins_names_the_host_and_each_point_gets_its_plugin() {
        let cat = mini_chat();
        assert_eq!(cat.find("cf-gears-mini-chat").unwrap().id, "mini-chat");
        let done = complete(
            &cat,
            &names(&["cf-gears-mini-chat"]),
            &GearConfig::default(),
        );
        assert_eq!(
            done.gears,
            [
                "cf-gears-mini-chat",
                "static-mini-chat-audit-plugin",
                "static-mini-chat-model-policy-plugin"
            ]
        );
        let c = compose(&cat, &done.gears);
        assert_eq!(c.gears.len(), 1);
        assert_eq!(
            c.gears[0].plugins,
            [
                "static-mini-chat-audit-plugin",
                "static-mini-chat-model-policy-plugin"
            ]
        );
        assert!(c.plugin_options.is_empty());
    }

    #[test]
    fn a_plugin_goes_under_its_host_and_brings_the_host_when_missing() {
        let c = compose(&catalogue(), &names(&["cf-gears-static-authn-plugin"]));
        assert_eq!(
            c.gears,
            vec![GearUse {
                id: "authn-resolver".into(),
                plugins: vec!["static-authn-plugin".into()],
            }]
        );
        assert_eq!(
            c.added_hosts,
            vec![(
                "authn-resolver".to_string(),
                "static-authn-plugin".to_string()
            )]
        );
    }

    #[test]
    fn a_picked_host_is_not_reported_as_added() {
        let c = compose(
            &catalogue(),
            &names(&[
                "cf-gears-oidc-authn-plugin",
                "cf-gears-authn-resolver",
                "static-authn-plugin",
            ]),
        );
        assert_eq!(c.gears.len(), 1);
        assert_eq!(
            c.gears[0].plugins,
            ["oidc-authn-plugin", "static-authn-plugin"]
        );
        assert!(c.added_hosts.is_empty());
    }

    /// The shape of the real corpus on feature/gearbox, cut down to what
    /// completion reasons about.
    fn corpus() -> EngineCatalogue {
        let point = |sdk: &str| json!({"sdk": {"crate_name": sdk}});
        let plugin = |id: &str, sdk: &str, prio: i64, deps: &[&str]| {
            json!({"id": id, "package": {"crate_name": format!("cf-gears-{id}")},
                   "fills": {"point": point(sdk), "default_priority": prio}, "colocated_deps": deps})
        };
        serde_json::from_value(json!({"gears": {
            "types-registry": {"id": "types-registry", "package": {"crate_name": "cf-gears-types-registry"},
                               "runtime_caps": ["db", "rest", "system"]},
            "authn-resolver": {"id": "authn-resolver", "package": {"crate_name": "cf-gears-authn-resolver"},
                               "extension_points": [point("authn-sdk")], "colocated_deps": ["types-registry"]},
            "oidc-authn-plugin": plugin("oidc-authn-plugin", "authn-sdk", 100, &["authn-resolver"]),
            "static-authn-plugin": plugin("static-authn-plugin", "authn-sdk", 100, &["types-registry"]),
            "authz-resolver": {"id": "authz-resolver", "package": {"crate_name": "cf-gears-authz-resolver"},
                               "extension_points": [point("authz-sdk")], "runtime_caps": ["rest"]},
            "resource-group": {"id": "resource-group", "package": {"crate_name": "cf-gears-resource-group"},
                               "colocated_deps": ["authz-resolver"], "runtime_caps": ["rest"]},
            "tenant-resolver": {"id": "tenant-resolver", "package": {"crate_name": "cf-gears-tenant-resolver"},
                                "extension_points": [point("tr-sdk")]},
            "static-tr-plugin": plugin("static-tr-plugin", "tr-sdk", 100, &[]),
            "single-tenant-tr-plugin": plugin("single-tenant-tr-plugin", "tr-sdk", 1000, &[]),
            "rg-tr-plugin": plugin("rg-tr-plugin", "tr-sdk", 50, &["resource-group"]),
            "account-management": plugin("account-management", "idp-sdk", 100, &[]),
            "api-gateway": {"id": "api-gateway", "package": {"crate_name": "cf-gears-api-gateway"},
                            "runtime_caps": ["rest", "rest_host"], "colocated_deps": ["authn-resolver"],
                            "serves": [{"config_key": "bind_addr"}],
                            "config_schema": {"fields": [{"name": "bind_addr", "required": true}]}},
            "event-broker": {"id": "event-broker", "package": {"crate_name": "cf-gears-event-broker"},
                             "config_schema": {"fields": [
                                 {"name": "mode", "required": true, "default": null},
                                 {"name": "retention", "required": true, "default": "7d"},
                                 {"name": "tuning", "required": false}]}}
        }}))
        .expect("corpus fixture parses")
    }

    #[test]
    fn completion_drops_what_cannot_run_and_adds_what_is_missing() {
        let c = complete(
            &corpus(),
            &names(&[
                "cf-gears-types-registry",
                "cf-gears-resource-group",
                "cf-gears-event-broker",
                "cf-gears-account-management",
                "cf-gears-tenant-resolver",
                "cf-gears-ledger",
            ]),
            &GearConfig::new(),
        );
        assert_eq!(
            c.gears,
            [
                "cf-gears-types-registry",
                "cf-gears-tenant-resolver",
                // the host's plugin: rg-tr has the best priority but must run
                // with resource-group, which needs authz-resolver, which
                // nothing in the corpus can plug
                "cf-gears-static-tr-plugin",
                // the REST host, bound through `serves` so `bind_addr` is not
                // a missing field, and it brings authn-resolver along
                "cf-gears-api-gateway",
                // …whose plugin comes a round later; static beats oidc on the tie
                "cf-gears-static-authn-plugin",
            ]
        );
        let why: BTreeMap<&str, (bool, &str)> = c
            .changes
            .iter()
            .map(|ch| (ch.gear.as_str(), (ch.added, ch.reason.as_str())))
            .collect();
        assert!(!why["cf-gears-ledger"].0);
        assert!(
            why["cf-gears-resource-group"]
                .1
                .contains("cf-gears-authz-resolver")
        );
        assert!(why["cf-gears-event-broker"].1.contains("mode"));
        assert!(
            !why["cf-gears-event-broker"].1.contains("retention"),
            "a default is not a missing field"
        );
        assert!(
            why["cf-gears-account-management"]
                .1
                .contains("no gear in the corpus hosts")
        );
        assert!(why["cf-gears-static-tr-plugin"].0);
        assert!(why["cf-gears-api-gateway"].1.contains("REST host"));
    }

    #[test]
    fn facts_say_what_a_gear_is_in_a_composition_and_whether_it_can_run() {
        let f = gear_facts(&corpus(), "acme/gears@main (abc1234)");
        let get = |crate_name: &str, key: &str| {
            f[crate_name][key]["v"]
                .as_str()
                .unwrap_or_default()
                .to_string()
        };
        assert_eq!(get("cf-gears-api-gateway", "gdl"), "yes");
        assert_eq!(get("cf-gears-api-gateway", "gdl_id"), "api-gateway");
        assert_eq!(get("cf-gears-api-gateway", "gdl_caps"), "rest, rest_host");
        assert_eq!(
            get("cf-gears-api-gateway", "gdl_deps"),
            "cf-gears-authn-resolver"
        );
        // Written by generation, so not asked of a person.
        assert_eq!(get("cf-gears-api-gateway", "gdl_config"), "—");
        assert_eq!(get("cf-gears-api-gateway", "gdl_runs"), "yes");
        assert_eq!(
            get("cf-gears-api-gateway", "gdl_corpus"),
            "acme/gears@main (abc1234)"
        );
        assert!(get("cf-gears-tenant-resolver", "gdl_role").starts_with("host; plugins: "));
        assert_eq!(
            get("cf-gears-static-tr-plugin", "gdl_role"),
            "plugin of cf-gears-tenant-resolver"
        );
        assert!(get("cf-gears-authz-resolver", "gdl_role").contains("no plugin"));
        assert_eq!(get("cf-gears-event-broker", "gdl_config"), "mode");
        assert!(get("cf-gears-resource-group", "gdl_runs").contains("cf-gears-authz-resolver"));
        assert_eq!(f["cf-gears-resource-group"]["gdl_runs"]["s"], "bad");
        assert!(
            !f.contains_key("cf-gears-ledger"),
            "no descriptor, no facts"
        );
        // The fixture's points carry no spec and nothing provides a contract.
        assert_eq!(get("cf-gears-tenant-resolver", "gdl_contracts"), "—");
    }

    /// What the composer matches a capability's contracts against, in the
    /// shape `gearbox catalogue --format json` writes at ea964f9.
    #[test]
    fn a_gears_contracts_are_what_it_provides_hosts_and_implements() {
        let catalogue: EngineCatalogue = serde_json::from_value(json!({"gears": {
            "authz-resolver": {
                "id": "authz-resolver",
                "package": {"crate_name": "cf-authz-resolver"},
                "provides": [{"contract": "authz-resolver/AuthZResolverApi@v1",
                              "provider_gear": "authz-resolver", "transports": ["local", "rest"]}],
                "extension_points": [{"sdk": {"crate_name": "cf-authz-resolver-sdk"},
                                      "spec": "cf.toolkit.plugins.plugin.v1~cf.core.authz_resolver.plugin.v1~"}]
            },
            "static-authz-plugin": {
                "id": "static-authz-plugin",
                "package": {"crate_name": "cf-static-authz-plugin"},
                "implements": {"point": {"sdk": {"crate_name": "cf-authz-resolver-sdk"},
                                         "spec": "cf.toolkit.plugins.plugin.v1~cf.core.authz_resolver.plugin.v1~"}}
            }
        }}))
        .expect("the engine's shape deserializes");
        assert_eq!(
            catalogue.gears["authz-resolver"].contracts(),
            [
                "authz-resolver/AuthZResolverApi@v1",
                "cf.toolkit.plugins.plugin.v1~cf.core.authz_resolver.plugin.v1~",
            ]
        );
        assert_eq!(
            catalogue.gears["static-authz-plugin"].contracts(),
            ["cf.toolkit.plugins.plugin.v1~cf.core.authz_resolver.plugin.v1~"]
        );
        let f = gear_facts(&catalogue, "corpus");
        assert_eq!(
            f["cf-authz-resolver"]["gdl_contracts"]["v"],
            "authz-resolver/AuthZResolverApi@v1, cf.toolkit.plugins.plugin.v1~cf.core.authz_resolver.plugin.v1~"
        );
    }

    #[test]
    fn a_config_schema_says_what_is_required_defaulted_and_written_by_generation() {
        let schemas = config_schemas(
            &corpus(),
            &names(&[
                "cf-gears-event-broker",
                "api-gateway",
                "cf-gears-types-registry",
                "cf-gears-nowhere",
                "cf-gears-event-broker",
            ]),
        );
        let asked: Vec<&str> = schemas.iter().map(|s| s.gear.as_str()).collect();
        assert_eq!(
            asked,
            [
                "cf-gears-event-broker",
                "api-gateway",
                "cf-gears-types-registry",
                "cf-gears-nowhere"
            ],
            "in the order asked, each once, by the name it was asked by"
        );

        let broker = &schemas[0];
        assert_eq!(broker.id.as_deref(), Some("event-broker"));
        let field = |name: &str| ConfigFieldInfo {
            name: name.to_string(),
            required: false,
            default: None,
            derived: false,
        };
        assert_eq!(
            broker.fields,
            [
                ConfigFieldInfo {
                    required: true,
                    ..field("mode")
                },
                ConfigFieldInfo {
                    required: true,
                    default: Some(json!("7d")),
                    ..field("retention")
                },
                field("tuning"),
            ],
            "a null default is no default; declaration order is kept"
        );

        let gateway = &schemas[1];
        assert_eq!(
            gateway.fields,
            [ConfigFieldInfo {
                required: true,
                derived: true,
                ..field("bind_addr")
            }],
            "an endpoint's config_key is generation's to write"
        );

        assert_eq!(schemas[2].id.as_deref(), Some("types-registry"));
        assert!(schemas[2].fields.is_empty(), "no schema, no fields");
        assert_eq!(schemas[3].id, None, "not in the corpus");
        assert!(schemas[3].fields.is_empty());
    }

    #[test]
    fn a_complete_set_is_left_as_it_is() {
        let picks = names(&[
            "cf-gears-api-gateway",
            "cf-gears-authn-resolver",
            "cf-gears-oidc-authn-plugin",
        ]);
        let c = complete(&corpus(), &picks, &GearConfig::new());
        assert_eq!(c.gears, picks);
        assert!(c.changes.is_empty());
    }

    #[test]
    fn a_host_picked_without_a_plugin_is_offered_the_ones_that_fill_it() {
        let c = compose(
            &catalogue(),
            &names(&["cf-gears-authn-resolver", "api-gateway"]),
        );
        assert_eq!(
            c.plugin_options,
            vec![(
                "authn-resolver".to_string(),
                vec![
                    "cf-gears-oidc-authn-plugin".to_string(),
                    "cf-gears-static-authn-plugin".to_string()
                ]
            )]
        );
        let filled = compose(
            &catalogue(),
            &names(&["authn-resolver", "static-authn-plugin"]),
        );
        assert!(filled.plugin_options.is_empty());
    }

    #[test]
    fn a_plugin_with_no_host_in_the_corpus_is_left_for_the_engine_to_judge() {
        let c = compose(&catalogue(), &names(&["cf-gears-credstore"]));
        assert_eq!(c.gears[0].id, "credstore");
        assert!(c.gears[0].plugins.is_empty());
    }

    #[test]
    fn a_gear_without_a_descriptor_is_reported_once_and_not_written() {
        let c = compose(
            &catalogue(),
            &names(&["cf-gears-ledger", "cf-gears-ledger", " "]),
        );
        assert!(c.gears.is_empty());
        assert_eq!(c.not_described, ["cf-gears-ledger"]);
    }

    #[test]
    fn a_pinned_description_names_its_corpus_commit_and_no_sibling_path() {
        let c = compose(&catalogue(), &names(&["api-gateway"]));
        let gdl = render_product_gdl(
            "my-shop",
            "products/my-shop/product.gdl",
            "My Shop",
            &c,
            "dev",
            Some(CorpusPin {
                url: "https://github.com/MikeFalcon77/gears-rust.git",
                rev: "a0a42cec5e68b313c31e3ceb00254b0df89cd8b8",
            }),
            &BTreeMap::new(),
        );
        assert!(
            gdl.contains(
                r#"source(id = "gears-rust", at = git(url = "https://github.com/MikeFalcon77/gears-rust.git", rev = "a0a42cec5e68b313c31e3ceb00254b0df89cd8b8"))"#
            ),
            "{gdl}"
        );
        assert!(!gdl.contains(r#"path("../gears-rust")"#));
    }

    #[test]
    fn a_new_product_lives_under_products_and_reaches_the_corpus_from_there() {
        assert_eq!(product_gdl_path("my-shop"), "products/my-shop/product.gdl");
        let c = compose(&catalogue(), &names(&["api-gateway"]));
        let gdl = render_product_gdl(
            "my-shop",
            &product_gdl_path("my-shop"),
            "My Shop",
            &c,
            "dev",
            None,
            &BTreeMap::new(),
        );
        assert!(
            gdl.contains(r#"source(id = "gears-rust", at = path("../../../gears-rust"))"#),
            "{gdl}"
        );
        assert!(gdl.contains("gearbox resolve --root ../../../gears-rust --product product.gdl"));
    }

    #[test]
    fn a_product_path_stays_inside_the_repository() {
        assert!(is_product_path("product.gdl"));
        assert!(is_product_path("products/my-shop/product.gdl"));
        for bad in [
            "",
            "/product.gdl",
            "../product.gdl",
            "products/../../product.gdl",
            "products/./product.gdl",
            "products//product.gdl",
            r"products\my-shop\product.gdl",
            "products/my-shop/shop.gdl",
        ] {
            assert!(!is_product_path(bad), "{bad}");
        }
    }

    #[test]
    fn the_description_names_every_profile_and_nests_plugins() {
        let c = compose(
            &catalogue(),
            &names(&["api-gateway", "static-authn-plugin"]),
        );
        let gdl = render_product_gdl(
            "my-shop",
            "product.gdl",
            "My \"Shop\"",
            &c,
            "local",
            None,
            &BTreeMap::new(),
        );
        assert!(gdl.contains("id = \"my-shop\""));
        assert!(gdl.contains("name = \"My \\\"Shop\\\"\""));
        assert!(gdl.contains("source(id = \"gears-rust\", at = path(\"../gears-rust\"))"));
        assert!(gdl.contains("embedded(id = \"dev\")"));
        assert!(gdl.contains("self_hosted(id = \"local\", host = \"my-shop\""));
        assert!(gdl.contains("kubernetes(id = \"prod\""));
        assert!(gdl.contains("default_profile = \"local\""));
        assert!(gdl.contains("use_gear(\"api-gateway\", source = \"gears-rust\"),"));
        assert!(gdl.contains(
            "use_gear(\"authn-resolver\", source = \"gears-rust\", plugins = [plugin(\"static-authn-plugin\")]),"
        ));
    }

    #[test]
    fn kebab_ids() {
        for ok in ["a", "my-shop", "shop2", "a-b-c"] {
            assert!(is_kebab_id(ok), "{ok}");
        }
        for bad in ["", "My-shop", "2shop", "shop-", "a--b", "a_b", "-a"] {
            assert!(!is_kebab_id(bad), "{bad}");
        }
    }

    #[test]
    fn diagnostics_point_at_repository_paths_one_based() {
        let v = json!([
            {"code": "GBX0513", "severity": "error", "message": "no host",
             "location": {"uri": "file:///tmp/x/my-shop/product.gdl",
                          "range": {"start": {"line": 9, "character": 0}}},
             "help": "select the host"},
            {"code": "GBX0108", "severity": "warning", "message": "category",
             "location": {"uri": "file:///tmp/x/gears-rust/gears/a/gear.gdl",
                          "range": {"start": {"line": 0, "character": 0}}}},
            {"severity": "error", "message": "no code, dropped"}
        ]);
        let d = relabel(parse_diagnostics(&v, Path::new("/tmp/x/gears-rust")));
        assert_eq!(d.len(), 2);
        assert_eq!(d[0].file.as_deref(), Some("product.gdl"));
        assert_eq!(d[0].line, Some(10));
        assert!(d[0].is_error());
        assert_eq!(d[0].help.as_deref(), Some("select the host"));
        assert_eq!(d[1].file.as_deref(), Some("gears/a/gear.gdl"));
        assert!(!d[1].is_error());
    }

    #[test]
    fn a_resolution_reads_as_applications_and_reasons() {
        let v = json!({
            "gears": {
                "api-gateway": {"id": "api-gateway", "package": {"crate_name": "cf-gears-api-gateway"},
                                "selected_by": [{"reason": "selected"}]},
                "static-authn-plugin": {"id": "static-authn-plugin",
                                        "package": {"crate_name": "cf-gears-static-authn-plugin"},
                                        "selected_by": [{"reason": "plugin_of", "host": "authn-resolver", "profile": "dev"}]},
                "types-registry": {"id": "types-registry", "package": {"crate_name": "cf-gears-types-registry"},
                                   "selected_by": [{"reason": "colocated_by", "gear": "authn-resolver"}]}
            },
            "applications": [{
                "name": "my-shop", "kind": "host", "anchor": "api-gateway",
                "gears": ["types-registry", "api-gateway"], "replicas": 2,
                "listens": [{"name": "rest", "gear": "api-gateway", "address": "127.0.0.1:8087"}]
            }],
            "diagnostics": [{"code": "GBX0315", "severity": "warning", "message": "grpc"}]
        });
        let r = parse_resolution(&v, Path::new("/c"));
        assert_eq!(r.applications.len(), 1);
        let app = &r.applications[0];
        assert_eq!(
            (app.name.as_str(), app.anchor.as_deref(), app.replicas),
            ("my-shop", Some("api-gateway"), 2)
        );
        assert_eq!(app.listens[0].address, "127.0.0.1:8087");
        let reasons: BTreeMap<_, _> = r
            .gears
            .iter()
            .map(|g| (g.id.as_str(), g.reasons.clone()))
            .collect();
        assert_eq!(reasons["api-gateway"], ["selected"]);
        assert_eq!(reasons["static-authn-plugin"], ["plugin of authn-resolver"]);
        assert_eq!(reasons["types-registry"], ["colocated with authn-resolver"]);
        assert_eq!(r.diagnostics[0].code, "GBX0315");
    }

    #[test]
    fn a_host_is_offered_only_when_its_sdk_can_be_located() {
        let c: EngineCatalogue = serde_json::from_value(json!({
            "gears": {
                "authn-resolver": {
                    "id": "authn-resolver",
                    "package": {"crate_name": "cf-gears-authn-resolver"},
                    "extension_points": [{
                        "spec": "cf.toolkit.plugins.plugin.v1~cf.core.authn_resolver.plugin.v1~",
                        "trait_ident": "AuthNResolverPluginClient",
                        "sdk": {
                            "crate_name": "cf-gears-authn-resolver-sdk",
                            "lib_ident": "authn_resolver_sdk",
                            "path": "gears/system/authn-resolver/authn-resolver-sdk"
                        }
                    }]
                },
                // Without a path a plugin's `gear.gdl` could not point at it.
                "credstore": {
                    "id": "credstore",
                    "package": {"crate_name": "cf-gears-credstore"},
                    "extension_points": [{"sdk": {"crate_name": "cf-gears-credstore-sdk"}}]
                }
            }
        }))
        .expect("fixture parses");
        let points = host_points(&c);
        assert_eq!(points.len(), 1, "{points:?}");
        assert_eq!(points[0].host_crate, "cf-gears-authn-resolver");
        assert_eq!(points[0].sdk_lib, "authn_resolver_sdk");
        assert_eq!(
            spec_segment(&points[0].spec),
            "cf.core.authn_resolver.plugin.v1~"
        );
        assert_eq!(points[0].trait_ident, "AuthNResolverPluginClient");
    }

    #[test]
    fn the_sdk_path_climbs_to_the_repository_root_and_no_further() {
        // gears/<slug>/ -> up two to the root, then down to the SDK. Never
        // above the root: the engine refuses that (GBX0102).
        assert_eq!(
            sdk_path_in_repo("gears", "gears/system/x-sdk"),
            "../../gears/system/x-sdk"
        );
        assert_eq!(
            sdk_path_in_repo("/gears/bss/", "/gears/x-sdk"),
            "../../../gears/x-sdk"
        );
        assert_eq!(sdk_path_in_repo("", "x-sdk"), "../x-sdk");
    }

    #[test]
    fn from_a_projects_own_repository_the_sdk_is_in_the_checkout_beside_it() {
        assert_eq!(
            sdk_path_beside("gears", "gears/system/x-sdk"),
            "../../../gears-rust/gears/system/x-sdk"
        );
        assert_eq!(sdk_path_beside("", "x-sdk"), "../../gears-rust/x-sdk");
    }

    #[test]
    fn two_spellings_of_one_repository_compare_equal() {
        assert_eq!(
            repo_key("https://github.com/MikeFalcon77/gears-rust.git"),
            "mikefalcon77/gears-rust"
        );
        assert_eq!(
            repo_key("MikeFalcon77/gears-rust"),
            "mikefalcon77/gears-rust"
        );
        assert_ne!(
            repo_key("acme/gears-rust"),
            repo_key("MikeFalcon77/gears-rust")
        );
    }

    #[test]
    fn a_scaffold_answer_yields_its_gdl_or_the_engines_refusal() {
        let ok = json!({"id": 2, "result": {"gear_gdl": "gear x {}\n", "plans": []}});
        assert_eq!(answer_gdl(&ok).expect("gdl"), "gear x {}\n");
        let refused =
            json!({"id": 2, "error": {"code": -32602, "message": "id is not kebab-case"}});
        let e = answer_gdl(&refused).expect_err("refused");
        assert!(format!("{e}").contains("id is not kebab-case"), "{e}");
        assert!(answer_gdl(&json!({"id": 2, "result": {}})).is_err());
    }

    #[test]
    fn an_unknown_gear_kind_is_refused_and_blank_means_service() {
        assert_eq!(GearKind::parse(""), Some(GearKind::Service));
        assert_eq!(GearKind::parse(" plugin "), Some(GearKind::Plugin));
        assert_eq!(GearKind::parse("library"), None);
    }

    fn vendor_corpus(plugins: &[(&str, &str)]) -> EngineCatalogue {
        let mut gears = serde_json::Map::new();
        gears.insert(
            "account-management".into(),
            json!({
                "id": "account-management",
                "package": {"crate_name": "cf-gears-account-management"},
                "vendor_selector": "constructorfabric",
                "extension_points": [{"spec": "cf.toolkit.plugins.plugin.v1~cf.core.idp.plugin.v1~",
                                      "sdk": {"crate_name": "cf-gears-account-management-sdk"}}]
            }),
        );
        for (id, vendor) in plugins {
            gears.insert(
                (*id).into(),
                json!({
                    "id": id,
                    "package": {"crate_name": format!("cf-gears-{id}")},
                    "fills": {"point": {"sdk": {"crate_name": "cf-gears-account-management-sdk"}}},
                    "config_schema": {"fields": [{"name": "vendor", "default": vendor}]}
                }),
            );
        }
        serde_json::from_value(json!({ "gears": gears })).expect("fixture parses")
    }

    #[test]
    fn a_plugin_under_the_hosts_vendor_is_preferred() {
        let c = vendor_corpus(&[
            ("keycloak-idp-plugin", "keycloak"),
            ("cf-idp-plugin", "constructorfabric"),
        ]);
        let done = complete(
            &c,
            &names(&["cf-gears-account-management"]),
            &GearConfig::new(),
        );
        assert!(
            done.gears.contains(&"cf-gears-cf-idp-plugin".to_string()),
            "{:?}",
            done.gears
        );
        assert!(
            done.config.is_empty(),
            "nothing needed setting: {:?}",
            done.config
        );
    }

    #[test]
    fn a_plugin_under_another_vendor_gets_the_hosts() {
        // The corpus as it is today: the host selects `constructorfabric`,
        // its plugin registers under `cf` (GBX0512).
        let c = vendor_corpus(&[("static-idp-plugin", "cf")]);
        let done = complete(
            &c,
            &names(&["cf-gears-account-management"]),
            &GearConfig::new(),
        );
        assert!(
            done.gears
                .contains(&"cf-gears-static-idp-plugin".to_string())
        );
        assert_eq!(
            done.config["cf-gears-static-idp-plugin"]["vendor"],
            "constructorfabric"
        );
        assert!(
            done.changes
                .iter()
                .any(|ch| ch.reason.contains("vendor set to `constructorfabric`"))
        );
    }

    #[test]
    fn a_vendor_somebody_set_is_kept() {
        let c = vendor_corpus(&[("static-idp-plugin", "cf")]);
        let mut mine = GearConfig::new();
        mine.entry("cf-gears-static-idp-plugin".into())
            .or_default()
            .insert("vendor".into(), json!("mine"));
        let done = complete(
            &c,
            &names(&["cf-gears-account-management", "cf-gears-static-idp-plugin"]),
            &mine,
        );
        assert_eq!(done.config["cf-gears-static-idp-plugin"]["vendor"], "mine");
    }

    #[test]
    fn configuration_is_written_on_the_gear_and_on_its_plugin() {
        let composition = Composition {
            gears: vec![GearUse {
                id: "account-management".into(),
                plugins: vec!["static-idp-plugin".into()],
            }],
            ..Composition::default()
        };
        let mut config = BTreeMap::new();
        config.insert(
            "static-idp-plugin".to_string(),
            json!({"vendor": "constructorfabric", "priority": 100})
                .as_object()
                .expect("object")
                .clone(),
        );
        config.insert(
            "account-management".to_string(),
            json!({"strict": true}).as_object().expect("object").clone(),
        );
        let gdl = render_product_gdl("p", "product.gdl", "P", &composition, "dev", None, &config);
        assert!(
            gdl.contains(r#"use_gear("account-management", source = "gears-rust", config = {"strict": True}, plugins = [plugin("static-idp-plugin", config = {"priority": 100, "vendor": "constructorfabric"})])"#),
            "{gdl}"
        );
    }

    fn config(corpus_url: &str) -> GearboxConfig {
        GearboxConfig {
            bin: PathBuf::from("gearbox"),
            workdir: std::env::temp_dir(),
            corpus_url: corpus_url.into(),
            corpus_ref: "main".into(),
            refresh: DEFAULT_REFRESH,
        }
    }

    fn repo_root(id: &str, url: &str) -> GearRoot {
        GearRoot {
            id: id.into(),
            source: CorpusSource {
                label: id.into(),
                key: format!("gearbox-{id}"),
                repo: id.into(),
                url: url.into(),
                username: "x-access-token".into(),
                token: String::new(),
                git_ref: String::new(),
            },
            connection_id: Some(uuid::Uuid::new_v4()),
        }
    }

    fn ids(g: &Gearbox) -> Vec<String> {
        g.roots().into_iter().map(|r| r.id).collect()
    }

    #[test]
    fn the_platforms_gear_repositories_replace_the_deployments_corpus_until_there_are_none() {
        let g = Gearbox::new(config("https://github.com/MikeFalcon77/gears-rust.git"));
        assert_eq!(ids(&g), ["gears-rust"]);
        assert!(g.roots_due());

        let core = repo_root(
            "gears-core",
            "https://github.com/constructorfabric/gears-core.git",
        );
        let bss = repo_root(
            "gears-bss",
            "https://github.com/constructorfabric/gears-bss.git",
        );
        g.use_repositories(vec![core.clone(), bss.clone()]);
        assert_eq!(ids(&g), ["gears-core", "gears-bss"]);
        assert!(!g.roots_due());
        assert!(g.is_corpus_repo("constructorfabric/gears-bss"));
        assert!(!g.is_corpus_repo("MikeFalcon77/gears-rust"));
        let generation = g.roots.lock().expect("roots").generation;

        // The same list again is not a change: nothing is checked out afresh.
        g.use_repositories(vec![core.clone(), bss.clone()]);
        assert_eq!(g.roots.lock().expect("roots").generation, generation);
        // Another order is: the engine's order decides which declaration wins.
        g.use_repositories(vec![bss.clone(), core]);
        assert_eq!(g.roots.lock().expect("roots").generation, generation + 1);
        // Removed and added again as it was: another connection, so another
        // root -- its status must name the connection that exists.
        let again = repo_root(
            "gears-core",
            "https://github.com/constructorfabric/gears-core.git",
        );
        g.use_repositories(vec![bss, again.clone()]);
        assert_eq!(g.roots.lock().expect("roots").generation, generation + 2);
        assert_eq!(g.roots()[1].connection_id, again.connection_id);

        g.use_repositories(Vec::new());
        assert_eq!(ids(&g), ["gears-rust"]);
    }

    #[test]
    fn without_a_corpus_or_a_gear_repository_there_is_nothing_to_read() {
        let g = Gearbox::new(config(""));
        assert!(g.roots().is_empty());
        assert_eq!(g.corpus_label(), "no gear repository");
        assert_eq!(g.corpus_origin(), (String::new(), String::new(), false));
    }

    #[test]
    fn each_gear_names_the_repository_it_came_from_and_each_repository_is_pinned() {
        let c = compose(&catalogue(), &names(&["api-gateway", "credstore"]));
        let gear_source: BTreeMap<String, String> =
            [("credstore".to_string(), "gears-security".to_string())].into();
        let gdl = render_product_gdl_from(
            "my-shop",
            "products/my-shop/product.gdl",
            "My Shop",
            &c,
            "dev",
            &[
                SourcePin {
                    id: "gears-core",
                    url: "https://github.com/constructorfabric/gears-core.git",
                    rev: Some("aaaa"),
                },
                SourcePin {
                    id: "gears-security",
                    url: "https://github.com/constructorfabric/gears-security.git",
                    rev: Some("bbbb"),
                },
            ],
            &gear_source,
            &BTreeMap::new(),
        );
        assert!(gdl.contains(r#"source(id = "gears-core", at = git(url = "https://github.com/constructorfabric/gears-core.git", rev = "aaaa"))"#), "{gdl}");
        assert!(gdl.contains(r#"source(id = "gears-security", at = git(url = "https://github.com/constructorfabric/gears-security.git", rev = "bbbb"))"#), "{gdl}");
        assert!(
            gdl.contains(r#"use_gear("credstore", source = "gears-security""#),
            "{gdl}"
        );
        // A gear the engine attributes to no listed repository takes the first.
        assert!(
            gdl.contains(r#"use_gear("api-gateway", source = "gears-core""#),
            "{gdl}"
        );
        assert!(gdl.contains("gearbox resolve --root ../../../gears-core --root ../../../gears-security --product"), "{gdl}");
    }
}
