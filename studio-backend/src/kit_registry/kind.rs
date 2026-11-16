//! What kind of kit a kit is, for the library's "Kit type" column: what it
//! brings, by the tiers of ADR-0068 §8, computed from its contents.
//!
//! | `kind` | The kit | Today |
//! | --- | --- | --- |
//! | [`KIND_RUNTIME`] | brings its own code that runs in Studio: micro-frontend bundles loaded at run time (ADR-0068 phase 5), WebAssembly or agent functions (§8, §9), or a kit service container | a bundle kit (`STUDIO_KIT_BUNDLES_DIR`), an organization's `kit.json` with `mfe`, `functions` or `services` |
//! | [`KIND_GEARS`] | is built on Studio's gears: its screens are Studio's own and its data is held by gears it claims or calls | every built-in kit |
//! | [`KIND_MODEL`] | brings types, fields and rules only, no code: the generic screens show its objects | an organization's `kit.json` with a model and nothing else |
//! | [`KIND_MATERIAL`] | brings working material only, files `cfs` writes into a project's checkout | `sdlc`, `compete` (`.cf-studio-kit.toml`) |
//!
//! A kit that brings several gets the strongest, in the order above, and
//! lists them all in `brings`, strongest first. A kit nothing reliable
//! describes (no manifest) is classified by its shelf: a built-in kit is
//! `gears`, any other `material` (what `cfs` installs).

use super::contents::KitDetail;
use super::service::SHELF_BUILTIN;

/// Its own code runs in Studio.
pub const KIND_RUNTIME: &str = "runtime";
/// Built on Studio's gears.
pub const KIND_GEARS: &str = "gears";
/// Types and rules only.
pub const KIND_MODEL: &str = "model";
/// Working material for a checkout only.
pub const KIND_MATERIAL: &str = "material";

/// A kit's kind and every tier it brings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KitKind {
    /// The strongest of `brings`.
    pub kind: &'static str,
    /// Every tier it brings, strongest first; never empty.
    pub brings: Vec<&'static str>,
}

/// The kind of `detail`'s kit, from what it brings.
pub fn kind_of(detail: &KitDetail) -> KitKind {
    let c = &detail.contents;
    let runtime = !c.mfe.is_empty() || !c.functions.is_empty() || !c.services.is_empty();
    // Studio's own screens (a tab or section without a bundle of the kit's),
    // or the gears' data: claimed, or read and written through their routes.
    let gears = detail.kit.shelf == SHELF_BUILTIN
        || !c.gears.is_empty()
        || !c.permissions.reads.is_empty()
        || !c.permissions.writes.is_empty()
        || (!c.screens.is_empty() && c.mfe.is_empty());
    let model = !c.types.is_empty()
        || !c.model.fields.is_empty()
        || !c.model.relations.is_empty()
        || !c.model.tabs.is_empty()
        || !c.rules.is_empty();
    let material = !c.material.is_empty() || !c.kinds.is_empty();
    let mut brings: Vec<&'static str> = [
        (KIND_RUNTIME, runtime),
        (KIND_GEARS, gears),
        (KIND_MODEL, model),
        (KIND_MATERIAL, material),
    ]
    .into_iter()
    .filter_map(|(kind, has)| has.then_some(kind))
    .collect();
    if brings.is_empty() {
        brings.push(KIND_MATERIAL);
    }
    KitKind {
        kind: brings[0],
        brings,
    }
}

#[cfg(test)]
#[path = "kind_tests.rs"]
mod tests;
