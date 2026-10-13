//! The project's document checks on its open pull requests, reported to the
//! repository host as a commit status (`docs/design/studio-documents.md`,
//! "Checks on pull requests"; issue #734).
//!
//! Interview problem 2.3: every team builds its own PR check, and a check
//! exists in one repository of sixty-eight. Studio already knows each
//! document's type and the template that type requires; this runs that
//! structural check on every document a pull request changes, on the version
//! in the pull request, and says the result where the reviewers look: a
//! commit status named [`STATUS_CONTEXT`] on the pull request's head commit.
//! A commit status rather than a check run because a personal token can set
//! one; check runs need an installed app.

use serde_json::{Value, json};

use super::model::DocumentType;
use super::validate::validate;

/// The status context the host shows.
pub const STATUS_CONTEXT: &str = "studio/documents";

/// Open pull requests with their head commit and changed files.
pub const OPEN_PULLS_QUERY: &str = r#"
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 30, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { number title url headRefOid files(first: 100) { nodes { path } } }
    }
  }
}
"#;

pub fn open_pulls_request(owner: &str, name: &str) -> Value {
    json!({ "query": OPEN_PULLS_QUERY, "variables": { "owner": owner, "name": name } })
}

/// One open pull request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenPull {
    pub number: i64,
    pub title: String,
    pub url: Option<String>,
    pub head: String,
    pub files: Vec<String>,
}

pub fn read_open_pulls(answer: &Value) -> Result<Vec<OpenPull>, String> {
    if let Some(e) = answer.pointer("/errors/0/message").and_then(Value::as_str) {
        return Err(e.to_string());
    }
    Ok(answer
        .pointer("/data/repository/pullRequests/nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|p| {
            Some(OpenPull {
                number: p.get("number")?.as_i64()?,
                title: p
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                url: p.get("url").and_then(Value::as_str).map(str::to_string),
                head: p.get("headRefOid")?.as_str()?.to_string(),
                files: p
                    .pointer("/files/nodes")
                    .and_then(Value::as_array)
                    .map(|f| {
                        f.iter()
                            .filter_map(|x| {
                                x.get("path").and_then(Value::as_str).map(str::to_string)
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            })
        })
        .collect())
}

/// One changed document's result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileResult {
    pub path: String,
    pub type_key: String,
    pub conforms: bool,
    /// What it lacks: missing or thin required sections, front-matter issues.
    pub issues: Vec<String>,
}

/// One pull request's result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outcome {
    /// `success` or `failure`, as the host's status states.
    pub state: &'static str,
    /// At most 140 characters, the host's limit.
    pub description: String,
    pub files: Vec<FileResult>,
}

/// Check every changed document of a known type, `(path, type, text)`.
pub fn check(changed: &[(String, &DocumentType, String)]) -> Outcome {
    let files: Vec<FileResult> = changed
        .iter()
        .map(|(path, ty, text)| {
            let report = validate(text, &ty.template);
            let mut issues: Vec<String> = report
                .sections
                .iter()
                .filter(|s| s.required && !s.ok)
                .map(|s| {
                    if s.present {
                        format!("section “{}” is too thin", s.title)
                    } else {
                        format!("section “{}” is missing", s.title)
                    }
                })
                .collect();
            issues.extend(report.issues.iter().cloned());
            issues.dedup();
            FileResult {
                path: path.clone(),
                type_key: ty.key.clone(),
                conforms: report.conforms,
                issues,
            }
        })
        .collect();
    let failing = files.iter().filter(|f| !f.conforms).count();
    let description = if files.is_empty() {
        "No Studio document changed".to_string()
    } else if failing == 0 {
        format!("{} document(s) follow their templates", files.len())
    } else {
        let first = files.iter().find(|f| !f.conforms).map(|f| {
            let name = f.path.rsplit('/').next().unwrap_or(&f.path);
            match f.issues.first() {
                Some(i) => format!("{name}: {i}"),
                None => name.to_string(),
            }
        });
        format!(
            "{failing} of {} document(s) do not follow their templates — {}",
            files.len(),
            first.unwrap_or_default()
        )
    };
    Outcome {
        state: if failing == 0 { "success" } else { "failure" },
        description: description.chars().take(140).collect(),
        files,
    }
}

#[cfg(test)]
#[path = "pr_checks_tests.rs"]
mod tests;
