//! The domain store against graph-storage itself: the real service and its
//! in-process client over the gear's in-memory store (`test-support`), not a
//! fake of the client. What is checked is what only the gear can say — that a
//! type registered before `_scope` was an index path takes it on an update,
//! that the projection then admits the filter, and that a type which cannot
//! take it still answers by walking.

#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::sync::Arc;

use graph_storage_sdk::GraphStorageClientV1;
use graph_storage_sdk::models::TypeRegistration;
use serde_json::{Value, json};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::gts;
use super::ontology::NodeType;
use super::store::{DomainStore, GraphStorageBackend, NodeUpsert};
use crate::test_graph::{client, client_with_budget, client_with_chain_depth, ctx};

fn node_type(leaf: &str) -> NodeType {
    NodeType {
        type_id: gts::node_type_id(leaf),
        title: leaf.to_owned(),
        description: String::new(),
        payload: serde_json::Map::new(),
    }
}

/// The schema domain node types were registered with before `_scope` was an
/// index path: the family and the search traits, nothing else.
fn schema_before_the_index(type_id: &str) -> Value {
    let mut schema = gts::derived_node_schema(type_id);
    schema["x-gts-traits"]
        .as_object_mut()
        .expect("traits")
        .remove("index");
    schema["allOf"].as_array_mut().expect("allOf").truncate(1);
    schema
}

/// Register `types` the way the store used to: no options, so a stored type
/// is never touched again.
async fn register_the_old_way(
    client: &dyn GraphStorageClientV1,
    ctx: &SecurityContext,
    types: &[NodeType],
) {
    let batch = types
        .iter()
        .map(|t| TypeRegistration {
            type_id: gts::graph_type_id(&t.type_id),
            schema: schema_before_the_index(&t.type_id),
        })
        .collect();
    client
        .register_types(ctx, batch)
        .await
        .expect("the old schemas register");
}

fn object(type_id: &str, key: &str, payload: Value) -> NodeUpsert {
    NodeUpsert {
        expected_version: None,
        type_id: type_id.to_owned(),
        node_key: gts::instance_id(type_id, key),
        name: Some(key.to_owned()),
        payload,
    }
}

async fn index_of(
    client: &dyn GraphStorageClientV1,
    ctx: &SecurityContext,
    type_id: &str,
) -> Vec<String> {
    client
        .get_type(ctx, &gts::graph_type_id(type_id))
        .await
        .expect("the type reads")
        .effective_traits
        .index
}

/// What the scope filter is, asked of the projection directly: admitted
/// means the graph narrowed the rows, not this process.
async fn filter_is_admitted(
    client: &dyn GraphStorageClientV1,
    ctx: &SecurityContext,
    type_id: &str,
) -> bool {
    let filter = toolkit_odata::parse_filter_string("payload/_scope eq 'p1'")
        .expect("the filter parses")
        .into_expr();
    client
        .count_nodes(
            ctx,
            &[gts::graph_type_id(type_id)],
            toolkit_odata::ODataQuery::default().with_filter(filter),
        )
        .await
        .is_ok()
}

