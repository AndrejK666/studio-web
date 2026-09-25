//! The graph-store contract for artifact ingest.
//!
//! Artifacts are normalized into typed GTS nodes and handed to a
//! [`GraphStore`]. The real store is the graph-storage gear (see
//! `graph_backend::GraphStorageBackend`); [`InMemoryGraphStore`] is the
//! fallback when that gear is not linked (the `graph` Cargo feature is off) or
//! its client is not available.
//!
//! Every operation carries the caller's [`SecurityContext`] because the real
//! store is tenant-scoped; the in-memory fallback ignores it.
//!
//! Vectors are the store's business, not the producer's: the graph-storage
//! gear computes a node's embedding itself from the payload paths its type
//! declares, with the one provider the deployment runs, so the same model
//! embeds both the stored text and the query. This contract therefore carries
//! text only.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::Value;
use toolkit_security::SecurityContext;

use super::port::IngestedFile;

/// A GTS node to persist: its type id (`gts.cf.studio.artifact.*`), a
/// deterministic instance id (uuid5 of a stable key — idempotent across
/// syncs), and the payload.
#[derive(Debug, Clone)]
pub struct GtsNode {
    pub type_id: &'static str,
    pub instance_id: String,
    pub value: Value,
}

/// A GTS edge to persist: its type id (`gts.cf.studio.rel.*`) and the instance
/// ids of its endpoints (the same ids nodes are keyed on). Idempotent by
/// `(type, from, to)`, so re-syncing the same relation upserts.
#[derive(Debug, Clone)]
pub struct GtsEdge {
    pub type_id: &'static str,
    pub from: String,
    pub to: String,
}

/// A relation read back for the UI: endpoints resolved to node instance ids, so
/// the portal can match them against the nodes it already holds.
#[derive(Debug, Clone)]
pub struct GtsEdgeView {
    pub type_id: String,
    pub from: String,
    pub to: String,
}

/// The graph store contract. Batched, idempotent by instance id, and readable
/// back so the UI can list what was ingested.
#[async_trait]
pub trait GraphStore: Send + Sync {
    async fn upsert_nodes(&self, ctx: &SecurityContext, nodes: &[GtsNode]) -> anyhow::Result<()>;

    /// Upsert relations between already-upserted nodes. Endpoints are addressed
    /// by node instance id; a batch with a dangling endpoint is the caller's
    /// bug, so implementations may drop or reject such an edge.
    async fn upsert_edges(&self, ctx: &SecurityContext, edges: &[GtsEdge]) -> anyhow::Result<()>;

    /// Forget nodes their source no longer has, with the relations that touch
    /// them, and return how many this call removed.
    ///
    /// Idempotent: a node that is absent or already removed is not an error
    /// and is not counted. A node forgotten here must stay writable under the
    /// same instance id, because every id is deterministic — a file that leaves
    /// a repository and comes back, or a checkout switched to another branch
    /// and back, needs the key it had. The next upsert of the key brings the
    /// node back.
    async fn delete_nodes(&self, ctx: &SecurityContext, nodes: &[GtsNode])
    -> anyhow::Result<usize>;

    /// Rank nodes by relevance to a query. The real store runs hybrid
    /// retrieval — lexical and vector arms fused — embedding the query with
    /// the same provider that embedded the nodes. Defaulted to empty for a
    /// store with no search.
    async fn search(
        &self,
        _ctx: &SecurityContext,
        _text: &str,
        _limit: u32,
    ) -> anyhow::Result<Vec<GtsNode>> {
        Ok(Vec::new())
    }

    /// Stored nodes for the listing: the four first-class artifacts by default,
    /// or one type when `type_filter` names it (full GTS id, or the bare leaf).
    ///
    /// SHARED, NOT OWNED. The real store cannot narrow this read — `scope`,
    /// `repo` and the `updated_at` order all live in the node payload, which
    /// graph-storage's projection cannot filter or order on — so one call
    /// returns the whole typed node set and the caller narrows it. On
    /// studio-dev that is 28,717 nodes; handing every caller its own copy
    /// would replace a slow read with a large memcpy, and the cache behind
    /// this would be paying for itself only once. Callers that need owned
    /// values clone the ones they keep, which is a page rather than the set.
    async fn list(
        &self,
        ctx: &SecurityContext,
        type_filter: Option<&str>,
    ) -> anyhow::Result<Arc<Vec<GtsNode>>>;

    /// The relations the UI draws — authored_by / modifies / artifact_of /
    /// contains — as endpoint instance-id pairs.
    async fn list_relations(&self, ctx: &SecurityContext) -> anyhow::Result<Vec<GtsEdgeView>>;

