//! Retired kit slugs and what they resolve to (ADR-0071 §8): the alias
//! table, read for one release after the merges of step 5.
//!
//! Who reads it:
//!
//! - **the installer**: every installed-kits document is read through
//!   [`migrate`] (`installed::MigratingStore`), so a base, organization or project
//!   installation of a retired slug counts as an installation of every kit it
//!   resolves to, and `removed_builtin` naming one keeps its successors
//!   removed only where every slug they merge was removed (§8, "merging kits
//!   whose states differ"). The first write of a document stores it migrated;
//!   the `kit-rename` sweep (`sweep.rs`) writes every one. A request
//!   naming a retired slug acts on what it resolves to.
//! - **`GET /installed-kits`** and **`KitPresence`**: `effective` also lists
//!   a retired slug wherever everything it resolves to applies
//!   ([`with_retired`]), so an old portal or desktop does not hide its
//!   screens during the alias release.
//! - **the model**: the `kit-rename` sweep moves `meta.kit`, `left_by.kit`
//!   and a property's `kit` to the kit that brings the piece now
//!   ([`super::owners`]); the ADR-0070 §5 equality check compares them so.
//!
//! **Step 7 (#1089) removes this table** one release after step 5 reached
//! every environment. `aliases_tests.rs` lists every alias with that note,
//! and fails once a release past [`REMOVE_AFTER`] still carries one.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use super::installed::{InstalledDocument, InstalledKit, InstalledRecord};
use super::service::SHELF_BUILTIN;

/// A retired slug, the kits it resolves to (none: the shell's), and when the
/// alias goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Alias {
    pub retired: &'static str,
    pub resolves_to: &'static [&'static str],
    /// Read by the test that lists the aliases for step 7.
    #[cfg_attr(not(test), allow(dead_code))]
    pub removal: &'static str,
}

/// When an alias goes: one release after the merge, once the sweep has run
/// in every organization and no client reads a retired slug.
const REMOVAL: &str = "remove one release after ADR-0071 step 5 reached every environment \
                       (step 7, #1089): the kit-rename sweep has run in every organization and \
                       no client (portal, desktop, Theia, scripts) reads or sends the slug";

/// The last Studio version (`CARGO_PKG_VERSION`, dotted) that may still carry
/// the aliases: the release after the one that brought them. The test that
/// lists them fails on a later version.
#[cfg_attr(not(test), allow(dead_code))]
pub const REMOVE_AFTER: &str = "0.2";

/// The alias table (ADR-0071 §8).
pub const ALIASES: &[Alias] = &[
    Alias {
        retired: "project-issues",
        resolves_to: &["project-domain-model", "project-git"],
        removal: REMOVAL,
    },
    Alias {
        retired: "project-activity",
        resolves_to: &["project-git", "project-lifecycle"],
        removal: REMOVAL,
    },
    Alias {
        retired: "product-releases",
        resolves_to: &["project-product", "delivery"],
        removal: REMOVAL,
    },
    Alias {
        retired: "org-infrastructure",
        resolves_to: &["delivery"],
        removal: REMOVAL,
    },
    // To the shell (ADR-0071 §6, step 6): Connections, the project's People
    // and Artifacts are Studio's own; an installation of these is nothing.
    Alias {
        retired: "org-connections",
        resolves_to: &[],
        removal: REMOVAL,
    },
    Alias {
        retired: "project-team",
        resolves_to: &[],
        removal: REMOVAL,
    },
    Alias {
        retired: "project-artifacts",
        resolves_to: &[],
        removal: REMOVAL,
    },
];

/// The kits the merges brought: no installation names them before, so they
/// are removed where every slug they merge was removed.
const INTRODUCED: &[&str] = &["delivery", "project-product"];

/// What `slug` resolves to when it is retired; `None` for a current slug.
pub fn resolve(slug: &str) -> Option<&'static [&'static str]> {
    ALIASES
        .iter()
        .find(|a| a.retired == slug)
        .map(|a| a.resolves_to)
}

/// The retired slugs that resolve to `kit`.
fn retired_into(kit: &str) -> Vec<&'static str> {
    ALIASES
        .iter()
        .filter(|a| a.resolves_to.contains(&kit))
        .map(|a| a.retired)
        .collect()
}

/// What the migration of one document did: kept on the document, so its
/// administrators can be told (`GET /installed-kits`, `renamed`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct KitRenameReport {
    /// Each retired slug the document named, and what it now is.
    pub renamed: Vec<RenamedKit>,
    /// Kits applying again although one of the slugs merged into them had
    /// been removed (§8: the merged kit is installed, nothing changes
    /// silently).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shown_again: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenamedKit {
    pub from: String,
    /// Empty: the shell's now.
    pub to: Vec<String>,
}

