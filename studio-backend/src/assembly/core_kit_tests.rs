//! The core knows no kit (ADR-0079): a ratchet on the references that are
//! still there.
//!
//! Three tables are read from the code at build time (`build.rs`), outside
//! tests and comments, for every top-level module under `src/` and the crate
//! root (`lib`, `main`):
//!
//! * `MODULE_REFS`: which module names which as `crate::<module>::…` (in the
//!   crate root, also as a bare `<module>::…`);
//! * `MODULE_NAME_REFS`: which module's string literals name a gear another
//!   module declares, by its name or in its REST path
//!   (`"/studio-documents/v1/…"`);
//! * `MODULE_SLUG_REFS`: which module has a built-in kit's slug as a string
//!   literal (`"project-git"`), listed as `kit:<slug>`.
//!
//! Every module that is not a kit gear is core-side. A core-side module naming
//! a kit gear or a kit's slug fails here unless the pair is in
//! `core_kit_allowlist.txt`, and a listed pair the code no longer has fails
//! too, so the list only shrinks.

use std::collections::BTreeSet;

use super::manifest::{MODULE_NAME_REFS, MODULE_REFS, MODULE_SLUG_REFS};

/// The kit registry: naming the built-in kits by slug is what it is for
/// (their manifests, the catalogue, the retired slugs), until a kit
/// registers its own manifest (ADR-0079 §5).
const REGISTRY: &str = "kit_registry";

/// The folders under `src/` that are kits' gears (ADR-0079 §7), and the two
/// kits' modules the ADR's list predates: `gears_matcher` (the gears-matcher
/// kit's client of its service, ADR-0076) and `research_emulator` (the
/// constructor-research kit's stand-in for Constructor Research, ADR-0049); and
/// the built-in kits' functions on the kit-runtime port: `mna` (M&A due
/// diligence) and `project_lifecycle` (Project lifecycle).
const KIT_GEARS: &[&str] = &[
    "artifact_ingest",
    "components_catalog",
    "documents",
    "environments",
    "gears_matcher",
    "git_proxy",
    "insight",
    "llm_proxy",
    "mna",
    "product",
    "project_lifecycle",
    "reports",
    "research_emulator",
    "spec_graph",
    "spec_mapping",
    "spec_quality",
    "studio_theia",
    "usage",
];

const ALLOWLIST: &str = include_str!("core_kit_allowlist.txt");

/// `from -> to  # why`, one pair per line; the reason is for the reader.
fn allowlist() -> BTreeSet<(String, String)> {
    ALLOWLIST
        .lines()
        .map(|l| l.split_once('#').map_or(l, |(pair, _)| pair).trim())
        .filter(|l| !l.is_empty())
        .map(|l| {
            let (from, to) = l
                .split_once("->")
                .unwrap_or_else(|| panic!("core_kit_allowlist.txt: `{l}` is not `from -> to`"));
            (from.trim().to_owned(), to.trim().to_owned())
        })
        .collect()
}

/// The core-side modules that name a kit gear, as the code has them now.
fn core_to_kit() -> BTreeSet<(String, String)> {
    MODULE_REFS
        .iter()
        .chain(MODULE_NAME_REFS)
        .filter(|(from, to)| !KIT_GEARS.contains(from) && KIT_GEARS.contains(to))
        .map(|(from, to)| ((*from).to_owned(), (*to).to_owned()))
        .chain(
            MODULE_SLUG_REFS
                .iter()
                .filter(|(from, _)| !KIT_GEARS.contains(from) && *from != REGISTRY)
                .map(|(from, slug)| ((*from).to_owned(), format!("kit:{slug}"))),
        )
        .collect()
}

#[test]
fn every_kit_gear_folder_exists() {
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    for kit in KIT_GEARS {
        assert!(
            src.join(kit).is_dir(),
            "src/{kit} is gone: take it out of KIT_GEARS"
        );
    }
}

#[test]
fn the_core_names_no_kit_gear_beyond_the_allowlist() {
    let allowed = allowlist();
    let found = core_to_kit();
    let new: Vec<String> = found
        .difference(&allowed)
        .map(|(f, t)| format!("{f} -> {t}"))
        .collect();
    assert!(
        new.is_empty(),
        "core-side modules name a kit's gear: {new:?}. The core knows no kit (ADR-0079): \
         contribute through a core port instead of naming the kit's gear (its module, its \
         gear name or its REST path) from the core."
    );
}

#[test]
fn the_allowlist_only_lists_references_that_still_exist() {
    let found = core_to_kit();
    let gone: Vec<String> = allowlist()
        .difference(&found)
        .map(|(f, t)| format!("{f} -> {t}"))
        .collect();
    assert!(
        gone.is_empty(),
        "core_kit_allowlist.txt lists references the code no longer has: {gone:?}. \
         Remove those lines."
    );
}

#[test]
fn the_scanner_sees_references_between_modules() {
    // Guard against empty tables passing every check above, and pin down each
    // blind spot the scanner once had.
    let has = |table: &[(&str, &str)], from: &str, to: &str| {
        table.iter().any(|(f, t)| *f == from && *t == to)
    };
    assert!(
        has(MODULE_REFS, "documents", "spec_quality"),
        "build.rs read no module references"
    );
    // A path after the file's first `#[cfg(test)]` that is not test code.
    assert!(
        has(MODULE_REFS, "artifact_ingest", "gts_inventory"),
        "build.rs stopped at the first #[cfg(test)] instead of skipping its item"
    );
    // The crate root's bare paths.
    assert!(
        has(MODULE_REFS, "lib", "research_emulator"),
        "build.rs did not read lib.rs"
    );
    // A kit gear's REST path in a string.
    assert!(
        has(MODULE_NAME_REFS, "notify", "studio_theia"),
        "build.rs read no gear names in strings"
    );
    // A kit's slug in a string.
    assert!(
        has(MODULE_SLUG_REFS, "organizations", "components"),
        "build.rs read no kit slugs in strings"
    );
}
