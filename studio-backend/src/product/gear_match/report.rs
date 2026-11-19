//! What a coverage report says, read for a person: per requirement its
//! verdict, the candidate gears with the matcher's evidence, the passage of
//! the specification it was read from, and what Studio offers to do about it.
//! Also how a run's documents are prepared (their paths as the matcher takes
//! them, the answers to its questions put beside the requirements they
//! answer) and how two runs differ.
//!
//! Pure: JSON in, values out. The report is the matcher's own document
//! (`gears-matcher/schemas/coverage-report.schema.json`); a field this module
//! does not know is left alone, and a field it reads but does not find reads
//! as empty rather than refusing the report.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// The major `schema_version` this module reads. A report of another major is
/// stored as it came and shown as unreadable.
pub const SCHEMA_MAJOR: &str = "1";

/// The longest passage shown beside a requirement.
const PASSAGE_MAX_CHARS: usize = 1500;
/// How far a passage reaches after its requirement's id line.
const PASSAGE_MAX_LINES: usize = 40;

/// What Studio offers for a requirement.
pub const ACTION_PROPOSE: &str = "propose";
pub const ACTION_REVIEW: &str = "review";
pub const ACTION_CREATE_GEAR: &str = "create_gear";
pub const ACTION_ANSWER: &str = "answer";
pub const ACTION_RERUN: &str = "rerun";
pub const ACTION_NONE: &str = "none";

/// One document as it was sent to the matcher.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SentDocument {
    /// The project's own path: a repository path, `studio:<id>` or
    /// `upload:<name>`.
    pub path: String,
    /// The path the matcher was given (relative, `/`, ending in `.md`).
    pub matcher_path: String,
    /// Hex SHA-256 of the text as sent (answers included).
    pub sha256: String,
    pub bytes: u64,
    pub doc_type: Option<String>,
    /// The commit and branch a repository document was read at.
    pub commit: Option<String>,
    pub branch: Option<String>,
    /// The questions whose answers were added to the text sent.
    #[serde(default)]
    pub answered: Vec<String>,
}

/// Hex SHA-256 of a text's UTF-8 bytes, as the matcher checks it.
pub fn sha256_hex(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

/// A project path as the matcher takes it: relative, `/`-separated, no `..`,
/// ending in `.md`. `upload:survey.csv` is `upload/survey.csv.md`,
/// `studio:<id>` is `studio/<id>.md`.
pub fn matcher_path(path: &str) -> String {
    let (prefix, rest) = match path.split_once(':') {
        Some((p @ ("upload" | "studio"), rest)) => (Some(p), rest),
        _ => (None, path),
    };
    let cleaned: Vec<String> = rest
        .replace('\\', "/")
        .split('/')
        .filter(|s| !s.is_empty() && *s != ".")
        .map(|s| {
            let s: String = s.chars().filter(|c| !c.is_control()).collect();
            if s == ".." { "_".to_owned() } else { s }
        })
        .collect();
    let mut out = match prefix {
        Some(p) => format!("{p}/{}", cleaned.join("/")),
        None => cleaned.join("/"),
    };
    if out.is_empty() {
        out = "document".to_owned();
    }
    if !out.to_ascii_lowercase().ends_with(".md") {
        out.push_str(".md");
    }
    // The contract's bound; a longer path keeps its end, which names it.
    if out.chars().count() > 300 {
        let tail: String = out
            .chars()
            .rev()
            .take(290)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        out = format!("long/{tail}");
    }
    out
}

/// The line of `lines` that defines `id`: the one that says `**ID**` and names
/// it in backticks, else any line naming it in backticks, else any naming it.
fn id_line(lines: &[&str], id: &str) -> Option<usize> {
    let ticked = format!("`{id}`");
    lines
        .iter()
        .position(|l| l.contains("**ID**") && l.contains(&ticked))
        .or_else(|| lines.iter().position(|l| l.contains(&ticked)))
        .or_else(|| lines.iter().position(|l| contains_word(l, id)))
}

/// `needle` in `line`, not as part of a longer id.
fn contains_word(line: &str, needle: &str) -> bool {
    let id_char = |c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_';
    line.match_indices(needle).any(|(at, _)| {
        let before = line[..at].chars().next_back();
        let after = line[at + needle.len()..].chars().next();
        !before.is_some_and(id_char) && !after.is_some_and(id_char)
    })
}

/// Where the block a requirement's id line opens ends: before the next
/// heading or the next requirement's id, at most [`PASSAGE_MAX_LINES`] on,
/// without trailing blank lines.
fn block_end(lines: &[&str], at: usize) -> usize {
    let mut end = lines.len().min(at + 1 + PASSAGE_MAX_LINES);
    for (i, l) in lines
        .iter()
        .enumerate()
        .skip(at + 1)
        .take(PASSAGE_MAX_LINES)
    {
        let t = l.trim_start();
        if t.starts_with('#') || t.contains("**ID**") {
            end = i;
            break;
        }
    }
    while end > at + 1 && lines[end - 1].trim().is_empty() {
        end -= 1;
    }
    end
}

/// A line that ends a requirement's statement for the matcher
/// (`gears-matcher/src/gears_matcher/spec/markdown.py`).
fn is_label_line(line: &str) -> bool {
    const LABELS: [&str; 5] = [
        "**Rationale**",
        "**Actors**",
        "**Threshold**",
        "**Verification Method**",
        "**Architecture Allocation**",
    ];
    let t = line.trim_start();
    LABELS.iter().any(|l| t.starts_with(l))
}

/// The passage a requirement was read from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Passage {
    /// The project's path.
    pub path: String,
    /// 1-based line the passage starts at.
    pub line: u32,
    pub text: String,
}

