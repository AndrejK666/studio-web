//! A project stored as its kit's subtype of Project is found by every reader
//! exactly as a plain one (ADR-0073 amendment, studio-web#1118).
//!
//! The kit `deals` brings `deals-project`, which `extends: project` and adds
//! `deal_size`. Each reader of project objects is asked for `project` and
//! must answer the subtype's object too: by the is-a check, never by the
//! string `project`.

#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::sync::Arc;

use serde_json::{Value, json};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::kit_overlay::KitOverlay;
use super::ontology::{FieldEdit, FieldSpec};
use super::query::Query;
use super::service::{DomainModelService, WriteOptions};
use super::store::{DomainStore, InMemoryDomainStore};
use super::tenant_objects::subtype_named_in;
use super::validate::ValidateMode;

const SUB: &str = "deals-project";
const SUB_GTS: &str = "gts.cf.studio.domain.project.v1~cf.studio.kit_deals.project.v1~";
const PLAIN_GTS: &str = "gts.cf.studio.domain.project.v1~";
const TYPED: Uuid = Uuid::from_u128(0x7001);
const PLAIN: Uuid = Uuid::from_u128(0x7002);

fn ctx() -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(1))
        .subject_tenant_id(Uuid::from_u128(1))
        .token_scopes(vec!["*".to_string()])
        .build()
        .expect("test security context")
}

fn overlay() -> KitOverlay {
    serde_json::from_value(json!({"types": [{"name": "project", "extends": "project",
        "label": "Deal", "fields": [{"name": "deal_size", "type": "number?"}]}]}))
    .expect("overlay")
}

async fn write(s: &DomainModelService, ty: &str, project: Uuid, value: Value) -> String {
    s.create_object(
        &ctx(),
        ty,
        "self",
        WriteOptions {
            validate: ValidateMode::Off,
            scope: Some(&project.to_string()),
            ..Default::default()
        },
        value,
    )
    .await
    .unwrap()
    .instance_id
}

/// A model carrying the kit, one project stored as the subtype and one plain.
async fn fixture() -> (DomainModelService, Arc<InMemoryDomainStore>, String, String) {
    let store = Arc::new(InMemoryDomainStore::default());
    let s = DomainModelService::new(store.clone());
    s.sync_kit_model(&ctx(), "deals", "1", Some(&overlay()))
        .await
        .expect("the kit's model");
    let typed = write(
        &s,
        SUB,
        TYPED,
        json!({"name": "Acme deal", "tenant_id": TYPED.to_string(), "deal_size": 5}),
    )
    .await;
    let plain = write(
        &s,
        "project",
        PLAIN,
        json!({"name": "Plain", "tenant_id": PLAIN.to_string()}),
    )
    .await;
    (s, store, typed, plain)
}

fn query(body: Value) -> Query {
    Query::from_json(body).expect("query")
}

#[tokio::test]
async fn the_model_says_which_types_are_a_project() {
    let (s, ..) = fixture().await;
    let o = s.tenant_model(&ctx()).await.unwrap();
    assert!(o.is_project("project"));
    assert!(o.is_project(SUB));
    assert!(o.is_project(SUB_GTS));
    assert!(!o.is_project("workspace"));
    assert!(!o.is_project("team"));
    // Stored under its chained id, which names it, not its base.
    assert_eq!(o.type_id_of(SUB), SUB_GTS);
    assert_eq!(o.entity_of_type(SUB_GTS).as_deref(), Some(SUB));
    assert_eq!(o.type_id_of("project"), PLAIN_GTS);
    // `project` is read with its subtypes; the subtype alone with itself.
    assert_eq!(o.type_ids_of("project"), [PLAIN_GTS, SUB_GTS]);
    assert_eq!(o.type_ids_of(SUB), [SUB_GTS]);
    // The search reads the same ids (`search_objects`).
    assert_eq!(o.type_ids_of("team"), ["gts.cf.studio.domain.team.v1~"]);
    // Its own fields are what graph-storage is given to validate.
    let schema = o.own_payload_schema(SUB);
    assert!(schema.contains_key("deal_size"));
    assert!(o.own_payload_schema("project").is_empty());
    let registered = o
        .node_types()
        .into_iter()
        .find(|n| n.type_id == SUB_GTS)
        .expect("the subtype registers");
    assert!(registered.payload.contains_key("deal_size"));
}

