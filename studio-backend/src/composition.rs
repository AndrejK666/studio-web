//! Which kits run in this deployment (ADR-0079 §5): the composition switch.
//!
//! Our own kits are linked into the binary; the deployment's configuration
//! says which of them start. A kit's gear says which kit it belongs to in its
//! own module:
//!
//! ```ignore
//! inventory::submit! {
//!     crate::composition::KitGear { gear: "studio-reports", kit: "org-reports" }
//! }
//! ```
//!
//! and asks [`gear_on`] at `init`, `register_rest` and `migrations`: a gear
//! whose kit is switched off starts nothing, keeps no tables and mounts no
//! route. The core's ports ask the same question of every contribution
//! ([`contributes`], by the gear that registered it), so a switched-off kit
//! brings no MCP tool, Overview block, status part, inbox source, access rule,
//! schedule or cost meter either. A gear no kit claims is the core's: it
//! always runs.
//!
//! The setting is `vendor.studio.kits` in the configuration file:
//!
//! ```yaml
//! vendor:
//!   studio:
//!     kits:
//!       edition: studio     # `studio` (the default) or `glasshouse`
//!       enabled: all        # `all` (the default), `none`, or a list of slugs
//!       disabled: []        # slugs taken out of `enabled`
//! ```
//!
//! An **edition** is a set of kits: each built-in kit names the editions it
//! runs in (`editions` in its `kit.json`; none named is `studio`). `all` means
//! every kit of the deployment's edition. A list in `enabled` names kits of any
//! edition, so a deployment can add one kit from another edition on purpose.
//! Every kit that predates editions is `studio`'s, so a deployment that does
//! not name an edition runs exactly what it ran before.
//!
//! Both take a YAML list or one comma-separated string, so an environment
//! variable can carry them (`${STUDIO_KITS_DISABLED:-}`). A slug no kit has
//! fails the start: a typo must not leave a kit running that was meant off.
//! Switching a kit on or off needs a restart, not a rebuild.

use std::collections::BTreeSet;
use std::sync::OnceLock;

use anyhow::{Result, bail};
use serde::Deserialize;
use serde_json::Value;

/// A kit's gear, as the kit's module registers it: the gear starts only
/// while its kit is switched on.
pub struct KitGear {
    /// The gear's name (`#[toolkit::gear(name = …)]`).
    pub gear: &'static str,
    /// The kit it belongs to, by slug.
    pub kit: &'static str,
}

inventory::collect!(KitGear);

/// The `vendor` section this module reads.
const VENDOR: &str = "studio";

/// The edition every deployment runs unless it names another, and the one a
/// kit that names no edition belongs to.
pub const EDITION_STUDIO: &str = "studio";
/// The Glasshouse edition: a vendor opens its code to partner companies
/// (`docs/glasshouse-plan.md`).
pub const EDITION_GLASSHOUSE: &str = "glasshouse";
/// Every edition this binary knows.
pub const EDITIONS: [&str; 2] = [EDITION_STUDIO, EDITION_GLASSHOUSE];

/// Which kits run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Composition {
    /// Every kit: the default, and what a deployment without the setting gets.
    All,
    /// Only these kits.
    Only(BTreeSet<String>),
}

impl Composition {
    /// Whether kit `slug` runs.
    pub fn kit_on(&self, slug: &str) -> bool {
        match self {
            Self::All => true,
            Self::Only(kits) => kits.contains(slug),
        }
    }

    /// The kits known to this binary that do not run, sorted.
    pub fn off(&self) -> Vec<String> {
        known_kits()
            .into_iter()
            .filter(|k| !self.kit_on(k))
            .collect()
    }
}

/// `vendor.studio.kits`, as written.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct KitsSetting {
    #[serde(default)]
    edition: Option<String>,
    #[serde(default)]
    enabled: Option<Slugs>,
    #[serde(default)]
    disabled: Option<Slugs>,
}

/// A list of slugs, written as a YAML list or one comma-separated string.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum Slugs {
    List(Vec<String>),
    Text(String),
}

impl Slugs {
    fn items(&self) -> Vec<String> {
        let raw: Vec<&str> = match self {
            Self::List(l) => l.iter().map(String::as_str).collect(),
            Self::Text(t) => t.split(',').collect(),
        };
        raw.into_iter()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect()
    }
}

/// Every kit this binary knows: the built-in kits' slugs and every kit a gear
/// registered for.
pub fn known_kits() -> BTreeSet<String> {
    crate::kit_registry::service::builtin_catalogue()
        .into_iter()
        .map(|k| k.slug)
        .chain(
            inventory::iter::<KitGear>
                .into_iter()
                .map(|g| g.kit.to_owned()),
        )
        .collect()
}

/// The editions kit `slug` runs in.
pub fn kit_editions(slug: &str) -> Vec<String> {
    crate::kit_registry::builtin_editions(slug)
}

/// The kits of `edition`, sorted.
pub fn edition_kits(edition: &str) -> BTreeSet<String> {
    known_kits()
        .into_iter()
        .filter(|k| kit_editions(k).iter().any(|e| e == edition))
        .collect()
}