/// The passage of `docs` (`(project path, text)`) that defines `id`: its
/// heading, its id line and the block after it.
pub fn passage(docs: &[(String, String)], id: &str) -> Option<Passage> {
    for (path, text) in docs {
        let lines: Vec<&str> = text.lines().collect();
        let Some(at) = id_line(&lines, id) else {
            continue;
        };
        // The heading just above, when it is close: a CF requirement is
        // `#### Title` then its checkbox line with the id.
        let start = (at.saturating_sub(4)..at)
            .rev()
            .find(|&i| lines[i].trim_start().starts_with('#'))
            .unwrap_or(at);
        let end = block_end(&lines, at);
        let mut body = lines[start..end].join("\n");
        if body.chars().count() > PASSAGE_MAX_CHARS {
            body = body.chars().take(PASSAGE_MAX_CHARS).collect::<String>() + "…";
        }
        return Some(Passage {
            path: path.clone(),
            line: u32::try_from(start + 1).unwrap_or(u32::MAX),
            text: body,
        });
    }
    None
}

/// `text` with each answer put after the block of the requirement it answers
/// (`(requirement id, answer)`), as a paragraph of its statement (before its Rationale), which the matcher reads with the
/// requirement; and the ids it found. The document itself is not changed:
/// only the copy sent.
pub fn with_answers(text: &str, answers: &[(String, String)]) -> (String, Vec<String>) {
    let mut lines: Vec<String> = text.lines().map(str::to_owned).collect();
    let mut applied = Vec::new();
    for (id, answer) in answers {
        let answer = one_line(answer);
        if answer.is_empty() {
            continue;
        }
        let borrowed: Vec<&str> = lines.iter().map(String::as_str).collect();
        let Some(at) = id_line(&borrowed, id) else {
            continue;
        };
        // A paragraph of the statement itself: the matcher reads a
        // requirement's statement up to its first labelled line (Rationale,
        // Actors, ...) and nothing after it.
        let said = format!(
            "Answered in Studio (a question the gear match asked about this requirement): {answer}"
        );
        let end = block_end(&borrowed, at);
        match (at + 1..end).find(|&i| is_label_line(borrowed[i])) {
            Some(label) => {
                lines.splice(label..label, [said, String::new()]);
            }
            None => {
                lines.splice(end..end, [String::new(), said]);
            }
        }
        applied.push(id.clone());
    }
    let mut out = lines.join("\n");
    if text.ends_with('\n') {
        out.push('\n');
    }
    (out, applied)
}