#[tokio::test]
async fn a_type_registered_before_the_index_takes_it_and_a_scoped_read_filters() {
    let client = client();
    let ctx = ctx(Uuid::now_v7());
    let store = GraphStorageBackend::new(Arc::clone(&client));
    let team = node_type("team");

    register_the_old_way(client.as_ref(), &ctx, std::slice::from_ref(&team)).await;
    assert!(
        index_of(client.as_ref(), &ctx, &team.type_id)
            .await
            .is_empty()
    );
    assert!(
        !filter_is_admitted(client.as_ref(), &ctx, &team.type_id).await,
        "without the declaration the projection refuses the path"
    );

    // Rows written under the old schema, which the update has to revalidate:
    // in two scopes, one without a scope, one deleted. Under one page: the
    // in-memory store answers a single page and mints no cursor, so paging
    // is not what this checks (the filter re-sent with every cursor is the
    // catalogue's snapshot read, which a stand has checked).
    let mut rows: Vec<NodeUpsert> = (0..30)
        .map(|i| object(&team.type_id, &format!("p1-{i}"), json!({ "_scope": "p1" })))
        .collect();
    rows.extend(
        (0..20).map(|i| object(&team.type_id, &format!("p2-{i}"), json!({ "_scope": "p2" }))),
    );
    rows.push(object(&team.type_id, "unscoped", json!({ "name": "free" })));
    rows.push(object(
        &team.type_id,
        "gone",
        json!({ "_scope": "p1", "_deleted": true }),
    ));
    rows.push(object(&team.type_id, "quote", json!({ "_scope": "it's" })));
    for chunk in rows.chunks(100) {
        store
            .upsert_nodes(&ctx, chunk)
            .await
            .expect("the rows write");
    }

    let pinned = store
        .register_types(&ctx, std::slice::from_ref(&team), &[])
        .await
        .expect("the registration answers");
    assert!(pinned.is_empty(), "nothing is refused: {pinned:?}");
    assert_eq!(
        index_of(client.as_ref(), &ctx, &team.type_id).await,
        gts::INDEX_PATHS.map(str::to_owned).to_vec(),
        "the update put the index on the stored type"
    );
    assert!(filter_is_admitted(client.as_ref(), &ctx, &team.type_id).await);

    let types = [team.type_id.clone()];
    let p1 = store
        .list_objects(&ctx, &types, Some("p1"), None)
        .await
        .expect("a scoped read");
    assert_eq!(p1.len(), 30, "every live object of the scope");
    assert!(p1.iter().all(|o| o.value["_scope"] == "p1"));

    let bounded = store
        .list_objects(&ctx, &types, Some("p2"), Some(7))
        .await
        .expect("a bounded scoped read");
    assert_eq!(bounded.len(), 7);

    let quoted = store
        .list_objects(&ctx, &types, Some("it's"), None)
        .await
        .expect("a scope with a quote is a literal");
    assert_eq!(quoted.len(), 1);

    let all = store
        .list_objects(&ctx, &types, None, None)
        .await
        .expect("an unscoped read");
    assert_eq!(all.len(), 52, "every live object, the deleted one left out");

    // Registered again, nothing changes and nothing is refused.
    let again = store
        .register_types(&ctx, std::slice::from_ref(&team), &[])
        .await
        .expect("the registration converges");
    assert!(again.is_empty());
}

#[tokio::test]
async fn a_type_whose_rows_refuse_the_index_keeps_its_schema_and_still_answers() {
    let client = client();
    let ctx = ctx(Uuid::now_v7());
    let store = GraphStorageBackend::new(Arc::clone(&client));
    let team = node_type("team");
    let odd = node_type("odd");

    register_the_old_way(client.as_ref(), &ctx, &[team.clone(), odd.clone()]).await;
    store
        .upsert_nodes(
            &ctx,
            &[
                object(&team.type_id, "a", json!({ "_scope": "p1" })),
                // A scope that is not a string: the typed property refuses it,
                // so the update of this type cannot be admitted.
                object(&odd.type_id, "n", json!({ "_scope": 7 })),
                object(&odd.type_id, "b", json!({ "_scope": "p1" })),
            ],
        )
        .await
        .expect("the rows write");

    let pinned = store
        .register_types(&ctx, &[team.clone(), odd.clone()], &[])
        .await
        .expect("one refused type does not fail the registration");
    assert_eq!(pinned, vec![gts::graph_type_id(&odd.type_id)]);
    assert_eq!(
        index_of(client.as_ref(), &ctx, &team.type_id).await.len(),
        1
    );
    assert!(
        index_of(client.as_ref(), &ctx, &odd.type_id)
            .await
            .is_empty()
    );

    // The refused type is read by walking it; a read over both types cannot
    // filter (a path counts only when every selected type declares it), and
    // walks too.
    let odd_in_p1 = store
        .list_objects(&ctx, std::slice::from_ref(&odd.type_id), Some("p1"), None)
        .await
        .expect("the walk answers");
    assert_eq!(odd_in_p1.len(), 1);
    let both = store
        .list_objects(
            &ctx,
            &[team.type_id.clone(), odd.type_id.clone()],
            Some("p1"),
            None,
        )
        .await
        .expect("the walk answers");
    assert_eq!(both.len(), 2);
}

