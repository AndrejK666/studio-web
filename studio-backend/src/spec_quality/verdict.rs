//! Reading what a detector answered, once, on this side.
//!
//! The four detectors return JSON this assembly does not define and cannot
//! predict: the upstream service's OpenAPI declares the four request bodies and
//! nothing else, so a result arrives inside a generic task view and every key
//! below is read defensively. Turning that into a verdict is a judgement — not
//! a deserialization — and it was being made in the browser.
//!
//! That is the reason this exists rather than any performance one. The
//! prototype is about to be retired; a second portal reading these results
//! would have to arrive at the same four judgements independently, from the
//! same undocumented shapes, and any place the two disagreed would show
//! different verdicts for one analysis. The rules are the product, so they
//! belong where both portals meet them.
//!
//! ── Each rule, and what it costs to get wrong ───────────────────────────────
//!
//! **A doc type means nothing without its spec share.** `mixture.other` is how
//! much of a file is not specification content at all; what is left is how much
//! the detector actually recognised. That, and not `gate`, is the evidence for
//! the type it named — a file that is 90% changelog gets a confident `doc_type`
//! and the share is the only thing that says so.
//!
//! **An absent boolean is `None`, never `false`.** A gate with no answer keeps
//! shut rather than guessing; a gate that reads a missing field as a pass opens
//! for everything while looking like it checked.
//!
//! **Only duplication ACROSS documents is bloat.** A document repeating itself
//! is a different and lesser complaint, and failing a stage for it would bury
//! the one bloat exists for: two documents saying the same thing, so that
//! changing one silently leaves the other lying.
//!
//! **An unfamiliar shape is not an empty answer.** `recognised` is false when
//! the result carried none of the edge keys this knows. Without it, a shape
//! this reader does not understand and a genuinely unreferenced document set
//! both render as "no references" — and the first is a bug here while the
//! second is a fact about the documents.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

/// What the `purpose` detector concluded about one document.
#[derive(Debug, Clone, PartialEq)]
pub struct DocTypeVerdict {
    /// The type it named. It always names one, which is why the share matters.
    pub doc_type: Option<String>,
    /// How much of the document read as specification content rather than
    /// `other`, 0.0–1.0 — the detector's own evidence for the type it named.
    pub spec_share: f64,
    /// Whether the purpose gate passed. `None` when the service answered
    /// without one, which keeps a gate shut rather than guessing.
    pub gate_passed: Option<bool>,
}

/// What the `leak` detector concluded about one document.
#[derive(Debug, Clone, PartialEq)]
pub struct LeakVerdict {
    /// Whether the foreign share stayed under the threshold. `None` when the
    /// service answered without one.
    pub passed: Option<bool>,
    /// How much of the document read as belonging to another kind, 0.0–1.0.
    pub leak_share: Option<f64>,
    /// The kinds it read as — `design` and `requirement` inside an ADR, say.
    pub foreign_roles: Vec<String>,
}

/// Which documents of a set repeat which others.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct BloatVerdicts {
    /// Every document asked about, mapped to the others it shares text with.
    /// An empty list means nothing of it is duplicated elsewhere.
    pub by_path: BTreeMap<String, Vec<String>>,
    /// The same relation, deduplicated and unordered, for the graph.
    pub pairs: Vec<(String, String)>,
}

/// How a set of documents references itself.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct TraceVerdicts {
    /// Every document asked about, mapped to the documents it references.
    pub by_path: BTreeMap<String, Vec<String>>,
    /// The same edges, directed, for the graph.
    pub pairs: Vec<(String, String)>,
    /// False when the result carried none of the edge keys this knows. An empty
    /// answer then means "unreadable", not "nothing found".
    pub recognised: bool,
}

