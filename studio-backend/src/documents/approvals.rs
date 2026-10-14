//! Review requests on a project's documents and the approvals given on them
//! (`docs/design/studio-documents.md`, "Reviews and approvals").
//!
//! A request names one version of one document, the people asked to review
//! it, which of them are required, and when it is due. An approval is a
//! record of one person's verdict on that version, kept as written and never
//! edited: a later verdict is another record. Everything here is the pure
//! part — who is still awaited, whether it is late, whom to suggest — so the
//! gate and the inbox read the same answer.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

/// One person asked to review.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reviewer {
    /// Canonical person id (ADR-0025).
    pub person: String,
    #[serde(default)]
    pub name: Option<String>,
    /// The request is not approved until every required reviewer approves.
    #[serde(default = "yes")]
    pub required: bool,
}

fn yes() -> bool {
    true
}

/// `approved`, or `changes_requested`.
pub const VERDICTS: [&str; 2] = ["approved", "changes_requested"];

/// One verdict as it was recorded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Verdict {
    pub approver: String,
    pub verdict: String,
    pub decided_at: OffsetDateTime,
}

/// Each reviewer's latest verdict, by person.
fn latest(verdicts: &[Verdict]) -> BTreeMap<&str, &Verdict> {
    let mut out: BTreeMap<&str, &Verdict> = BTreeMap::new();
    for v in verdicts {
        match out.get(v.approver.as_str()) {
            Some(prev) if prev.decided_at > v.decided_at => {}
            _ => {
                out.insert(v.approver.as_str(), v);
            }
        }
    }
    out
}

/// The required reviewers whose latest verdict is not an approval: what keeps
/// the request, and the stage gated on it, open.
pub fn outstanding<'r>(reviewers: &'r [Reviewer], verdicts: &[Verdict]) -> Vec<&'r Reviewer> {
    let latest = latest(verdicts);
    reviewers
        .iter()
        .filter(|r| r.required)
        .filter(|r| {
            latest
                .get(r.person.as_str())
                .is_none_or(|v| v.verdict != "approved")
        })
        .collect()
}

/// The reviewers who have given no verdict yet, required or not: whose
/// action the request waits on.
pub fn awaiting<'r>(reviewers: &'r [Reviewer], verdicts: &[Verdict]) -> Vec<&'r Reviewer> {
    let latest = latest(verdicts);
    reviewers
        .iter()
        .filter(|r| !latest.contains_key(r.person.as_str()))
        .collect()
}

/// Whether every required reviewer approved. A request with no required
/// reviewer is approved by its first approval.
pub fn approved(reviewers: &[Reviewer], verdicts: &[Verdict]) -> bool {
    if reviewers.iter().any(|r| r.required) {
        outstanding(reviewers, verdicts).is_empty()
    } else {
        latest(verdicts).values().any(|v| v.verdict == "approved")
    }
}

/// Past its due date with somebody still awaited.
pub fn overdue(
    due_at: Option<OffsetDateTime>,
    reviewers: &[Reviewer],
    verdicts: &[Verdict],
    now: OffsetDateTime,
) -> bool {
    due_at.is_some_and(|due| due < now) && !approved(reviewers, verdicts)
}

/// One earlier request, as a suggestion reads it.
pub struct Earlier<'a> {
    pub subject_id: &'a str,
    pub type_key: Option<&'a str>,
    pub reviewers: &'a [Reviewer],
}

/// Whom to ask, from who was asked before in this project: the reviewers of
/// this very document first, then of documents of its type, each ranked by
/// how often they were asked; never the requester. Required if they were
/// required the last time they were asked.
pub fn suggest(
    earlier: &[Earlier<'_>],
    subject_id: &str,
    type_key: Option<&str>,
    requester: &str,
    limit: usize,
) -> Vec<Reviewer> {
    // (rank: 0 same document, 1 same type), count, the last entry seen.
    let mut seen: BTreeMap<String, (u8, usize, Reviewer)> = BTreeMap::new();
    for e in earlier {
        let rank = if e.subject_id == subject_id {
            0
        } else if type_key.is_some() && e.type_key == type_key {
            1
        } else {
            continue;
        };
        for r in e.reviewers {
            if r.person == requester {
                continue;
            }
            let entry = seen
                .entry(r.person.clone())
                .or_insert_with(|| (rank, 0, r.clone()));
            entry.0 = entry.0.min(rank);
            entry.1 += 1;
            entry.2 = Reviewer {
                person: r.person.clone(),
                name: r.name.clone().or(entry.2.name.clone()),
                required: r.required,
            };
        }
    }
    let mut out: Vec<(u8, usize, Reviewer)> = seen.into_values().collect();
    out.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then(b.1.cmp(&a.1))
            .then(a.2.person.cmp(&b.2.person))
    });
    out.into_iter().take(limit).map(|(_, _, r)| r).collect()
}

#[cfg(test)]
#[path = "approvals_tests.rs"]
mod tests;
