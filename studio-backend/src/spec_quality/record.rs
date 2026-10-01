//! What a finished analysis RECORDS about each document it covered.
//!
//! ## Why the server records at all
//!
//! The detectors ran on the server, the verdict was read on the server, and
//! the graph writer is on the server — and the only thing that joined them was
//! the browser. The Specs tab and the IDE's Analyze panel each followed the run,
//! read every verdict, turned it into a `spec_finding` node and posted it back.
//! So nothing was recorded unless a tab stayed open to the end, and an
//! analysis nobody was watching (the one a source sync should start) could not
//! be recorded at all.
//!
//! A batch run that is told what each document is (`RecordSpec`) records its
//! own results as they finish. What it records is the same thing both clients
//! wrote — `severity`, `summary`, `score` in the words they used, which the
//! Specs tab and the activity feed already read — plus the findings, placed in
//! the text, under `details.findings`.
//!
//! ## What deliberately stays the caller's
//!
//! WHICH documents are analysed, and that they should be recorded at all. The
//! run records only when its payload carries a `record` block, and records only
//! the subjects that block names: this module turns a verdict into a record, it
//! does not decide what deserves one.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

/// What a run should record, and against what.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordSpec {
    /// The workspace the documents are in, which the graph node is tagged with
    /// and the analysis row is scoped to.
    pub workspace_id: Uuid,
    /// The project, when the documents are a project's.
    #[serde(default)]
    pub project_id: Option<Uuid>,
    /// Each document the run covers, by the path the run names it with.
    pub subjects: BTreeMap<String, RecordSubject>,
}

/// One document a verdict is recorded against.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecordSubject {
    /// What its findings are keyed on: the graph file node for a repository
    /// document, `studio-doc:<id>` for one written in Studio. The same key
    /// both clients used.
    pub node: String,
    /// The binding a stage gate reads, for a repository document.
    #[serde(default)]
    pub binding_id: Option<Uuid>,
    /// The Studio document, for one written in Studio.
    #[serde(default)]
    pub document_id: Option<Uuid>,
}

/// Whether a verdict clears the detector's gate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    Pending,
    Passed,
    Failed,
}

impl Gate {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Gate::Pending => "pending",
            Gate::Passed => "passed",
            Gate::Failed => "failed",
        }
    }
}

