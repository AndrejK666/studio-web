//! What a component's fields actually say, out of the three places that can
//! answer for them.
//!
//! A catalogued component has three sources, and they disagree on purpose:
//!
//! 1. **crates.io** — what the registry published. Always there for a crate,
//!    never there for anything else.
//! 2. **the repository scan** (`profile.auto`) — what reading the checkout
//!    found, refreshed on every sync.
//! 3. **the profile** (`profile.values`) — what a PERSON set, and the only
//!    one of the three that is a decision rather than an observation.
//!
//! Later wins. That order is the whole rule and it is not obvious from any one
//! of them: a person's correction must survive the next sync, and a sync must
//! still be able to fill in what nobody has corrected.
//!
//! ── Why this is not in the browser any more ──────────────────────────────────
//!
//! It was, in `components-catalog.tsx`, run per row on every render. Like the
//! Analysis fold, this saves no requests — the page already held both the node
//! and the profile. What it saves is a second portal working the precedence
//! out again, and getting it wrong in a way nobody notices: the legacy keys
//! below fill only where nothing is set yet, so reading them at the wrong
//! point in the order silently overwrites a person's edit with an old flat
//! field.

use serde_json::{Map, Value, json};

/// Every field that has an answer, keyed by schema field id.
///
/// An answer is the shape the catalogue has always stored: `v` the full value,
/// `b` the badge a table shows, `n` a number to sort on, `s` a grade, `l` a
/// link, `u` a date. Every part optional, because a source that knows the
/// value but not its grade should say so rather than invent one.
pub type Values = Map<String, Value>;

/// Flat profile keys the old editor wrote, and the schema field each means.
///
/// These fill ONLY where nothing is set yet — they are the oldest source and
/// the least trustworthy, and a component edited since has better answers.
const LEGACY_KEYS: [(&str, &str); 16] = [
    ("category", "category"),
    ("domain", "category"),
    ("lifecycle_status", "lifecycle"),
    ("maintainers", "maintainer"),
    ("repository", "path"),
    ("code_coverage", "coverage"),
    ("code_loc", "codeloc"),
    ("spec_loc", "specloc"),
    ("unit_test_loc", "unitloc"),
    ("e2e_test_loc", "e2eloc"),
    ("supported_databases", "dbs"),
    ("plugins", "plugins"),
    ("dependencies", "deps"),
    ("events_published", "events"),
    ("feature_flags", "flags"),
    ("api_spec_link", "openapi"),
];

/// `https://github.com/owner/name/` → `github.com/owner/name`.
fn short_repo(url: &str) -> String {
    let url = url.trim_end_matches('/');
    let url = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url);
    url.strip_prefix("www.").unwrap_or(url).to_owned()
}

fn field(pairs: &[(&str, Value)]) -> Value {
    let mut out = Map::new();
    for (key, value) in pairs {
        if !value.is_null() {
            out.insert((*key).to_owned(), value.clone());
        }
    }
    Value::Object(out)
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|s| !s.is_empty())
}

