//! The conversation a repository carries in its own files.
//!
//! Studio's IDE writes comment threads beside the document they are anchored
//! to, as append-only per-author logs that are committed with the branch
//! (`theia/product-ext/src/browser/comment-log.js`):
//!
//! ```text
//! .studio/comments/docs/prd.md/oidc-sub-1.jsonl   one party's ops
//! .studio/comments/docs/prd.md/agent-claude.jsonl another party's
//! .studio/comments/docs/prd.md.json               the legacy whole-file sidecar
//! ```
//!
//! That is the right home for them — a thread travels with the branch, shows up
//! in a pull request as a reviewable diff, and needs no database. What it does
//! not give anybody is an answer to "which of this project's documents have a
//! conversation waiting on someone", because answering it means reading every
//! sidecar in the repository, and the portal has no checkout to read.
//!
//! The sync does. It already walks the whole repository with every file's text
//! in hand, which is the one moment that question is cheap. So the count is
//! taken here, exactly as `open_review_threads` is taken for a pull request,
//! and lands on the document's file node.
//!
//! # A count, not a copy
//!
//! Nothing here keeps a message, an author or a quote. The sidecars are the
//! record and they stay the record; a second copy in the graph would be a
//! second version of one conversation, drifting apart on every re-sync, which
//! is the argument `docs/documents-from-a-repository.md` already makes about
//! document content.
//!
//! # Why the fold is repeated rather than shared
//!
//! The IDE folds these logs in JavaScript and this folds them again in Rust,
//! which is duplication with a real cost: the two can disagree. It is still the
//! right trade, because the alternatives are worse. Having the IDE report the
//! counts would leave every repository nobody has opened in the IDE — which is
//! most of them, and exactly the ones the portal lists — with no answer at all.
//! And a count is a much smaller thing to agree on than a rendering: what is
//! mirrored here is which threads exist and whether each is resolved, not who
//! said what or how it reads.
//!
//! The ordering rules are mirrored deliberately and are the part worth
//! guarding, because they are the part that is not obvious: a total order over
//! (timestamp, author key, file, line), threads created in a first pass so an
//! op cannot be orphaned by a millisecond of clock skew, and tombstones applied
//! last. `comment-log.js`'s own header explains why each of those is necessary;
//! the tests below pin this side to the same answers.
//!
//! # Where the count can be low, and why that is left alone
//!
//! This reads what the walk read. The walk stops at 10,000 files and spends a
//! 24 MB text budget ([`super::clone`]), so on a repository big enough to hit
//! either, sidecars beyond the cap are never opened and their threads are not
//! counted.
//!
//! Exempting `.studio/` from those caps was the obvious fix and is the wrong
//! one: the caps exist so one enormous repository cannot exhaust the backend's
//! memory, and carving out a directory by name re-opens exactly that hole for
//! anybody who puts a large file in it. A repository that big has a count that
//! is low rather than absent, which is the same compromise its file list
//! already makes — and the file list is what a reader compares it against.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::Value;

/// Where the IDE keeps them. A path outside this prefix is not a comment log.
const SIDECAR_DIR: &str = ".studio/comments/";
const LOG_SUFFIX: &str = ".jsonl";
const LEGACY_SUFFIX: &str = ".json";

/// What a document's conversation amounts to.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ThreadCounts {
    /// Threads still open: not resolved, not deleted, and with something left
    /// in them after retractions.
    pub open: usize,
    /// Threads someone has settled. Counted rather than dropped, because "no
    /// open threads" and "nobody has ever commented" are different states and
    /// a reader is entitled to tell them apart.
    pub resolved: usize,
}

impl ThreadCounts {
    fn total(&self) -> usize {
        self.open + self.resolved
    }
}

/// One line of one party's log, placed in the total order.
struct Entry<'a> {
    at: &'a str,
    party: String,
    file: &'a str,
    line: usize,
    op: &'a Value,
}

/// A thread while it is being folded.
#[derive(Default)]
struct Thread {
    resolved: bool,
    /// Message ids in the order they were added, so a retraction can remove
    /// exactly one and a thread emptied by retractions stops being a thread.
    messages: Vec<String>,
}

