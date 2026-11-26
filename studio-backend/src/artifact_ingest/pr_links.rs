//! Pull request → file links (`modifies`), in portions a run can stop between
//! and a later run continues from.
//!
//! ## Why this is its own step
//!
//! A pull request's changed files are one provider call each. On a GitLab
//! project with 2,356 merge requests, read one after another, the linking did
//! not finish inside the fifteen minutes a run holds its lease -- and because
//! the links were only written when the whole sync ended, a run cut short kept
//! none of them, and a retry started the same full pass again.
//!
//! ## Where the progress lives
//!
//! On each pull request's own node: `files_linked` is the head it was linked
//! at (its head commit, else its merge commit, else when it was last updated).
//! A sync carries the mark forward when the head it lists is the one the
//! stored node was linked at, and asks again only about the rest. So the
//! cursor survives anything -- a retry of the run, the next scheduled sync, a
//! redeploy -- because it is the graph, not the run; and a pull request pushed
//! to since is linked again because its head moved.
//!
//! ## Portions
//!
//! The pull requests left to link are read a portion at a time, several in
//! flight ([`ConnectorDriver::item_read_concurrency`]). Each portion is
//! written before the next is read -- edges first, then the marks, so a mark
//! never says more than the graph holds -- and the deadline is checked
//! between portions. What the deadline leaves is counted as `left`, and the
//! task hands the run on to its next attempt (`ingest_task`).

use std::collections::HashMap;
use std::time::Instant;

use futures_util::{StreamExt, stream};
use serde_json::Value;
use toolkit_security::SecurityContext;
use tracing::warn;

use super::graph::{GraphStore, GtsEdge, GtsNode};
use super::gts;
use super::service::stamp_scope;
use crate::connectors::sdk::{ConnectionAuth, ConnectorDriver, RemotePullRequest};

/// The field a pull request node carries its mark in. Declared in
/// `gts/artifact/nodes/pull_request.schema.json`.
pub(super) const LINKED_FIELD: &str = "files_linked";

/// Pull requests per portion, per read in flight: a portion is a few seconds
/// of work, so the deadline is never overshot by much.
const PORTION_PER_READ: usize = 8;

/// Edges per store call, as the sync's own flush keeps them
/// (`service::EDGE_CHUNK`): a portion's links can be thousands.
const EDGE_CHUNK: usize = 1_000;

/// What a pull request's changed files are known for: the commit at its head,
/// else the one its merge made, else when it last changed. `None` when the
/// provider says none of them, and then it is linked on every sync, as all of
/// them were before.
pub(super) fn fingerprint(p: &RemotePullRequest) -> Option<String> {
    [&p.head_sha, &p.merge_sha, &p.updated_at]
        .into_iter()
        .flatten()
        .map(|s| s.trim())
        .find(|s| !s.is_empty())
        .map(str::to_owned)
}

/// [`fingerprint`] of a pull request as its stored node says it: for one an
/// earlier attempt of a resumed walk listed (`listing_cursor`), which this
/// attempt does not list again.
pub(super) fn stored_fingerprint(node: &GtsNode) -> Option<String> {
    ["head_sha", "merge_sha", "updated_at"]
        .into_iter()
        .filter_map(|field| node.value.get(field).and_then(Value::as_str))
        .map(str::trim)
        .find(|s| !s.is_empty())
        .map(str::to_owned)
}

/// The marks the stored pull requests of one repository carry: node instance
/// id → the head they were linked at.
pub(super) fn stored_marks(stored: &[GtsNode], repo_id: &str) -> HashMap<String, String> {
    stored
        .iter()
        .filter(|n| n.type_id == gts::PULL_REQUEST_TYPE)
        .filter(|n| n.value.get("repo").and_then(Value::as_str) == Some(repo_id))
        .filter_map(|n| {
            let mark = n.value.get(LINKED_FIELD)?.as_str()?;
            Some((n.instance_id.clone(), mark.to_owned()))
        })
        .collect()
}

