//! Comments read item by item, in portions a run can stop between and a later
//! run continues from -- for a provider that reads its comments per item
//! ([`ConnectorDriver::comments_per_item`]): GitLab, and GitHub.
//!
//! ## Why
//!
//! GitLab keeps notes on each merge request and issue, one call per item. Its
//! driver used to fake a paged listing: comment page N was the notes of item
//! page N, twenty items a page, and five item pages in a row without a single
//! note answered "no more". On a project with thousands of merge requests that
//! read the notes of the newest few hundred items and stopped -- or stopped at
//! the first quiet stretch -- and said nothing about it.
//!
//! GitHub has a repository-wide listing, and its driver walked it on every
//! sync from the newest comment: a sync without `since` read every comment of
//! the repository again, however few had moved. Read per item, a sync reads
//! only the items that moved.
//!
//! ## Where the progress lives
//!
//! On each item's own node, as [`super::pr_links`] does for files:
//! `comments_read` is the item's `updated_at` when its notes were read. A new
//! or edited note touches its item, so a sync carries the mark while the item
//! is unchanged and reads the notes only of the items that changed or were
//! never read. The cursor is the graph, not the run: a retry, the next
//! scheduled sync or a redeploy all go on from where the last one stopped, and
//! a repository's later syncs read only what moved.
//!
//! ## Portions
//!
//! Several items are read at once ([`ConnectorDriver::item_read_concurrency`]),
//! a portion at a time. Each portion is stored before the next is read --
//! comment and author nodes, then their edges, then the items' marks, so a
//! mark never says more than the graph holds -- and the deadline is checked
//! between portions. What it leaves is counted as `left`, and the task hands
//! the run on to its next attempt (`ingest_task`).

use std::collections::HashMap;
use std::time::Instant;

use futures_util::{StreamExt, stream};
use serde_json::Value;
use toolkit_security::SecurityContext;
use tracing::warn;

use super::graph::{GraphStore, GtsEdge, GtsNode};
use super::gts;
use super::service::stamp_scope;
use crate::connectors::sdk::{ConnectionAuth, ConnectorDriver, RemoteComment};

/// The field an issue or pull request node carries its mark in. Declared in
/// `gts/artifact/nodes/{issue,pull_request}.schema.json`.
pub(super) const READ_FIELD: &str = "comments_read";

/// Items per portion, per read in flight: a portion is a few seconds of work,
/// so the deadline is never overshot by much.
const PORTION_PER_READ: usize = 8;

/// Nodes and edges per store call, as the sync's own flush keeps them.
const CHUNK: usize = 1_000;

/// What an item's comments are known for: when it last changed. `None` when
/// the provider does not say, and then its comments are read on every sync.
pub(super) fn fingerprint(updated_at: Option<&str>) -> Option<String> {
    updated_at
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// The marks the stored issues and pull requests of one repository carry:
/// node instance id → the state their comments were read at.
pub(super) fn stored_marks(stored: &[GtsNode], repo_id: &str) -> HashMap<String, String> {
    stored
        .iter()
        .filter(|n| n.type_id == gts::ISSUE_TYPE || n.type_id == gts::PULL_REQUEST_TYPE)
        .filter(|n| n.value.get("repo").and_then(Value::as_str) == Some(repo_id))
        .filter_map(|n| {
            let mark = n.value.get(READ_FIELD)?.as_str()?;
            Some((n.instance_id.clone(), mark.to_owned()))
        })
        .collect()
}

/// Put `mark` on an issue or pull request node -- or `null`, which says "not
/// read at this state" and overwrites a mark an earlier sync left, whether
/// the store replaces a payload or merges into it.
pub(super) fn mark(node: &mut GtsNode, mark: Option<&str>) {
    if let Some(obj) = node.value.as_object_mut() {
        obj.insert(
            READ_FIELD.to_owned(),
            mark.map_or(Value::Null, |m| Value::String(m.to_owned())),
        );
    }
}

/// An item whose comments are still to be read: its node as this sync wrote
/// it (unmarked), and the state to mark it with once read.
pub(super) struct Pending {
    pub number: i64,
    pub is_pull_request: bool,
    pub node: GtsNode,
    pub fingerprint: Option<String>,
}

/// How far the reading got, this sync's work and earlier ones' together.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct Tally {
    /// Issues and pull requests this sync listed.
    pub total: usize,
    /// Of them, read at their current state: by an earlier sync, or now.
    pub read: usize,
    /// Left for a later run because this one ran out of time.
    pub left: usize,
    /// Whose comments the provider would not give: tried again next sync.
    pub failed: usize,
    /// Comments this sync stored.
    pub comments: usize,
}

