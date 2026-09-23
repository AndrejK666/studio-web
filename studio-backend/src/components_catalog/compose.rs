//! Matching what a product needs against the components this system knows.
//!
//! Asked from two directions — the App Spec's Compose button and a project's
//! Components tab — and it must not answer them two ways. That was already the
//! reason this was one module in the portal rather than two call sites; with a
//! second portal arriving it stops being enough, because the two would make
//! their own copies of the rules below and disagree quietly.
//!
//! ── Why a candidate carries whether it was ever built ────────────────────────
//!
//! A gear directory in the catalogue is not a gear. Reading the repository
//! listing on screen during an interview (2026-09-18) the point was made
//! plainly — there are documents and design in there and no implementation at
//! all, so how should that count? — against a roadmap number roughly five times
//! the count of gears anyone has finished.
//!
//! That is not a complaint about the catalogue. It is a defect in any tool that
//! reads it and ranks by keyword alone, because a well-written stub is mostly
//! prose and prose is what keywords match. Suggesting it is worse than
//! suggesting nothing: it answers "what can we build this from?" with something
//! nobody can build from.
//!
//! So candidates are sorted built-first and the rest are LABELLED rather than
//! dropped — a design may legitimately name a component that is still only a
//! design — and the cut to a handful happens after that sort, so a shipped
//! component is never displaced from the list by a stub that mentioned the word
//! more often.

use serde_json::Value;

/// What the catalogue can say about whether a component was ever built.
///
/// `Unknown` is not a maybe. It means the question does not apply or was never
/// asked: a FrontX package carries no crate count at all, and a component with
/// no profile has not been scanned. Neither is evidence of absence, so neither
/// is reported as one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuildState {
    Built,
    DocsOnly,
    Unknown,
}

impl BuildState {
    pub fn as_str(self) -> &'static str {
        match self {
            BuildState::Built => "built",
            BuildState::DocsOnly => "docs-only",
            BuildState::Unknown => "unknown",
        }
    }

    /// Built first, then the unscanned, then what is known to be docs only.
    ///
    /// The unknown sits in the middle deliberately: it might be built, and
    /// ranking it below something known NOT to be would be asserting more than
    /// the catalogue said.
    fn rank(self) -> u8 {
        match self {
            BuildState::Built => 0,
            BuildState::Unknown => 1,
            BuildState::DocsOnly => 2,
        }
    }
}

/// What the Gearbox engine said about a component, as the catalogue sync
/// recorded it in the profile (`auto.gdl_runs`).
///
/// A different question from [`BuildState`], and the two are read together:
/// built says somebody wrote code, this says the engine can put it into a
/// product. `Undescribed` is the absence of a `gear.gdl`, not a failure —
/// most of the catalogue is undescribed, and ranking it below something the
/// engine PROVED cannot run would be asserting more than the engine said.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Composability {
    Runs,
    Blocked,
    Undescribed,
}

impl Composability {
    pub fn as_str(self) -> &'static str {
        match self {
            Composability::Runs => "runs",
            Composability::Blocked => "blocked",
            Composability::Undescribed => "undescribed",
        }
    }

    /// Can run first, undescribed next, proved-cannot last.
    fn rank(self) -> u8 {
        match self {
            Composability::Runs => 0,
            Composability::Undescribed => 1,
            Composability::Blocked => 2,
        }
    }
}

/// One component offered for one capability.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub name: String,
    pub kind: String,
    /// How many of the capability's terms this component mentions.
    pub score: usize,
    /// Which terms they were — the reason, so a suggestion can be argued with.
    pub why: Vec<String>,
    pub built: BuildState,
    pub composable: Composability,
    /// The engine's reason, when `Blocked`. Absent otherwise.
    pub composable_why: Option<String>,
}

/// One capability, and what could fill it.
#[derive(Debug, Clone, PartialEq)]
pub struct PlanRow {
    pub capability: String,
    pub candidates: Vec<Candidate>,
    /// No candidate at all — the capability has nothing to build from.
    pub gap: bool,
    /// Candidates exist, but none has been built. Not a gap, and not an answer
    /// either: worth saying out loud rather than leaving to the reader.
    pub unbuilt: bool,
}

/// How many candidates a row offers before the tail is cut.
const SHORTLIST: usize = 5;