    /// The payload this store keeps for a node — what a later read returns.
    ///
    /// The graph does not keep what it is given: file content becomes a
    /// bounded excerpt, and an oversized payload loses fields. Whoever mirrors
    /// the store (the artifact index) has to mirror THAT, or a page served
    /// from the mirror would differ from the same page served from the graph.
    fn stored_payload(&self, value: &Value) -> Value {
        value.clone()
    }

    /// The nodes of [`GraphStore::list`] whose payload names `scope` as its
    /// workspace or its project.
    ///
    /// Defaulted to the whole projection narrowed here, which is what every
    /// caller did before there was an index to ask. The index overrides it.
    async fn list_in_scope(
        &self,
        ctx: &SecurityContext,
        type_filter: Option<&str>,
        scope: &str,
    ) -> anyhow::Result<Vec<GtsNode>> {
        Ok(self
            .list(ctx, type_filter)
            .await?
            .iter()
            .filter(|n| super::rest::node_in_scope(&n.value, Some(scope)))
            .cloned()
            .collect())
    }

    /// How many of those there are, without handing them over.
    async fn count_in_scope(
        &self,
        ctx: &SecurityContext,
        type_filter: Option<&str>,
        scope: &str,
    ) -> anyhow::Result<u64> {
        let n = self
            .list(ctx, type_filter)
            .await?
            .iter()
            .filter(|n| super::rest::node_in_scope(&n.value, Some(scope)))
            .count();
        Ok(u64::try_from(n).unwrap_or(u64::MAX))
    }

    /// The scope's files, as the documents gear lists them.
    async fn files_in_scope(
        &self,
        ctx: &SecurityContext,
        scope: &str,
    ) -> anyhow::Result<Vec<IngestedFile>> {
        Ok(self
            .list(ctx, Some(super::gts::FILE_TYPE))
            .await?
            .iter()
            .filter(|n| super::rest::node_in_scope(&n.value, Some(scope)))
            .filter_map(ingested_file)
            .collect())
    }

    /// One page of the listing, narrowed, ordered and sliced.
    ///
    /// Defaulted to the whole projection narrowed in process
    /// ([`page_of_nodes`]) — what `/nodes` has always done. The index
    /// overrides it with a query.
    async fn page(
        &self,
        ctx: &SecurityContext,
        query: &NodePageQuery<'_>,
    ) -> anyhow::Result<NodePage> {
        let nodes = self.list(ctx, query.type_filter).await?;
        Ok(page_of_nodes(&nodes, query))
    }
}

/// What `/nodes` asks for.
#[derive(Debug, Clone)]
pub struct NodePageQuery<'a> {
    /// As [`GraphStore::list`]'s `type_filter`.
    pub type_filter: Option<&'a str>,
    /// Keep nodes whose payload names this as its workspace or its project.
    /// `None` is every node.
    pub scope: Option<&'a str>,
    /// Keep nodes whose payload `repo` equals this.
    pub repo: Option<&'a str>,
    /// Already lower-cased. Matched against title, author, path, full path
    /// and the number, as the listing always has.
    pub needle: Option<&'a str>,
    /// Newest `updated_at` first, ties by instance id; else by instance id.
    pub by_updated: bool,
    pub start: PageStart<'a>,
    pub limit: usize,
}

/// Where a page starts.
#[derive(Debug, Clone, Copy)]
pub enum PageStart<'a> {
    Offset(usize),
    /// Just after this instance id, in the page's order. An id the filtered
    /// set does not contain starts at the beginning, as it always has.
    After(&'a str),
}

/// One page and how many nodes the filter matches across every page.
#[derive(Debug, Clone)]
pub struct NodePage {
    pub nodes: Vec<GtsNode>,
    pub total: u64,
    /// The position of the first node of `nodes` in the filtered set.
    pub start: u64,
}

