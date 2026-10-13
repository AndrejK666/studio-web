//! The work against the documents: which issues, pull requests and commits
//! name an identifier the project's documents define (`docs/project-and-product.md`,
//! "The links", work → requirement).
//!
//! Mechanical only: a piece of work is linked to an identifier when its title
//! or text names it, as a whole token. No model proposes a link here; a
//! proposed link for work that names nothing is a later step, decided by a
//! member like a finding.

use std::collections::BTreeMap;

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
    for (i, item) in work.iter().enumerate() {
        let text = format!("{}\n{}", item.title, item.text).to_ascii_lowercase();
        let mut named = false;
        for id in ids.keys() {
            if names(&text, id) {
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
    let id = id.to_ascii_lowercase();
    let part = |c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_';
    let mut from = 0;
    while let Some(at) = text[from..].find(&id) {
        let start = from + at;
        let end = start + id.len();
        let before = text[..start].chars().next_back();
        let after = text[end..].chars().next();
        if !before.is_some_and(part) && !after.is_some_and(part) {
            return true;
        }
        from = start + 1;
        while !text.is_char_boundary(from) {
            from += 1;
        }
    }
    false
}

#[cfg(test)]
#[path = "work_tests.rs"]
mod tests;