/// Everything one reading pass needs from the sync around it.
pub(super) struct Reading<'a> {
    pub graph: &'a dyn GraphStore,
    pub ctx: &'a SecurityContext,
    pub driver: &'a dyn ConnectorDriver,
    pub auth: &'a ConnectionAuth,
    pub repo_full_path: &'a str,
    pub since: Option<&'a str>,
    /// The repository node's instance id, and what keys this attachment's
    /// nodes (`gts::comment_node`, `gts::user_node`).
    pub repo_id: &'a str,
    pub source_scope: &'a str,
    pub connector_id: &'a str,
    pub provider: &'a str,
    /// The attachment scope stamped on every node (`store_node_batch`).
    pub workspace_id: Option<&'a str>,
    pub project_id: Option<&'a str>,
    /// Stop starting portions after this. `None`: read everything.
    pub deadline: Option<Instant>,
}

/// Read the comments of `pending` and store them, a portion at a time, and
/// count it on `tally` (whose `total` and earlier `read` the caller set).
/// `report` hears the tally after every portion.
///
/// Never fails: a provider that will not answer about one item, or a write
/// the store refuses, leaves those items unmarked for the next sync.
///
/// The first portion is read whatever the deadline says, so every attempt
/// gets somewhere even when the sync before the comments was slow.
pub(super) async fn read(
    run: &Reading<'_>,
    pending: Vec<Pending>,
    tally: &mut Tally,
    report: &(dyn Fn(&Tally) + Sync),
) {
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
        // so each answer stays with the item it is about.
        let answers: Vec<(Pending, anyhow::Result<Vec<RemoteComment>>)> =
            stream::iter(part.into_iter().map(|p| async move {
                let comments = run
                    .driver
                    .list_item_comments(
                        run.auth,
                        run.repo_full_path,
                        run.since,
                        p.is_pull_request,
                        p.number,
                    )
                    .await;
                (p, comments)
            }))
            .buffered(width)
            .collect()
            .await;

        let mut nodes: Vec<GtsNode> = Vec::new();
        let mut users: HashMap<String, GtsNode> = HashMap::new();
        let mut edges: Vec<GtsEdge> = Vec::new();
        let mut marked: Vec<GtsNode> = Vec::new();
        let mut comments = 0usize;
        for (mut p, answer) in answers {
            match answer {
                Ok(list) => {
                    comments += list.len();
                    for c in list {
                        let author = c.author.clone();
                        let node = gts::comment_node(
                            run.source_scope,
                            run.repo_id,
                            run.connector_id,
                            run.repo_full_path,
                            c,
                        );
                        edges.push(gts::comment_on_edge(&node.instance_id, &p.node.instance_id));
                        if let Some(login) =
                            author.as_deref().map(str::trim).filter(|l| !l.is_empty())
                        {
                            let u = gts::user_node(
                                run.source_scope,
                                run.connector_id,
                                run.provider,
                                login,
                            );
                            edges.push(gts::authored_by_edge(&node.instance_id, &u.instance_id));
                            users.entry(u.instance_id.clone()).or_insert(u);
                        }
                        nodes.push(node);
                    }
                    mark(&mut p.node, p.fingerprint.as_deref());
                    marked.push(p.node);
                }
                Err(e) => {
                    tally.failed += 1;
                    warn!(
                        error = %e,
                        repo = run.repo_full_path,
                        item = p.number,
                        pull_request = p.is_pull_request,
                        "studio-artifact-ingest: comments of one item unreadable — the next sync tries again"
                    );
                }
            }
        }
        nodes.extend(users.into_values());
        // Nodes, then edges, then marks: a mark says the comments are in the
        // graph, and an edge needs both of its ends stored.
        if store(run, &mut nodes, &edges).await {
            tally.comments += comments;
            for n in &mut marked {
                // Written again: it keeps the attachment scope the sync's
                // flush stamped on it.
                stamp_scope(&mut n.value, run.workspace_id, run.project_id);
            }
            if !marked.is_empty() {
                match run.graph.upsert_nodes(run.ctx, &marked).await {
                    Ok(()) => tally.read += marked.len(),
                    Err(e) => warn!(
                        error = %e,
                        repo = run.repo_full_path,
                        "studio-artifact-ingest: could not mark items' comments read — the next sync reads them again"
                    ),
                }
            }
        }
        report(tally);
    }
}