/// Put `mark` on a pull request node -- or `null`, which says "not linked at
/// this head" and overwrites a mark an earlier sync left, whether the store
/// replaces a payload or merges into it.
pub(super) fn mark(node: &mut GtsNode, mark: Option<&str>) {
    if let Some(obj) = node.value.as_object_mut() {
        obj.insert(
            LINKED_FIELD.to_owned(),
            mark.map_or(Value::Null, |m| Value::String(m.to_owned())),
        );
    }
}

/// A pull request whose files are still to be linked: its node as this sync
/// wrote it (unmarked), and the head to mark it with once linked.
pub(super) struct Pending {
    pub number: i64,
    pub node: GtsNode,
    pub fingerprint: Option<String>,
}

/// How far the linking got, this sync's work and earlier ones' together.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct Tally {
    /// Pull requests this sync listed.
    pub total: usize,
    /// Of them, linked at their current head: by an earlier sync, or now.
    pub linked: usize,
    /// Left for a later run because this one ran out of time.
    pub left: usize,
    /// Whose files the provider would not give: tried again next sync.
    pub failed: usize,
}

/// Everything one linking pass needs from the sync around it.
pub(super) struct Linking<'a> {
    pub graph: &'a dyn GraphStore,
    pub ctx: &'a SecurityContext,
    pub driver: &'a dyn ConnectorDriver,
    pub auth: &'a ConnectionAuth,
    pub repo_full_path: &'a str,
    /// The attachment scope stamped on every node (`store_node_batch`).
    pub workspace_id: Option<&'a str>,
    pub project_id: Option<&'a str>,
    /// Stop starting portions after this. `None`: link everything.
    pub deadline: Option<Instant>,
}

