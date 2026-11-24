//! Where a GitLab merge request stands in review: who still owes one, what
//! each reviewer last said, and how many discussions are still open.
//!
//! GitLab records a review's verdicts as **system notes** on the merge
//! request, each with its actor and its instant: "approved this merge
//! request", "unapproved this merge request", "requested changes",
//! "requested review from @a and @b", "removed review request for @a".
//! Insight reads the review history from them, and so does this: the
//! `/approvals` endpoint names only the current approvers, with no time, and
//! answers 402 on an edition that is not licensed for it, so it is an
//! optional extra here (an approval it lists that no note recorded), never
//! the source.
//!
//! The fold mirrors GitHub's reading, so the people view treats both hosts
//! alike: an approval or a request for changes is what a reviewer last
//! decided, and a later comment does not undo it; answering in any way takes
//! a reviewer off the "still owed" list, and asking again puts them back. The
//! author's own notes are not reviews.

use std::collections::BTreeMap;

use super::super::driver::RemoteReview;
use super::model::{Discussion, Note};

/// One merge request's review, as [`fold`] reads it.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct ReviewState {
    /// Discussions with a resolvable note nobody has resolved.
    pub open_threads: usize,
    /// Discussions with a resolvable note at all.
    pub total_threads: usize,
    /// Each reviewer's last word, one per login.
    pub reviews: Vec<RemoteReview>,
    /// Of the reviewers GitLab lists, the ones who have not answered since
    /// they were last asked.
    pub owed: Vec<String>,
}

#[derive(Default)]
struct Standing {
    login: String,
    verdict: Option<&'static str>,
    commented: bool,
    /// `None` until an event says: a listed reviewer with no event is owed.
    asked: Option<bool>,
}

/// The logins a system note names (`@a, @b and @c`).
fn mentioned(body: &str) -> Vec<String> {
    body.split_whitespace()
        .filter_map(|w| w.strip_prefix('@'))
        .map(|w| w.trim_end_matches([',', '.', ';', ':']).to_owned())
        .filter(|w| !w.is_empty())
        .collect()
}

/// The standing of `login`, made on first sight; `None` for the author,
/// whose own notes are not reviews.
fn standing<'a>(
    people: &'a mut BTreeMap<String, Standing>,
    author: Option<&str>,
    login: &str,
) -> Option<&'a mut Standing> {
    let login = login.trim();
    if login.is_empty() || author.is_some_and(|a| a.eq_ignore_ascii_case(login)) {
        return None;
    }
    Some(
        people
            .entry(login.to_lowercase())
            .or_insert_with(|| Standing {
                login: login.to_owned(),
                ..Standing::default()
            }),
    )
}