/// Which document a sidecar path belongs to, and what kind of file it is.
///
/// `.studio/comments/docs/prd.md/roma.jsonl` is one party's log for
/// `docs/prd.md`; `.studio/comments/docs/prd.md.json` is the legacy sidecar for
/// the same document. Exactly one trailing `.json` is stripped, so a document
/// genuinely called `data.json` keeps its name — the same rule the IDE applies
/// when it decides where to write.
fn sidecar_of(path: &str) -> Option<(String, Kind<'_>)> {
    let rest = path.strip_prefix(SIDECAR_DIR)?;
    if let Some(stem) = rest.strip_suffix(LOG_SUFFIX) {
        let (document, party) = stem.rsplit_once('/')?;
        if document.is_empty() {
            return None;
        }
        return Some((document.to_string(), Kind::Log(party)));
    }
    let document = rest.strip_suffix(LEGACY_SUFFIX)?;
    if document.is_empty() || document.ends_with('/') {
        return None;
    }
    Some((document.to_string(), Kind::Legacy))
}

enum Kind<'a> {
    /// A party's append-only op log; the name is the tiebreak in the order.
    Log(&'a str),
    /// The whole-thread sidecar written before the logs existed.
    Legacy,
}

/// Everything one document's sidecars say, before folding.
#[derive(Default)]
struct Sidecars<'a> {
    legacy: Option<&'a str>,
    logs: Vec<(&'a str, &'a str)>,
}

/// Fold every comment sidecar among a repository's files into per-document
/// counts, keyed by the **document's** repo-relative path.
///
/// Takes `(path, text)` for the files the sync already read; anything that is
/// not a sidecar is ignored, so the caller hands over the whole walk rather
/// than pre-filtering it. A document whose threads have all been deleted
/// produces no entry, which is the same as never having been commented on.
pub fn fold_repository<'a, I>(files: I) -> BTreeMap<String, ThreadCounts>
where
    I: IntoIterator<Item = (&'a str, &'a str)>,
{
    let mut by_document: HashMap<String, Sidecars<'a>> = HashMap::new();
    for (path, text) in files {
        let Some((document, kind)) = sidecar_of(path) else {
            continue;
        };
        let entry = by_document.entry(document).or_default();
        match kind {
            Kind::Log(party) => entry.logs.push((party, text)),
            Kind::Legacy => entry.legacy = Some(text),
        }
    }

    let mut counts = BTreeMap::new();
    for (document, sidecars) in by_document {
        let folded = fold_document(&sidecars);
        if folded.total() > 0 {
            counts.insert(document, folded);
        }
    }
    counts
}

