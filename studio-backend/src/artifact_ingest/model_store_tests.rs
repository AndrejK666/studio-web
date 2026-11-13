//! The artifact graph kept as domain objects: the move from the old store,
//! and reads and writes after it.

#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::{ID_PREFIX, ModelGraph, ModelGraphStore};
use crate::artifact_ingest::graph::{GraphStore, GtsEdge, GtsNode, InMemoryGraphStore};
use crate::artifact_ingest::gts;
use crate::domain_model::port::{DomainObjects, OwnedObject, StoredObject, TypeNeed};

/// The model as the port shows it, with just enough of the query language
/// for what the store asks: `id` and `_or` of equalities.
#[derive(Default)]
struct Model {
    objects: Mutex<HashMap<String, (String, String, Value)>>,
    links: Mutex<Vec<(String, String, String)>>,
    types: Mutex<Vec<String>>,
    /// Every query fails, as one does behind a saturated pool.
    failing: std::sync::atomic::AtomicBool,
    /// How many rows the queries have handed back, all told.
    rows_read: std::sync::atomic::AtomicUsize,
    /// How many queries and aggregates were asked, all told: what a read
    /// model answers with a statement (or a few) each.
    asked: std::sync::atomic::AtomicUsize,
    /// How many queries were asked, all told.
    queries: std::sync::atomic::AtomicUsize,
    /// Declaring a type is refused, as it is to a person.
    refuse_types: std::sync::atomic::AtomicBool,
}

impl Model {
    /// The objects of the body's type its `where` and `project_ids` admit.
    fn admitted(&self, body: &Value) -> Vec<(String, Value)> {
        let ty = body["type"].as_str().unwrap();
        let w = body.get("where").cloned().unwrap_or(Value::Null);
        let scopes: Option<Vec<String>> = body
            .get("project_ids")
            .map(|v| serde_json::from_value(v.clone()).unwrap());
        self.objects
            .lock()
            .unwrap()
            .iter()
            .filter(|(id, (e, scope, v))| {
                e == ty && matches(&w, id, v) && scopes.as_ref().is_none_or(|s| s.contains(scope))
            })
            .map(|(id, (_, _, v))| (id.clone(), v.clone()))
            .collect()
    }
}

fn matches(w: &Value, id: &str, v: &Value) -> bool {
    let Some(obj) = w.as_object() else {
        return true;
    };
    obj.iter().all(|(k, cond)| match k.as_str() {
        "_or" => cond.as_array().unwrap().iter().any(|c| matches(c, id, v)),
        field => {
            let at = if field == "id" {
                Some(Value::String(id.to_string()))
            } else {
                v.get(field).cloned()
            };
            if let Some(eq) = cond.get("_eq") {
                return at.as_ref() == Some(eq);
            }
            if let Some(list) = cond.get("_in").and_then(Value::as_array) {
                return at.is_some_and(|a| list.contains(&a));
            }
            false
        }
    })
}