/// Store one portion's nodes and edges; false when the store refused either,
/// and then the portion's items stay unmarked.
async fn store(run: &Reading<'_>, nodes: &mut [GtsNode], edges: &[GtsEdge]) -> bool {
    for n in nodes.iter_mut() {
        stamp_scope(&mut n.value, run.workspace_id, run.project_id);
    }
    for chunk in nodes.chunks(CHUNK) {
        if let Err(e) = run.graph.upsert_nodes(run.ctx, chunk).await {
            warn!(
                error = %e,
                repo = run.repo_full_path,
                "studio-artifact-ingest: comments not stored — the next sync reads these items again"
            );
            return false;
        }
    }
    for chunk in edges.chunks(CHUNK) {
        if let Err(e) = run.graph.upsert_edges(run.ctx, chunk).await {
            warn!(
                error = %e,
                repo = run.repo_full_path,
                "studio-artifact-ingest: comment relations not stored — the next sync reads these items again"
            );
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_item_is_known_by_when_it_last_changed() {
        assert_eq!(
            fingerprint(Some(" 2026-11-02T10:00:00Z ")).as_deref(),
            Some("2026-11-02T10:00:00Z")
        );
        assert_eq!(fingerprint(Some("  ")), None);
        assert_eq!(fingerprint(None), None);
    }

    #[test]
    fn only_this_repositorys_marked_issues_and_pull_requests_are_read_back() {
        let node = |type_id, id: &str, repo: &str, mark: Value| GtsNode {
            type_id,
            instance_id: id.into(),
            value: json!({ "repo": repo, "comments_read": mark }),
        };
        let stored = vec![
            node(gts::ISSUE_TYPE, "a", "repo-1", json!("t1")),
            node(gts::PULL_REQUEST_TYPE, "b", "repo-1", json!("t2")),
            node(gts::PULL_REQUEST_TYPE, "c", "repo-1", Value::Null),
            node(gts::ISSUE_TYPE, "d", "repo-2", json!("t4")),
            node(gts::COMMENT_TYPE, "e", "repo-1", json!("t5")),
        ];
        let marks = stored_marks(&stored, "repo-1");
        assert_eq!(marks.len(), 2);
        assert_eq!(marks.get("a").map(String::as_str), Some("t1"));
        assert_eq!(marks.get("b").map(String::as_str), Some("t2"));
    }

    #[test]
    fn an_unmarked_node_says_null_so_a_merging_store_forgets_the_old_mark() {
        let mut n = GtsNode {
            type_id: gts::ISSUE_TYPE,
            instance_id: "a".into(),
            value: json!({ "repo": "r" }),
        };
        mark(&mut n, None);
        assert_eq!(n.value[READ_FIELD], Value::Null);
        mark(&mut n, Some("t2"));
        assert_eq!(n.value[READ_FIELD], "t2");
    }
}
