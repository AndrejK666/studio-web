//! Reading a `bloat` result as an answer about DOCUMENTS.
//!
//! The detector answers about TEXT: clusters of passages that repeat. The
//! question somebody opened the Analysis tab with is *which document do I go
//! and fix*, and those are not the same question — so that fold happens here.
//!
//! ── Why here rather than in the page ─────────────────────────────────────────
//!
//! This fold saves no requests, and saying so matters, because the others that
//! moved did: the browser already HELD this result, having polled the run.
//! What it does not hold is a second portal's agreement about how to read it,
//! and this is not an obvious reading. A cluster count is a PER-CLUSTER fact
//! while an occurrence count is not, so a file appearing three times in one
//! cluster takes part in one cluster and has three occurrences. Get that
//! backwards and the table accuses the wrong document.
//!
//! So the fold runs where the result is WRITTEN, once per analysis rather than
//! once per render, and every consumer of the stored result inherits it. A run
//! made before this existed carries no `by_document`, and the screen says so
//! rather than drawing an empty table — re-running fills it in.
//!
//! ── What stayed in the browser ───────────────────────────────────────────────
//!
//! `weightedMixture`, which says what a whole SET is made of, did not come
//! here. Its only caller aggregates results the browser gathered itself, one
//! document at a time, so a copy on this side would be a field nobody reads.
//! When batch runs are read back from the server rather than driven from the
//! page, it belongs here too.
//!
//! ── Defensive on purpose ─────────────────────────────────────────────────────
//!
//! The detector's response shape is not in its OpenAPI. An occurrence without
//! a `file`, a cluster without `occurrences` — each is skipped rather than
//! allowed to fail the run that was supposed to explain itself.

use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// One document's share of the duplication a `bloat` run found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocDuplication {
    pub path: String,
    /// Clusters this document takes part in.
    pub clusters: u32,
    /// Times its text turns up in one — more than `clusters` when a passage
    /// repeats inside the same document as well as across others.
    pub occurrences: u32,
    /// Words counted in those occurrences, from the tokens the service already
    /// split each occurrence into. Its unit, not a second one invented here.
    pub words: u32,
    /// The other documents it shares text with — the pair that has to be
    /// reconciled. Empty means the document only repeats ITSELF, which is a
    /// different and lesser complaint.
    pub partners: Vec<String>,
}

/// Fold a `bloat` result's clusters into one row per document, worst first.
///
/// Only documents that appear in a cluster get a row. Listing the clean ones
/// as zeroes would bury four real findings under eleven blanks; how many were
/// read is a separate number, and the caller states it separately.
#[must_use]
pub fn duplication_by_document(clusters: Option<&Value>) -> Vec<DocDuplication> {
    let clusters = clusters
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let mut rows: BTreeMap<String, DocDuplication> = BTreeMap::new();

    for cluster in clusters {
        let occurrences = cluster
            .get("occurrences")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();

        // The distinct files in this cluster. Distinct, because `clusters` and
        // `partners` are per-CLUSTER facts: a file occurring three times in
        // one cluster still takes part in one cluster.
        let files: BTreeSet<&str> = occurrences
            .iter()
            .filter_map(|o| o.get("file").and_then(Value::as_str))
            .filter(|f| !f.is_empty())
            .collect();

        for occurrence in occurrences {
            let Some(file) = occurrence
                .get("file")
                .and_then(Value::as_str)
                .filter(|f| !f.is_empty())
            else {
                continue;
            };
            let row = rows
                .entry(file.to_owned())
                .or_insert_with(|| DocDuplication {
                    path: file.to_owned(),
                    clusters: 0,
                    occurrences: 0,
                    words: 0,
                    partners: Vec::new(),
                });
            row.occurrences += 1;
            row.words += occurrence
                .get("tokens")
                .and_then(Value::as_array)
                .map(|t| u32::try_from(t.len()).unwrap_or(u32::MAX))
                .unwrap_or(0);
        }

        for file in &files {
            let Some(row) = rows.get_mut(*file) else {
                continue;
            };
            row.clusters += 1;
            for other in &files {
                if other != file && !row.partners.iter().any(|p| p == *other) {
                    row.partners.push((*other).to_owned());
                }
            }
        }
    }

    let mut out: Vec<DocDuplication> = rows.into_values().collect();
    for row in &mut out {
        row.partners.sort();
    }
    // Worst first, by the measure a reader acts on: how much text is repeated,
    // then how often, then by name so one result always reads the same way.
    out.sort_by(|a, b| {
        b.words
            .cmp(&a.words)
            .then(b.occurrences.cmp(&a.occurrences))
            .then(a.path.cmp(&b.path))
    });
    out
}

/// The folded reading of one `bloat` result, as it is stored beside the raw one.
#[must_use]
pub fn bloat_by_document(result: &Value) -> Value {
    let rows: Vec<Value> = duplication_by_document(result.get("clusters"))
        .into_iter()
        .map(|row| {
            json!({
                "path": row.path,
                "clusters": row.clusters,
                "occurrences": row.occurrences,
                "words": row.words,
                "partners": row.partners,
            })
        })
        .collect();
    Value::Array(rows)
}

