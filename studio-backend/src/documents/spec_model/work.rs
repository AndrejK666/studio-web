//! The work against the documents: which issues, pull requests and commits
//! name an identifier the project's documents define (`docs/project-and-product.md`,
//! "The links", work → requirement).
//!
//! Mechanical only: a piece of work is linked to an identifier when its title
//! or text names it, as a whole token. No model proposes a link here; a
//! proposed link for work that names nothing is a later step, decided by a
//! member like a finding.

use std::collections::{BTreeMap, HashSet};

use super::finding::Side;
use crate::artifact_ingest::port::WorkItem;

/// One identifier and the work that names it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Linked {
    pub id: String,
    /// Where the documents define it.
    pub defined: Vec<Side>,
    /// Indexes into the work given to [`link`], issues and pull requests
    /// before commits, newest number first.
    pub work: Vec<usize>,
}

/// Every identifier in `ids` that some work names, with that work, in the
/// identifiers' order; and how many pieces of work name none.
pub fn link(ids: &BTreeMap<String, Vec<Side>>, work: &[WorkItem]) -> (Vec<Linked>, usize) {
    let mut by_id: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    let mut unlinked = 0;
    // Each id lower-cased once, not once per piece of work. An id made of
    // token characters alone is named exactly when it is one of the text's
    // tokens, so it is looked up in the item's token set; any other id is
    // searched for the slow way.
    let wanted: Vec<(&String, String, bool)> = ids
        .keys()
        .map(|id| {
            let lower = id.to_ascii_lowercase();
            let token = is_token(&lower);
            (id, lower, token)
        })
        .collect();
    for (i, item) in work.iter().enumerate() {
        let mut text = String::with_capacity(item.title.len() + 1 + item.text.len());
        text.push_str(&item.title);
        text.push('\n');
        text.push_str(&item.text);
        text.make_ascii_lowercase();
        let tokens: HashSet<&str> = text.split(|c: char| !is_part(c)).collect();
        let mut named = false;
        for (id, lower, token) in &wanted {
            let found = if *token {
                tokens.contains(lower.as_str())
            } else {
                named_at(&text, lower).is_some()
            };
            if found {
                by_id.entry(id.as_str()).or_default().push(i);
                named = true;
            }
        }
        if !named {
            unlinked += 1;
        }
    }
    let linked = by_id
        .into_iter()
        .map(|(id, mut items)| {
            items.sort_by_key(|&i| {
                let w = &work[i];
                (w.kind == "commit", std::cmp::Reverse(w.number))
            });
            Linked {
                id: id.to_string(),
                defined: ids[id].clone(),
                work: items,
            }
        })
        .collect();
    (linked, unlinked)
}

/// Whether `text` (lower-cased) names `id` as a whole token: no letter, digit,
/// `-` or `_` on either side, so `cpt-x-fr-1` is not found inside
/// `cpt-x-fr-12` or `cpt-x-fr-1-draft`.
pub(super) fn names(text: &str, id: &str) -> bool {
    named_at(text, &id.to_ascii_lowercase()).is_some()
}

/// Where [`names`] first finds `id` (already lower-cased) in `text`, as a
/// byte offset.
pub(super) fn named_at(text: &str, id: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(at) = text[from..].find(id) {
        let start = from + at;
        let end = start + id.len();
        let before = text[..start].chars().next_back();
        let after = text[end..].chars().next();
        if !before.is_some_and(is_part) && !after.is_some_and(is_part) {
            return Some(start);
        }
        from = start + 1;
        while !text.is_char_boundary(from) {
            from += 1;
        }
    }
    None
}

/// What a token is made of, as [`names`] reads a whole token.
pub(super) fn is_part(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_'
}

/// An id [`names`] can only find as one whole token, so finding it is
/// looking it up among the text's tokens.
pub(super) fn is_token(id: &str) -> bool {
    !id.is_empty() && id.chars().all(is_part)
}

#[cfg(test)]
#[path = "work_tests.rs"]
mod tests;
