//! The one resolver of references (ADR-0047 §3).
//!
//! A change request names the work items it closes, and anything may name
//! another item, in text: `Closes #42`, `see group/repo#7`, a link to an
//! issue. Every host writes these its own way, so each driver says which
//! [`ReferenceSyntax`] its text uses, and this module turns text into
//! [`Mention`]s, the provider-neutral form the artifact graph links by.
//!
//! Only what the text says is read: a mention inside a code block or a code
//! span is not a mention, and a number nobody can place stays a mention the
//! ingest leaves without an edge.

/// How a provider's text names an item.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReferenceSyntax {
    /// `#42`, `owner/repo#42` and links to `…/issues/42`, `…/pull/42` or
    /// `…/merge_requests/42`: the git hosts.
    Numbered,
    /// The provider's text names nothing Studio can place.
    None,
}

/// What a mention says about its target.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Relation {
    /// The mentioning change request, once merged, closes the target: the
    /// target follows a closing keyword (`Closes`, `Fixes`, `Resolves`).
    Closes,
    /// Any other mention.
    References,
}

impl Relation {
    pub fn as_str(self) -> &'static str {
        match self {
            Relation::Closes => "closes",
            Relation::References => "references",
        }
    }
}

/// An item named by its number, in its repository, or in the one the text
/// belongs to when `repo` is `None`.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct NumberRef {
    /// `owner/repo` (or `group/subgroup/repo`), as the text wrote it.
    pub repo: Option<String>,
    pub number: i64,
}

impl NumberRef {
    /// Whether this names an item of `repo_full_path`.
    pub fn is_in(&self, repo_full_path: &str) -> bool {
        self.repo
            .as_deref()
            .is_none_or(|r| r.eq_ignore_ascii_case(repo_full_path))
    }
}

/// One item the text names, and how.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mention {
    pub relation: Relation,
    pub target: NumberRef,
}

/// The words that make the items after them closed by a merge: the ones
/// GitHub and GitLab both act on.
const CLOSING: [&str; 9] = [
    "close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved",
];

/// The items `text` names, each once, in the order first named. An item both
/// closed and referenced is closed.
pub fn find(text: &str, syntax: ReferenceSyntax) -> Vec<Mention> {
    if syntax == ReferenceSyntax::None {
        return Vec::new();
    }
    let mut out: Vec<Mention> = Vec::new();
    let mut push =
        |relation: Relation, target: NumberRef| match out.iter_mut().find(|m| m.target == target) {
            Some(m) => m.relation = m.relation.min(relation),
            None => out.push(Mention { relation, target }),
        };
    let mut fenced = false;
    for line in text.lines() {
        if line.trim_start().starts_with("```") || line.trim_start().starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        // After a closing keyword, every item listed (`#1, #2 and #3`) is
        // closed; any other word ends the list.
        let mut closing = false;
        for token in without_code_spans(line).split_whitespace() {
            let word = token.trim_matches(|c: char| "([{<\"'".contains(c));
            let ends_sentence = word.ends_with(['.', ';', '!', '?']);
            let word = word.trim_end_matches(|c: char| ",.;:!?)]}>\"'".contains(c));
            if CLOSING.contains(&word.to_ascii_lowercase().as_str()) {
                closing = !ends_sentence;
                continue;
            }
            if let Some(target) = number_ref(word) {
                let relation = if closing {
                    Relation::Closes
                } else {
                    Relation::References
                };
                push(relation, target);
                if ends_sentence {
                    closing = false;
                }
                continue;
            }
            if !matches!(word.to_ascii_lowercase().as_str(), "and" | "&" | "") {
                closing = false;
            }
        }
    }
    out
}

/// `line` with every `code span` blanked out.
fn without_code_spans(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut in_code = false;
    for c in line.chars() {
        if c == '`' {
            in_code = !in_code;
            out.push(' ');
        } else if in_code {
            out.push(' ');
        } else {
            out.push(c);
        }
    }
    out
}

/// The item one word names: `#42`, `owner/repo#42`, or a link to one.
fn number_ref(word: &str) -> Option<NumberRef> {
    if word.starts_with("http://") || word.starts_with("https://") {
        return link_ref(word);
    }
    let (repo, number) = word.split_once('#')?;
    let number = digits(number)?;
    if repo.is_empty() {
        return Some(NumberRef { repo: None, number });
    }
    let path_like = repo.contains('/')
        && repo.split('/').all(|seg| {
            !seg.is_empty()
                && seg
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
        });
    path_like.then(|| NumberRef {
        repo: Some(repo.to_string()),
        number,
    })
}