/// The role mixture of a whole SET, weighted by how long each document is.
///
/// Averaging the per-file shares would let a forty-word stub count as much as
/// a four-thousand-word specification, which is how a set that is nearly all
/// requirements comes out looking evenly mixed. Weighting by `n_tokens` makes
/// the bar say what share of the SET's words read as each role.
///
/// A result that carries a mixture but no token count is weighted 1 rather
/// than dropped: it shows up as a rounding difference instead of as a document
/// that silently left the set.
#[must_use]
pub fn weighted_mixture(results: &[Value]) -> (BTreeMap<String, f64>, f64) {
    let mut totals: BTreeMap<String, f64> = BTreeMap::new();
    let mut tokens = 0.0f64;

    for result in results {
        let Some(mixture) = result.get("mixture").and_then(Value::as_object) else {
            continue;
        };
        let weight = result
            .get("n_tokens")
            .and_then(Value::as_f64)
            .filter(|n| *n > 0.0)
            .unwrap_or(1.0);
        tokens += weight;
        for (role, share) in mixture {
            let Some(share) = share.as_f64().filter(|s| s.is_finite()) else {
                continue;
            };
            *totals.entry(role.clone()).or_insert(0.0) += share * weight;
        }
    }

    // No readable result is NOT the same as a set that is 0% everything: a
    // caller given an empty mixture draws an empty bar rather than four
    // confident zeroes.
    if tokens == 0.0 {
        return (BTreeMap::new(), 0.0);
    }
    let mixture = totals
        .into_iter()
        .map(|(role, sum)| (role, sum / tokens))
        .collect();
    (mixture, tokens)
}