/// Does `hay` mention `term` at the start of a word?
///
/// ANCHORED AT THE HEAD ONLY, and that asymmetry is the whole rule. Anchoring
/// both ends loses the matches that are genuine — `deploy` in
/// `deployment-topology`, `node` in `nodes-registry`, `subscription` in
/// `subscriptions`. Anchoring neither end gains the matches that are noise —
/// `source` swallowed by `resource`, `file` by `profile`, `entity` by
/// `machine-identity`, `graph` by `cryptography`. Every false positive found in
/// practice was a term ending inside a longer word; every genuine match lost to
/// a both-ends anchor was a term beginning one.
///
/// The boundary is "not a letter or digit" rather than a word boundary, so a
/// hyphen, a slash and an `@` all start a word: `storage` finds
/// `cf-gears-file-storage` and `state` finds `@gears-frontx/state`.
fn mentions(hay: &str, term: &str) -> bool {
    let term = term.trim().to_lowercase();
    if term.is_empty() {
        return false;
    }
    let hay_bytes = hay.as_bytes();
    let mut from = 0usize;
    while let Some(found) = hay[from..].find(&term) {
        let at = from + found;
        let preceded_by_word_char = at > 0
            && hay_bytes
                .get(at - 1)
                .is_some_and(|b| b.is_ascii_alphanumeric());
        if !preceded_by_word_char {
            return true;
        }
        from = at + 1;
        if from >= hay.len() {
            break;
        }
    }
    false
}

