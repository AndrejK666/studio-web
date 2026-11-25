//! A kit declares the kits it reads (ADR-0071 §5, ADR-0079 §5): when a kit's
//! screens read another kit's gear, or the kit claims part of another kit's
//! gear, that other kit is in its `requires`, directly or through a kit it
//! requires. Once a switched-off kit's gear does not start (ADR-0079 §5), an
//! undeclared read is a screen that breaks with nobody told.
//!
//! **Who owns a gear.** Several kits claim one gear (studio-artifact-ingest
//! is claimed by project-git, project-tests, delivery, spec-mapping and
//! project-domain-model), so a claim does not say whose gear it is. The
//! owner is ADR-0079 §7's placement, written once in [`GEAR_OWNERS`]: the kit
//! the gear starts and stops with. A gear in [`CORE_GEARS`] is the core's and
//! needs no `requires`. A route of a gear in neither list fails the test:
//! place the gear first.
//!
//! **What counts.** Every `permissions.reads` route (`METHOD /studio-<gear>/…`;
//! a route outside a gear, such as `/openapi.json`, is the shell's) and every
//! `gears[]` claim. A claim stands for the gear's types, tools or routes, so
//! the gear has to run.
//!
//! **The ratchet.** A pair `kit -> other-kit` not covered by `requires` fails
//! unless `requires_allowlist.txt` lists it; a listed pair that is covered or
//! gone fails too, so the list only shrinks. A pair stays listed where a
//! `requires` would be wrong today: it would close a cycle, forbid removing a
//! kit an organization may remove (spec-mapping, ADR-0074), or name a kit the
//! read only enriches; those reads move to the model's `/query` (ADR-0079).

#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::collections::{BTreeMap, BTreeSet};

use crate::kit_registry::claims::builtin_manifests;
use crate::kit_registry::manifest::KitManifest;

/// ADR-0079 §7: the kit each kit gear belongs to, by the gear's route name.
/// `studio-insight` and `studio-theia` belong to kits that do not exist yet
/// (insight, ide); no built-in kit reads them.
const GEAR_OWNERS: &[(&str, &str)] = &[
    ("studio-artifact-ingest", "project-git"),
    ("studio-git", "project-git"),
    ("studio-documents", "project-specs"),
    ("studio-spec-quality", "project-specs"),
    ("studio-spec-mapping", "spec-mapping"),
    ("studio-spec-graph", "spec-graph"),
    ("studio-environments", "delivery"),
    ("studio-product", "project-product"),
    ("studio-components-catalog", "components"),
    ("studio-reports", "org-reports"),
    ("studio-usage", "org-costs"),
    ("studio-llm", "assistant"),
];

/// ADR-0079 §1, §7: the core's gears, by route name. Any kit may read them.
/// `studio-kits` serves a kit's own data too (mna's routes): the registry is
/// the core's.
const CORE_GEARS: &[&str] = &[
    "studio-user",
    "studio-organizations",
    "studio-session",
    "studio-kits",
    "studio-domain-model",
    "studio-tasks",
    "studio-events",
    "studio-scheduler",
    "studio-identity",
    "studio-connector",
    "studio-mcp",
    "studio-notify",
    "studio-presence",
    "studio-assembly",
];

const ALLOWLIST: &str = include_str!("requires_allowlist.txt");

/// `(kit, other kit)` as listed, each with its reason.
fn allowlist() -> BTreeMap<(String, String), String> {
    let mut out = BTreeMap::new();
    for line in ALLOWLIST.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (pair, reason) = line.split_once('#').unwrap_or((line, ""));
        let (kit, other) = pair
            .split_once("->")
            .unwrap_or_else(|| panic!("requires_allowlist.txt: `{line}` is not `kit -> kit`"));
        assert!(
            !reason.trim().is_empty(),
            "requires_allowlist.txt: `{line}` gives no reason"
        );
        let key = (kit.trim().to_owned(), other.trim().to_owned());
        assert!(
            out.insert(key, reason.trim().to_owned()).is_none(),
            "requires_allowlist.txt: `{line}` is listed twice"
        );
    }
    out
}

/// The gear a read route belongs to: `studio-x` of `GET /studio-x/v1/…`.
fn gear_of_route(route: &str) -> Option<&str> {
    let path = route.split_whitespace().nth(1)?;
    let gear = path.strip_prefix('/')?.split('/').next()?;
    gear.starts_with("studio-").then_some(gear)
}

/// The kit owning `gear`; `None` for a core gear. Panics on a gear neither
/// list places.
fn owner(gear: &str) -> Option<&'static str> {
    if CORE_GEARS.contains(&gear) {
        return None;
    }
    let found = GEAR_OWNERS.iter().find(|(g, _)| *g == gear);
    Some(
        found
            .unwrap_or_else(|| {
                panic!("`{gear}` is in neither GEAR_OWNERS nor CORE_GEARS: place it (ADR-0079 §7)")
            })
            .1,
    )
}

