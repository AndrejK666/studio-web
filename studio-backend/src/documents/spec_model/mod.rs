//! A project's domain model, read from its documents, and the places they
//! disagree about it (`docs/spec-domain-model.md`).
//!
//! Built in stages: the reference index and its rules (`index.rs`), which
//! need no model; the facts of each document revision, read by a model on the
//! caller's key (`extract.rs`, run by `build.rs`); and the finding every rule
//! answers with (`finding.rs`); the merged model's candidates (`rules.rs`)
//! and the model call that confirms or drops each (`judge.rs`).

use std::collections::{BTreeMap, BTreeSet};

pub(crate) mod build;
pub(crate) mod extract;
pub(crate) mod finding;
pub(crate) mod glossary;
pub(crate) mod index;
pub(crate) mod judge;
pub(crate) mod questions;
pub(crate) mod record;
pub(crate) mod related;
pub(crate) mod requirements;
pub(crate) mod rules;
pub(crate) mod trace;
pub(crate) mod work;

/// One document of the project, with its text.
#[derive(Clone, Debug)]
pub struct SourceText {
    pub path: String,
    pub text: String,
    pub doc_type: Option<String>,
    /// The file's node in the artifact graph, which its `spec_finding`
    /// verdict is recorded on.
    pub node: String,
}

/// What the model is read from: the project's documents, and every path of
/// its checkouts for resolving references.
#[derive(Clone, Debug, Default)]
pub struct Sources {
    pub documents: Vec<SourceText>,
    pub tree: BTreeSet<String>,
    /// The checkouts' other text files, `(path, text)`: the code and tests a
    /// requirement can be traced to.
    pub files: Vec<(String, String)>,
}

impl Sources {
    pub fn reference_findings(&self) -> Vec<finding::Finding> {
        index::reference_findings(&source_docs(&self.documents), &self.tree).1
    }

    /// The identifiers the documents define with a label, and where.
    pub fn labelled_ids(&self) -> BTreeMap<String, Vec<finding::Side>> {
        index::labelled_ids(&source_docs(&self.documents))
    }

    /// Every requirement the documents define, with the basis it states.
    pub fn requirements(&self) -> Vec<requirements::Requirement> {
        requirements::requirements(&source_docs(&self.documents))
    }

    /// Where each requirement is cited: documents, code, tests.
    pub fn trace(&self) -> Vec<trace::Trace> {
        trace::trace(
            &self.requirements(),
            &source_docs(&self.documents),
            &self.files,
        )
    }
}

fn source_docs(documents: &[SourceText]) -> Vec<index::SourceDoc<'_>> {
    documents
        .iter()
        .map(|d| index::SourceDoc {
            path: &d.path,
            text: &d.text,
            doc_type: d.doc_type.as_deref(),
        })
        .collect()
}

/// Every candidate for the judge: the rules' over the merged facts, and the
/// citations of a decision record worth asking about, which need no facts.
pub fn candidates(documents: &[SourceText], facts: &[extract::Fact]) -> Vec<rules::Candidate> {
    let mut out = rules::candidates(facts, CANDIDATE_CAP);
    out.extend(index::misattribution_candidates(
        &source_docs(documents),
        index::CITATION_CAP,
    ));
    out
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

/// Most candidates the rules over the facts send to the judge in one build:
/// each is a model call. Citations have their own cap
/// ([`index::CITATION_CAP`]).
pub const CANDIDATE_CAP: usize = 150;

/// A candidate's key for its judgement: its fingerprint (its sides' paths
/// and passages) and the revisions of the documents its sides are in. A
/// judgement holds while neither document changes.
pub fn judgement_key(
    candidate: &rules::Candidate,
    revision_of: &BTreeMap<String, String>,
) -> (String, String) {
    let fingerprint = finding::Finding::new("", "", String::new(), candidate.side_refs())
        .keyed_by_sides()
        .fingerprint;
    let mut revisions: Vec<&str> = candidate
        .sides
        .iter()
        .map(|f| revision_of.get(&f.path).map_or("", String::as_str))
        .collect();
    revisions.sort_unstable();
    (fingerprint, revisions.join(","))
}

/// One kept judgement, as the findings read it.
pub struct Judged<'a> {
    pub fingerprint: &'a str,
    pub revisions: &'a str,
    pub judge_version: &'a str,
    pub finding: Option<&'a str>,
}

/// The confirmed findings among today's candidates, and the candidates not
/// judged yet at their revisions. A judgement of a revision that is gone, or
/// by an older judge, answers nothing.
pub fn judged(
    candidates: &[rules::Candidate],
    revision_of: &BTreeMap<String, String>,
    kept: &[Judged<'_>],
) -> (Vec<finding::Finding>, Vec<usize>) {
    let mut findings = Vec::new();
    let mut unjudged = Vec::new();
    for (i, candidate) in candidates.iter().enumerate() {
        let (fingerprint, revisions) = judgement_key(candidate, revision_of);
        let hit = kept.iter().find(|k| {
            k.fingerprint == fingerprint
                && k.revisions == revisions
                && k.judge_version == judge::JUDGE_VERSION
        });
        match hit {
            Some(k) => {
                if let Some(found) = k.finding.and_then(|f| serde_json::from_str(f).ok()) {
                    findings.push(found);
                }
            }
            None => unjudged.push(i),
        }
    }
    (findings, unjudged)
}

/// Each document's current revision, by path.
pub fn revisions(documents: &[SourceText]) -> BTreeMap<String, String> {
    documents
        .iter()
        .map(|d| (d.path.clone(), extract::revision(&d.text)))
        .collect()
}