fn list(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// Everything the crates.io payload can answer.
///
/// The version falls back `max_stable_version` → `newest_version` →
/// `max_version`: the first is what a consumer should depend on, the last is
/// whatever exists including pre-releases, and offering the last when the
/// first is known would advertise a version nobody should take.
#[must_use]
pub fn from_crate(node: &Value) -> Values {
    let mut out = Values::new();
    let name = text(node, "name").unwrap_or_default();
    let crate_url = (!name.is_empty())
        .then(|| format!("https://crates.io/crates/{}", urlencoding_component(&name)));

    if let Some(description) = text(node, "description") {
        out.insert(
            "description".to_owned(),
            field(&[("v", json!(description)), ("b", json!(description))]),
        );
    }
    if let Some(repository) = text(node, "repository") {
        out.insert(
            "path".to_owned(),
            field(&[
                ("v", json!(repository)),
                ("b", json!(short_repo(&repository))),
                ("l", json!(repository)),
            ]),
        );
    }
    let latest = text(node, "max_stable_version")
        .or_else(|| text(node, "newest_version"))
        .or_else(|| text(node, "max_version"));
    if let Some(latest) = latest {
        let link = crate_url.clone().map(Value::from).unwrap_or(Value::Null);
        let version = field(&[
            ("v", json!(latest)),
            ("b", json!(latest)),
            ("l", link.clone()),
        ]);
        out.insert("version".to_owned(), version.clone());
        out.insert("lastrelease".to_owned(), version);
        out.insert(
            "published".to_owned(),
            field(&[
                ("v", json!(format!("On crates.io — {name} {latest}"))),
                ("b", json!("crates.io")),
                ("s", json!("good")),
                ("l", link),
            ]),
        );
    }
    if let Some(updated) = text(node, "updated_at") {
        let day: String = updated.chars().take(10).collect();
        out.insert(
            "lastchange".to_owned(),
            field(&[("v", json!(day)), ("b", json!(day)), ("u", json!(day))]),
        );
    }
    // Categories first, keywords only when there are none: a category is what
    // the publisher filed it under, a keyword is what they hoped it is found by.
    let categories = list(node, "categories");
    let keywords = list(node, "keywords");
    let (all, first) = if !categories.is_empty() {
        (categories.join(", "), categories[0].clone())
    } else if !keywords.is_empty() {
        (keywords.join(", "), keywords[0].clone())
    } else {
        (String::new(), String::new())
    };
    if !all.is_empty() {
        out.insert(
            "category".to_owned(),
            field(&[("v", json!(all)), ("b", json!(first))]),
        );
    }
    if let Some(license) = text(node, "license") {
        out.insert(
            "licence".to_owned(),
            field(&[("v", json!(license)), ("b", json!(license))]),
        );
    }
    out
}

/// Percent-encode the parts of a crate name a URL path cannot carry.
///
/// Crate names are `[A-Za-z0-9_-]`, so this encodes nothing in practice — it
/// is here so a name that somehow is not cannot build a URL that points
/// somewhere else.
fn urlencoding_component(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') {
                c.to_string()
            } else {
                c.to_string()
                    .bytes()
                    .map(|b| format!("%{b:02X}"))
                    .collect::<String>()
            }
        })
        .collect()
}

/// Turn a bare stored value into a field answer, if it can be one.
///
/// A profile may hold the rich shape already, or a bare string, number or
/// list from an older editor. `None` means "this says nothing" — an empty
/// string is not an answer, and storing it as one would hide the source below.
#[must_use]
pub fn to_field_val(raw: &Value) -> Option<Value> {
    match raw {
        Value::Null => None,
        Value::String(s) if s.is_empty() => None,
        Value::String(s) => Some(field(&[("v", json!(s)), ("b", json!(s))])),
        Value::Number(n) => {
            // `n` is the number itself, for sorting and for whoever draws it.
            // The badge is the plain digits: thousands separators are a LOCALE
            // decision, and this side does not hold one — the portal that does
            // formats `n` when it is there. The same reason the access
            // catalogue serves privilege ids and not their English names.
            let shown = n.to_string();
            Some(field(&[
                ("v", json!(shown)),
                ("b", json!(shown)),
                ("n", raw.clone()),
            ]))
        }
        Value::Bool(b) => {
            let shown = b.to_string();
            Some(field(&[("v", json!(shown)), ("b", json!(shown))]))
        }
        Value::Array(items) => {
            let joined: Vec<String> = items
                .iter()
                .map(|item| match item {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                })
                .collect();
            let joined = joined.join(", ");
            (!joined.is_empty()).then(|| {
                field(&[
                    ("v", json!(joined)),
                    ("b", json!(joined)),
                    ("n", json!(items.len())),
                ])
            })
        }
        Value::Object(object) => {
            // Already the rich shape when it carries any of its keys.
            if ["v", "b", "n", "s", "l", "u"]
                .iter()
                .any(|k| object.contains_key(*k))
            {
                return Some(raw.clone());
            }
            // An object nobody recognises: shown compactly rather than dropped,
            // because a value that exists and cannot be read is still a fact.
            let shown = raw.to_string();
            Some(field(&[("v", json!(shown)), ("b", json!(shown))]))
        }
    }
}