/// What one detector concluded about one document, ready to record.
#[derive(Debug, Clone, PartialEq)]
pub struct Reading {
    pub path: String,
    /// The word the Specs tab colours a row by: `gate-passed`, `gate-failed`,
    /// `analyzed`, `unrecognised` for `purpose`; `clean`, `high`, `analyzed`
    /// for `leak`; `clean`, `high` for `bloat`; `clean`, `some` for
    /// `traceability`. The clients' own vocabulary, kept so that a recorded
    /// row reads exactly as one they wrote.
    pub severity: &'static str,
    pub summary: String,
    pub score: Option<f64>,
    pub gate: Gate,
    /// The structured reading, with `findings` among it.
    pub details: Value,
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn findings_json(findings: Vec<super::findings::Finding>) -> Value {
    Value::Array(
        findings
            .into_iter()
            .map(|f| serde_json::to_value(super::rest::finding_dto(f)).unwrap_or(Value::Null))
            .collect(),
    )
}

/// The readings in one finished item.
///
/// A document detector (`purpose`, `leak`) answers about the one document the
/// item was, `item_id`. A set detector (`bloat`, `traceability`) answers about
/// every document in `set`, and yields one reading each.
#[must_use]
pub fn readings(
    detector: &str,
    item_id: &str,
    result: Option<&Value>,
    set: &[String],
) -> Vec<Reading> {
    match detector {
        "purpose" => vec![purpose(item_id, result)],
        "leak" => vec![leak(item_id, result)],
        "bloat" => bloat(result, set),
        "traceability" => trace(result, set),
        _ => Vec::new(),
    }
}

fn purpose(path: &str, result: Option<&Value>) -> Reading {
    let v = super::verdict::doc_type(result);
    let share = v.spec_share;
    let findings = super::findings::purpose(result);
    let severity = match v.gate_passed {
        Some(true) => "gate-passed",
        Some(false) => "gate-failed",
        None if share >= super::findings::MIN_SPEC_SHARE => "analyzed",
        None => "unrecognised",
    };
    let summary = match &v.doc_type {
        Some(t) => format!("purpose: {t} ({:.0}% specification)", share * 100.0),
        None => "purpose: no type named".to_owned(),
    };
    Reading {
        path: path.to_owned(),
        severity,
        summary,
        score: Some(share),
        gate: match v.gate_passed {
            Some(true) => Gate::Passed,
            Some(false) => Gate::Failed,
            None => Gate::Pending,
        },
        details: json!({
            "doc_type": v.doc_type,
            "spec_share": share,
            "gate_passed": v.gate_passed,
            "findings": findings_json(findings),
        }),
    }
}

fn leak(path: &str, result: Option<&Value>) -> Reading {
    let v = super::verdict::leak(result);
    let findings = super::findings::leak(result);
    let foreign = v
        .leak_share
        .map(|s| format!(" ({:.0}% foreign)", s * 100.0))
        .unwrap_or_default();
    let roles = if v.foreign_roles.is_empty() {
        "another kind".to_owned()
    } else {
        v.foreign_roles.join(", ")
    };
    let (severity, summary, gate) = match v.passed {
        Some(true) => ("clean", format!("leak: clean{foreign}"), Gate::Passed),
        Some(false) => (
            "high",
            format!("leak: reads partly as {roles}{foreign}"),
            Gate::Failed,
        ),
        None => ("analyzed", "leak: no verdict".to_owned(), Gate::Pending),
    };
    Reading {
        path: path.to_owned(),
        severity,
        summary,
        score: v.leak_share,
        gate,
        details: json!({
            "passed": v.passed,
            "leak_share": v.leak_share,
            "foreign_roles": v.foreign_roles,
            "findings": findings_json(findings),
        }),
    }
}

fn bloat(result: Option<&Value>, set: &[String]) -> Vec<Reading> {
    let v = super::verdict::bloat(result, set);
    let all = super::findings::bloat(result, set);
    set.iter()
        .map(|path| {
            let repeats = v.by_path.get(path).cloned().unwrap_or_default();
            let mine: Vec<_> = all
                .iter()
                .filter(|f| f.path.as_deref() == Some(path.as_str()))
                .cloned()
                .collect();
            let names: Vec<&str> = repeats.iter().map(|p| basename(p)).collect();
            Reading {
                path: path.clone(),
                severity: if repeats.is_empty() { "clean" } else { "high" },
                summary: if repeats.is_empty() {
                    "bloat: nothing repeated elsewhere".to_owned()
                } else {
                    format!("bloat: repeats {}", names.join(", "))
                },
                score: Some(repeats.len() as f64),
                gate: if repeats.is_empty() {
                    Gate::Passed
                } else {
                    Gate::Failed
                },
                details: json!({ "repeats": repeats, "findings": findings_json(mine) }),
            }
        })
        .collect()
}

fn trace(result: Option<&Value>, set: &[String]) -> Vec<Reading> {
    let v = super::verdict::trace(result, set);
    // An unreadable answer is not recorded as "references nothing": that
    // would read as a fact about the documents.
    if !v.recognised {
        return Vec::new();
    }
    set.iter()
        .map(|path| {
            let references = v.by_path.get(path).cloned().unwrap_or_default();
            let referenced_by: Vec<&String> = v
                .by_path
                .iter()
                .filter(|(other, refs)| *other != path && refs.contains(path))
                .map(|(other, _)| other)
                .collect();
            let names: Vec<&str> = references.iter().map(|p| basename(p)).collect();
            Reading {
                path: path.clone(),
                severity: if references.is_empty() {
                    "some"
                } else {
                    "clean"
                },
                summary: if references.is_empty() {
                    "traceability: references no other document in this set".to_owned()
                } else {
                    format!("traceability: references {}", names.join(", "))
                },
                score: Some(references.len() as f64),
                gate: Gate::Passed,
                details: json!({
                    "references": references,
                    "referenced_by": referenced_by,
                    "findings": [],
                }),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(paths: &[&str]) -> Vec<String> {
        paths.iter().map(|p| (*p).to_owned()).collect()
    }

    #[test]
    fn a_failed_purpose_gate_reads_as_the_clients_wrote_it_and_carries_its_findings() {
        let result = json!({
            "path": "docs/PRD.md",
            "doc_type": "prd",
            "mixture": { "other": 0.1, "design": 0.9 },
            "gate": { "passed": false, "violations": [
                { "section": "Scope", "role": "design", "line_start": 4, "line_end": 9,
                  "confidence": 0.97, "reason": "PRD section reads as DESIGN" }
            ]}
        });
        let r = &readings("purpose", "docs/PRD.md", Some(&result), &[])[0];
        assert_eq!(r.severity, "gate-failed");
        assert_eq!(r.summary, "purpose: prd (90% specification)");
        assert_eq!(r.gate, Gate::Failed);
        let findings = r.details["findings"].as_array().unwrap();
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0]["rule"], "purpose.foreign_section");
        assert_eq!(findings[0]["anchor"]["line_start"], 4);
    }

    #[test]
    fn a_purpose_answer_without_a_gate_is_pending_not_passed() {
        let r = &readings("purpose", "a.md", Some(&json!({ "doc_type": "adr" })), &[])[0];
        assert_eq!(r.severity, "analyzed");
        assert_eq!(r.gate, Gate::Pending);
    }

    #[test]
    fn a_leak_names_what_the_document_reads_as() {
        let result =
            json!({ "passed": false, "leak_share": 0.4, "foreign_roles": ["design"], "leaks": [] });
        let r = &readings("leak", "a.md", Some(&result), &[])[0];
        assert_eq!(r.severity, "high");
        assert_eq!(r.summary, "leak: reads partly as design (40% foreign)");
        assert_eq!(r.score, Some(0.4));
    }

    #[test]
    fn bloat_gives_every_document_in_the_set_a_reading_with_only_its_own_findings() {
        let result = json!({ "clusters": [{ "occurrences": [
            { "file": "a.md", "section": "S", "line": 3, "line_end": 3, "text": "same words" },
            { "file": "b.md", "section": "T", "line": 9, "line_end": 9, "text": "same words" },
        ]}]});
        let rs = readings(
            "bloat",
            "set",
            Some(&result),
            &set(&["a.md", "b.md", "c.md"]),
        );
        assert_eq!(rs.len(), 3);
        let a = rs.iter().find(|r| r.path == "a.md").unwrap();
        assert_eq!(a.severity, "high");
        assert_eq!(a.summary, "bloat: repeats b.md");
        assert_eq!(a.details["findings"].as_array().unwrap().len(), 1);
        assert_eq!(a.details["findings"][0]["path"], "a.md");
        let c = rs.iter().find(|r| r.path == "c.md").unwrap();
        assert_eq!(c.severity, "clean");
        assert_eq!(c.gate, Gate::Passed);
        assert!(c.details["findings"].as_array().unwrap().is_empty());
    }

    #[test]
    fn an_unreadable_traceability_answer_records_nothing() {
        assert!(readings("traceability", "set", Some(&json!({})), &set(&["a.md"])).is_empty());
    }

    #[test]
    fn a_record_spec_survives_the_run_payload() {
        let spec = RecordSpec {
            workspace_id: Uuid::nil(),
            project_id: None,
            subjects: BTreeMap::from([(
                "docs/a.md".to_owned(),
                RecordSubject {
                    node: "n1".to_owned(),
                    binding_id: Some(Uuid::nil()),
                    document_id: None,
                },
            )]),
        };
        let back: RecordSpec =
            serde_json::from_value(serde_json::to_value(&spec).unwrap()).unwrap();
        assert_eq!(back.subjects["docs/a.md"], spec.subjects["docs/a.md"]);
    }
}