/// The item a link names: `https://host/owner/repo/issues/42`,
/// `…/pull/42`, `…/-/merge_requests/42`. Anything after the number (a
/// fragment, `/files`) does not change which item it is.
fn link_ref(url: &str) -> Option<NumberRef> {
    let rest = url.split_once("://")?.1;
    let rest = rest.split(['?', '#']).next()?;
    let segs: Vec<&str> = rest.split('/').skip(1).collect();
    let at = segs
        .iter()
        .position(|s| matches!(*s, "issues" | "pull" | "pulls" | "merge_requests"))?;
    let number = digits(segs.get(at + 1)?)?;
    let repo: Vec<&str> = segs[..at]
        .iter()
        .copied()
        .filter(|s| *s != "-" && !s.is_empty())
        .collect();
    (repo.len() >= 2).then(|| NumberRef {
        repo: Some(repo.join("/")),
        number,
    })
}

fn digits(s: &str) -> Option<i64> {
    if s.is_empty() || !s.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    s.parse().ok().filter(|n| *n > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local(number: i64) -> NumberRef {
        NumberRef { repo: None, number }
    }

    fn found(text: &str) -> Vec<(Relation, NumberRef)> {
        find(text, ReferenceSyntax::Numbered)
            .into_iter()
            .map(|m| (m.relation, m.target))
            .collect()
    }

    #[test]
    fn a_closing_keyword_closes_every_item_it_lists() {
        assert_eq!(
            found("Closes #853, #854 and #857. Combines #855 and #856."),
            vec![
                (Relation::Closes, local(853)),
                (Relation::Closes, local(854)),
                (Relation::Closes, local(857)),
                (Relation::References, local(855)),
                (Relation::References, local(856)),
            ]
        );
    }

    #[test]
    fn a_keyword_followed_by_other_words_closes_nothing() {
        assert_eq!(
            found("Fix the race in #12"),
            vec![(Relation::References, local(12))]
        );
        assert_eq!(found("fixes: #3"), vec![(Relation::Closes, local(3))]);
    }

    #[test]
    fn an_item_in_another_repository_keeps_its_path() {
        let target = NumberRef {
            repo: Some("constructorfabric/gearbox".into()),
            number: 2,
        };
        assert_eq!(
            found("Resolves constructorfabric/gearbox#2"),
            vec![(Relation::Closes, target.clone())]
        );
        assert!(!target.is_in("constructorfabric/studio-web"));
        assert!(target.is_in("ConstructorFabric/Gearbox"));
        assert!(local(1).is_in("anything/at-all"));
    }

    #[test]
    fn a_link_names_its_item_on_any_host() {
        assert_eq!(
            found(
                "see https://github.com/o/r/pull/7/files and (https://gitlab.example/g/sub/p/-/merge_requests/9#note_1)"
            ),
            vec![
                (
                    Relation::References,
                    NumberRef {
                        repo: Some("o/r".into()),
                        number: 7
                    }
                ),
                (
                    Relation::References,
                    NumberRef {
                        repo: Some("g/sub/p".into()),
                        number: 9
                    }
                ),
            ]
        );
        assert_eq!(
            found("closes https://github.com/o/r/issues/5"),
            vec![(
                Relation::Closes,
                NumberRef {
                    repo: Some("o/r".into()),
                    number: 5
                }
            )]
        );
    }

    #[test]
    fn code_is_not_a_mention() {
        let text = "Fixes `#1` here\n```\ncloses #2\n```\nand #3";
        assert_eq!(found(text), vec![(Relation::References, local(3))]);
    }

    #[test]
    fn closed_wins_over_referenced_and_each_item_comes_once() {
        assert_eq!(
            found("Part of #4. Closes #4. Again #4"),
            vec![(Relation::Closes, local(4))]
        );
    }

    #[test]
    fn what_only_looks_like_a_number_is_not_one() {
        assert!(found("a#1 colour #fff &#38; #0 issue#x foo/#2").is_empty());
        assert!(find("Closes #1", ReferenceSyntax::None).is_empty());
    }
}