#[tokio::test]
async fn a_new_tenant_registers_the_index_from_the_start() {
    let client = client();
    let ctx = ctx(Uuid::now_v7());
    let store = GraphStorageBackend::new(Arc::clone(&client));
    let team = node_type("team");

    store
        .register_meta_types(&ctx)
        .await
        .expect("the meta types register");
    let pinned = store
        .register_types(&ctx, std::slice::from_ref(&team), &[])
        .await
        .expect("the types register");
    assert!(pinned.is_empty());
    assert!(filter_is_admitted(client.as_ref(), &ctx, &team.type_id).await);
}

// ── Removing a relation on a busy node ─────────────────────────────────────

/// A team with many `owns` edges of one relation (`staff`) and one of
/// another (`lead`), all of the verb `owns`.
async fn busy_team(store: &GraphStorageBackend, ctx: &SecurityContext) -> (String, Vec<String>) {
    use super::ontology::EdgeType;
    let team = node_type("team");
    let person = node_type("person");
    let owns = gts::edge_type_id("owns");
    store.register_meta_types(ctx).await.expect("meta types");
    store
        .register_types(
            ctx,
            &[team.clone(), person.clone()],
            &[EdgeType {
                type_id: owns.clone(),
                relation_kind: "owns".to_owned(),
                src_type_ids: vec![team.type_id.clone()],
                dst_type_ids: vec![person.type_id.clone()],
            }],
        )
        .await
        .expect("types");
    let mut nodes = vec![object(&team.type_id, "core", json!({"name": "core"}))];
    nodes.extend((0..8).map(|i| {
        object(
            &person.type_id,
            &format!("p{i}"),
            json!({"name": format!("p{i}")}),
        )
    }));
    store.upsert_nodes(ctx, &nodes).await.expect("nodes");
    let core = nodes[0].node_key.clone();
    let people: Vec<String> = nodes[1..].iter().map(|n| n.node_key.clone()).collect();
    // Six staff edges, then the lead, and p7 with no edge at all.
    for p in &people[..6] {
        store
            .create_relation(ctx, &owns, &core, p, Some("staff"), None)
            .await
            .expect("staff");
    }
    store
        .create_relation(ctx, &owns, &core, &people[6], Some("lead"), None)
        .await
        .expect("lead");
    (core, people)
}

#[tokio::test]
async fn a_relation_on_a_busy_node_is_found_by_its_discriminator() {
    use super::store::RelationRemoval;
    let client = client_with_budget(3);
    let ctx = ctx(Uuid::now_v7());
    let store = GraphStorageBackend::new(Arc::clone(&client));
    let (core, people) = busy_team(&store, &ctx).await;
    let owns = gts::edge_type_id("owns");

    // An unfiltered walk from `core` is cut: eight edges, three nodes.
    let walk = client
        .traverse(
            &ctx,
            graph_storage_sdk::models::TraverseRequest {
                seeds: vec![core.clone()],
                depth: 1,
                ..Default::default()
            },
        )
        .await
        .expect("walk");
    assert!(walk.truncated.is_some(), "the hub is over the budget");

    // The lead is one edge of its relation: the walk carries only it.
    let removed = store
        .delete_relation(&ctx, &owns, &core, &people[6], Some("lead"))
        .await
        .expect("the lead is found");
    assert_eq!(removed, RelationRemoval::Named);
    let lead = client
        .traverse(
            &ctx,
            graph_storage_sdk::models::TraverseRequest {
                seeds: vec![core.clone()],
                depth: 1,
                edge_discriminators: vec!["lead".to_owned()],
                ..Default::default()
            },
        )
        .await
        .expect("walk");
    assert!(lead.edges.is_empty(), "the lead edge is gone");

    // Asked again, the named edge is not there, and the look for an older
    // unnamed one has to walk every `owns` edge of the hub, which the budget
    // cuts: the store says it cannot tell rather than "absent".
    let again = store
        .delete_relation(&ctx, &owns, &core, &people[6], Some("lead"))
        .await
        .expect_err("the unnamed look is cut");
    assert!(super::store::is_relation_unseen(&again), "{again}");
}

