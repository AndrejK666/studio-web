//! A gear reaches its own records as itself (#1080): a member the PDP gives
//! nothing on a project still gets the records through the gear, which has
//! already authorized the project on its own route.

#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::json;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::access::{Access, AccessError, GearsKeepTheirOwn, ObjectPolicy, is_gear_itself};
use super::port::{DomainObjects, KeptByGear, Objects, OwnedObject, TypeNeed, as_gear, is_refusal};
use super::service::DomainModelService;
use super::store::InMemoryDomainStore;

const ORG: Uuid = Uuid::from_u128(7);
const PROJECT: Uuid = Uuid::from_u128(70);

/// A member of the organization on the `roles` model with no grant here.
fn member() -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(1))
        .subject_type("user")
        .subject_tenant_id(ORG)
        .token_scopes(vec!["*".to_string()])
        .bearer_token("member-token".to_string())
        .build()
        .expect("test security context")
}

/// What the PDP answers that member: no grant carries `domain.view`.
struct NoGrant;

#[async_trait]
impl ObjectPolicy for NoGrant {
    async fn access(
        &self,
        _ctx: &SecurityContext,
        _action: &str,
        _entity: Option<&str>,
    ) -> Result<Access, AccessError> {
        Err(AccessError::Denied)
    }
}

fn need() -> TypeNeed {
    TypeNeed {
        declared_by: "studio-test".to_owned(),
        id: "test-extraction".into(),
        name: "Test Extraction".into(),
        description: "A gear's record.".into(),
        extends: Some("record".into()),
        bucket: Some("operations".into()),
        fields: vec![("path".into(), "string".into(), String::new())],
        relations: Vec::new(),
        held_by: Some("studio-test".into()),
        searchable: false,
    }
}

#[test]
fn the_gears_context_keeps_the_tenant_and_drops_the_callers_token() {
    let gear = as_gear(&member()).unwrap();
    assert_eq!(gear.subject_tenant_id(), ORG);
    assert!(gear.bearer_token().is_none());
    assert!(is_gear_itself(&gear));
}

#[tokio::test]
async fn a_member_without_a_grant_gets_a_gears_records_through_the_gear() {
    let service = Arc::new(
        DomainModelService::new(Arc::new(InMemoryDomainStore::default()))
            .with_policy(Arc::new(GearsKeepTheirOwn(Arc::new(NoGrant)))),
    );
    let callers: Arc<dyn DomainObjects> = Arc::new(Objects(service.clone()));
    let gears = KeptByGear::wrap(callers.clone());

    gears.ensure_type(&member(), &need()).await.unwrap();
    let written = gears
        .put_objects(
            &member(),
            "test-extraction",
            vec![OwnedObject {
                id: "ext-1".into(),
                scope: PROJECT.to_string(),
                payload: json!({ "path": "epics/GRN-6.md" }),
            }],
        )
        .await
        .unwrap();
    assert_eq!(written, 1);

    // As the caller, the PDP asks again and the member has no grant.
    match callers
        .list_in(&member(), "test-extraction", &PROJECT.to_string())
        .await
    {
        Ok(rows) => assert!(rows.is_empty(), "the PDP admitted {rows:?}"),
        Err(e) => assert!(is_refusal(&e), "{e:#}"),
    }

    let rows = gears
        .list_in(&member(), "test-extraction", &PROJECT.to_string())
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].payload["path"], "epics/GRN-6.md");
}