#[async_trait]
impl DomainObjects for Model {
    async fn upsert(
        &self,
        _: &SecurityContext,
        _: &str,
        _: &str,
        _: Value,
    ) -> anyhow::Result<String> {
        unreachable!()
    }
    async fn list(&self, _: &SecurityContext, _: &str) -> anyhow::Result<Vec<StoredObject>> {
        unreachable!()
    }
    async fn ensure_type(&self, _: &SecurityContext, need: &TypeNeed) -> anyhow::Result<()> {
        if self.refuse_types.load(std::sync::atomic::Ordering::SeqCst) {
            anyhow::bail!("not permitted on domain objects");
        }
        self.types.lock().unwrap().push(need.id.clone());
        Ok(())
    }
    async fn put_objects(
        &self,
        _: &SecurityContext,
        entity: &str,
        objects: Vec<OwnedObject>,
    ) -> anyhow::Result<usize> {
        let n = objects.len();
        let mut map = self.objects.lock().unwrap();
        for o in objects {
            map.insert(o.id, (entity.to_string(), o.scope, o.payload));
        }
        Ok(n)
    }
    async fn remove_objects(
        &self,
        _: &SecurityContext,
        _: &str,
        ids: Vec<String>,
    ) -> anyhow::Result<usize> {
        let mut map = self.objects.lock().unwrap();
        Ok(ids.iter().filter(|id| map.remove(*id).is_some()).count())
    }
    async fn link_objects(
        &self,
        _: &SecurityContext,
        links: Vec<(String, String, String, String)>,
    ) -> anyhow::Result<(usize, usize)> {
        let n = links.len();
        self.links.lock().unwrap().extend(
            links
                .into_iter()
                .map(|(_, name, from, to)| (name, from, to)),
        );
        Ok((n, 0))
    }
    async fn query(
        &self,
        _: &SecurityContext,
        body: Value,
    ) -> anyhow::Result<(Vec<StoredObject>, usize)> {
        self.queries
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if self.failing.load(std::sync::atomic::Ordering::SeqCst) {
            anyhow::bail!("pool timed out while waiting for an open connection");
        }
        self.asked.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let mut rows: Vec<StoredObject> = self
            .admitted(&body)
            .into_iter()
            .map(|(instance_id, payload)| StoredObject {
                instance_id,
                payload,
            })
            .collect();
        // As the read model orders: each key with an absent value last, then
        // the object id.
        let keys: Vec<(String, bool)> = body
            .get("order_by")
            .and_then(Value::as_array)
            .map(|keys| {
                keys.iter()
                    .map(|k| {
                        (
                            k["field"].as_str().unwrap().to_string(),
                            k.get("direction").and_then(Value::as_str) == Some("desc"),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        rows.sort_by(|a, b| {
            for (field, desc) in &keys {
                let (x, y) = (
                    a.payload.get(field).and_then(Value::as_str),
                    b.payload.get(field).and_then(Value::as_str),
                );
                let o = match (x, y) {
                    (Some(x), Some(y)) if *desc => y.cmp(x),
                    (Some(x), Some(y)) => x.cmp(y),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (None, None) => std::cmp::Ordering::Equal,
                };
                if o != std::cmp::Ordering::Equal {
                    return o;
                }
            }
            a.instance_id.cmp(&b.instance_id)
        });
        let n = rows.len();
        let offset = body.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
        let limit = body
            .get("limit")
            .and_then(Value::as_u64)
            .map_or(usize::MAX, |l| l as usize);
        let rows: Vec<StoredObject> = rows.into_iter().skip(offset).take(limit).collect();
        self.rows_read
            .fetch_add(rows.len(), std::sync::atomic::Ordering::SeqCst);
        Ok((rows, n))
    }
    async fn aggregate(
        &self,
        _: &SecurityContext,
        body: Value,
    ) -> anyhow::Result<(Vec<(Vec<Value>, u64)>, usize)> {
        self.asked.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let by: Vec<String> =
            serde_json::from_value(body["aggregate"]["group_by"].clone()).unwrap();
        let admitted = self.admitted(&body);
        let mut groups: Vec<(Vec<Value>, u64)> = Vec::new();
        for (_, v) in &admitted {
            let key: Vec<Value> = by
                .iter()
                .map(|f| v.get(f).cloned().unwrap_or(Value::Null))
                .collect();
            match groups.iter_mut().find(|(k, _)| *k == key) {
                Some((_, n)) => *n += 1,
                None => groups.push((key, 1)),
            }
        }
        Ok((groups, admitted.len()))
    }
    async fn relations(
        &self,
        _: &SecurityContext,
        names: &[&str],
    ) -> anyhow::Result<Vec<(String, String, String)>> {
        Ok(self
            .links
            .lock()
            .unwrap()
            .iter()
            .filter(|(n, ..)| names.contains(&n.as_str()))
            .cloned()
            .collect())
    }
}

fn ctx() -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::new_v4())
        .subject_tenant_id(Uuid::new_v4())
        .build()
        .unwrap()
}

fn node(type_id: &'static str, id: &str, value: Value) -> GtsNode {
    GtsNode {
        type_id,
        instance_id: id.to_string(),
        value,
    }
}

const WS: &str = "11111111-1111-1111-1111-111111111111";

fn setup() -> (Arc<InMemoryGraphStore>, Arc<Model>, ModelGraph) {
    let legacy = Arc::new(InMemoryGraphStore::default());
    let model = Arc::new(Model::default());
    let hub = Arc::new(toolkit::client_hub::ClientHub::new());
    hub.register::<dyn DomainObjects>(model.clone() as Arc<dyn DomainObjects>);
    let store = ModelGraph(Arc::new(ModelGraphStore::new(legacy.clone(), hub)));
    (legacy, model, store)
}

/// The sweep's step for `ctx`'s tenant: the one place the move runs.
async fn moved(store: &ModelGraph, ctx: &SecurityContext) {
    assert!(
        store.0.make_ready(ctx).await.expect("the move"),
        "the move never finished"
    );
    assert!(store.0.ready(ctx).await, "reads now answer from the model");
}

#[tokio::test]
async fn what_the_old_store_held_moves_and_reads_back_the_same() {
    let (legacy, model, store) = setup();
    let ctx = ctx();
    let repo = node(
        gts::REPO_TYPE,
        "r1",
        json!({"full_path": "acme/web", "workspace_id": WS}),
    );
    let pr = node(
        gts::PULL_REQUEST_TYPE,
        "p1",
        json!({"repo": "r1", "number": 7, "title": "Fix", "workspace_id": WS}),
    );
    legacy
        .upsert_nodes(&ctx, &[repo.clone(), pr.clone()])
        .await
        .unwrap();
    legacy
        .upsert_edges(
            &ctx,
            &[GtsEdge {
                type_id: gts::REL_ARTIFACT_OF,
                from: "p1".into(),
                to: "r1".into(),
            }],
        )
        .await
        .unwrap();

    // The first read is the old store's; the sweep then moves the tenant.
    let first = store
        .list(&ctx, Some(gts::PULL_REQUEST_TYPE))
        .await
        .unwrap();
    assert_eq!(first.len(), 1);
    moved(&store, &ctx).await;

    let prs = store
        .list(&ctx, Some(gts::PULL_REQUEST_TYPE))
        .await
        .unwrap();
    assert_eq!(prs.len(), 1);
    assert_eq!(prs[0].instance_id, "p1", "the artifact keeps its id");
    assert_eq!(prs[0].value, pr.value, "and its payload");
    assert!(
        model
            .objects
            .lock()
            .unwrap()
            .contains_key(&format!("{ID_PREFIX}p1"))
    );

    let rels = store.list_relations(&ctx).await.unwrap();
    assert_eq!(rels.len(), 1);
    assert_eq!(
        (
            rels[0].type_id.as_str(),
            rels[0].from.as_str(),
            rels[0].to.as_str()
        ),
        (gts::REL_ARTIFACT_OF, "p1", "r1")
    );
    assert!(
        model
            .types
            .lock()
            .unwrap()
            .contains(&"system-object".to_string()),
        "the relations were declared"
    );
}

#[tokio::test]
async fn after_the_move_only_the_model_is_written() {
    let (legacy, _model, store) = setup();
    let ctx = ctx();
    store.list(&ctx, None).await.unwrap();
    moved(&store, &ctx).await;

    let issue = node(
        gts::ISSUE_TYPE,
        "i1",
        json!({"title": "Bug", "project_id": WS}),
    );
    store
        .upsert_nodes(&ctx, std::slice::from_ref(&issue))
        .await
        .unwrap();
    assert!(
        legacy
            .list(&ctx, Some(gts::ISSUE_TYPE))
            .await
            .unwrap()
            .is_empty(),
        "the old store is not written"
    );

    let scoped = store
        .list_in_scope(&ctx, Some(gts::ISSUE_TYPE), WS)
        .await
        .unwrap();
    assert_eq!(scoped.len(), 1);
    assert_eq!(
        store
            .count_in_scope(&ctx, Some(gts::ISSUE_TYPE), "elsewhere")
            .await
            .unwrap(),
        0
    );

    assert_eq!(store.delete_nodes(&ctx, &[issue]).await.unwrap(), 1);
    assert!(
        store
            .list(&ctx, Some(gts::ISSUE_TYPE))
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn a_marker_that_cannot_be_read_does_not_start_the_move() {
    let (legacy, model, store) = setup();
    let ctx = ctx();
    legacy
        .upsert_nodes(
            &ctx,
            &[node(
                gts::REPO_TYPE,
                "r1",
                json!({"full_path": "acme/web", "workspace_id": WS}),
            )],
        )
        .await
        .unwrap();
    model
        .failing
        .store(true, std::sync::atomic::Ordering::SeqCst);
    for _ in 0..3 {
        assert!(!store.0.ready(&ctx).await, "reads stay on the old store");
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        model.objects.lock().unwrap().is_empty(),
        "nothing was moved"
    );
    assert!(
        model.types.lock().unwrap().is_empty(),
        "no type was declared"
    );
    assert_eq!(
        legacy.list(&ctx, Some(gts::REPO_TYPE)).await.unwrap().len(),
        1
    );

    // Once the marker reads again, the sweep's move runs as before.
    model
        .failing
        .store(false, std::sync::atomic::Ordering::SeqCst);
    moved(&store, &ctx).await;
    assert!(!model.objects.lock().unwrap().is_empty());
}

/// What Dev showed (#1077): every artifact read started the move as the
/// person reading, failed "not permitted", and asked the model for the
/// marker each time. A read asks once, then remembers, and moves nothing.
#[tokio::test]
async fn a_read_never_starts_the_move_and_asks_for_the_marker_once() {
    use crate::artifact_ingest::graph::{NodePageQuery, PageStart};
    use std::sync::atomic::Ordering;

    let (legacy, model, store) = setup();
    let ctx = ctx();
    legacy
        .upsert_nodes(
            &ctx,
            &[node(
                gts::REPO_TYPE,
                "r1",
                json!({"full_path": "acme/web", "workspace_id": WS}),
            )],
        )
        .await
        .unwrap();
    // A person may not declare the model's types: were the move tried as
    // them, it would fail here.
    model.refuse_types.store(true, Ordering::SeqCst);
    for _ in 0..3 {
        assert_eq!(
            store.list(&ctx, Some(gts::REPO_TYPE)).await.unwrap().len(),
            1
        );
        assert_eq!(
            store
                .list_in_scope(&ctx, Some(gts::REPO_TYPE), WS)
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store
                .count_in_scope(&ctx, Some(gts::REPO_TYPE), WS)
                .await
                .unwrap(),
            1
        );
        store.list_relations(&ctx).await.unwrap();
        store
            .page(
                &ctx,
                &NodePageQuery {
                    type_filter: Some("repo"),
                    scope: Some(WS),
                    repo: None,
                    subject: None,
                    needle: None,
                    by_updated: false,
                    start: PageStart::Offset(0),
                    limit: 10,
                },
            )
            .await
            .unwrap();
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        store.0.moves_started.load(Ordering::SeqCst),
        0,
        "no move was started"
    );
    assert!(
        model.types.lock().unwrap().is_empty(),
        "no type was declared"
    );
    assert!(
        model.objects.lock().unwrap().is_empty(),
        "nothing was moved"
    );
    assert_eq!(
        model.queries.load(Ordering::SeqCst),
        1,
        "the marker was asked once, not on every read"
    );
}

/// A move that fails waits for its back-off: the next sweep does not list
/// the whole old store again at once, and reads stay on the old store.
#[tokio::test]
async fn a_failed_move_is_not_retried_before_its_back_off() {
    use std::sync::atomic::Ordering;

    let (legacy, model, store) = setup();
    let ctx = ctx();
    legacy
        .upsert_nodes(
            &ctx,
            &[node(
                gts::REPO_TYPE,
                "r1",
                json!({"full_path": "acme/web", "workspace_id": WS}),
            )],
        )
        .await
        .unwrap();
    model.refuse_types.store(true, Ordering::SeqCst);
    assert!(store.0.make_ready(&ctx).await.is_err(), "the move failed");
    assert_eq!(store.0.moves_started.load(Ordering::SeqCst), 1);
    model.refuse_types.store(false, Ordering::SeqCst);
    assert!(!store.0.make_ready(&ctx).await.unwrap(), "not tried yet");
    assert_eq!(store.0.moves_started.load(Ordering::SeqCst), 1);
    assert!(!store.0.ready(&ctx).await, "reads stay on the old store");
}

/// A scope's artifacts of the four listed types, some with no date, and a
/// second scope's that no page of the first may show.
async fn listed_fixture(store: &ModelGraph, ctx: &SecurityContext) -> Vec<GtsNode> {
    let mut nodes = Vec::new();
    for i in 0..40u32 {
        let (type_id, scope) = match i % 5 {
            0 => (gts::FILE_TYPE, WS),
            1 => (gts::ISSUE_TYPE, WS),
            2 => (gts::PULL_REQUEST_TYPE, WS),
            3 => (gts::FILE_TYPE, "22222222-2222-2222-2222-222222222222"),
            _ => (gts::REPO_TYPE, WS),
        };
        let mut value = json!({
            "project_id": scope,
            "repo": if i % 2 == 0 { "r-even" } else { "r-odd" },
            "title": format!("t{i}"),
        });
        // Every seventh has no date; the rest repeat four dates, so ties
        // are broken by id.
        if i % 7 != 0 {
            value["updated_at"] = json!(format!("2026-11-0{}T00:00:00Z", 1 + i % 4));
        }
        nodes.push(node(type_id, &format!("n{i:02}"), value));
    }
    store.upsert_nodes(ctx, &nodes).await.unwrap();
    nodes
}

#[tokio::test]
async fn a_page_cut_by_the_model_is_the_page_cut_here() {
    use crate::artifact_ingest::graph::{NodePageQuery, PageStart, page_of_nodes};

    let (_legacy, _model, store) = setup();
    let ctx = ctx();
    store.list(&ctx, None).await.unwrap();
    moved(&store, &ctx).await;
    let all = listed_fixture(&store, &ctx).await;

    for type_filter in [None, Some("file"), Some("issue"), Some("commit")] {
        let of_type: Vec<GtsNode> = all
            .iter()
            .filter(|n| gts::resolve_listable_types(type_filter).contains(&n.type_id))
            .cloned()
            .collect();
        for repo in [None, Some("r-even")] {
            for by_updated in [false, true] {
                for (offset, limit) in [(0, 5), (3, 4), (0, 200), (7, 3), (500, 10)] {
                    let q = NodePageQuery {
                        type_filter,
                        scope: Some(WS),
                        repo,
                        subject: None,
                        needle: None,
                        by_updated,
                        start: PageStart::Offset(offset),
                        limit,
                    };
                    let expected = page_of_nodes(&of_type, &q);
                    let got = store.page(&ctx, &q).await.unwrap();
                    let ids =
                        |p: &[GtsNode]| p.iter().map(|n| n.instance_id.clone()).collect::<Vec<_>>();
                    let what = format!(
                        "type={type_filter:?} repo={repo:?} by_updated={by_updated} offset={offset} limit={limit}"
                    );
                    assert_eq!(ids(&got.nodes), ids(&expected.nodes), "{what}");
                    assert_eq!(got.total, expected.total, "{what}");
                    assert_eq!(got.start, expected.start, "{what}");
                }
            }
        }
    }
}

#[tokio::test]
async fn a_page_of_one_type_reads_the_page_not_the_scope() {
    use crate::artifact_ingest::graph::{NodePageQuery, PageStart};
    use std::sync::atomic::Ordering;

    let (_legacy, model, store) = setup();
    let ctx = ctx();
    store.list(&ctx, None).await.unwrap();
    moved(&store, &ctx).await;
    listed_fixture(&store, &ctx).await;

    model.rows_read.store(0, Ordering::SeqCst);
    let page = store
        .page(
            &ctx,
            &NodePageQuery {
                type_filter: Some("file"),
                scope: Some(WS),
                repo: None,
                subject: None,
                needle: None,
                by_updated: true,
                start: PageStart::Offset(2),
                limit: 3,
            },
        )
        .await
        .unwrap();
    assert_eq!(page.nodes.len(), 3);
    assert_eq!(page.total, 8, "the count still covers the whole scope");
    assert_eq!(
        model.rows_read.load(Ordering::SeqCst),
        3,
        "only the page's rows were read"
    );

    model.rows_read.store(0, Ordering::SeqCst);
    assert_eq!(
        store.count_in_scope(&ctx, Some("file"), WS).await.unwrap(),
        8
    );
    assert!(
        model.rows_read.load(Ordering::SeqCst) <= 1,
        "a count reads at most one row"
    );
}

// ── A table of projects: one read per type, not one per type and project ──

const P1: &str = "aaaaaaaa-0000-0000-0000-000000000001";
const P2: &str = "aaaaaaaa-0000-0000-0000-000000000002";
const P3: &str = "aaaaaaaa-0000-0000-0000-000000000003";
const ELSEWHERE: &str = "aaaaaaaa-0000-0000-0000-000000000009";

/// Findings in three projects of one workspace, one in a project nobody
/// asks about, one on the workspace itself; and an issue in the first.
async fn projects_fixture(store: &ModelGraph, ctx: &SecurityContext) {
    store.list(ctx, None).await.unwrap();
    moved(store, ctx).await;
    let finding = |id: &str, project: Option<&str>| {
        let mut value =
            json!({"subject": id, "workspace_id": WS, "recorded_at": "2026-11-01T00:00:00Z"});
        if let Some(p) = project {
            value["project_id"] = json!(p);
        }
        node(gts::SPEC_FINDING_TYPE, id, value)
    };
    store
        .upsert_nodes(
            ctx,
            &[
                finding("f1", Some(P1)),
                finding("f2", Some(P1)),
                finding("f3", Some(P2)),
                finding("f4", Some(ELSEWHERE)),
                finding("f5", None),
                node(
                    gts::ISSUE_TYPE,
                    "i1",
                    json!({"title": "Bug", "workspace_id": WS, "project_id": P1}),
                ),
            ],
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn projects_are_listed_with_one_read_per_type() {
    use std::sync::atomic::Ordering;
    let (_legacy, model, store) = setup();
    let ctx = ctx();
    projects_fixture(&store, &ctx).await;
    let projects = [P1.to_string(), P2.to_string(), P3.to_string()];

    model.asked.store(0, Ordering::SeqCst);
    model.rows_read.store(0, Ordering::SeqCst);
    let listed = store
        .list_in_projects(&ctx, Some("spec_finding"), &projects)
        .await
        .unwrap();
    assert_eq!(
        model.asked.load(Ordering::SeqCst),
        1,
        "one query for three projects, not three"
    );
    assert_eq!(
        model.rows_read.load(Ordering::SeqCst),
        3,
        "only the asked projects' rows: not the workspace's, not another project's"
    );

    // The same answer three reads of one project each give.
    for p in &projects {
        let one = store
            .list_in_scope(&ctx, Some("spec_finding"), p)
            .await
            .unwrap();
        let ids = |nodes: &[GtsNode]| {
            let mut ids: Vec<String> = nodes.iter().map(|n| n.instance_id.clone()).collect();
            ids.sort();
            ids
        };
        assert_eq!(ids(&listed[p]), ids(&one), "{p}");
    }
    assert!(listed[P3].is_empty(), "a project with none is listed empty");
}

#[tokio::test]
async fn projects_are_counted_without_reading_a_row() {
    use std::sync::atomic::Ordering;
    let (_legacy, model, store) = setup();
    let ctx = ctx();
    projects_fixture(&store, &ctx).await;
    let projects = [P1.to_string(), P2.to_string(), P3.to_string()];

    model.asked.store(0, Ordering::SeqCst);
    model.rows_read.store(0, Ordering::SeqCst);
    let counted = store
        .count_in_projects(&ctx, Some("spec_finding"), &projects)
        .await
        .unwrap();
    assert_eq!(model.asked.load(Ordering::SeqCst), 1, "one aggregate");
    assert_eq!(model.rows_read.load(Ordering::SeqCst), 0, "no row read");
    for p in &projects {
        assert_eq!(
            counted[p],
            store
                .count_in_scope(&ctx, Some("spec_finding"), p)
                .await
                .unwrap(),
            "{p}"
        );
    }
    assert_eq!(
        (counted[P1], counted[P2], counted[P3]),
        (2, 1, 0),
        "every project asked for is answered"
    );
}