/// Merge the three sources in precedence order: crates.io < scan < profile.
#[must_use]
pub fn resolve(node: &Value, profile: Option<&Value>) -> Values {
    let mut out = from_crate(node);
    let Some(profile) = profile else {
        return out;
    };

    // What reading the checkout found, refreshed on every sync.
    if let Some(auto) = profile.get("auto").and_then(Value::as_object) {
        for (key, raw) in auto {
            if let Some(value) = to_field_val(raw) {
                out.insert(key.clone(), value);
            }
        }
    }

    // What a person set. The only decision of the three, so it wins — and it
    // is inserted even when it says nothing, because clearing a field is also
    // a decision and must not fall back to what the scan found.
    if let Some(values) = profile.get("values").and_then(Value::as_object) {
        for (key, raw) in values {
            match to_field_val(raw) {
                Some(value) => out.insert(key.clone(), value),
                None => out.insert(key.clone(), Value::Null),
            };
        }
    }

    // The oldest source, filling only what is still unanswered.
    for (flat, key) in LEGACY_KEYS {
        if out.contains_key(key) {
            continue;
        }
        if let Some(raw) = profile.get(flat)
            && let Some(value) = to_field_val(raw)
        {
            out.insert(key.to_owned(), value);
        }
    }
    out
}

/// What to file a component under, out of the four places a category hides.
///
/// In order: what the scan read, what a person set, what the node itself says,
/// then the first of the published categories. Empty when nothing answers —
/// which is a fact about the component and reads better than "Uncategorised"
/// invented here.
#[must_use]
pub fn category_of(node: &Value, profile: Option<&Value>) -> String {
    let pick = |parent: Option<&Value>| -> Option<String> {
        let value = parent?.get("category")?;
        match value {
            Value::String(s) => (!s.is_empty()).then(|| s.clone()),
            Value::Object(o) => o
                .get("b")
                .or_else(|| o.get("v"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_owned),
            _ => None,
        }
    };
    pick(profile.and_then(|p| p.get("auto")))
        .or_else(|| pick(profile.and_then(|p| p.get("values"))))
        .or_else(|| text(node, "category"))
        .or_else(|| list(node, "categories").first().cloned())
        .unwrap_or_default()
}

// ── which version is newer ───────────────────────────────────────────────────

/// Order two crate versions, newest first.
///
/// Not semver: the catalogue holds whatever crates.io published, which is
/// mostly semver and occasionally not. The comparison splits on `.`, `-` and
/// `+` and compares the runs of digits, which is what the portal did and what
/// every version in the catalogue today sorts correctly under.
///
/// A segment that is not a number counts as ZERO rather than making the whole
/// version unorderable: `1.2.0-rc1` and `1.2.0` then compare on the parts that
/// mean something, and a version nobody can parse sorts last instead of
/// scrambling the list around it.
#[must_use]
pub fn newer_first(a: &str, b: &str) -> std::cmp::Ordering {
    let parts = |s: &str| -> Vec<u64> {
        s.split(['.', '-', '+'])
            .map(|p| p.parse::<u64>().unwrap_or(0))
            .collect()
    };
    let (pa, pb) = (parts(a), parts(b));
    for i in 0..pa.len().max(pb.len()) {
        let (x, y) = (
            pa.get(i).copied().unwrap_or(0),
            pb.get(i).copied().unwrap_or(0),
        );
        if x != y {
            // Newest FIRST, so the comparison is reversed.
            return y.cmp(&x);
        }
    }
    std::cmp::Ordering::Equal
}

#[cfg(test)]
mod tests {
    use super::*;

    fn crate_node(extra: Value) -> Value {
        let mut node = json!({ "name": "cf-gears-api-gateway" });
        if let (Some(a), Some(b)) = (node.as_object_mut(), extra.as_object()) {
            for (k, v) in b {
                a.insert(k.clone(), v.clone());
            }
        }
        node
    }

    fn badge(values: &Values, key: &str) -> Option<String> {
        values
            .get(key)?
            .get("b")
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    // ---- what the registry answers ---------------------------------------

    #[test]
    fn the_stable_version_wins_over_whatever_merely_exists() {
        // Offering a pre-release when a stable one is known would advertise a
        // version nobody should depend on.
        let node = crate_node(json!({
            "max_stable_version": "1.2.0",
            "newest_version": "1.3.0-rc1",
            "max_version": "1.3.0-rc1"
        }));
        assert_eq!(
            badge(&from_crate(&node), "version").as_deref(),
            Some("1.2.0")
        );
    }

    #[test]
    fn a_crate_with_only_a_prerelease_still_says_which_one() {
        let node = crate_node(json!({ "max_version": "0.1.0-alpha" }));
        assert_eq!(
            badge(&from_crate(&node), "version").as_deref(),
            Some("0.1.0-alpha")
        );
    }

    #[test]
    fn a_repository_is_shown_without_its_scheme_and_kept_whole_as_the_link() {
        let node = crate_node(json!({ "repository": "https://www.github.com/cf/gears-rust/" }));
        let values = from_crate(&node);
        assert_eq!(
            badge(&values, "path").as_deref(),
            Some("github.com/cf/gears-rust")
        );
        assert_eq!(
            values["path"]["l"].as_str(),
            Some("https://www.github.com/cf/gears-rust/"),
            "the link keeps the address that works"
        );
    }

    #[test]
    fn categories_are_preferred_to_keywords() {
        // A category is what the publisher filed it under; a keyword is what
        // they hoped it would be found by.
        let node = crate_node(json!({ "categories": ["gateway"], "keywords": ["http", "proxy"] }));
        assert_eq!(
            badge(&from_crate(&node), "category").as_deref(),
            Some("gateway")
        );

        let no_categories = crate_node(json!({ "keywords": ["http", "proxy"] }));
        let values = from_crate(&no_categories);
        assert_eq!(badge(&values, "category").as_deref(), Some("http"));
        assert_eq!(values["category"]["v"].as_str(), Some("http, proxy"));
    }

    #[test]
    fn a_crate_that_answers_nothing_produces_nothing() {
        // Rather than a row of empty fields that read as measured zeroes.
        assert!(from_crate(&json!({ "name": "x" })).is_empty());
    }

    // ---- precedence -------------------------------------------------------

    #[test]
    fn a_persons_answer_beats_the_scan_which_beats_the_registry() {
        let node = crate_node(json!({ "description": "from crates.io" }));
        let profile = json!({
            "auto": { "description": "from the checkout" },
            "values": { "description": "what somebody wrote" }
        });
        let values = resolve(&node, Some(&profile));
        assert_eq!(
            badge(&values, "description").as_deref(),
            Some("what somebody wrote")
        );

        let scan_only = json!({ "auto": { "description": "from the checkout" } });
        assert_eq!(
            badge(&resolve(&node, Some(&scan_only)), "description").as_deref(),
            Some("from the checkout")
        );
        assert_eq!(
            badge(&resolve(&node, None), "description").as_deref(),
            Some("from crates.io")
        );
    }

    #[test]
    fn clearing_a_field_is_a_decision_and_does_not_fall_back() {
        // A person who empties a field means it, and reverting to what the
        // scan found would quietly undo them on the next render.
        let node = crate_node(json!({ "description": "from crates.io" }));
        let profile = json!({
            "auto": { "description": "from the checkout" },
            "values": { "description": "" }
        });
        let values = resolve(&node, Some(&profile));
        assert_eq!(values["description"], Value::Null);
    }

    #[test]
    fn a_legacy_key_fills_only_what_is_still_unanswered() {
        // Reading it at the wrong point in the order would overwrite a
        // person's edit with an old flat field, and nobody would notice.
        let node = crate_node(json!({}));
        let answered = json!({ "values": { "category": "gateways" }, "domain": "old-flat" });
        assert_eq!(
            badge(&resolve(&node, Some(&answered)), "category").as_deref(),
            Some("gateways")
        );

        let unanswered = json!({ "domain": "old-flat" });
        assert_eq!(
            badge(&resolve(&node, Some(&unanswered)), "category").as_deref(),
            Some("old-flat")
        );
    }

    #[test]
    fn every_legacy_key_maps_to_a_field_and_none_maps_twice_to_a_different_one() {
        // `category` and `domain` both mean the category, and that is the one
        // deliberate duplicate; anything else would be two keys fighting.
        for (flat, key) in LEGACY_KEYS {
            assert!(!flat.is_empty() && !key.is_empty());
        }
        let mut seen: Vec<(&str, &str)> = LEGACY_KEYS.to_vec();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), LEGACY_KEYS.len(), "a flat key is listed twice");
    }

    // ---- reading a stored value ------------------------------------------

    #[test]
    fn the_rich_shape_is_passed_through_untouched() {
        let rich = json!({ "v": "92%", "b": "92%", "n": 92, "s": "good" });
        assert_eq!(to_field_val(&rich), Some(rich.clone()));
    }

    #[test]
    fn a_bare_value_becomes_one_and_a_number_keeps_something_to_sort_on() {
        assert_eq!(
            to_field_val(&json!("MIT")),
            Some(json!({ "v": "MIT", "b": "MIT" }))
        );
        let number = to_field_val(&json!(1284)).expect("a number answers");
        assert_eq!(number["n"], json!(1284));
    }

    #[test]
    fn a_list_is_joined_and_says_how_many_it_was() {
        let out = to_field_val(&json!(["postgres", "sqlite"])).expect("a list answers");
        assert_eq!(out["b"], json!("postgres, sqlite"));
        assert_eq!(out["n"], json!(2));
    }

    #[test]
    fn nothing_is_nothing_rather_than_an_empty_answer() {
        // An empty answer would hide whatever the source below it knows.
        for raw in [json!(null), json!(""), json!([])] {
            assert_eq!(to_field_val(&raw), None, "{raw}");
        }
    }

    #[test]
    fn an_object_nobody_recognises_is_shown_rather_than_dropped() {
        // A value that exists and cannot be read is still a fact.
        let odd = json!({ "shape": "unknown" });
        let out = to_field_val(&odd).expect("shown");
        assert!(out["v"].as_str().unwrap().contains("unknown"));
    }

    // ---- which version is newer -------------------------------------------

    fn ordered(mut versions: Vec<&str>) -> Vec<&str> {
        versions.sort_by(|a, b| newer_first(a, b));
        versions
    }

    #[test]
    fn the_newest_version_comes_first() {
        assert_eq!(
            ordered(vec!["0.9.0", "1.2.0", "1.10.0", "1.2.1"]),
            vec!["1.10.0", "1.2.1", "1.2.0", "0.9.0"],
            "ten is after two, not before it"
        );
    }

    #[test]
    fn a_prerelease_sorts_below_the_release_it_precedes() {
        // `1.2.0-rc1` splits to [1,2,0,0] against [1,2,0]: equal on what both
        // carry, and the release wins nothing — which is the portal's
        // behaviour and is why they read as adjacent rather than reordered.
        assert_eq!(
            ordered(vec!["1.2.0-rc1", "1.3.0"]),
            vec!["1.3.0", "1.2.0-rc1"]
        );
    }

    #[test]
    fn a_version_nobody_can_parse_does_not_scramble_the_list_around_it() {
        // Unparseable segments count as zero, so it sorts low rather than
        // throwing the versions that ARE readable out of order.
        let out = ordered(vec!["2.0.0", "nightly", "1.0.0"]);
        assert_eq!(out[0], "2.0.0");
        assert_eq!(out[1], "1.0.0");
        assert_eq!(out[2], "nightly");
    }

    #[test]
    fn a_shorter_version_is_not_newer_for_being_shorter() {
        assert_eq!(ordered(vec!["1.2", "1.2.1"]), vec!["1.2.1", "1.2"]);
        assert_eq!(newer_first("1.2.0", "1.2"), std::cmp::Ordering::Equal);
    }

    // ---- the category ------------------------------------------------------

    #[test]
    fn the_category_is_looked_for_in_four_places_in_order() {
        let node = json!({ "category": "on the node", "categories": ["published"] });
        let scanned = json!({ "auto": { "category": { "b": "scanned" } } });
        let set = json!({ "values": { "category": "set by hand" } });

        assert_eq!(category_of(&node, Some(&scanned)), "scanned");
        assert_eq!(category_of(&node, Some(&set)), "set by hand");
        assert_eq!(category_of(&node, None), "on the node");
        assert_eq!(
            category_of(&json!({ "categories": ["published"] }), None),
            "published"
        );
    }

    #[test]
    fn a_component_nothing_can_file_says_nothing() {
        // Better than an "Uncategorised" invented here, which reads as a fact.
        assert_eq!(category_of(&json!({ "name": "x" }), None), "");
        assert_eq!(category_of(&json!({}), Some(&json!({ "auto": {} }))), "");
    }
}