/// The set-wide reading stored beside a purpose sweep's items.
#[must_use]
pub fn purpose_mixture(item_results: &[Value]) -> Value {
    let (mixture, tokens) = weighted_mixture(item_results);
    json!({ "mixture": mixture, "tokens": tokens })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn occurrence(file: &str, words: usize) -> Value {
        json!({ "file": file, "tokens": vec!["w"; words] })
    }

    fn paths(rows: &[DocDuplication]) -> Vec<&str> {
        rows.iter().map(|r| r.path.as_str()).collect()
    }

    // ---- duplication -------------------------------------------------------

    #[test]
    fn a_document_gets_one_row_with_its_share_of_the_cluster() {
        let clusters = json!([{ "occurrences": [occurrence("a.md", 5), occurrence("b.md", 5)] }]);
        let rows = duplication_by_document(Some(&clusters));
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].clusters, 1);
        assert_eq!(rows[0].occurrences, 1);
        assert_eq!(rows[0].words, 5);
    }

    #[test]
    fn a_cluster_is_counted_once_per_file_however_often_that_file_occurs_in_it() {
        // The occurrences are two; the cluster is still one.
        let clusters = json!([{
            "occurrences": [occurrence("a.md", 3), occurrence("a.md", 4), occurrence("b.md", 1)]
        }]);
        let rows = duplication_by_document(Some(&clusters));
        let a = rows.iter().find(|r| r.path == "a.md").unwrap();
        assert_eq!(a.clusters, 1);
        assert_eq!(a.occurrences, 2);
        assert_eq!(a.words, 7);
    }

    #[test]
    fn partners_are_the_other_documents_and_never_the_document_itself() {
        let clusters = json!([{
            "occurrences": [occurrence("a.md", 1), occurrence("a.md", 1), occurrence("b.md", 1)]
        }]);
        let rows = duplication_by_document(Some(&clusters));
        let a = rows.iter().find(|r| r.path == "a.md").unwrap();
        assert_eq!(a.partners, vec!["b.md"]);
    }

    #[test]
    fn a_document_that_only_repeats_itself_has_no_partners() {
        // A different and lesser complaint, and the empty list is what says so.
        let clusters = json!([{ "occurrences": [occurrence("a.md", 2), occurrence("a.md", 2)] }]);
        let rows = duplication_by_document(Some(&clusters));
        assert_eq!(rows[0].partners, Vec::<String>::new());
        assert_eq!(rows[0].occurrences, 2);
        assert_eq!(rows[0].clusters, 1);
    }

    #[test]
    fn rows_come_back_worst_first() {
        let clusters = json!([
            { "occurrences": [occurrence("small.md", 1), occurrence("big.md", 40)] },
        ]);
        let rows = duplication_by_document(Some(&clusters));
        assert_eq!(paths(&rows), vec!["big.md", "small.md"]);
    }

    #[test]
    fn a_tie_on_words_is_broken_by_occurrences_then_by_name() {
        let clusters = json!([
            { "occurrences": [occurrence("b.md", 2), occurrence("a.md", 2)] },
            { "occurrences": [occurrence("c.md", 1), occurrence("c.md", 1)] },
        ]);
        let rows = duplication_by_document(Some(&clusters));
        // c.md has the same two words, across two occurrences, so it leads.
        assert_eq!(paths(&rows), vec!["c.md", "a.md", "b.md"]);
    }

    #[test]
    fn only_documents_that_appear_in_a_cluster_get_a_row() {
        // Listing the clean ones as zeroes would bury the real findings.
        let clusters = json!([{ "occurrences": [occurrence("a.md", 1), occurrence("b.md", 1)] }]);
        let rows = duplication_by_document(Some(&clusters));
        assert_eq!(paths(&rows), vec!["a.md", "b.md"]);
    }

    #[test]
    fn a_payload_shape_nobody_documented_is_skipped_rather_than_fatal() {
        // The detector's response shape is not in its OpenAPI, and a tab that
        // was supposed to explain a run must not die explaining it.
        for clusters in [
            json!(null),
            json!("not an array"),
            json!([null]),
            json!([{}]),
            json!([{ "occurrences": "not an array" }]),
            json!([{ "occurrences": [{ "file": "" }, { "no_file": 1 }, null] }]),
        ] {
            assert!(
                duplication_by_document(Some(&clusters)).is_empty(),
                "{clusters}"
            );
        }
        assert!(duplication_by_document(None).is_empty());
    }

    #[test]
    fn an_occurrence_with_no_tokens_counts_as_an_occurrence_with_no_words() {
        let clusters = json!([{ "occurrences": [{ "file": "a.md" }, occurrence("b.md", 3)] }]);
        let rows = duplication_by_document(Some(&clusters));
        let a = rows.iter().find(|r| r.path == "a.md").unwrap();
        assert_eq!(a.occurrences, 1);
        assert_eq!(a.words, 0);
        assert_eq!(a.partners, vec!["b.md"]);
    }

    // ---- what gets stored --------------------------------------------------

    #[test]
    fn the_stored_reading_is_the_rows_in_order() {
        let result = json!({
            "clusters": [{ "occurrences": [occurrence("a.md", 1), occurrence("b.md", 9)] }]
        });
        let stored = bloat_by_document(&result);
        let rows = stored.as_array().expect("an array");
        assert_eq!(rows[0]["path"], "b.md");
        assert_eq!(rows[0]["words"], 9);
        assert_eq!(rows[0]["partners"], json!(["a.md"]));
    }

    #[test]
    fn a_result_with_no_clusters_stores_an_empty_reading_not_a_missing_one() {
        // The tab can then say "nothing repeated" rather than "no answer".
        assert_eq!(bloat_by_document(&json!({})), json!([]));
    }
    // ---- the set-wide mixture ---------------------------------------------

    fn share(mixture: Value, tokens: f64) -> Value {
        json!({ "mixture": mixture, "n_tokens": tokens })
    }

    #[test]
    fn a_long_document_weighs_more_than_a_short_one() {
        // The whole reason this is not an average: a forty-word stub must not
        // count as much as a four-thousand-word specification.
        let long = share(json!({ "requirements": 1.0 }), 4000.0);
        let stub = share(json!({ "design": 1.0 }), 40.0);
        let (mixture, tokens) = weighted_mixture(&[long, stub]);
        assert_eq!(tokens, 4040.0);
        assert!(mixture["requirements"] > 0.98, "{mixture:?}");
        assert!(mixture["design"] < 0.02, "{mixture:?}");
    }

    #[test]
    fn a_result_with_no_token_count_weighs_one_rather_than_nothing() {
        // It shows up as a rounding difference instead of as a document that
        // silently left the set.
        let counted = share(json!({ "a": 1.0 }), 9.0);
        let uncounted = json!({ "mixture": { "b": 1.0 } });
        let (mixture, tokens) = weighted_mixture(&[counted, uncounted]);
        assert_eq!(tokens, 10.0);
        assert!((mixture["a"] - 0.9).abs() < 1e-9, "{mixture:?}");
        assert!((mixture["b"] - 0.1).abs() < 1e-9, "{mixture:?}");
    }

    #[test]
    fn nothing_readable_is_an_empty_mixture_not_four_confident_zeroes() {
        let (mixture, tokens) = weighted_mixture(&[json!({}), json!(null)]);
        assert!(mixture.is_empty());
        assert_eq!(tokens, 0.0);
    }

    #[test]
    fn a_share_that_is_not_a_number_is_left_out_rather_than_read_as_zero() {
        let odd = json!({ "mixture": { "a": 1.0, "b": "lots", "c": null }, "n_tokens": 10.0 });
        let (mixture, _) = weighted_mixture(&[odd]);
        assert_eq!(mixture.keys().collect::<Vec<_>>(), vec!["a"]);
    }

    #[test]
    fn a_zero_or_negative_token_count_falls_back_to_one() {
        // `0` would make the document weightless and a negative one would
        // subtract it from the set, which is not a thing a document can do.
        let zero = share(json!({ "a": 1.0 }), 0.0);
        let negative = share(json!({ "b": 1.0 }), -5.0);
        let (mixture, tokens) = weighted_mixture(&[zero, negative]);
        assert_eq!(tokens, 2.0);
        assert!((mixture["a"] - 0.5).abs() < 1e-9, "{mixture:?}");
    }
}