fn fold_document(sidecars: &Sidecars<'_>) -> ThreadCounts {
    let mut threads: HashMap<String, Thread> = HashMap::new();

    // The base layer: threads already committed in the legacy sidecar. Read as
    // a starting state and never rewritten — it is committed data, and the ops
    // are applied on top of it.
    if let Some(text) = sidecars.legacy
        && let Ok(Value::Object(root)) = serde_json::from_str::<Value>(text)
        && let Some(Value::Array(list)) = root.get("threads")
    {
        for value in list {
            let Some(id) = value.get("id").and_then(Value::as_str) else {
                continue;
            };
            let messages = value
                .get("messages")
                .and_then(Value::as_array)
                .map(|m| {
                    m.iter()
                        .enumerate()
                        .map(|(index, message)| {
                            message
                                .get("id")
                                .and_then(Value::as_str)
                                .map_or_else(|| derived_message_id(id, index), str::to_string)
                        })
                        .collect()
                })
                .unwrap_or_default();
            threads.insert(
                id.to_string(),
                Thread {
                    resolved: value
                        .get("resolved")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    messages,
                },
            );
        }
    }

    // Parse every line of every log, then put them in one order. A line that
    // does not parse is skipped rather than fatal: the format is line-oriented
    // precisely so a half-flushed tail or a bad merge costs one line instead of
    // the document.
    let parsed: Vec<(usize, &str, Vec<Value>)> = sidecars
        .logs
        .iter()
        .enumerate()
        .map(|(index, (party, text))| {
            (
                index,
                *party,
                text.lines()
                    .map(|line| serde_json::from_str::<Value>(line.trim()).unwrap_or(Value::Null))
                    .collect(),
            )
        })
        .collect();

    let mut ops: Vec<Entry<'_>> = Vec::new();
    for (_, party, lines) in &parsed {
        for (line, op) in lines.iter().enumerate() {
            if !op.is_object() {
                continue;
            }
            ops.push(Entry {
                at: op.get("at").and_then(Value::as_str).unwrap_or(""),
                // The author key the op carries wins over the file name: an op
                // states the record that was true when it was written, and a
                // file could in principle be renamed. The name is the tiebreak.
                party: op
                    .get("by")
                    .and_then(|by| by.get("key"))
                    .and_then(Value::as_str)
                    .unwrap_or(party)
                    .to_string(),
                file: party,
                line,
                op,
            });
        }
    }
    ops.sort_by(|a, b| {
        a.at.cmp(b.at)
            .then_with(|| a.party.cmp(&b.party))
            .then_with(|| a.file.cmp(b.file))
            .then_with(|| a.line.cmp(&b.line))
    });

    let mut deleted: HashSet<&str> = HashSet::new();
    let mut retracted: HashSet<&str> = HashSet::new();

    // Phase 1 — every `open`, so no later op can be orphaned by clock skew.
    for entry in &ops {
        if entry.op.get("op").and_then(Value::as_str) != Some("open") {
            continue;
        }
        let Some(id) = entry.op.get("thread").and_then(Value::as_str) else {
            continue;
        };
        let thread = threads.entry(id.to_string()).or_default();
        // An open carries the thread's first message when it has a body; a
        // thread opened with none is an anchor waiting for one.
        if entry
            .op
            .get("body")
            .and_then(Value::as_str)
            .is_some_and(|b| !b.is_empty())
        {
            let message = message_id(entry.op, id, thread.messages.len());
            thread.messages.push(message);
        }
    }

    // Phase 2 — everything said about a thread, in the same order.
    for entry in &ops {
        let op = entry.op.get("op").and_then(Value::as_str).unwrap_or("");
        if op == "open" {
            continue;
        }
        let Some(id) = entry.op.get("thread").and_then(Value::as_str) else {
            continue;
        };
        let Some(thread) = threads.get_mut(id) else {
            // A thread this fold has not seen — a partial clone, or a branch
            // where the opening party's log never merged. Its tombstones are
            // still collected in case the missing half is in this same set.
            match op {
                "delete" => {
                    deleted.insert(id);
                }
                "retract" => {
                    if let Some(message) = entry.op.get("message").and_then(Value::as_str) {
                        retracted.insert(message);
                    }
                }
                _ => {}
            }
            continue;
        };
        match op {
            "reply" => {
                let message = message_id(entry.op, id, thread.messages.len());
                thread.messages.push(message);
            }
            // Not final, unlike a delete: the last one in the total order wins,
            // which is why resolution is a field and deletion is a set.
            "resolve" => thread.resolved = true,
            "reopen" => thread.resolved = false,
            "retract" => {
                if let Some(message) = entry.op.get("message").and_then(Value::as_str) {
                    retracted.insert(message);
                }
            }
            "delete" => {
                deleted.insert(id);
            }
            // An op kind this build does not know about. A newer IDE may write
            // one; ignoring it is right, losing the document is not.
            _ => {}
        }
    }

    // Phase 3 — tombstones, and then the count.
    let mut counts = ThreadCounts::default();
    for (id, thread) in &threads {
        if deleted.contains(id.as_str()) {
            continue;
        }
        let left = thread
            .messages
            .iter()
            .filter(|message| !retracted.contains(message.as_str()))
            .count();
        // A thread whose every message was retracted shows nothing in the IDE,
        // so counting it here would report a conversation nobody can find.
        if left == 0 {
            continue;
        }
        if thread.resolved {
            counts.resolved += 1;
        } else {
            counts.open += 1;
        }
    }
    counts
}