/// Narrow, order and slice a projection in process — the listing's rules,
/// written once, and the reference the index is tested against.
pub fn page_of_nodes(nodes: &[GtsNode], q: &NodePageQuery<'_>) -> NodePage {
    // `nodes` may be the store's shared projection. Narrow by reference and
    // clone only the page: the filters typically keep a page out of tens of
    // thousands.
    let mut kept: Vec<&GtsNode> = nodes
        .iter()
        .filter(|n| super::rest::node_in_scope(&n.value, q.scope))
        // Repo nodes carry no `repo` field, so they drop out when a repo
        // filter is set — which is the intent (you're listing its contents).
        .filter(|n| match q.repo {
            Some(r) => n.value.get("repo").and_then(Value::as_str) == Some(r),
            None => true,
        })
        .filter(|n| match q.needle {
            None => true,
            Some(needle) => {
                let v = &n.value;
                let hay = [
                    v.get("title").and_then(Value::as_str).unwrap_or(""),
                    v.get("author").and_then(Value::as_str).unwrap_or(""),
                    v.get("path").and_then(Value::as_str).unwrap_or(""),
                    v.get("full_path").and_then(Value::as_str).unwrap_or(""),
                ]
                .join(" ")
                .to_lowercase();
                let num = v
                    .get("number")
                    .and_then(Value::as_i64)
                    .map(|n| n.to_string())
                    .unwrap_or_default();
                hay.contains(needle) || num.contains(needle)
            }
        })
        .collect();
    // Newest `updated_at` first when asked, else a stable order by instance id
    // (the graph returns storage pages in any order). ISO-8601 timestamps sort
    // lexically, so a string compare is chronological.
    if q.by_updated {
        fn updated(n: &GtsNode) -> &str {
            n.value
                .get("updated_at")
                .and_then(Value::as_str)
                .unwrap_or("")
        }
        kept.sort_by(|a, b| {
            updated(b)
                .cmp(updated(a))
                .then_with(|| a.instance_id.cmp(&b.instance_id))
        });
    } else {
        kept.sort_by(|a, b| a.instance_id.cmp(&b.instance_id));
    }
    let start = match q.start {
        PageStart::Offset(offset) => offset.min(kept.len()),
        PageStart::After(cursor) => kept
            .iter()
            .position(|n| n.instance_id == cursor)
            .map_or(0, |i| i + 1),
    };
    let end = start.saturating_add(q.limit).min(kept.len());
    NodePage {
        nodes: kept[start..end].iter().map(|n| (*n).clone()).collect(),
        total: u64::try_from(kept.len()).unwrap_or(u64::MAX),
        start: u64::try_from(start).unwrap_or(u64::MAX),
    }
}

/// A file node as the documents gear wants it, or `None` for a directory or a
/// node with no path — neither is anything a spec screen can show.
pub fn ingested_file(node: &GtsNode) -> Option<IngestedFile> {
    let obj = node.value.as_object()?;
    if obj.get("is_dir").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let path = obj.get("path").and_then(Value::as_str).unwrap_or_default();
    if path.is_empty() {
        return None;
    }
    Some(IngestedFile {
        node_id: node.instance_id.clone(),
        path: path.to_owned(),
        repo: obj
            .get("repo")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
    })
}

/// In-memory store: keyed by instance id, so a re-sync upserts. Not persistent
/// — it resets when the backend restarts. The fallback for a build without the
/// graph-storage gear.
#[derive(Default)]
pub struct InMemoryGraphStore {
    nodes: Mutex<HashMap<String, GtsNode>>,
    /// Keyed by `type|from|to` so a re-sync upserts rather than duplicates.
    edges: Mutex<HashMap<String, GtsEdge>>,
}

#[async_trait]
impl GraphStore for InMemoryGraphStore {
    async fn upsert_nodes(&self, _ctx: &SecurityContext, nodes: &[GtsNode]) -> anyhow::Result<()> {
        let total = {
            let mut map = self
                .nodes
                .lock()
                .map_err(|_| anyhow::anyhow!("graph store lock poisoned"))?;
            for n in nodes {
                map.insert(n.instance_id.clone(), n.clone());
            }
            map.len()
        };
        tracing::info!(
            batch = nodes.len(),
            total,
            "studio-artifact-ingest: in-memory graph upsert"
        );
        Ok(())
    }

    async fn upsert_edges(&self, _ctx: &SecurityContext, edges: &[GtsEdge]) -> anyhow::Result<()> {
        let total = {
            let mut map = self
                .edges
                .lock()
                .map_err(|_| anyhow::anyhow!("graph store lock poisoned"))?;
            for e in edges {
                map.insert(format!("{}|{}|{}", e.type_id, e.from, e.to), e.clone());
            }
            map.len()
        };
        tracing::info!(
            batch = edges.len(),
            total,
            "studio-artifact-ingest: in-memory graph edge upsert"
        );
        Ok(())
    }