/// `kit` and every kit it requires, transitively.
fn closure(by_slug: &BTreeMap<String, KitManifest>, kit: &str) -> BTreeSet<String> {
    let mut seen = BTreeSet::from([kit.to_owned()]);
    let mut stack = vec![kit.to_owned()];
    while let Some(k) = stack.pop() {
        for r in by_slug.get(&k).map(|m| m.requires.clone()).unwrap_or_default() {
            if seen.insert(r.clone()) {
                stack.push(r);
            }
        }
    }
    seen
}

fn by_slug() -> BTreeMap<String, KitManifest> {
    builtin_manifests()
        .into_iter()
        .map(|m| (m.slug.clone(), m))
        .collect()
}

/// Every `(kit, other kit)` whose gear the kit reads or claims while its
/// `requires` does not reach the other kit, with what showed it.
fn undeclared() -> BTreeMap<(String, String), Vec<String>> {
    let kits = by_slug();
    let mut out: BTreeMap<(String, String), Vec<String>> = BTreeMap::new();
    for (slug, m) in &kits {
        let reach = closure(&kits, slug);
        let reads = m
            .permissions
            .reads
            .iter()
            .filter_map(|r| gear_of_route(r).map(|g| (g.to_owned(), format!("reads `{r}`"))));
        let claims = m
            .gears
            .iter()
            .map(|c| (c.gear.to_ascii_lowercase(), format!("claims `{}`", c.gear)));
        for (gear, why) in reads.chain(claims) {
            if let Some(other) = owner(&gear)
                && !reach.contains(other)
            {
                out.entry((slug.clone(), other.to_owned()))
                    .or_default()
                    .push(why);
            }
        }
    }
    out
}

#[test]
fn every_owner_is_a_built_in_kit_and_no_gear_is_placed_twice() {
    let kits = by_slug();
    for (gear, kit) in GEAR_OWNERS {
        assert!(kits.contains_key(*kit), "`{gear}`'s owner `{kit}` is no built-in kit");
        assert!(!CORE_GEARS.contains(gear), "`{gear}` is both core and `{kit}`'s");
    }
    let gears: BTreeSet<&str> = GEAR_OWNERS.iter().map(|(g, _)| *g).collect();
    assert_eq!(gears.len(), GEAR_OWNERS.len(), "a gear has two owners");
    // The owners are the kits that claim the gear, as ADR-0079 places it.
    for (gear, kit) in GEAR_OWNERS {
        let claims = kits[*kit].gears.iter().any(|c| c.gear == *gear);
        let reads = kits[*kit]
            .permissions
            .reads
            .iter()
            .any(|r| gear_of_route(r) == Some(gear));
        assert!(claims || reads, "`{kit}` neither claims nor reads its own `{gear}`");
    }
}

#[test]
fn requires_has_no_cycle() {
    let kits = by_slug();
    for (slug, m) in &kits {
        for r in &m.requires {
            assert!(
                !closure(&kits, r).contains(slug),
                "`{slug}` requires `{r}`, which requires `{slug}` back"
            );
        }
    }
}

#[test]
fn a_kit_requires_every_kit_whose_gear_it_reads_or_claims() {
    let allowed = allowlist();
    let new: Vec<String> = undeclared()
        .into_iter()
        .filter(|(pair, _)| !allowed.contains_key(pair))
        .map(|((kit, other), why)| format!("{kit} -> {other}: {}", why.join(", ")))
        .collect();
    assert!(
        new.is_empty(),
        "kits read or claim another kit's gear without requiring that kit: {new:#?}. \
         Add the kit to `requires` (ADR-0071 §5), or read it through the model's `/query`."
    );
}

#[test]
fn the_requires_allowlist_only_lists_pairs_still_undeclared() {
    let found = undeclared();
    let gone: Vec<String> = allowlist()
        .into_keys()
        .filter(|pair| !found.contains_key(pair))
        .map(|(kit, other)| format!("{kit} -> {other}"))
        .collect();
    assert!(
        gone.is_empty(),
        "requires_allowlist.txt lists pairs that are declared or no longer read: {gone:?}. \
         Remove those lines."
    );
}

#[test]
fn the_scan_sees_reads_and_claims() {
    // Guard against an empty scan passing every check above.
    assert_eq!(
        gear_of_route("GET /studio-product/v1/gearbox"),
        Some("studio-product")
    );
    assert_eq!(gear_of_route("GET /openapi.json"), None);
    let kits = by_slug();
    let reach = closure(&kits, "gears-project");
    assert!(reach.contains("project-product") && reach.contains("delivery"));
    assert!(!undeclared().is_empty() || allowlist().is_empty());
}
