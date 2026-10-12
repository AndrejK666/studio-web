//! A project's domain model, read from its documents, and the places they
//! disagree about it (`docs/spec-domain-model.md`).
//!
//! Built in stages: the reference index and its rules (`index.rs`), which
//! need no model; the facts of each document revision, read by a model on the
//! caller's key (`extract.rs`, run by `build.rs`); and the finding every rule
//! answers with (`finding.rs`).

use std::collections::{BTreeMap, BTreeSet};

pub(crate) mod build;
pub(crate) mod extract;
pub(crate) mod finding;
pub(crate) mod index;

/// One document of the project, with its text.
#[derive(Clone, Debug)]
pub struct SourceText {
    pub path: String,
    pub text: String,
    pub doc_type: Option<String>,
}

/// What the model is read from: the project's documents, and every path of
/// its checkouts for resolving references.
#[derive(Clone, Debug, Default)]
pub struct Sources {
    pub documents: Vec<SourceText>,
    pub tree: BTreeSet<String>,
}

impl Sources {
    pub fn reference_findings(&self) -> Vec<finding::Finding> {
        let docs: Vec<index::SourceDoc<'_>> = self
            .documents
            .iter()
            .map(|d| index::SourceDoc {
                path: &d.path,
                text: &d.text,
                doc_type: d.doc_type.as_deref(),
            })
            .collect();
        index::reference_findings(&docs, &self.tree).1
    }
}

/// Where one document stands in the model.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Coverage {
    pub path: String,
    pub revision: String,
    /// `extracted` at its current revision, `failed` part-way (asked again on
    /// the next build), `stale` (extracted at an older revision only) or
    /// `pending` (never).
    pub state: &'static str,
    pub facts: usize,
    pub dropped: usize,
    pub error: Option<String>,
}

/// One kept extraction, as the model view reads it.
pub struct Kept<'a> {
    pub path: &'a str,
    pub revision: &'a str,
    pub extractor_version: &'a str,
    pub facts: &'a str,
    pub dropped: i32,
    pub error: Option<&'a str>,
}

/// The facts of every document at its current revision, and where each
/// document stands. An extraction by an older extractor version counts as
/// stale: it answered a different question.
pub fn current(documents: &[SourceText], kept: &[Kept<'_>]) -> (Vec<extract::Fact>, Vec<Coverage>) {
    let mut by_path: BTreeMap<&str, Vec<&Kept<'_>>> = BTreeMap::new();
    for k in kept {
        by_path.entry(k.path).or_default().push(k);
    }
    let mut facts = Vec::new();
    let mut coverage = Vec::new();
    for doc in documents {
        let revision = extract::revision(&doc.text);
        let rows = by_path
            .get(doc.path.as_str())
            .map(Vec::as_slice)
            .unwrap_or_default();
        let now = rows
            .iter()
            .find(|k| k.revision == revision && k.extractor_version == extract::EXTRACTOR_VERSION);
        let (state, n, dropped, error) = match now {
            Some(k) => {
                let got: Vec<extract::Fact> = serde_json::from_str(k.facts).unwrap_or_default();
                let n = got.len();
                facts.extend(got);
                let state = if k.error.is_some() {
                    "failed"
                } else {
                    "extracted"
                };
                (
                    state,
                    n,
                    usize::try_from(k.dropped).unwrap_or(0),
                    k.error.map(str::to_string),
                )
            }
            None if rows.is_empty() => ("pending", 0, 0, None),
            None => ("stale", 0, 0, None),
        };
        coverage.push(Coverage {
            path: doc.path.clone(),
            revision,
            state,
            facts: n,
            dropped,
            error,
        });
    }
    (facts, coverage)
}

/// The documents a build has to read: never extracted at their revision, or
/// extracted part-way.
pub fn to_read(coverage: &[Coverage]) -> Vec<&str> {
    coverage
        .iter()
        .filter(|c| c.state != "extracted")
        .map(|c| c.path.as_str())
        .collect()
}