/// Answers to the report's own questions (not tied to a requirement), as a
/// section added at the end of the copy sent.
pub fn with_general_answers(text: &str, answers: &[(String, String)]) -> String {
    let lines: Vec<String> = answers
        .iter()
        .map(|(topic, a)| (one_line(topic), one_line(a)))
        .filter(|(_, a)| !a.is_empty())
        .map(|(t, a)| format!("- **{t}**: {a}"))
        .collect();
    if lines.is_empty() {
        return text.to_owned();
    }
    let mut out = text.trim_end().to_owned();
    out.push_str("\n\n## Answers given in Studio\n\n");
    out.push_str(&lines.join("\n"));
    out.push('\n');
    out
}

fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A candidate gear for one requirement, as the matcher judged it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Candidate {
    /// The matcher's id, `<repository>/<gear>`.
    pub gear_id: String,
    /// The gear's name as a product picks it (the id after its repository).
    pub pick: String,
    /// Its display name, when the report lists it among the gears it uses.
    pub name: Option<String>,
    /// `covered`, `partial`, `none` or `unjudgeable`.
    pub verdict: String,
    pub confidence: Option<f64>,
    /// `chosen`, `alternative` or `other`.
    pub role: String,
    pub evidence: String,
    pub covers: String,
    pub missing: String,
    pub rationale: String,
    /// Whether the gear has code (a future part has none yet).
    pub in_code: Option<bool>,
    /// Which of the report's lists names it: `recommended`, `also_possible`
    /// or `future_part`.
    pub listed: Option<String>,
    /// Studio proposes it for the product: it covers the requirement at least
    /// in part and has code.
    pub proposed: bool,
}

/// One requirement of the report.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Requirement {
    pub requirement_id: String,
    /// `fr` or `nfr`.
    pub kind: String,
    /// `covered`, `partial`, `gap`, `clarification_needed` or `not_assessed`.
    pub coverage: String,
    pub confidence: Option<f64>,
    pub low_confidence: bool,
    pub planned: bool,
    /// Read from a document not in the spec format.
    pub extracted: bool,
    pub reason: String,
    pub gear_provides: String,
    pub remaining_work: String,
    /// What Studio offers: `propose`, `review`, `create_gear`, `answer`,
    /// `rerun` or `none`.
    pub action: String,
    pub candidates: Vec<Candidate>,
    pub passage: Option<Passage>,
}

/// A question the matcher asks: about one requirement it could not decide,
/// or one it raised while reading the documents.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Question {
    /// The requirement's id, or `c-` and a hash of the question.
    pub id: String,
    pub requirement_id: Option<String>,
    pub topic: String,
    pub reason: String,
    pub quote: Option<String>,
    /// The project's path it is about.
    pub path: Option<String>,
}

/// The counts a report gives.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Totals {
    pub requirements: u32,
    pub covered: u32,
    pub partial: u32,
    pub gap: u32,
    pub clarification_needed: u32,
    pub not_assessed: u32,
}

impl Totals {
    /// In a line, for a run's summary.
    pub fn line(&self) -> String {
        format!(
            "{} requirements: {} covered, {} partial, {} gap, {} to clarify, {} not assessed",
            self.requirements,
            self.covered,
            self.partial,
            self.gap,
            self.clarification_needed,
            self.not_assessed
        )
    }
}