/// Read one `purpose` verdict.
pub fn doc_type(result: Option<&Value>) -> DocTypeVerdict {
    let empty = Value::Null;
    let r = result.unwrap_or(&empty);
    let doc_type = r
        .get("doc_type")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    // `gate.passed`, or `gate.ok` — the service has answered with both.
    let gate_passed = r
        .get("gate")
        .and_then(|g| g.get("passed").or_else(|| g.get("ok")))
        .and_then(Value::as_bool);
    let other = r
        .get("mixture")
        .and_then(|m| m.get("other"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let spec_share = if other.is_finite() {
        (1.0 - other).clamp(0.0, 1.0)
    } else {
        0.0
    };
    DocTypeVerdict {
        doc_type,
        spec_share,
        gate_passed,
    }
}

/// Read one `leak` verdict.
pub fn leak(result: Option<&Value>) -> LeakVerdict {
    let empty = Value::Null;
    let r = result.unwrap_or(&empty);
    LeakVerdict {
        passed: r.get("passed").and_then(Value::as_bool),
        leak_share: r.get("leak_share").and_then(Value::as_f64),
        foreign_roles: r
            .get("foreign_roles")
            .and_then(Value::as_array)
            .map(|roles| {
                roles
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default(),
    }
}

/// Read one `bloat` result for a known set of documents.
pub fn bloat(result: Option<&Value>, paths: &[String]) -> BloatVerdicts {
    let empty = Value::Null;
    let r = result.unwrap_or(&empty);
    let clusters = r
        .get("clusters")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut shares: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for cluster in &clusters {
        let files: BTreeSet<String> = cluster
            .get("occurrences")
            .and_then(Value::as_array)
            .map(|occurrences| {
                occurrences
                    .iter()
                    .filter_map(|o| o.get("file").and_then(Value::as_str))
                    .filter(|f| !f.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        // One file, however many times: that is a document repeating itself.
        if files.len() < 2 {
            continue;
        }
        for file in &files {
            let others = shares.entry(file.clone()).or_default();
            for other in &files {
                if other != file {
                    others.insert(other.clone());
                }
            }
        }
    }

    let mut verdicts = BloatVerdicts::default();
    for path in paths {
        let others = shares.get(path).cloned().unwrap_or_default();
        verdicts
            .by_path
            .insert(path.clone(), others.into_iter().collect());
    }
    // The same fact as a relation: an unordered pair, once.
    let mut seen: BTreeSet<(String, String)> = BTreeSet::new();
    for (path, others) in &shares {
        for other in others {
            let pair = if path < other {
                (path.clone(), other.clone())
            } else {
                (other.clone(), path.clone())
            };
            seen.insert(pair);
        }
    }
    verdicts.pairs = seen.into_iter().collect();
    verdicts
}

/// Read one `traceability` result for a known set of documents.
pub fn trace(result: Option<&Value>, paths: &[String]) -> TraceVerdicts {
    let empty = Value::Null;
    let r = result.unwrap_or(&empty);
    // Four spellings have been seen in the wild; none is in the service's
    // OpenAPI, which is why `recognised` exists at all.
    let raw_edges = ["edges", "links", "references", "pairs"]
        .iter()
        .find_map(|key| r.get(*key))
        .and_then(Value::as_array);

    let mut verdicts = TraceVerdicts {
        recognised: raw_edges.is_some(),
        ..TraceVerdicts::default()
    };
    for path in paths {
        verdicts.by_path.insert(path.clone(), Vec::new());
    }

    for raw in raw_edges.into_iter().flatten() {
        // Tuples and objects both appear; take whichever this is.
        let (from, to) = match raw {
            Value::Array(pair) => (
                pair.first().and_then(Value::as_str),
                pair.get(1).and_then(Value::as_str),
            ),
            Value::Object(_) => (
                ["from", "source", "src"]
                    .iter()
                    .find_map(|k| raw.get(*k).and_then(Value::as_str)),
                ["to", "target", "dst"]
                    .iter()
                    .find_map(|k| raw.get(*k).and_then(Value::as_str)),
            ),
            _ => (None, None),
        };
        let (Some(from), Some(to)) = (from, to) else {
            continue;
        };
        // A document referencing itself is not a reference between documents.
        if from == to {
            continue;
        }
        verdicts.pairs.push((from.to_owned(), to.to_owned()));
        if let Some(list) = verdicts.by_path.get_mut(from)
            && !list.iter().any(|existing| existing == to)
        {
            list.push(to.to_owned());
        }
    }
    for list in verdicts.by_path.values_mut() {
        list.sort();
    }
    verdicts
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn paths(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_owned()).collect()
    }

    // ---- purpose ---------------------------------------------------------

    /// The rule the screen turns on: the share, not the gate, is the evidence
    /// for the type. A file that is mostly `other` got a confident name from a
    /// tenth of itself.
    #[test]
    fn the_spec_share_is_what_is_left_after_other() {
        let v = doc_type(Some(&json!({
            "doc_type": "design",
            "mixture": { "other": 0.9, "design": 0.1 },
            "gate": { "passed": true },
        })));
        assert_eq!(v.doc_type.as_deref(), Some("design"));
        assert!((v.spec_share - 0.1).abs() < 1e-9);
        assert_eq!(v.gate_passed, Some(true));
    }

    #[test]
    fn a_result_without_a_mixture_is_read_as_all_specification() {
        assert!((doc_type(Some(&json!({ "doc_type": "prd" }))).spec_share - 1.0).abs() < 1e-9);
    }

    #[test]
    fn a_gate_the_service_did_not_answer_stays_unknown() {
        // Not `false`: a gate with no answer keeps shut, and a gate that reads
        // a missing field as a pass opens for everything while looking checked.
        assert_eq!(
            doc_type(Some(&json!({ "doc_type": "adr" }))).gate_passed,
            None
        );
        assert_eq!(doc_type(None).gate_passed, None);
    }

    #[test]
    fn a_gate_spelled_ok_is_read_as_well_as_one_spelled_passed() {
        let v = doc_type(Some(&json!({ "gate": { "ok": false } })));
        assert_eq!(v.gate_passed, Some(false));
    }

    #[test]
    fn a_blank_doc_type_is_no_doc_type() {
        assert_eq!(doc_type(Some(&json!({ "doc_type": "   " }))).doc_type, None);
    }

    // ---- leak ------------------------------------------------------------

    #[test]
    fn a_leak_verdict_carries_the_share_and_the_kinds_it_read_as() {
        let v = leak(Some(&json!({
            "passed": false,
            "leak_share": 0.42,
            "foreign_roles": ["design", "requirement"],
        })));
        assert_eq!(v.passed, Some(false));
        assert_eq!(v.leak_share, Some(0.42));
        assert_eq!(v.foreign_roles, paths(&["design", "requirement"]));
    }

    #[test]
    fn a_leak_result_with_nothing_in_it_is_unknown_rather_than_clean() {
        let v = leak(None);
        assert_eq!(v.passed, None);
        assert_eq!(v.leak_share, None);
        assert!(v.foreign_roles.is_empty());
    }

    // ---- bloat -----------------------------------------------------------

    /// The rule that keeps bloat worth acting on.
    #[test]
    fn a_document_repeating_itself_is_not_bloat() {
        let result = json!({
            "clusters": [
                { "occurrences": [{ "file": "a.md" }, { "file": "a.md" }] },
            ]
        });
        let v = bloat(Some(&result), &paths(&["a.md"]));
        assert!(v.by_path["a.md"].is_empty());
        assert!(v.pairs.is_empty());
    }

    #[test]
    fn two_documents_sharing_text_name_each_other() {
        let result = json!({
            "clusters": [
                { "occurrences": [{ "file": "a.md" }, { "file": "b.md" }] },
            ]
        });
        let v = bloat(Some(&result), &paths(&["a.md", "b.md"]));
        assert_eq!(v.by_path["a.md"], paths(&["b.md"]));
        assert_eq!(v.by_path["b.md"], paths(&["a.md"]));
        // Once, unordered — the relation is symmetric and the graph stores one.
        assert_eq!(v.pairs, vec![("a.md".to_owned(), "b.md".to_owned())]);
    }

    #[test]
    fn a_document_nobody_duplicated_is_still_reported_with_an_empty_list() {
        // Absent from the answer would read as "not analysed"; empty says
        // "analysed, nothing shared".
        let v = bloat(Some(&json!({ "clusters": [] })), &paths(&["lonely.md"]));
        assert_eq!(v.by_path["lonely.md"], Vec::<String>::new());
    }

    // ---- traceability ----------------------------------------------------

    /// The flag that separates a bug here from a fact about the documents.
    #[test]
    fn a_result_with_no_edge_key_is_unrecognised_not_empty() {
        let v = trace(Some(&json!({ "verdict": "clean" })), &paths(&["a.md"]));
        assert!(!v.recognised);
        assert!(v.pairs.is_empty());
    }

    #[test]
    fn an_empty_edge_list_is_recognised_and_genuinely_empty() {
        let v = trace(Some(&json!({ "edges": [] })), &paths(&["a.md"]));
        assert!(v.recognised);
        assert!(v.pairs.is_empty());
    }

    #[test]
    fn edges_are_read_as_tuples_and_as_objects() {
        let tuples = trace(
            Some(&json!({ "edges": [["a.md", "b.md"]] })),
            &paths(&["a.md", "b.md"]),
        );
        let objects = trace(
            Some(&json!({ "links": [{ "source": "a.md", "target": "b.md" }] })),
            &paths(&["a.md", "b.md"]),
        );
        assert_eq!(tuples.by_path["a.md"], paths(&["b.md"]));
        assert_eq!(objects.by_path["a.md"], paths(&["b.md"]));
        assert_eq!(tuples.pairs, objects.pairs);
    }

    #[test]
    fn a_document_referencing_itself_is_not_an_edge() {
        let v = trace(
            Some(&json!({ "edges": [["a.md", "a.md"]] })),
            &paths(&["a.md"]),
        );
        assert!(v.recognised);
        assert!(v.pairs.is_empty());
        assert!(v.by_path["a.md"].is_empty());
    }

    #[test]
    fn the_same_reference_twice_is_listed_once_per_document() {
        let v = trace(
            Some(&json!({ "edges": [["a.md", "b.md"], ["a.md", "b.md"]] })),
            &paths(&["a.md", "b.md"]),
        );
        assert_eq!(v.by_path["a.md"], paths(&["b.md"]));
    }
}