#[tokio::test]
async fn a_relation_past_the_budget_is_unseen_not_absent() {
    let client = client_with_budget(3);
    let ctx = ctx(Uuid::now_v7());
    let store = GraphStorageBackend::new(Arc::clone(&client));
    let (core, people) = busy_team(&store, &ctx).await;
    let owns = gts::edge_type_id("owns");

    // p7 has no staff edge, but six staff edges overflow the walk: the store
    // cannot tell, and says so rather than "absent".
    let e = store
        .delete_relation(&ctx, &owns, &core, &people[7], Some("staff"))
        .await
        .expect_err("a cut walk is not an answer");
    assert!(super::store::is_relation_unseen(&e), "{e}");

    // A staff edge either is found and removed, or is unseen: never absent.
    for p in &people[..6] {
        match store
            .delete_relation(&ctx, &owns, &core, p, Some("staff"))
            .await
        {
            Ok(r) => assert!(r.removed(), "{p}: {r:?}"),
            Err(e) => assert!(super::store::is_relation_unseen(&e), "{p}: {e}"),
        }
    }
}

// ── Reading every edge for the read model's fill ───────────────────────────

/// Two teams, two people each: walked together they exceed a budget of
/// three nodes, walked one at a time they do not.
#[tokio::test]
async fn a_cut_walk_is_walked_again_in_halves_until_every_edge_is_read() {
    use super::ontology::EdgeType;
    let client = client_with_budget(3);
    let ctx = ctx(Uuid::now_v7());
    let store = GraphStorageBackend::new(Arc::clone(&client));
    let team = node_type("team");
    let person = node_type("person");
    let owns = gts::edge_type_id("owns");
    store.register_meta_types(&ctx).await.expect("meta types");
    store
        .register_types(
            &ctx,
            &[team.clone(), person.clone()],
            &[EdgeType {
                type_id: owns.clone(),
                relation_kind: "owns".to_owned(),
                src_type_ids: vec![team.type_id.clone()],
                dst_type_ids: vec![person.type_id.clone()],
            }],
        )
        .await
        .expect("types");
    let nodes = vec![
        object(&team.type_id, "t1", json!({})),
        object(&team.type_id, "t2", json!({})),
        object(&person.type_id, "a", json!({})),
        object(&person.type_id, "b", json!({})),
        object(&person.type_id, "c", json!({})),
        object(&person.type_id, "d", json!({})),
    ];
    store.upsert_nodes(&ctx, &nodes).await.expect("nodes");
    let key = |i: usize| nodes[i].node_key.clone();
    for (t, p) in [(0, 2), (0, 3), (1, 4), (1, 5)] {
        store
            .create_relation(&ctx, &owns, &key(t), &key(p), Some("staff"), None)
            .await
            .expect("edge");
    }
    let seeds = vec![key(0), key(1)];

    let both = client
        .traverse(
            &ctx,
            graph_storage_sdk::models::TraverseRequest {
                seeds: seeds.clone(),
                depth: 1,
                ..Default::default()
            },
        )
        .await
        .expect("walk");
    assert!(both.truncated.is_some(), "one walk of both is cut");

    let whole = store.read_edges_whole(&ctx, &seeds).await.expect("edges");
    assert_eq!(whole.edges.len(), 4, "every edge, after halving");
    assert!(whole.cut.is_empty());

    // A team with more edges than one walk carries has them listed instead,
    // page by page: the fill reads it whole rather than staying unfilled.
    for p in ["e", "f", "g"] {
        let n = object(&person.type_id, p, json!({}));
        store
            .upsert_nodes(&ctx, std::slice::from_ref(&n))
            .await
            .expect("node");
        store
            .create_relation(&ctx, &owns, &key(0), &n.node_key, Some("staff"), None)
            .await
            .expect("edge");
    }
    let whole = store.read_edges_whole(&ctx, &seeds).await.expect("edges");
    assert!(whole.cut.is_empty(), "{:?}", whole.cut);
    assert_eq!(
        whole.edges.len(),
        7,
        "the hub's five and the other team's two"
    );
}