#[tokio::test]
async fn the_query_api_reads_a_subtype_as_a_project() {
    // POST /query, the MCP `domain_query` tool, the inbox's `{"type": "project"}`
    // and the kits' phase reads all come here.
    let (s, _, typed, plain) = fixture().await;
    let out = s
        .query(&ctx(), &query(json!({"type": "project"})))
        .await
        .unwrap();
    let mut got: Vec<(String, String)> = out
        .rows
        .items
        .iter()
        .map(|r| (r.id.clone(), r.entity.clone()))
        .collect();
    got.sort();
    let mut want = vec![(typed, SUB.to_owned()), (plain, "project".to_owned())];
    want.sort();
    assert_eq!(got, want, "the row says the real type");
    assert_eq!(out.rows.total, 2);
    // In one project's scope, as the tenant sweep asks.
    let scoped = s
        .query(
            &ctx(),
            &query(json!({"type": "project", "project_id": TYPED.to_string(),
                "where": {"tenant_id": {"_eq": TYPED.to_string()}}})),
        )
        .await
        .unwrap();
    assert_eq!(scoped.rows.items.len(), 1);
    assert_eq!(scoped.rows.items[0].value["deal_size"], 5);
    // The subtype asked for itself answers only itself.
    let only = s.query(&ctx(), &query(json!({"type": SUB}))).await.unwrap();
    assert_eq!(only.rows.total, 1);
}

#[tokio::test]
async fn a_relation_to_a_project_reaches_a_subtype() {
    let (s, _, typed, plain) = fixture().await;
    let team = s
        .create_object(
            &ctx(),
            "team",
            "core",
            WriteOptions::default(),
            json!({"name": "Core"}),
        )
        .await
        .unwrap()
        .instance_id;
    for p in [&typed, &plain] {
        s.create_relation(&ctx(), "team.delivers", &team, p)
            .await
            .unwrap();
    }
    let out = s
        .query(
            &ctx(),
            &query(json!({"type": "team", "include": {"delivers": {}}})),
        )
        .await
        .unwrap();
    assert_eq!(out.rows.items[0].relations["delivers"].total, 2);
}

#[tokio::test]
async fn object_listings_read_a_subtype_as_a_project() {
    // GET /objects and the port's `list` / `list_in` (the kits' phase, the
    // creation's `model` step).
    let (s, _, typed, _) = fixture().await;
    let all = s.list_objects(&ctx(), Some("project"), None).await.unwrap();
    assert_eq!(all.len(), 2);
    let scoped = s
        .list_objects(&ctx(), Some("project"), Some(&TYPED.to_string()))
        .await
        .unwrap();
    assert_eq!(scoped.len(), 1);
    assert_eq!(scoped[0].instance_id, typed);
    assert_eq!(scoped[0].type_id, SUB_GTS);
    // The objects graph (the model editor's object view).
    let (nodes, ..) = s
        .objects_graph(&ctx(), 50, Some("project"), None)
        .await
        .unwrap();
    let typed_node = nodes.iter().find(|n| n.instance_id == typed).unwrap();
    assert_eq!(typed_node.entity, SUB);
    assert_eq!(nodes.len(), 2);
}

#[tokio::test]
async fn a_write_to_a_project_lands_on_its_subtype_object() {
    // The attributes cards and the kits' phase write `project` / `self`.
    let (s, store, typed, _) = fixture().await;
    let id = write(
        &s,
        "project",
        TYPED,
        json!({"name": "Acme deal", "tenant_id": TYPED.to_string(), "deal_size": 5, "phase": "build"}),
    )
    .await;
    assert_eq!(id, typed, "no second, plain object beside it");
    let stored = store.get_object(&ctx(), &typed).await.unwrap().unwrap();
    assert_eq!(stored.type_id, SUB_GTS);
    assert_eq!(stored.value["phase"], "build");
    let all = s
        .list_objects(&ctx(), Some("project"), Some(&TYPED.to_string()))
        .await
        .unwrap();
    assert_eq!(all.len(), 1);
}