    /// A real removal: nothing here outlives the process, so there is no
    /// tombstone to keep a key from coming back.
    async fn delete_nodes(
        &self,
        _ctx: &SecurityContext,
        nodes: &[GtsNode],
    ) -> anyhow::Result<usize> {
        let gone: HashSet<&str> = nodes.iter().map(|n| n.instance_id.as_str()).collect();
        let removed = {
            let mut map = self
                .nodes
                .lock()
                .map_err(|_| anyhow::anyhow!("graph store lock poisoned"))?;
            gone.iter().filter(|id| map.remove(**id).is_some()).count()
        };
        self.edges
            .lock()
            .map_err(|_| anyhow::anyhow!("graph store lock poisoned"))?
            .retain(|_, e| !gone.contains(e.from.as_str()) && !gone.contains(e.to.as_str()));
        Ok(removed)
    }

    async fn list(
        &self,
        _ctx: &SecurityContext,
        type_filter: Option<&str>,
    ) -> anyhow::Result<Arc<Vec<GtsNode>>> {
        let out = {
            let map = self
                .nodes
                .lock()
                .map_err(|_| anyhow::anyhow!("graph store lock poisoned"))?;
            let types = super::gts::resolve_listable_types(type_filter);
            map.values()
                .filter(|n| types.contains(&n.type_id))
                .cloned()
                .collect()
        };
        Ok(Arc::new(out))
    }

    async fn list_relations(&self, _ctx: &SecurityContext) -> anyhow::Result<Vec<GtsEdgeView>> {
        let out = {
            let map = self
                .edges
                .lock()
                .map_err(|_| anyhow::anyhow!("graph store lock poisoned"))?;
            map.values()
                .map(|e| GtsEdgeView {
                    type_id: e.type_id.to_string(),
                    from: e.from.clone(),
                    to: e.to.clone(),
                })
                .collect()
        };
        Ok(out)
    }

    /// Naive lexical fallback: substring match over each node's serialized value.
    async fn search(
        &self,
        _ctx: &SecurityContext,
        text: &str,
        limit: u32,
    ) -> anyhow::Result<Vec<GtsNode>> {
        let needle = text.trim().to_lowercase();
        let out = {
            let map = self
                .nodes
                .lock()
                .map_err(|_| anyhow::anyhow!("graph store lock poisoned"))?;
            map.values()
                .filter(|n| {
                    needle.is_empty() || n.value.to_string().to_lowercase().contains(&needle)
                })
                .take(limit as usize)
                .cloned()
                .collect()
        };
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, clippy::unwrap_used)]

    use super::*;
    use crate::artifact_ingest::gts;
    use serde_json::json;
    use uuid::Uuid;

    fn ctx() -> SecurityContext {
        SecurityContext::builder()
            .subject_id(Uuid::from_u128(0xca7))
            .subject_type("service")
            .subject_tenant_id(Uuid::from_u128(0x7e4a47))
            .build()
            .expect("security context")
    }

    fn node(id: &str) -> GtsNode {
        GtsNode {
            type_id: gts::FILE_TYPE,
            instance_id: id.to_string(),
            value: json!({ "path": id }),
        }
    }

    fn edge(from: &str, to: &str) -> GtsEdge {
        GtsEdge {
            type_id: gts::REL_CONTAINS,
            from: from.to_string(),
            to: to.to_string(),
        }
    }

    /// A forgotten node takes the relations that touch it along, from either
    /// end, and leaves every other node and relation where it was.
    #[tokio::test]
    async fn forgetting_a_node_takes_its_relations_and_nothing_else() {
        let store = InMemoryGraphStore::default();
        let ctx = ctx();
        store
            .upsert_nodes(&ctx, &[node("repo"), node("a"), node("b")])
            .await
            .unwrap();
        store
            .upsert_edges(
                &ctx,
                &[edge("repo", "a"), edge("repo", "b"), edge("a", "b")],
            )
            .await
            .unwrap();

        let removed = store.delete_nodes(&ctx, &[node("a")]).await.unwrap();
        assert_eq!(removed, 1);

        let mut left: Vec<String> = store
            .list(&ctx, Some("file"))
            .await
            .unwrap()
            .iter()
            .map(|n| n.instance_id.clone())
            .collect();
        left.sort();
        assert_eq!(left, ["b", "repo"]);
        let relations = store.list_relations(&ctx).await.unwrap();
        assert_eq!(relations.len(), 1);
        assert_eq!(
            (relations[0].from.as_str(), relations[0].to.as_str()),
            ("repo", "b")
        );

        // Again, and for a node that was never there: nothing to do, no error.
        let again = store
            .delete_nodes(&ctx, &[node("a"), node("nope")])
            .await
            .unwrap();
        assert_eq!(again, 0);
    }
}
