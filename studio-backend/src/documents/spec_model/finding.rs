//! A problem found in a project's documents: the shape every rule answers
//! with, and its fingerprint.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// One passage a finding rests on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Side {
    pub path: String,
    /// The first and last line, from 1. Absent when the side is a whole
    /// document (the record a citation could mean).
    pub line_start: Option<usize>,
    pub line_end: Option<usize>,
    /// The passage, verbatim; a document's title when the side is the whole
    /// document.
    pub quote: Option<String>,
}

impl Side {
    /// One line of a document.
    pub fn at(path: &str, line: usize, text: &str) -> Self {
        Self {
            path: path.to_string(),
            line_start: Some(line),
            line_end: Some(line),
            quote: Some(text.trim().to_string()),
        }
    }

    /// A whole document, by its title when it has one.
    pub fn file(path: &str, title: Option<&str>) -> Self {
        Self {
            path: path.to_string(),
            line_start: None,
            line_end: None,
            quote: title.map(str::to_string),
        }
    }
}

/// A finding, in the words the spec-findings pipeline uses
/// (`docs/spec-findings.md`), with every side instead of an anchor and its
/// related passages.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Finding {
    /// Stable across re-runs and line shifts: the rule, the message and every
    /// side's path and passage, never a line number.
    pub fingerprint: String,
    pub rule: String,
    /// `high`, `medium` or `low`.
    pub severity: String,
    pub message: String,
    pub sides: Vec<Side>,
    /// The decision a person has to take when the documents cannot tell
    /// which side is right: one choice per entry. Empty when there is none.
    pub decide: Vec<String>,
    /// The smallest edit that fixes it, when the documents show which side
    /// is right.
    #[serde(default)]
    pub edit: Option<Edit>,
}

/// Replace `replace` with `with` in `path`; `replace` is checked to be in
/// the document before an edit is offered.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Edit {
    pub path: String,
    pub replace: String,
    pub with: String,
}

impl Finding {
    pub fn new(rule: &str, severity: &str, message: String, sides: Vec<Side>) -> Self {
        let fingerprint = fingerprint(rule, &message, &sides);
        Self {
            fingerprint,
            rule: rule.to_string(),
            severity: severity.to_string(),
            message,
            sides,
            decide: Vec::new(),
            edit: None,
        }
    }

    /// Fingerprinted by the rule and the message alone, for a finding about
    /// one missing thing wherever it is cited: a new citation is not a new
    /// finding.
    pub fn keyed_by_message(mut self) -> Self {
        self.fingerprint = fingerprint(&self.rule, &self.message, &[]);
        self
    }

    /// Fingerprinted by its sides alone, for a finding a model worded: the
    /// same two passages are the same finding however it is explained.
    pub fn keyed_by_sides(mut self) -> Self {
        self.fingerprint = fingerprint("", "", &self.sides);
        self
    }

    pub fn with_fix_decide(mut self, options: &[&str]) -> Self {
        self.decide = options.iter().map(|o| (*o).to_string()).collect();
        self
    }
}

/// Whitespace collapsed, so a re-wrapped paragraph keeps its fingerprint.
fn normalised(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn fingerprint(rule: &str, message: &str, sides: &[Side]) -> String {
    let mut parts: Vec<String> = sides
        .iter()
        .map(|s| {
            format!(
                "{}\u{1f}{}",
                s.path,
                normalised(s.quote.as_deref().unwrap_or(""))
            )
        })
        .collect();
    parts.sort();
    let mut hasher = Sha256::new();
    hasher.update(rule.as_bytes());
    hasher.update([0x1e]);
    hasher.update(normalised(message).as_bytes());
    for part in parts {
        hasher.update([0x1e]);
        hasher.update(part.as_bytes());
    }
    hex::encode(&hasher.finalize()[..12])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fingerprint_ignores_lines_and_wrapping_but_not_the_passage() {
        let a = Finding::new(
            "r",
            "high",
            "m".into(),
            vec![Side::at("a.md", 3, "one  two")],
        );
        let moved = Finding::new(
            "r",
            "high",
            "m".into(),
            vec![Side::at("a.md", 40, "one two")],
        );
        let other = Finding::new(
            "r",
            "high",
            "m".into(),
            vec![Side::at("a.md", 3, "one three")],
        );
        assert_eq!(a.fingerprint, moved.fingerprint);
        assert_ne!(a.fingerprint, other.fingerprint);
    }

    #[test]
    fn a_fingerprint_does_not_depend_on_the_order_of_sides() {
        let x = Side::at("a.md", 1, "x");
        let y = Side::at("b.md", 1, "y");
        let ab = Finding::new("r", "high", "m".into(), vec![x.clone(), y.clone()]);
        let ba = Finding::new("r", "high", "m".into(), vec![y, x]);
        assert_eq!(ab.fingerprint, ba.fingerprint);
    }
}