/// `vendor.studio.kits`, read; no section is the default setting.
fn setting_of(section: Option<&Value>) -> Result<KitsSetting> {
    match section.and_then(|s| s.get("kits")) {
        None | Some(Value::Null) => Ok(KitsSetting::default()),
        Some(v) => serde_json::from_value(v.clone()).map_err(|e| {
            anyhow::anyhow!("vendor.{VENDOR}.kits: {e}; write `edition`, `enabled` and `disabled`")
        }),
    }
}

/// The edition a setting names: `studio` when it names none (or an empty
/// string, as an unset environment variable renders).
fn edition_in(setting: &KitsSetting) -> Result<String> {
    let edition = setting
        .edition
        .as_deref()
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .unwrap_or(EDITION_STUDIO);
    if !EDITIONS.contains(&edition) {
        bail!("vendor.{VENDOR}.kits.edition is `{edition}`; the editions are {EDITIONS:?}");
    }
    Ok(edition.to_owned())
}

/// The edition `vendor.studio` (the section, if any) names.
pub fn edition_from_vendor(section: Option<&Value>) -> Result<String> {
    edition_in(&setting_of(section)?)
}

/// The composition `vendor.studio` (the section, if any) asks for.
pub fn from_vendor(section: Option<&Value>) -> Result<Composition> {
    let setting = setting_of(section)?;
    let edition = edition_in(&setting)?;
    let known = known_kits();
    let check = |field: &str, slugs: &[String]| -> Result<()> {
        let unknown: Vec<&String> = slugs.iter().filter(|s| !known.contains(*s)).collect();
        if !unknown.is_empty() {
            bail!(
                "vendor.{VENDOR}.kits.{field} names kits this build does not have: {unknown:?}; \
                 the kits are {known:?}"
            );
        }
        Ok(())
    };
    let enabled: BTreeSet<String> = match setting.enabled.as_ref().map(Slugs::items) {
        None => edition_kits(&edition),
        Some(items) if items.len() == 1 && items[0] == "all" => edition_kits(&edition),
        Some(items) if items.len() == 1 && items[0] == "none" => BTreeSet::new(),
        Some(items) => {
            check("enabled", &items)?;
            items.into_iter().collect()
        }
    };
    let disabled = setting
        .disabled
        .as_ref()
        .map(Slugs::items)
        .unwrap_or_default();
    check("disabled", &disabled)?;
    let on: BTreeSet<String> = enabled
        .into_iter()
        .filter(|k| !disabled.contains(k))
        .collect();
    Ok(if on == known {
        Composition::All
    } else {
        Composition::Only(on)
    })
}

static CHOSEN: OnceLock<Composition> = OnceLock::new();

/// Fix the composition for this process from its configuration, before any
/// gear starts. A second call keeps the first answer.
pub fn configure(config: &toolkit::bootstrap::AppConfig) -> Result<()> {
    let section = config.vendor.get(VENDOR);
    let edition = edition_from_vendor(section)?;
    let composition = from_vendor(section)?;
    let off = composition.off();
    if off.is_empty() {
        tracing::info!(edition, "kits: every kit is switched on");
    } else {
        tracing::info!(edition, off = ?off, "kits: switched off by vendor.{VENDOR}.kits");
    }
    let _ = CHOSEN.set(composition);
    Ok(())
}

#[cfg(test)]
thread_local! {
    static OVERRIDE: std::cell::RefCell<Option<Composition>> = const { std::cell::RefCell::new(None) };
}

/// Run `f` with `composition` in place of the process's, on this thread.
#[cfg(test)]
pub fn with<T>(composition: Composition, f: impl FnOnce() -> T) -> T {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            OVERRIDE.with(|o| *o.borrow_mut() = None);
        }
    }
    OVERRIDE.with(|o| *o.borrow_mut() = Some(composition));
    let _reset = Reset;
    f()
}

fn current_kit_on(slug: &str) -> bool {
    #[cfg(test)]
    if let Some(on) = OVERRIDE.with(|o| o.borrow().as_ref().map(|c| c.kit_on(slug))) {
        return on;
    }
    CHOSEN.get().is_none_or(|c| c.kit_on(slug))
}

/// Whether kit `slug` runs in this deployment.
pub fn kit_on(slug: &str) -> bool {
    current_kit_on(slug)
}

/// The kit gear `gear` belongs to, when it is a kit's.
pub fn kit_of(gear: &str) -> Option<&'static str> {
    inventory::iter::<KitGear>
        .into_iter()
        .find(|g| g.gear == gear)
        .map(|g| g.kit)
}

/// Whether gear `gear` starts: a core gear always, a kit's gear while its kit
/// is switched on.
pub fn gear_on(gear: &str) -> bool {
    kit_of(gear).is_none_or(kit_on)
}

/// What a kit's gear asks first at `init`: `true`, and said in the log, when
/// its kit is switched off and the gear starts nothing.
pub fn stands_down(gear: &str) -> bool {
    if gear_on(gear) {
        return false;
    }
    tracing::info!(
        gear,
        kit = kit_of(gear).unwrap_or_default(),
        "kits: the kit is switched off in this deployment; the gear does not start"
    );
    true
}

/// Whether a contribution to a core port registered by `gear` counts.
pub fn contributes(gear: &str) -> bool {
    gear_on(gear)
}

#[cfg(test)]
#[path = "composition_tests.rs"]
mod tests;