/// A kit's Project subtype as the model registers it (ADR-0073 amendment):
/// derived from Project, so graph-storage validates the subtype's own fields
/// on every write across the chain, while Project's payload stays open.
#[tokio::test]
async fn a_project_subtype_is_registered_on_project_and_its_fields_are_validated() {
    let mut model = super::ontology::Ontology::load();
    let deals: super::kit_overlay::KitOverlay = serde_json::from_value(json!({"types": [
        {"name": "project", "extends": "project", "label": "Deal",
         "fields": [{"name": "deal_size", "type": "number?"},
                    {"name": "stage", "type": "sourcing | closing"}]}]}))
    .expect("overlay");
    super::kit_overlay::sync(&mut model, "deals", "1", Some(&deals), &|_| false).expect("sync");
    let sub_id = model.type_id_of("deals-project");
    assert_eq!(
        sub_id,
        "gts.cf.studio.domain.project.v1~cf.studio.kit_deals.project.v1~"
    );
    let types: Vec<NodeType> = model
        .node_types()
        .into_iter()
        .filter(|n| n.type_id == sub_id || n.type_id == gts::node_type_id("project"))
        .collect();
    assert_eq!(types.len(), 2);

    let deep = client_with_chain_depth(4);
    let ctx = ctx(Uuid::now_v7());
    let store = GraphStorageBackend::new(Arc::clone(&deep));
    let pinned = store
        .register_types(&ctx, &types, &[])
        .await
        .expect("registers");
    assert!(pinned.is_empty(), "{pinned:?}");

    // A valid subtype object is stored, in a project's scope.
    store
        .upsert_nodes(
            &ctx,
            &[object(
                &sub_id,
                "p1|self",
                json!({"_scope": "p1", "name": "Acme", "deal_size": 5, "stage": "closing"}),
            )],
        )
        .await
        .expect("a valid deal is stored");
    // An invalid field value is refused by graph-storage itself.
    for bad in [json!({"deal_size": "lots"}), json!({"stage": "won"})] {
        let refused = store
            .upsert_nodes(&ctx, &[object(&sub_id, "p2|self", bad.clone())])
            .await;
        assert!(refused.is_err(), "{bad} was stored");
    }
    // Project's own payload stays open: the same value on a plain project is
    // not the subtype's business.
    store
        .upsert_nodes(
            &ctx,
            &[object(
                &gts::node_type_id("project"),
                "p3|self",
                json!({"deal_size": "lots"}),
            )],
        )
        .await
        .expect("a plain project is not checked against the subtype");
    // Read as Project, both come back, each with its own type.
    let rows = store
        .list_objects(&ctx, &model.type_ids_of("project"), None, None)
        .await
        .expect("reads");
    let mut types_read: Vec<&str> = rows.iter().map(|r| r.type_id.as_str()).collect();
    types_read.sort_unstable();
    assert_eq!(
        types_read,
        [gts::node_type_id("project").as_str(), sub_id.as_str()]
    );

    // Under the gear's default depth the subtype cannot register: the
    // deployment's `ontology_max_chain_depth: 4` is what admits it.
    let shallow = GraphStorageBackend::new(client());
    let pinned = shallow
        .register_types(&ctx, &types, &[])
        .await
        .expect("the others register");
    assert_eq!(pinned, [gts::graph_type_id(&sub_id)]);
}
