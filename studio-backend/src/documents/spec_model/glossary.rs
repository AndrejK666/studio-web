//! The project's glossary: one entry per thing its documents name, with the
//! name the project uses for it and the other names that mean the same
//! (`docs/project-and-product.md`, "The project's words").
//!
//! The entries are proposed without a model, from the merged subjects of the
//! facts: every spelling that folds to one key is one entry. Members decide
//! the rest, because only they know which renames are deliberate: the name an
//! entry goes by, and which entry is another name of which. The decided
//! glossary is input to the rules, not a rule: facts about an alias count as
//! facts about the entry it is an alias of.

use std::collections::{BTreeMap, BTreeSet};

use super::extract::Fact;
use super::rules::subject_key;

/// A member's decision on one entry, by its key.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Choice {
    pub key: String,
    /// The name the project uses, in place of the most frequent spelling.
    pub name: Option<String>,
    /// The key of the entry this one is another name of.
    pub alias_of: Option<String>,
}

/// One name merged into an entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Alias {
    pub key: String,
    /// Its most frequent spelling.
    pub name: String,
}

/// One entry of the glossary.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub key: String,
    /// The chosen name, or the most frequent spelling.
    pub name: String,
    /// Whether a member chose `name`.
    pub chosen: bool,
    /// Every spelling of the entry and its aliases, most frequent first.
    pub spellings: Vec<String>,
    pub aliases: Vec<Alias>,
    pub facts: usize,
    pub documents: usize,
}

struct Group<'a> {
    spellings: BTreeMap<&'a str, usize>,
    facts: Vec<&'a Fact>,
}

/// The facts grouped by subject key; a subject only ever a decision is not a
/// thing the application has, and is left out, as the Entities view does.
fn groups(facts: &[Fact]) -> BTreeMap<String, Group<'_>> {
    let mut out: BTreeMap<String, Group<'_>> = BTreeMap::new();
    for fact in facts {
        let key = subject_key(&fact.subject);
        if key.is_empty() {
            continue;
        }
        let group = out.entry(key).or_insert_with(|| Group {
            spellings: BTreeMap::new(),
            facts: Vec::new(),
        });
        *group.spellings.entry(fact.subject.as_str()).or_default() += 1;
        group.facts.push(fact);
    }
    out.retain(|_, g| g.facts.iter().any(|f| f.kind != "decision"));
    out
}

fn most_frequent<'a>(spellings: &BTreeMap<&'a str, usize>) -> Vec<&'a str> {
    let mut all: Vec<(&str, usize)> = spellings.iter().map(|(s, n)| (*s, *n)).collect();
    all.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    all.into_iter().map(|(s, _)| s).collect()
}

/// Which entry each key belongs to. An alias of a key the documents no longer
/// name, of itself, or of a key that is an alias in turn holds nothing: one
/// level only, so that undoing one merge never moves a third entry.
pub fn canonical(present: &BTreeSet<&str>, choices: &[Choice]) -> BTreeMap<String, String> {
    let alias_of: BTreeMap<&str, &str> = choices
        .iter()
        .filter_map(|c| Some((c.key.as_str(), c.alias_of.as_deref()?)))
        .filter(|(k, target)| k != target && present.contains(k) && present.contains(target))
        .collect();
    present
        .iter()
        .map(|k| {
            let to = match alias_of.get(k) {
                Some(target) if !alias_of.contains_key(target) => *target,
                _ => *k,
            };
            ((*k).to_string(), to.to_string())
        })
        .collect()
}

/// The glossary of `facts` under the members' `choices`, the most described
/// entry first.
pub fn entries(facts: &[Fact], choices: &[Choice]) -> Vec<Entry> {
    let groups = groups(facts);
    let present: BTreeSet<&str> = groups.keys().map(String::as_str).collect();
    let to = canonical(&present, choices);
    let named: BTreeMap<&str, &str> = choices
        .iter()
        .filter_map(|c| {
            let name = c.name.as_deref()?.trim();
            (!name.is_empty()).then_some((c.key.as_str(), name))
        })
        .collect();

    let mut members: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for (key, target) in &to {
        if key != target {
            members
                .entry(target.as_str())
                .or_default()
                .push(key.as_str());
        }
    }
    let mut out = Vec::new();
    for (key, group) in &groups {
        if to.get(key).is_some_and(|t| t != key) {
            continue;
        }
        let aliases: Vec<&str> = members.get(key.as_str()).cloned().unwrap_or_default();
        let mut spellings = group.spellings.clone();
        let mut all_facts: Vec<&Fact> = group.facts.clone();
        let mut alias_list = Vec::new();
        for alias in &aliases {
            let other = &groups[*alias];
            for (s, n) in &other.spellings {
                *spellings.entry(s).or_default() += n;
            }
            all_facts.extend(other.facts.iter().copied());
            alias_list.push(Alias {
                key: (*alias).to_string(),
                name: named.get(alias).map_or_else(
                    || most_frequent(&other.spellings)[0].to_string(),
                    |n| (*n).to_string(),
                ),
            });
        }
        let ordered = most_frequent(&spellings);
        let (name, chosen) = match named.get(key.as_str()) {
            Some(n) => ((*n).to_string(), true),
            None => (most_frequent(&group.spellings)[0].to_string(), false),
        };
        out.push(Entry {
            key: key.clone(),
            name,
            chosen,
            spellings: ordered.into_iter().map(str::to_string).collect(),
            aliases: alias_list,
            facts: all_facts.len(),
            documents: all_facts
                .iter()
                .map(|f| f.path.as_str())
                .collect::<BTreeSet<_>>()
                .len(),
        });
    }
    out.sort_by(|a, b| b.facts.cmp(&a.facts).then(a.name.cmp(&b.name)));
    out
}

/// The facts with every alias's subject replaced by a spelling of its entry,
/// so that the rules group a thing's facts under one subject whatever the
/// document called it. The spelling is one the documents use, not the chosen
/// name, which may fold to another key. A fact's passage, path and lines are
/// untouched, and so are the fingerprints of the candidates built from it.
pub fn apply(facts: &[Fact], choices: &[Choice]) -> Vec<Fact> {
    if choices.iter().all(|c| c.alias_of.is_none()) {
        return facts.to_vec();
    }
    let groups = groups(facts);
    let present: BTreeSet<&str> = groups.keys().map(String::as_str).collect();
    let renamed: BTreeMap<String, String> = canonical(&present, choices)
        .into_iter()
        .filter(|(key, target)| key != target)
        .map(|(key, target)| {
            let spelling = most_frequent(&groups[&target].spellings)[0].to_string();
            (key, spelling)
        })
        .collect();
    facts
        .iter()
        .map(|f| match renamed.get(&subject_key(&f.subject)) {
            Some(name) => Fact {
                subject: name.clone(),
                ..f.clone()
            },
            None => f.clone(),
        })
        .collect()
}

#[cfg(test)]
#[path = "glossary_tests.rs"]
mod tests;