/// Everything about a component that a capability's terms are matched against.
fn haystack(component: &Value, profile: Option<&Value>) -> String {
    let text = |key: &str| {
        component
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let list = |key: &str| {
        component
            .get(key)
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default()
    };
    [
        text("name"),
        text("description"),
        text("kind"),
        list("keywords"),
        list("categories"),
        profile_text(profile),
    ]
    .join(" ")
    .to_lowercase()
}

/// The description the repository scan wrote, wherever it put it.
fn profile_text(profile: Option<&Value>) -> String {
    let Some(auto) = profile.and_then(|p| p.get("auto")) else {
        return String::new();
    };
    let Some(description) = auto.get("description") else {
        return String::new();
    };
    // The scan has written both a bare string and `{ s: "…" }`.
    description
        .get("s")
        .and_then(Value::as_str)
        .or_else(|| description.as_str())
        .unwrap_or_default()
        .to_owned()
}

/// Resolve capabilities to candidate components.
///
/// `terms` is the workspace's effective capability vocabulary — a capability it
/// invented can give its own search terms rather than getting zero candidates
/// and no explanation (ADR-0014 §5). A capability the vocabulary does not know
/// is matched against its own name, which is what it meant before vocabularies
/// existed.
pub fn plan(
    capabilities: &[String],
    components: &[Value],
    profiles: &serde_json::Map<String, Value>,
    terms: &std::collections::BTreeMap<String, Vec<String>>,
) -> Vec<PlanRow> {
    capabilities
        .iter()
        .map(|capability| {
            let own = vec![capability.clone()];
            let words = terms
                .get(capability)
                .filter(|t| !t.is_empty())
                .unwrap_or(&own);
            let mut candidates: Vec<Candidate> = components
                .iter()
                .filter_map(|component| {
                    let name = component.get("name").and_then(Value::as_str)?;
                    let hay = haystack(component, profiles.get(name));
                    let mut why: Vec<String> = Vec::new();
                    for word in words.iter().chain(std::iter::once(capability)) {
                        if mentions(&hay, word) && !why.iter().any(|w| w == word) {
                            why.push(word.clone());
                        }
                    }
                    if why.is_empty() {
                        return None;
                    }
                    Some(Candidate {
                        name: name.to_owned(),
                        kind: component
                            .get("kind")
                            .and_then(Value::as_str)
                            .unwrap_or("gear")
                            .to_owned(),
                        score: why.len(),
                        why,
                        built: build_state(component, profiles.get(name)),
                        composable: composability(profiles.get(name)),
                        composable_why: blocked_reason(profiles.get(name)),
                    })
                })
                .collect();
            // Built first, then by score. The cut comes AFTER, so a shipped
            // component is never displaced by a stub that said the word more.
            // Build state first, then what the engine can actually assemble,
            // then the score. The engine's verdict sits BETWEEN them on
            // purpose: a built component the engine cannot run is still built,
            // and a described component nobody has written is still unwritten.
            candidates.sort_by(|a, b| {
                a.built
                    .rank()
                    .cmp(&b.built.rank())
                    .then(a.composable.rank().cmp(&b.composable.rank()))
                    .then(b.score.cmp(&a.score))
                    .then(a.name.cmp(&b.name))
            });
            // One component, one candidate. Sixteen of the 118 names on the
            // reference stand are stored TWICE — the same FrontX package under
            // both `catalog.frontx.v1` and `catalog.gear.v1` — and a list of
            // five that spends two slots on one package is offering four.
            // After the sort, so the copy that survives is the better-ranked
            // one; before the cut, so the duplicate does not eat a slot.
            let mut seen = std::collections::HashSet::new();
            candidates.retain(|c| seen.insert(c.name.clone()));
            candidates.truncate(SHORTLIST);
            // Read off the list that is actually shown, and only when every one
            // of them is KNOWN to be docs-only. An `Unknown` among them is not
            // evidence of absence — saying "nothing here is built" over a
            // component nobody scanned asserts more than the catalogue said.
            let unbuilt = !candidates.is_empty()
                && candidates.iter().all(|c| c.built == BuildState::DocsOnly);
            PlanRow {
                capability: capability.clone(),
                gap: candidates.is_empty(),
                unbuilt,
                candidates,
            }
        })
        .collect()
}

/// What the engine said, as the sync wrote it into the profile.
///
/// `auto.gdl_runs` is a graded fact: `s` is the grade and `v` the sentence.
/// Anything other than `good` with a `gdl_runs` present means the engine was
/// asked and said no; no `gdl_runs` at all means nothing describes the
/// component for composition.
fn composability(profile: Option<&Value>) -> Composability {
    let Some(runs) = profile
        .and_then(|p| p.get("auto"))
        .and_then(|a| a.get("gdl_runs"))
    else {
        return Composability::Undescribed;
    };
    if !runs.is_object() {
        return Composability::Undescribed;
    }
    match runs.get("s").and_then(Value::as_str) {
        Some("good") => Composability::Runs,
        _ => Composability::Blocked,
    }
}

/// The engine's sentence, with the grade's own prefix removed.
///
/// The sync writes `no — <reason>`; the reason is what a person reads, and
/// repeating "no" beside a label that already says BLOCKED says nothing.
fn blocked_reason(profile: Option<&Value>) -> Option<String> {
    if composability(profile) != Composability::Blocked {
        return None;
    }
    let value = profile?
        .get("auto")?
        .get("gdl_runs")?
        .get("v")?
        .as_str()?
        .trim();
    // Trimmed FIRST, so the prefix has to be matched in both its forms: a
    // sentence that is only the prefix arrives as `no —` with nothing after
    // it, and stripping `no — ` would then leave the dash on screen.
    let reason = value
        .strip_prefix("no — ")
        .or_else(|| value.strip_prefix("no —"))
        .unwrap_or(value)
        .trim();
    (!reason.is_empty()).then(|| reason.to_owned())
}

/// What the catalogue says about a component, when it says anything.
///
/// The scan computes `gear_status` now, so every consumer gets one answer
/// instead of deriving its own. Reading the crate count stays as the fallback:
/// a graph synced before the status existed carries the count and not the word.
fn build_state(component: &Value, profile: Option<&Value>) -> BuildState {
    // The node's own publication status is the first word, because it is the
    // one a person set. `draft` and `published` are the catalogue's vocabulary;
    // anything else is not a third state, it is no answer, and falls through.
    match component.get("status").and_then(Value::as_str) {
        Some("draft") => return BuildState::DocsOnly,
        Some("published") => return BuildState::Built,
        _ => {}
    }
    let Some(profile) = profile else {
        return BuildState::Unknown;
    };
    if let Some(status) = profile
        .get("auto")
        .and_then(|a| a.get("gear_status"))
        .and_then(Value::as_str)
    {
        return match status {
            "built" => BuildState::Built,
            "docs-only" => BuildState::DocsOnly,
            _ => BuildState::Unknown,
        };
    }
    match profile
        .get("auto")
        .and_then(|a| a.get("crates"))
        .and_then(|c| c.get("n"))
        .and_then(Value::as_u64)
    {
        // Zero is the load-bearing value: a directory holding `docs/` and
        // `gear.toml` and no crate at all.
        Some(0) => BuildState::DocsOnly,
        Some(_) => BuildState::Built,
        None => BuildState::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn component(name: &str, description: &str) -> Value {
        json!({ "name": name, "kind": "gear", "description": description })
    }

    fn vocabulary(pairs: &[(&str, &[&str])]) -> std::collections::BTreeMap<String, Vec<String>> {
        pairs
            .iter()
            .map(|(k, terms)| {
                (
                    (*k).to_owned(),
                    terms.iter().map(|t| (*t).to_owned()).collect(),
                )
            })
            .collect()
    }

    // ---- the matching rule ----------------------------------------------

    #[test]
    fn a_term_beginning_a_longer_word_matches() {
        // The set a both-ends anchor would have lost.
        assert!(mentions("deployment-topology", "deploy"));
        assert!(mentions("nodes-registry", "node"));
        assert!(mentions("subscriptions", "subscription"));
    }

    #[test]
    fn a_term_swallowed_by_a_longer_word_does_not() {
        // The set no anchor at all would have gained.
        assert!(!mentions("resource", "source"));
        assert!(!mentions("profile", "file"));
        assert!(!mentions("machine-identity", "entity"));
        assert!(!mentions("cryptography", "graph"));
    }

    #[test]
    fn punctuation_starts_a_word() {
        assert!(mentions("cf-gears-file-storage", "storage"));
        assert!(mentions("@gears-frontx/state", "state"));
    }

    #[test]
    fn an_empty_term_matches_nothing() {
        assert!(!mentions("anything at all", "   "));
    }

    // ---- ranking ---------------------------------------------------------

    /// The rule the interview produced: a stub does not outrank a shipped
    /// component, however many times it says the word.
    #[test]
    fn a_built_component_outranks_a_stub_with_a_better_score() {
        let components = vec![
            component("chatty-stub", "chat chat chat messaging"),
            component("real-chat", "chat"),
        ];
        let profiles: serde_json::Map<String, Value> = [
            (
                "chatty-stub".to_owned(),
                json!({ "auto": { "crates": { "n": 0 } } }),
            ),
            (
                "real-chat".to_owned(),
                json!({ "auto": { "crates": { "n": 3 } } }),
            ),
        ]
        .into_iter()
        .collect();
        let rows = plan(
            &["chat".to_owned()],
            &components,
            &profiles,
            &vocabulary(&[("chat", &["chat", "messaging"])]),
        );
        assert_eq!(rows[0].candidates[0].name, "real-chat");
        assert_eq!(rows[0].candidates[0].built, BuildState::Built);
        // The stub is kept and labelled, not dropped: a design may name a
        // component that is still only a design.
        assert_eq!(rows[0].candidates[1].built, BuildState::DocsOnly);
        assert!(!rows[0].unbuilt);
    }

    #[test]
    fn a_capability_nothing_matches_is_a_gap() {
        let rows = plan(
            &["telepathy".to_owned()],
            &[component("chat", "messaging")],
            &serde_json::Map::new(),
            &vocabulary(&[]),
        );
        assert!(rows[0].gap);
        assert!(!rows[0].unbuilt);
        assert!(rows[0].candidates.is_empty());
    }

    /// Not a gap, and not an answer either.
    #[test]
    fn candidates_that_are_all_unbuilt_are_said_out_loud() {
        let profiles: serde_json::Map<String, Value> = [(
            "stub".to_owned(),
            json!({ "auto": { "crates": { "n": 0 } } }),
        )]
        .into_iter()
        .collect();
        let rows = plan(
            &["chat".to_owned()],
            &[component("stub", "chat")],
            &profiles,
            &vocabulary(&[]),
        );
        assert!(!rows[0].gap);
        assert!(rows[0].unbuilt);
    }

    #[test]
    fn a_capability_the_vocabulary_does_not_know_is_matched_on_its_own_name() {
        let rows = plan(
            &["billing".to_owned()],
            &[component("billing-engine", "invoices")],
            &serde_json::Map::new(),
            &vocabulary(&[]),
        );
        assert_eq!(rows[0].candidates[0].name, "billing-engine");
        assert_eq!(rows[0].candidates[0].why, vec!["billing".to_owned()]);
    }

    #[test]
    fn the_shortlist_is_cut_after_the_sort_not_before() {
        // Six stubs that all match, and one built component last in input
        // order. A cut before the sort would drop the only usable answer.
        let mut components: Vec<Value> = (0..6)
            .map(|i| component(&format!("stub-{i}"), "chat chat"))
            .collect();
        components.push(component("shipped", "chat"));
        let mut profiles = serde_json::Map::new();
        for i in 0..6 {
            profiles.insert(
                format!("stub-{i}"),
                json!({ "auto": { "crates": { "n": 0 } } }),
            );
        }
        profiles.insert(
            "shipped".to_owned(),
            json!({ "auto": { "crates": { "n": 2 } } }),
        );
        let rows = plan(
            &["chat".to_owned()],
            &components,
            &profiles,
            &vocabulary(&[]),
        );
        assert_eq!(rows[0].candidates.len(), SHORTLIST);
        assert_eq!(rows[0].candidates[0].name, "shipped");
    }

    // ---- build state -----------------------------------------------------

    #[test]
    fn the_scans_own_word_is_preferred_to_the_crate_count() {
        let profile = json!({ "auto": { "gear_status": "docs-only", "crates": { "n": 9 } } });
        assert_eq!(
            build_state(&json!({}), Some(&profile)),
            BuildState::DocsOnly
        );
    }

    #[test]
    fn no_profile_is_unknown_rather_than_docs_only() {
        // Never scanned is not the same fact as scanned and found empty.
        assert_eq!(build_state(&json!({}), None), BuildState::Unknown);
        assert_eq!(
            build_state(&json!({}), Some(&json!({}))),
            BuildState::Unknown
        );
    }

    #[test]
    fn a_zero_crate_count_is_the_load_bearing_one() {
        let profile = json!({ "auto": { "crates": { "n": 0 } } });
        assert_eq!(
            build_state(&json!({}), Some(&profile)),
            BuildState::DocsOnly
        );
    }
    #[test]
    fn a_node_that_says_it_is_published_is_not_asked_again() {
        // The status is what a person set; the crate count is what a scan
        // guessed. When both speak, the person wins.
        let node = json!({ "name": "x", "status": "published" });
        let profile = json!({ "auto": { "crates": { "n": 0 } } });
        assert_eq!(build_state(&node, Some(&profile)), BuildState::Built);

        let draft = json!({ "name": "x", "status": "draft" });
        assert_eq!(
            build_state(&draft, Some(&json!({ "auto": { "crates": { "n": 7 } } }))),
            BuildState::DocsOnly
        );
    }

    #[test]
    fn a_status_the_catalogue_does_not_use_is_no_answer_at_all() {
        // Not a third state — it falls through to what the scan found.
        let node = json!({ "name": "x", "status": "archived" });
        let profile = json!({ "auto": { "crates": { "n": 3 } } });
        assert_eq!(build_state(&node, Some(&profile)), BuildState::Built);
        assert_eq!(build_state(&node, None), BuildState::Unknown);
    }

    // ---- one component, one candidate ------------------------------------

    /// Sixteen of the 118 names on the reference stand are stored twice.
    #[test]
    fn a_component_stored_twice_is_offered_once() {
        let components = vec![
            json!({ "name": "@gears-frontx/state", "kind": "frontx", "description": "chat state" }),
            json!({ "name": "@gears-frontx/state", "kind": "gear", "description": "chat state" }),
            json!({ "name": "other-chat", "kind": "gear", "description": "chat" }),
        ];
        let rows = plan(
            &["chat".to_owned()],
            &components,
            &serde_json::Map::new(),
            &vocabulary(&[]),
        );
        let names: Vec<&str> = rows[0].candidates.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["@gears-frontx/state", "other-chat"]);
    }

    /// The duplicate must not eat a slot: dedup comes before the cut.
    #[test]
    fn a_duplicate_does_not_cost_the_shortlist_a_place() {
        let mut components: Vec<Value> = (0..SHORTLIST)
            .map(|i| component(&format!("chat-{i}"), "chat"))
            .collect();
        components.insert(0, component("chat-0", "chat"));
        let rows = plan(
            &["chat".to_owned()],
            &components,
            &serde_json::Map::new(),
            &vocabulary(&[]),
        );
        assert_eq!(rows[0].candidates.len(), SHORTLIST);
        let mut names: Vec<&str> = rows[0].candidates.iter().map(|c| c.name.as_str()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), SHORTLIST);
    }

    /// `unbuilt` is a claim about the list that is shown, and only when every
    /// candidate on it is KNOWN to be docs-only.
    #[test]
    fn an_unscanned_candidate_does_not_make_a_row_unbuilt() {
        let profiles: serde_json::Map<String, Value> = [(
            "stub".to_owned(),
            json!({ "auto": { "crates": { "n": 0 } } }),
        )]
        .into_iter()
        .collect();
        let rows = plan(
            &["chat".to_owned()],
            &[
                component("stub", "chat"),
                component("never-scanned", "chat"),
            ],
            &profiles,
            &vocabulary(&[]),
        );
        assert_eq!(rows[0].candidates.len(), 2);
        assert!(!rows[0].unbuilt, "one of them might well be built");
    }
    // ---- what the engine said --------------------------------------------

    fn described(state: &str, reason: &str) -> Value {
        json!({ "auto": { "gdl_runs": { "s": state, "v": reason } } })
    }

    #[test]
    fn a_gear_the_engine_can_run_outranks_one_it_proved_cannot() {
        // Within the same build state. Both are built; the engine decides.
        let profiles: serde_json::Map<String, Value> = [
            ("runs".to_owned(), {
                let mut p = described("good", "yes");
                p["auto"]["crates"] = json!({ "n": 1 });
                p
            }),
            ("blocked".to_owned(), {
                let mut p = described("bad", "no — needs a host nothing provides");
                p["auto"]["crates"] = json!({ "n": 1 });
                p
            }),
        ]
        .into_iter()
        .collect();
        let rows = plan(
            &["chat".to_owned()],
            &[
                component("blocked", "chat chat chat"),
                component("runs", "chat"),
            ],
            &profiles,
            &vocabulary(&[("chat", &["chat"])]),
        );
        // `blocked` says the word more often and still comes last.
        let names: Vec<&str> = rows[0].candidates.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["runs", "blocked"]);
        assert_eq!(rows[0].candidates[0].composable, Composability::Runs);
        assert_eq!(rows[0].candidates[1].composable, Composability::Blocked);
    }

    #[test]
    fn an_undescribed_gear_sits_between_the_two() {
        // Most of the catalogue has no gear.gdl. Ranking it below something
        // the engine PROVED cannot run would assert more than the engine said.
        assert!(Composability::Runs.rank() < Composability::Undescribed.rank());
        assert!(Composability::Undescribed.rank() < Composability::Blocked.rank());
        assert_eq!(composability(None), Composability::Undescribed);
        assert_eq!(composability(Some(&json!({}))), Composability::Undescribed);
        assert_eq!(
            composability(Some(&json!({ "auto": { "gdl_runs": "yes" } }))),
            Composability::Undescribed,
            "a fact that is not the graded object is no answer"
        );
    }

    #[test]
    fn any_grade_but_good_means_the_engine_said_no() {
        assert_eq!(
            composability(Some(&described("good", "yes"))),
            Composability::Runs
        );
        for grade in ["bad", "warn", "", "unknown"] {
            assert_eq!(
                composability(Some(&described(grade, "no — whatever"))),
                Composability::Blocked,
                "{grade}"
            );
        }
    }

    #[test]
    fn the_reason_drops_the_grades_own_prefix() {
        // The label already says BLOCKED; repeating "no" says nothing.
        let profile = described("bad", "no — needs a host nothing provides");
        assert_eq!(
            blocked_reason(Some(&profile)).as_deref(),
            Some("needs a host nothing provides")
        );
        // Nothing to explain when it runs, and no empty string when the
        // sentence was only the prefix.
        assert_eq!(blocked_reason(Some(&described("good", "yes"))), None);
        assert_eq!(blocked_reason(Some(&described("bad", "no — "))), None);
        assert_eq!(blocked_reason(None), None);
    }

    #[test]
    fn the_engines_verdict_does_not_outrank_being_built() {
        // A described gear nobody has written is still unwritten.
        let profiles: serde_json::Map<String, Value> = [
            (
                "shipped".to_owned(),
                json!({ "auto": { "crates": { "n": 4 } } }),
            ),
            ("stub".to_owned(), {
                let mut p = described("good", "yes");
                p["auto"]["crates"] = json!({ "n": 0 });
                p
            }),
        ]
        .into_iter()
        .collect();
        let rows = plan(
            &["chat".to_owned()],
            &[component("stub", "chat"), component("shipped", "chat")],
            &profiles,
            &vocabulary(&[]),
        );
        assert_eq!(rows[0].candidates[0].name, "shipped");
    }
}
