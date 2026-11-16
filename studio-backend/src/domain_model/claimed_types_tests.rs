//! A gear's type a kit claims (ADR-0071 §3): `meta.kit` names the claiming
//! kit, the type is dormant where that kit does not apply and installed again
//! where it does, and the gear keeps writing it either way.

#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::sync::Arc;

use serde_json::{Value, json};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::kit_overlay::KitOverlay;
use super::ontology::Ontology;
use super::port::{DomainObjects, Objects, OwnedObject, TypeNeed};
use super::service::DomainModelService;
use super::store::InMemoryDomainStore;

fn ctx() -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(1))
        .subject_tenant_id(Uuid::from_u128(7))
        .token_scopes(vec!["*".to_string()])
        .build()
        .expect("test security context")
}

/// What studio-usage declares: the price list and the budgets.
fn usage_needs() -> Vec<TypeNeed> {
    crate::model_metadata::declared_types(crate::usage::MODEL_KINDS)
        .into_iter()
        .filter(|n| n.declared_by == "studio-usage")
        .collect()
}

fn entity(doc: &Value, id: &str) -> Value {
    doc["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == id)
        .cloned()
        .unwrap_or_else(|| panic!("no type {id}"))
}

#[tokio::test]
async fn a_claimed_gear_type_names_its_kit_and_sleeps_without_it() {
    let service = Arc::new(DomainModelService::new(Arc::new(
        InMemoryDomainStore::default(),
    )));
    let port = Objects(service.clone());
    for need in usage_needs() {
        port.ensure_type(&ctx(), &need).await.unwrap();
    }
    let doc = service.ontology_document(&ctx()).await.unwrap();
    for id in ["budget", "model-price"] {
        let e = entity(&doc, id);
        assert_eq!(e["meta"]["origin"], "gear", "{id}");
        assert_eq!(e["meta"]["kit"], "org-costs", "{id}: the claiming kit");
        assert!(e["meta"]["left_by"].is_null(), "{id}");
    }
    // The kits' reconciliation sees the claiming kit, so it syncs it.
    assert!(
        service
            .kit_models(&ctx())
            .await
            .unwrap()
            .contains_key("org-costs")
    );

    // Uninstalled: dormant, left by Costs, still the gear's.
    let change = service
        .sync_kit_model(&ctx(), "org-costs", "", None)
        .await
        .unwrap();
    assert!(change.kept.contains(&"budget".to_owned()), "{change:?}");
    let doc = service.ontology_document(&ctx()).await.unwrap();
    for id in ["budget", "model-price"] {
        let e = entity(&doc, id);
        assert_eq!(e["meta"]["left_by"]["kit"], "org-costs", "{id}");
        assert!(e["meta"]["kit"].is_null(), "{id}");
        assert_eq!(e["meta"]["held_by"], "studio-usage", "{id}");
    }
    let installed = Ontology::without_dormant(&doc);
    assert!(
        installed["entities"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["id"] != "budget"),
        "a member does not see a dormant type"
    );
    // The gear goes on writing (ADR-0070 §7, decision 7).
    port.put_objects(
        &ctx(),
        "budget",
        vec![OwnedObject {
            id: "b-1".into(),
            scope: String::new(),
            payload: json!({}),
        }],
    )
    .await
    .unwrap();
    // A repeated declaration does not wake it up.
    for need in usage_needs() {
        port.ensure_type(&ctx(), &need).await.unwrap();
    }
    let again = service.ontology_document(&ctx()).await.unwrap();
    assert_eq!(
        entity(&again, "budget")["meta"]["left_by"]["kit"],
        "org-costs"
    );

    // Installed again: Costs' once more.
    let change = service
        .sync_kit_model(&ctx(), "org-costs", "1", Some(&KitOverlay::default()))
        .await
        .unwrap();
    assert!(
        change.updated.contains(&"type budget".to_owned()),
        "{change:?}"
    );
    let doc = service.ontology_document(&ctx()).await.unwrap();
    let e = entity(&doc, "budget");
    assert_eq!(e["meta"]["kit"], "org-costs");
    assert!(e["meta"]["left_by"].is_null());
}