fn s(v: &Value, k: &str) -> String {
    v.get(k)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn b(v: &Value, k: &str) -> bool {
    v.get(k).and_then(Value::as_bool).unwrap_or(false)
}

fn u(v: &Value, k: &str) -> u32 {
    v.get(k)
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or(0)
}

/// Whether Studio can read this report.
pub fn readable(report: &Value) -> bool {
    report
        .get("schema_version")
        .and_then(Value::as_str)
        .is_some_and(|v| v.split('.').next() == Some(SCHEMA_MAJOR))
}

/// The report's counts: its own `totals`, FR and NFR together.
pub fn totals(report: &Value) -> Totals {
    let t = &report["totals"];
    let mut out = Totals {
        requirements: u(t, "requirements"),
        ..Totals::default()
    };
    for side in ["fr", "nfr"] {
        let c = &t[side];
        out.covered += u(c, "covered");
        out.partial += u(c, "partial");
        out.gap += u(c, "gap");
        out.clarification_needed += u(c, "clarification_needed");
        out.not_assessed += u(c, "not_assessed");
    }
    if out.requirements == 0 {
        out.requirements = report["requirements"]
            .as_array()
            .map_or(0, |r| u32::try_from(r.len()).unwrap_or(u32::MAX));
    }
    out
}

/// What Studio offers for a requirement with this coverage and these
/// candidates.
pub fn action_of(coverage: &str, candidates: &[Candidate]) -> &'static str {
    match coverage {
        "covered" | "partial" if candidates.iter().any(|c| c.proposed) => ACTION_PROPOSE,
        "covered" | "partial" => ACTION_REVIEW,
        "gap" => ACTION_CREATE_GEAR,
        "clarification_needed" => ACTION_ANSWER,
        "not_assessed" => ACTION_RERUN,
        _ => ACTION_NONE,
    }
}

/// The gear's name as a product picks it: the id after its repository.
pub fn pick_of(gear_id: &str) -> String {
    gear_id
        .rsplit_once('/')
        .map_or(gear_id, |(_, name)| name)
        .to_owned()
}

/// The report's gear lists by gear id: `(list, name, in_code)`.
fn listed(report: &Value) -> BTreeMap<String, (&'static str, String, Option<bool>)> {
    let mut out = BTreeMap::new();
    for (key, label) in [
        ("recommended_gears", "recommended"),
        ("also_possible", "also_possible"),
        ("future_parts", "future_part"),
    ] {
        for g in report[key].as_array().into_iter().flatten() {
            let id = s(g, "gear_id");
            if id.is_empty() || out.contains_key(&id) {
                continue;
            }
            let in_code = g.get("in_code").and_then(Value::as_bool);
            out.insert(id, (label, s(g, "name"), in_code));
        }
    }
    out
}

/// The requirements of `report`, each with its candidates, Studio's action
/// and its passage in `docs` (`(project path, text sent)`).
pub fn requirements(report: &Value, docs: &[(String, String)]) -> Vec<Requirement> {
    let lists = listed(report);
    report["requirements"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|r| {
            let coverage = s(r, "coverage");
            let mut candidates: Vec<Candidate> = r["gears"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|g| {
                    let gear_id = s(g, "gear_id");
                    let listed = lists.get(&gear_id);
                    let in_code = listed.and_then(|(_, _, c)| *c);
                    let verdict = s(g, "verdict");
                    let proposed =
                        matches!(verdict.as_str(), "covered" | "partial") && in_code != Some(false);
                    Candidate {
                        pick: pick_of(&gear_id),
                        name: listed.map(|(_, n, _)| n.clone()).filter(|n| !n.is_empty()),
                        listed: listed.map(|(l, _, _)| (*l).to_owned()),
                        verdict,
                        confidence: g.get("confidence").and_then(Value::as_f64),
                        role: s(g, "role"),
                        evidence: s(g, "evidence"),
                        covers: s(g, "covers"),
                        missing: s(g, "missing"),
                        rationale: s(g, "rationale"),
                        in_code,
                        proposed,
                        gear_id,
                    }
                })
                .collect();
            // Proposed first, then by the matcher's own role and confidence.
            candidates.sort_by(|a, b| {
                b.proposed
                    .cmp(&a.proposed)
                    .then_with(|| role_rank(&a.role).cmp(&role_rank(&b.role)))
                    .then_with(|| {
                        b.confidence
                            .unwrap_or(0.0)
                            .total_cmp(&a.confidence.unwrap_or(0.0))
                    })
            });
            let id = s(r, "requirement_id");
            Requirement {
                action: action_of(&coverage, &candidates).to_owned(),
                passage: passage(docs, &id),
                kind: s(r, "kind"),
                confidence: r.get("confidence").and_then(Value::as_f64),
                low_confidence: b(r, "low_confidence"),
                planned: b(r, "planned"),
                extracted: b(r, "extracted"),
                reason: s(r, "reason"),
                gear_provides: s(r, "gear_provides"),
                remaining_work: s(r, "remaining_work"),
                requirement_id: id,
                coverage,
                candidates,
            }
        })
        .collect()
}