/// Link `pending` to the files this sync stored, a portion at a time, and
/// count it on `tally` (whose `total` and earlier `linked` the caller set).
/// `file_id` is the stored file node of a path, `None` for a path the sync
/// did not store. `report` hears the tally after every portion.
///
/// Never fails: a provider that will not answer about one pull request, or a
/// write the store refuses, leaves those pull requests unmarked for the next
/// sync, as the old all-at-the-end pass left its edges.
///
/// The first portion is read whatever the deadline says, so every attempt
/// gets somewhere even when the sync before the linking was slow.
///
/// Answers the marks it stored, by node instance id: a later write of the
/// same node in this sync (its comments read, `item_comments`) must carry
/// them, or it would put back the null it was listed with.
pub(super) async fn link(
    run: &Linking<'_>,
    pending: Vec<Pending>,
    file_id: &(dyn Fn(&str) -> Option<String> + Sync),
    tally: &mut Tally,
    report: &(dyn Fn(&Tally) + Sync),
) -> HashMap<String, Option<String>> {
    let mut written: HashMap<String, Option<String>> = HashMap::new();
    let width = run.driver.item_read_concurrency().max(1);
    let portion = width * PORTION_PER_READ;
    let mut rest = pending;
    let mut first = true;
    while !rest.is_empty() {
        if !first && run.deadline.is_some_and(|d| Instant::now() >= d) {
            tally.left = rest.len();
            break;
        }
        first = false;
        let tail = rest.split_off(portion.min(rest.len()));
        let part = std::mem::replace(&mut rest, tail);

        // In flight `width` at a time; `buffered` answers in the order asked,
        // so each answer stays with the pull request it is about.
        let answers: Vec<(Pending, anyhow::Result<Vec<String>>)> =
            stream::iter(part.into_iter().map(|p| async move {
                let files = run
                    .driver
                    .pull_request_files(run.auth, run.repo_full_path, p.number)
                    .await;
                (p, files)
            }))
            .buffered(width)
            .collect()
            .await;

        let mut edges: Vec<GtsEdge> = Vec::new();
        let mut marked: Vec<GtsNode> = Vec::new();
        for (mut p, files) in answers {
            match files {
                Ok(paths) => {
                    edges.extend(paths.iter().filter_map(|path| {
                        file_id(path.as_str()).map(|f| gts::modifies_edge(&p.node.instance_id, &f))
                    }));
                    mark(&mut p.node, p.fingerprint.as_deref());
                    // Written again: it keeps the attachment scope the
                    // sync's flush stamped on it.
                    stamp_scope(&mut p.node.value, run.workspace_id, run.project_id);
                    marked.push(p.node);
                }
                Err(e) => {
                    tally.failed += 1;
                    warn!(
                        error = %e,
                        repo = run.repo_full_path,
                        pr = p.number,
                        "studio-artifact-ingest: PR file listing failed — the next sync tries again"
                    );
                }
            }
        }
        // Edges before marks: a mark says the links are in the graph.
        let mut stored_edges = true;
        for chunk in edges.chunks(EDGE_CHUNK) {
            if let Err(e) = run.graph.upsert_edges(run.ctx, chunk).await {
                warn!(
                    error = %e,
                    repo = run.repo_full_path,
                    edges = edges.len(),
                    "studio-artifact-ingest: PR→file links not stored — the next sync links these pull requests again"
                );
                stored_edges = false;
                break;
            }
        }
        if stored_edges && !marked.is_empty() {
            match run.graph.upsert_nodes(run.ctx, &marked).await {
                Ok(()) => {
                    tally.linked += marked.len();
                    written.extend(marked.iter().map(|n| {
                        let mark = n.value.get(LINKED_FIELD).and_then(Value::as_str);
                        (n.instance_id.clone(), mark.map(str::to_owned))
                    }));
                }
                Err(e) => warn!(
                    error = %e,
                    repo = run.repo_full_path,
                    "studio-artifact-ingest: could not mark pull requests linked — the next sync links them again"
                ),
            }
        }
        report(tally);
    }
    written
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pull(head: Option<&str>, merge: Option<&str>, updated: Option<&str>) -> RemotePullRequest {
        RemotePullRequest {
            id: "1".into(),
            number: 1,
            title: "t".into(),
            state: "open".into(),
            author: None,
            body: None,
            url: None,
            source_branch: None,
            target_branch: None,
            merged: false,
            created_at: None,
            updated_at: updated.map(str::to_owned),
            draft: None,
            requested_reviewers: Vec::new(),
            requested_teams: Vec::new(),
            assignees: Vec::new(),
            head_sha: head.map(str::to_owned),
            merge_sha: merge.map(str::to_owned),
        }
    }

    #[test]
    fn the_head_names_the_files_and_without_one_the_merge_or_the_last_change() {
        assert_eq!(
            fingerprint(&pull(Some("h1"), Some("m1"), Some("t1"))).as_deref(),
            Some("h1")
        );
        assert_eq!(
            fingerprint(&pull(Some(" "), Some("m1"), Some("t1"))).as_deref(),
            Some("m1")
        );
        assert_eq!(
            fingerprint(&pull(None, None, Some("t1"))).as_deref(),
            Some("t1")
        );
        assert_eq!(fingerprint(&pull(None, None, None)), None);
    }

    #[test]
    fn only_this_repositorys_marked_pull_requests_are_read_back() {
        let node = |id: &str, repo: &str, mark: Value| GtsNode {
            type_id: gts::PULL_REQUEST_TYPE,
            instance_id: id.into(),
            value: json!({ "repo": repo, "files_linked": mark }),
        };
        let stored = vec![
            node("a", "repo-1", json!("h1")),
            node("b", "repo-1", Value::Null),
            node("c", "repo-2", json!("h3")),
            GtsNode {
                type_id: gts::ISSUE_TYPE,
                instance_id: "d".into(),
                value: json!({ "repo": "repo-1", "files_linked": "h4" }),
            },
        ];
        let marks = stored_marks(&stored, "repo-1");
        assert_eq!(marks.len(), 1);
        assert_eq!(marks.get("a").map(String::as_str), Some("h1"));
    }

    #[test]
    fn an_unmarked_node_says_null_so_a_merging_store_forgets_the_old_mark() {
        let mut n = GtsNode {
            type_id: gts::PULL_REQUEST_TYPE,
            instance_id: "a".into(),
            value: json!({ "repo": "r" }),
        };
        mark(&mut n, None);
        assert_eq!(n.value[LINKED_FIELD], Value::Null);
        mark(&mut n, Some("h2"));
        assert_eq!(n.value[LINKED_FIELD], "h2");
    }
}