/// Read one merge request's discussions (system notes included) and the
/// current approvers `/approvals` named, if it was asked.
pub(super) fn fold(
    author: Option<&str>,
    reviewers: &[String],
    discussions: &[Discussion],
    approved_by: &[String],
) -> ReviewState {
    let mut state = ReviewState::default();
    let mut people: BTreeMap<String, Standing> = BTreeMap::new();

    for d in discussions {
        if d.notes.iter().any(|n| n.resolvable) {
            state.total_threads += 1;
            if d.notes
                .iter()
                .any(|n| n.resolvable && n.resolved != Some(true))
            {
                state.open_threads += 1;
            }
        }
    }

    // In the order they were written: note ids only ever grow.
    let mut notes: Vec<&Note> = discussions.iter().flat_map(|d| d.notes.iter()).collect();
    notes.sort_by_key(|n| n.id);
    for note in notes {
        let body = note.body.as_deref().unwrap_or_default().trim();
        if note.system {
            let lower = body.to_lowercase();
            if lower.starts_with("requested review from") {
                for login in mentioned(body) {
                    if let Some(s) = standing(&mut people, author, &login) {
                        s.asked = Some(true);
                    }
                }
                continue;
            }
            if lower.starts_with("removed review request for") {
                for login in mentioned(body) {
                    if let Some(s) = standing(&mut people, author, &login) {
                        s.asked = Some(false);
                    }
                }
                continue;
            }
            let Some(actor) = note.author_login() else {
                continue;
            };
            let Some(s) = standing(&mut people, author, &actor) else {
                continue;
            };
            if lower == "approved this merge request" {
                s.verdict = Some("approved");
                s.asked = Some(false);
            } else if lower == "unapproved this merge request" {
                if s.verdict == Some("approved") {
                    s.verdict = None;
                }
            } else if lower.starts_with("requested changes") {
                s.verdict = Some("changes_requested");
                s.asked = Some(false);
            }
            continue;
        }
        let Some(actor) = note.author_login() else {
            continue;
        };
        if let Some(s) = standing(&mut people, author, &actor) {
            s.commented = true;
            s.asked = Some(false);
        }
    }

    for login in approved_by {
        if let Some(s) = standing(&mut people, author, login)
            && s.verdict.is_none()
        {
            s.verdict = Some("approved");
            s.asked = Some(false);
        }
    }

    state.owed = reviewers
        .iter()
        .filter(|r| {
            people
                .get(&r.trim().to_lowercase())
                .is_none_or(|s| s.asked != Some(false))
        })
        .cloned()
        .collect();
    state.reviews = people
        .into_values()
        .filter_map(|s| {
            let verdict = s.verdict.or(s.commented.then_some("commented"))?;
            Some(RemoteReview {
                login: s.login,
                state: verdict.to_owned(),
            })
        })
        .collect();
    state
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(id: i64, who: &str, body: &str, system: bool) -> Note {
        serde_json::from_value(serde_json::json!({
            "id": id, "body": body, "system": system, "author": { "username": who }
        }))
        .unwrap()
    }

    fn one(notes: Vec<Note>) -> Vec<Discussion> {
        notes
            .into_iter()
            .map(|n| Discussion { notes: vec![n] })
            .collect()
    }

    fn logins(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).to_owned()).collect()
    }

    fn reviews(state: &ReviewState) -> Vec<(&str, &str)> {
        state
            .reviews
            .iter()
            .map(|r| (r.login.as_str(), r.state.as_str()))
            .collect()
    }

    #[test]
    fn an_approval_outweighs_a_later_comment_and_answers_the_request() {
        let state = fold(
            Some("ada"),
            &logins(&["bob", "carol"]),
            &one(vec![
                note(1, "ada", "requested review from @bob and @carol", true),
                note(2, "bob", "approved this merge request", true),
                note(3, "bob", "Nit: rename this", false),
                note(4, "ada", "Done", false),
            ]),
            &[],
        );
        assert_eq!(reviews(&state), [("bob", "approved")]);
        assert_eq!(state.owed, logins(&["carol"]));
    }

    #[test]
    fn a_withdrawn_approval_falls_back_and_asking_again_makes_it_owed() {
        let state = fold(
            Some("ada"),
            &logins(&["bob"]),
            &one(vec![
                note(1, "bob", "approved this merge request", true),
                note(2, "bob", "unapproved this merge request", true),
                note(3, "ada", "requested review from @bob", true),
            ]),
            &[],
        );
        assert!(reviews(&state).is_empty());
        assert_eq!(state.owed, logins(&["bob"]));
    }

    #[test]
    fn changes_requested_and_a_comment_are_both_answers() {
        let state = fold(
            Some("ada"),
            &logins(&["bob", "carol", "dan"]),
            &one(vec![
                note(1, "bob", "requested changes", true),
                note(2, "carol", "Why?", false),
                note(3, "ada", "removed review request for @dan", true),
            ]),
            &[],
        );
        assert_eq!(
            reviews(&state),
            [("bob", "changes_requested"), ("carol", "commented")]
        );
        assert!(state.owed.is_empty());
    }

    #[test]
    fn an_approval_only_the_approvals_endpoint_knows_still_counts() {
        let state = fold(
            Some("ada"),
            &logins(&["bob"]),
            &[],
            &logins(&["bob", "ada"]),
        );
        assert_eq!(reviews(&state), [("bob", "approved")]);
        assert!(state.owed.is_empty());
    }

    #[test]
    fn only_unresolved_resolvable_discussions_are_open() {
        let thread = |resolved: Option<bool>| -> Note {
            serde_json::from_value(serde_json::json!({
                "id": 9, "body": "x", "resolvable": true, "resolved": resolved,
                "author": { "username": "bob" }
            }))
            .unwrap()
        };
        let discussions = vec![
            Discussion {
                notes: vec![thread(Some(true))],
            },
            Discussion {
                notes: vec![thread(Some(false))],
            },
            Discussion {
                notes: vec![note(1, "bob", "plain comment", false)],
            },
        ];
        let state = fold(None, &[], &discussions, &[]);
        assert_eq!((state.open_threads, state.total_threads), (1, 2));
    }
}