fn role_rank(role: &str) -> u8 {
    match role {
        "chosen" => 0,
        "alternative" => 1,
        _ => 2,
    }
}

/// A question's id when it is the report's own: `c-` and a hash of it.
pub fn general_question_id(topic: &str, quote: &str, path: &str) -> String {
    let h = sha256_hex(&format!("{topic}\u{1f}{quote}\u{1f}{path}"));
    format!("c-{}", &h[..12])
}

/// The questions a report asks: each requirement it could not decide, then
/// its own clarifications. `project_path` maps a matcher path back.
pub fn questions(
    report: &Value,
    requirements: &[Requirement],
    project_path: impl Fn(&str) -> Option<String>,
) -> Vec<Question> {
    let mut out: Vec<Question> = requirements
        .iter()
        .filter(|r| r.coverage == "clarification_needed")
        .map(|r| Question {
            id: r.requirement_id.clone(),
            requirement_id: Some(r.requirement_id.clone()),
            topic: r.requirement_id.clone(),
            reason: r.reason.clone(),
            quote: r.passage.as_ref().map(|p| p.text.clone()),
            path: r.passage.as_ref().map(|p| p.path.clone()),
        })
        .collect();
    let mut seen: BTreeSet<String> = out.iter().map(|q| q.id.clone()).collect();
    for c in report["clarifications"].as_array().into_iter().flatten() {
        let (topic, quote, path) = (s(c, "topic"), s(c, "quote"), s(c, "path"));
        let id = general_question_id(&topic, &quote, &path);
        if !seen.insert(id.clone()) {
            continue;
        }
        out.push(Question {
            id,
            requirement_id: None,
            reason: s(c, "reason"),
            quote: (!quote.is_empty()).then_some(quote),
            path: project_path(&path).or_else(|| (!path.is_empty()).then_some(path)),
            topic,
        });
    }
    out
}

/// How one requirement moved between two runs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Change {
    pub requirement_id: String,
    /// Its coverage in the earlier run; `None` when it was not there.
    pub before: Option<String>,
    pub after: Option<String>,
    /// The gears proposed for it in each run.
    pub gears_before: Vec<String>,
    pub gears_after: Vec<String>,
}

/// What changed from `base` to `head`, and how many requirements did not.
pub fn diff(base: &[Requirement], head: &[Requirement]) -> (Vec<Change>, u32) {
    let proposed = |r: &Requirement| -> Vec<String> {
        let mut g: Vec<String> = r
            .candidates
            .iter()
            .filter(|c| c.proposed)
            .map(|c| c.gear_id.clone())
            .collect();
        g.sort();
        g
    };
    let before: BTreeMap<&str, &Requirement> = base
        .iter()
        .map(|r| (r.requirement_id.as_str(), r))
        .collect();
    let after: BTreeMap<&str, &Requirement> = head
        .iter()
        .map(|r| (r.requirement_id.as_str(), r))
        .collect();
    let ids: BTreeSet<&str> = before.keys().chain(after.keys()).copied().collect();
    let mut changes = Vec::new();
    let mut same = 0u32;
    for id in ids {
        let (b, a) = (before.get(id), after.get(id));
        let change = Change {
            requirement_id: id.to_owned(),
            before: b.map(|r| r.coverage.clone()),
            after: a.map(|r| r.coverage.clone()),
            gears_before: b.map(|r| proposed(r)).unwrap_or_default(),
            gears_after: a.map(|r| proposed(r)).unwrap_or_default(),
        };
        if change.before == change.after && change.gears_before == change.gears_after {
            same += 1;
        } else {
            changes.push(change);
        }
    }
    (changes, same)
}

#[cfg(test)]
#[path = "report_tests.rs"]
mod tests;