#[tokio::test]
async fn a_plain_project_naming_its_type_is_retyped_once_with_its_relations() {
    // The migration the tenant sweep runs: an object written as `project`
    // with `project_type_id` becomes the subtype; running it again changes
    // nothing.
    let store = Arc::new(InMemoryDomainStore::default());
    let s = DomainModelService::new(store.clone());
    s.sync_kit_model(&ctx(), "deals", "1", Some(&overlay()))
        .await
        .unwrap();
    let old = write(
        &s,
        "project",
        TYPED,
        json!({"name": "Acme", "tenant_id": TYPED.to_string(),
            "project_type_id": SUB_GTS, "project_type": SUB, "budget": 3}),
    )
    .await;
    let team = s
        .create_object(
            &ctx(),
            "team",
            "core",
            WriteOptions::default(),
            json!({"name": "Core"}),
        )
        .await
        .unwrap()
        .instance_id;
    s.create_relation(&ctx(), "team.delivers", &team, &old)
        .await
        .unwrap();

    let model = s.tenant_model(&ctx()).await.unwrap();
    let found = s
        .query(
            &ctx(),
            &query(json!({"type": "project", "project_id": TYPED.to_string()})),
        )
        .await
        .unwrap();
    let row = &found.rows.items[0];
    assert_eq!(row.entity, "project");
    let subtype = subtype_named_in(&model, &row.value).expect("it names a subtype");
    assert_eq!(subtype, SUB);

    let seen = row.value.clone();
    let (new, wrote) = s
        .retype_object(
            &ctx(),
            "project",
            &subtype,
            "self",
            Some(&TYPED.to_string()),
            move |v: Option<&Value>, _: &str| v.cloned().unwrap_or(seen),
        )
        .await
        .unwrap();
    assert!(wrote);
    assert_ne!(new, old);
    let rows = s
        .query(
            &ctx(),
            &query(json!({"type": "project", "project_id": TYPED.to_string()})),
        )
        .await
        .unwrap();
    assert_eq!(rows.rows.total, 1, "the plain object is gone");
    assert_eq!(rows.rows.items[0].entity, SUB);
    assert_eq!(
        rows.rows.items[0].value["budget"], 3,
        "what people wrote stays"
    );
    // Its relation came along.
    let delivered = s
        .query(
            &ctx(),
            &query(json!({"type": "team", "include": {"delivers": {}}})),
        )
        .await
        .unwrap();
    let items = &delivered.rows.items[0].relations["delivers"].items;
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].id, new);
    // The fields stay for one release.
    assert_eq!(rows.rows.items[0].value["project_type_id"], SUB_GTS);

    // Again: nothing to do, and the sweep would not even ask.
    let again = s
        .retype_object(
            &ctx(),
            "project",
            SUB,
            "self",
            Some(&TYPED.to_string()),
            |v: Option<&Value>, _: &str| v.cloned().unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(again, (new, false));
    assert!(store.get_object(&ctx(), &old).await.unwrap().is_none());
}

#[tokio::test]
async fn retyping_goes_only_down_the_chain() {
    let (s, ..) = fixture().await;
    let refused = s
        .retype_object(
            &ctx(),
            SUB,
            "project",
            "self",
            Some(&PLAIN.to_string()),
            |_: Option<&Value>, _: &str| json!({}),
        )
        .await;
    assert!(refused.is_err());
    let refused = s
        .retype_object(
            &ctx(),
            "project",
            "team",
            "self",
            Some(&PLAIN.to_string()),
            |_: Option<&Value>, _: &str| json!({}),
        )
        .await;
    assert!(refused.is_err());
}

#[tokio::test]
async fn a_field_rename_reaches_the_subtypes_objects() {
    // `migrate_key`, behind a field rename on `project`: the subtype inherits
    // the field, so its objects hold the key too.
    let (s, store, typed, plain) = fixture().await;
    s.add_field(
        &ctx(),
        "project",
        FieldSpec {
            name: "budget_note".into(),
            type_name: "string".into(),
            description: None,
            required: false,
        },
    )
    .await
    .unwrap();
    write(
        &s,
        SUB,
        TYPED,
        json!({"name": "Acme deal", "tenant_id": TYPED.to_string(), "budget_note": "B-1"}),
    )
    .await;
    write(
        &s,
        "project",
        PLAIN,
        json!({"name": "Plain", "tenant_id": PLAIN.to_string(), "budget_note": "B-2"}),
    )
    .await;
    let edited = s
        .edit_field(
            &ctx(),
            "project",
            "budget_note",
            FieldEdit {
                rename_to: Some("budget_ref".into()),
                ..Default::default()
            },
            true,
        )
        .await
        .unwrap();
    assert_eq!(edited.migrated, Some(2));
    for id in [&typed, &plain] {
        let stored = store.get_object(&ctx(), id).await.unwrap().unwrap();
        assert!(stored.value.get("budget_ref").is_some(), "{id}");
    }
    let stored = store.get_object(&ctx(), &typed).await.unwrap().unwrap();
    assert_eq!(stored.type_id, SUB_GTS, "it keeps its type");
}

#[tokio::test]
async fn a_kit_whose_project_type_has_objects_keeps_it_when_removed() {
    // `sync_kit_model`'s "still inhabited" read.
    let (s, ..) = fixture().await;
    let change = s.sync_kit_model(&ctx(), "deals", "", None).await.unwrap();
    assert!(change.kept.iter().any(|k| k.contains(SUB)), "{change:?}");
}
