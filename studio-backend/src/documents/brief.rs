//! A review brief for one document (`docs/design/studio-documents.md`,
//! "Review briefs"; issue #736).
//!
//! Interview problems 2.2 and 2.7: a raw diff of a document is unreadable, a
//! long specification has no summary, and reviewers cannot tell a change of
//! meaning from rewording. Two parts, kept apart on purpose:
//! - which requirements were added, removed or reworded between two versions
//!   is computed, from the labelled requirements of each (`spec_model`);
//! - the summary, and whether each change alters what is required, is asked
//!   of a model on the caller's key (ADR-0039), and every claim it makes about
//!   a change must name a requirement the computed part found.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::spec_model::index::SourceDoc;
use super::spec_model::requirements::requirements;
use crate::llm_proxy::port::CompletionRequest;

/// One requirement that differs between two versions.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Change {
    pub id: String,
    /// `added`, `removed` or `changed`.
    pub kind: String,
    pub before: Option<String>,
    pub after: Option<String>,
}

/// The requirements that differ between `old` and `new`, in the new
/// document's order, removed ones last.
pub fn changes(path: &str, old: &str, new: &str) -> Vec<Change> {
    let read = |text: &str| {
        requirements(&[SourceDoc {
            path,
            text,
            doc_type: None,
        }])
        .into_iter()
        .map(|r| (r.id.clone(), r.text))
        .collect::<Vec<_>>()
    };
    let before: BTreeMap<String, String> = read(old).into_iter().collect();
    let after = read(new);
    let mut out: Vec<Change> = Vec::new();
    for (id, text) in &after {
        match before.get(id) {
            None => out.push(Change {
                id: id.clone(),
                kind: "added".into(),
                before: None,
                after: Some(text.clone()),
            }),
            Some(old) if normalised(old) != normalised(text) => out.push(Change {
                id: id.clone(),
                kind: "changed".into(),
                before: Some(old.clone()),
                after: Some(text.clone()),
            }),
            Some(_) => {}
        }
    }
    let now: std::collections::BTreeSet<&String> = after.iter().map(|(id, _)| id).collect();
    for (id, text) in &before {
        if !now.contains(id) {
            out.push(Change {
                id: id.clone(),
                kind: "removed".into(),
                before: Some(text.clone()),
                after: None,
            });
        }
    }
    out
}

fn normalised(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// What the model is asked to return.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Brief {
    /// The problem the document addresses, in two sentences at most.
    #[serde(default)]
    pub problem: String,
    #[serde(default)]
    pub roles: Vec<String>,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub out_of_scope: Vec<String>,
    /// Statements the document takes for granted without a source.
    #[serde(default)]
    pub assumptions: Vec<String>,
    /// What a reviewer has to decide.
    #[serde(default)]
    pub open_decisions: Vec<String>,
    /// For each computed change, whether it changes what is required.
    #[serde(default)]
    pub changes: Vec<ChangeMeaning>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangeMeaning {
    pub id: String,
    /// True when what is required changed; false for rewording.
    pub meaning: bool,
    #[serde(default)]
    pub why: String,
}

/// The longest document text sent: the brief is of what fits.
pub const TEXT_MAX: usize = 60_000;

/// The request for a brief of `text`, with the computed `changes`.
pub fn request(
    path: &str,
    doc_type: Option<&str>,
    text: &str,
    changes: &[Change],
) -> CompletionRequest {
    let clipped: String = text.chars().take(TEXT_MAX).collect();
    let changes_json = serde_json::to_string_pretty(changes).unwrap_or_else(|_| "[]".into());
    CompletionRequest {
        system: "You prepare review briefs of product and engineering documents for busy \
                 reviewers. You only state what the document says; you never invent \
                 requirements, roles or decisions. Answer with one JSON object and nothing else."
            .to_string(),
        prompt: format!(
            "Document `{path}`{kind}.\n\n\
             Return JSON with these keys:\n\
             - \"problem\": the problem it addresses, at most two sentences;\n\
             - \"roles\": the user roles it serves;\n\
             - \"scope\": what it covers, one sentence; \"out_of_scope\": what it says it does not cover;\n\
             - \"assumptions\": statements it takes for granted without a source;\n\
             - \"open_decisions\": what a reviewer has to decide, each one sentence;\n\
             - \"changes\": for EACH entry of CHANGES below, {{\"id\", \"meaning\": true if what is \
               required changed (an added or removed requirement always counts), false if only \
               the wording changed, \"why\"}}. Use only ids from CHANGES.\n\n\
             CHANGES:\n{changes_json}\n\nDOCUMENT:\n{clipped}",
            kind = doc_type.map(|t| format!(" (a {t})")).unwrap_or_default(),
        ),
        max_tokens: 2_000,
    }
}

/// Read the model's answer. A change the computed part did not find is
/// dropped; a change it found and the model skipped is kept as a change of
/// meaning, the cautious reading.
pub fn read_answer(answer: &str, changes: &[Change]) -> Result<Brief, String> {
    let start = answer.find('{').ok_or("the answer holds no JSON object")?;
    let end = answer.rfind('}').ok_or("the answer holds no JSON object")?;
    let mut brief: Brief = serde_json::from_str(&answer[start..=end])
        .map_err(|e| format!("the answer is not the brief asked for: {e}"))?;
    brief
        .changes
        .retain(|m| changes.iter().any(|c| c.id == m.id));
    for c in changes {
        let said = brief.changes.iter().any(|m| m.id == c.id);
        if !said || c.kind != "changed" {
            brief.changes.retain(|m| m.id != c.id);
            brief.changes.push(ChangeMeaning {
                id: c.id.clone(),
                meaning: true,
                why: if c.kind == "changed" {
                    "the model did not say; read it as a change of meaning".into()
                } else {
                    format!("{} requirement", c.kind)
                },
            });
        }
    }
    Ok(brief)
}

#[cfg(test)]
#[path = "brief_tests.rs"]
mod tests;