/// The id a message is known by, explicit when the op carries one.
fn message_id(op: &Value, thread: &str, index: usize) -> String {
    op.get("message")
        .and_then(Value::as_str)
        .map_or_else(|| derived_message_id(thread, index), str::to_string)
}

/// Positional and stable, so two clients that never met agree on which message
/// a retraction names. Minting one during a fold would give the same message a
/// different id on every read.
fn derived_message_id(thread: &str, index: usize) -> String {
    format!("{thread}-m{index}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One op, as the IDE writes it.
    fn op(at: &str, body: &str) -> String {
        format!(
            r#"{{"op":"open","thread":"t1","at":"{at}","by":{{"key":"oidc-a","name":"Ana"}},"body":"{body}"}}"#
        )
    }

    fn counts(files: &[(&str, &str)]) -> BTreeMap<String, ThreadCounts> {
        fold_repository(files.iter().map(|(p, t)| (*p, *t)))
    }

    #[test]
    fn a_document_with_no_sidecar_has_no_entry() {
        // Absent, not zero: "nobody has commented" is a different statement
        // from "every thread is settled", and the portal shows them differently.
        assert!(counts(&[("docs/prd.md", "# Brief")]).is_empty());
    }

    #[test]
    fn one_open_thread_is_one_open_thread() {
        let log = op("2026-09-17T10:00:00.000Z", "Why Q3?");
        let found = counts(&[(".studio/comments/docs/prd.md/oidc-a.jsonl", &log)]);
        assert_eq!(
            found.get("docs/prd.md"),
            Some(&ThreadCounts {
                open: 1,
                resolved: 0
            })
        );
    }

    #[test]
    fn resolving_moves_a_thread_across_rather_than_dropping_it() {
        let log = format!(
            "{}\n{}",
            op("2026-09-17T10:00:00.000Z", "Why Q3?"),
            r#"{"op":"resolve","thread":"t1","at":"2026-09-17T11:00:00.000Z","by":{"key":"oidc-a"}}"#
        );
        let found = counts(&[(".studio/comments/docs/prd.md/oidc-a.jsonl", &log)]);
        assert_eq!(
            found.get("docs/prd.md"),
            Some(&ThreadCounts {
                open: 0,
                resolved: 1
            })
        );
    }

    #[test]
    fn the_last_word_in_the_total_order_decides_resolution() {
        // Two parties, two files, and the reopen is later. A fold that read one
        // file after the other rather than merging them in time order would
        // report whichever file it happened to read last.
        let a = format!(
            "{}\n{}",
            op("2026-09-17T10:00:00.000Z", "Why Q3?"),
            r#"{"op":"reopen","thread":"t1","at":"2026-09-17T12:00:00.000Z","by":{"key":"oidc-a"}}"#
        );
        let b = r#"{"op":"resolve","thread":"t1","at":"2026-09-17T11:00:00.000Z","by":{"key":"oidc-b"}}"#;
        let found = counts(&[
            (".studio/comments/docs/prd.md/oidc-a.jsonl", a.as_str()),
            (".studio/comments/docs/prd.md/oidc-b.jsonl", b),
        ]);
        assert_eq!(found.get("docs/prd.md").map(|c| c.open), Some(1));
    }

    #[test]
    fn a_reply_that_sorts_before_its_open_is_still_a_reply() {
        // Measured in the IDE and written up in comment-log.js: two parties
        // inside the same millisecond, and a single-pass fold silently drops
        // the reply. The two phases exist for this.
        let a = op("2026-09-17T10:00:00.000Z", "Why Q3?");
        let b = r#"{"op":"reply","thread":"t1","at":"2026-09-17T10:00:00.000Z","by":{"key":"oidc-a2"},"body":"The audit."}"#;
        let found = counts(&[
            (".studio/comments/docs/prd.md/zz.jsonl", a.as_str()),
            (".studio/comments/docs/prd.md/aa.jsonl", b),
        ]);
        assert_eq!(found.get("docs/prd.md").map(|c| c.open), Some(1));
    }

    #[test]
    fn a_deleted_thread_is_gone_however_many_ops_follow_it() {
        let log = format!(
            "{}\n{}\n{}",
            op("2026-09-17T10:00:00.000Z", "Why Q3?"),
            r#"{"op":"delete","thread":"t1","at":"2026-09-17T11:00:00.000Z","by":{"key":"oidc-a"}}"#,
            r#"{"op":"reopen","thread":"t1","at":"2026-09-17T12:00:00.000Z","by":{"key":"oidc-a"}}"#
        );
        assert!(counts(&[(".studio/comments/docs/prd.md/oidc-a.jsonl", &log)]).is_empty());
    }

    #[test]
    fn a_thread_emptied_by_retractions_is_not_a_thread() {
        // It shows nothing in the IDE, so counting it would report a
        // conversation nobody can find. The id is the derived one, which is
        // what makes "retract the opening message" expressible at all.
        let log = format!(
            "{}\n{}",
            op("2026-09-17T10:00:00.000Z", "Why Q3?"),
            r#"{"op":"retract","thread":"t1","message":"t1-m0","at":"2026-09-17T11:00:00.000Z","by":{"key":"oidc-a"}}"#
        );
        assert!(counts(&[(".studio/comments/docs/prd.md/oidc-a.jsonl", &log)]).is_empty());
    }

    #[test]
    fn the_legacy_sidecar_is_the_base_layer_and_the_ops_land_on_top() {
        let legacy = r#"{"version":1,"threads":[
            {"id":"old","resolved":false,"messages":[{"id":"m1","body":"from before"}]}
        ]}"#;
        let log = r#"{"op":"resolve","thread":"old","at":"2026-09-17T11:00:00.000Z","by":{"key":"oidc-a"}}"#;
        let found = counts(&[
            (".studio/comments/docs/prd.md.json", legacy),
            (".studio/comments/docs/prd.md/oidc-a.jsonl", log),
        ]);
        assert_eq!(
            found.get("docs/prd.md"),
            Some(&ThreadCounts {
                open: 0,
                resolved: 1
            })
        );
    }

    #[test]
    fn a_malformed_line_costs_one_line_and_not_the_document() {
        let log = format!(
            "{}\n{{ this is not json\n{}",
            op("2026-09-17T10:00:00.000Z", "Why Q3?"),
            r#"{"op":"open","thread":"t2","at":"2026-09-17T10:01:00.000Z","by":{"key":"oidc-a"},"body":"And this?"}"#
        );
        assert_eq!(
            counts(&[(".studio/comments/docs/prd.md/oidc-a.jsonl", &log)])
                .get("docs/prd.md")
                .map(|c| c.open),
            Some(2)
        );
    }

    #[test]
    fn each_document_is_counted_on_its_own() {
        let one = op("2026-09-17T10:00:00.000Z", "Why Q3?");
        let found = counts(&[
            (".studio/comments/docs/prd.md/oidc-a.jsonl", one.as_str()),
            (".studio/comments/README.md/oidc-a.jsonl", one.as_str()),
            (".studio/changes/docs/prd.md.json", "{}"),
        ]);
        assert_eq!(found.len(), 2);
        assert!(found.contains_key("docs/prd.md"));
        assert!(found.contains_key("README.md"));
    }

    #[test]
    fn a_document_called_data_json_keeps_its_name() {
        // Exactly one trailing `.json` is stripped, matching the rule the IDE
        // applies when it decides where to write.
        let one = op("2026-09-17T10:00:00.000Z", "Why?");
        let found = counts(&[
            (".studio/comments/data.json.json", r#"{"threads":[]}"#),
            (".studio/comments/data.json/oidc-a.jsonl", one.as_str()),
        ]);
        assert_eq!(found.get("data.json").map(|c| c.open), Some(1));
    }
}