/// Whether `doc` names a retired slug anywhere.
pub fn needs_migration(doc: &InstalledDocument) -> bool {
    doc.kits.iter().any(|r| resolve(&r.kit_slug).is_some())
        || doc.removed_builtin.iter().any(|s| resolve(s).is_some())
}

/// Resolve every retired slug of `doc` (the built-in kits are `builtin`):
///
/// - an installation of a retired slug becomes one of each kit it resolves
///   to that the document does not record already (same version, installer
///   and time); the shell's slugs are dropped;
/// - `removed_builtin`: a surviving kit stays removed only when it and every
///   slug merged into it were removed; a kit the merge brought is removed
///   when every slug merged into it was (or it was itself, later). A kit that
///   applies again although part of it had been removed is reported.
///
/// Answers whether it changed anything; the report is kept on the document.
pub fn migrate(doc: &mut InstalledDocument, builtin: &[String]) -> bool {
    if !needs_migration(doc) {
        return false;
    }
    let mut report = KitRenameReport::default();
    let mut named: BTreeSet<&str> = BTreeSet::new();
    named.extend(doc.kits.iter().map(|r| r.kit_slug.as_str()));
    named.extend(doc.removed_builtin.iter().map(String::as_str));
    for a in ALIASES.iter().filter(|a| named.contains(a.retired)) {
        report.renamed.push(RenamedKit {
            from: a.retired.to_owned(),
            to: a.resolves_to.iter().map(|s| (*s).to_owned()).collect(),
        });
    }

    // Installations.
    let mut kits: Vec<InstalledRecord> = Vec::new();
    let (retired, current): (Vec<InstalledRecord>, Vec<InstalledRecord>) = doc
        .kits
        .drain(..)
        .partition(|r| resolve(&r.kit_slug).is_some());
    kits.extend(current);
    for r in retired {
        for to in resolve(&r.kit_slug).unwrap_or_default() {
            if kits.iter().any(|k| k.kit_slug == *to) {
                continue;
            }
            kits.push(InstalledRecord {
                kit_slug: (*to).to_owned(),
                shelf: SHELF_BUILTIN.to_owned(),
                ..r.clone()
            });
        }
    }
    kits.sort_by(|a, b| a.kit_slug.cmp(&b.kit_slug));
    doc.kits = kits;

    // Removed built-in kits.
    let removed: BTreeSet<String> = doc.removed_builtin.iter().cloned().collect();
    let mut next: Vec<String> = Vec::new();
    for kit in builtin {
        let merged = retired_into(kit);
        let all_merged_removed = merged.iter().all(|r| removed.contains(*r));
        let itself = removed.contains(kit);
        let gone = if merged.is_empty() {
            itself
        } else if INTRODUCED.contains(&kit.as_str()) {
            itself || all_merged_removed
        } else {
            itself && all_merged_removed
        };
        if gone {
            next.push(kit.clone());
        } else if itself || merged.iter().any(|r| removed.contains(*r)) {
            report.shown_again.push(kit.clone());
        }
    }
    next.sort();
    doc.removed_builtin = next;
    if !report.shown_again.is_empty() {
        tracing::warn!(
            shown_again = ?report.shown_again,
            "studio-kits: merged kits apply again although part of them had been removed (ADR-0071 §8)"
        );
    }
    doc.renamed = Some(report);
    true
}

/// `effective` with the retired slugs that every kit they resolve to (none,
/// for the shell's) applies for, for a client that still reads them during
/// the alias release. Marked [`InstalledKit::retired`].
pub fn with_retired(effective: &[InstalledKit]) -> Vec<InstalledKit> {
    let mut out = effective.to_vec();
    for a in ALIASES {
        if out.iter().any(|k| k.kit_slug == a.retired) {
            continue;
        }
        let targets: Vec<&InstalledKit> = a
            .resolves_to
            .iter()
            .filter_map(|t| effective.iter().find(|k| k.kit_slug == *t))
            .collect();
        if targets.len() != a.resolves_to.len() {
            continue;
        }
        let like = targets.first().map(|k| (*k).clone());
        out.push(InstalledKit {
            kit_slug: a.retired.to_owned(),
            retired: true,
            ..like.unwrap_or(InstalledKit {
                kit_slug: String::new(),
                version: super::service::BUILTIN_VERSION.to_owned(),
                shelf: SHELF_BUILTIN.to_owned(),
                kind: super::installed::KIND_BASE,
                installed_by: None,
                installed_at: None,
                by_default: true,
                retired: true,
            })
        });
    }
    out.sort_by(|a, b| a.kit_slug.cmp(&b.kit_slug));
    out
}

#[cfg(test)]
#[path = "aliases_tests.rs"]
mod tests;
