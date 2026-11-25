//! The core knows no kit (ADR-0079): a ratchet on the references that are
//! still there.
//!
//! `MODULE_REFS` is read from the code at build time (`build.rs`): which
//! top-level module under `src/` names which as `crate::<module>::…`, outside
//! tests and comments. Every module that is not a kit gear is core-side. A
//! core-side module naming a kit gear fails here unless the pair is in
//! `core_kit_allowlist.txt`, and a listed pair the code no longer has fails
//! too, so the list only shrinks.

use std::collections::BTreeSet;

use super::manifest::MODULE_REFS;

/// The folders under `src/` that are kits' gears (ADR-0079 §7).
const KIT_GEARS: &[&str] = &[
    "artifact_ingest",
    "components_catalog",
    "documents",
    "environments",
    "git_proxy",
    "insight",
    "llm_proxy",
    "product",
    "reports",
    "spec_graph",
    "spec_mapping",
    "spec_quality",
    "studio_theia",
    "usage",
];

const ALLOWLIST: &str = include_str!("core_kit_allowlist.txt");

fn allowlist() -> BTreeSet<(String, String)> {
    ALLOWLIST
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
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
        .filter(|(from, to)| !KIT_GEARS.contains(from) && KIT_GEARS.contains(to))
        .map(|(from, to)| ((*from).to_owned(), (*to).to_owned()))
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
         contribute through a core port instead of naming the kit's gear from the core."
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
    // Guard against an empty table passing every check above.
    assert!(
        MODULE_REFS
            .iter()
            .any(|(from, to)| *from == "documents" && *to == "spec_quality"),
        "build.rs read no module references"
    );
}
