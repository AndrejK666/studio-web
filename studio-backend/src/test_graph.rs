//! The graph-storage gear in process, for tests: the real service and its
//! in-process client over the gear's in-memory store (`test-support`), not a
//! fake of the client. What only the gear can say — how a registration is
//! admitted, what a projection filters, where a walk is cut — is checked
//! against this.

#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::sync::Arc;

use async_trait::async_trait;
use authz_resolver_sdk::api::AuthZResolverApi;
use authz_resolver_sdk::constraints::{Constraint, InPredicate, Predicate};
use authz_resolver_sdk::models::{
    EvaluationRequest, EvaluationResponse, EvaluationResponseContext,
};
use authz_resolver_sdk::pep::PolicyEnforcer;
use graph_storage::config::{GraphStorageConfig, ValidatedConfig};
use graph_storage::domain::embedding::{EmbeddingCoordinator, SpaceState};
use graph_storage::domain::local_client::GraphStorageLocalClient;
use graph_storage::domain::service::GraphServices;
use graph_storage::infra::embedding::fake::FakeEmbeddingProvider;
use graph_storage::infra::fake_store::{FakeGraphEngine, FakeGraphStore};
use graph_storage_sdk::GraphStorageClientV1;
use serde_json::Value;
use toolkit_canonical_errors::CanonicalError;
use toolkit_security::{PlatformSecurityContext, SecurityContext, pep_properties};
use uuid::Uuid;

/// Admits everything, in the caller's own tenant — the posture the gear is
/// deployed under: the policy decides who may call, the scope what they see.
struct AllowInOwnTenant;

#[async_trait]
impl AuthZResolverApi for AllowInOwnTenant {
    async fn evaluate(
        &self,
        _ctx: PlatformSecurityContext,
        request: EvaluationRequest,
    ) -> Result<EvaluationResponse, CanonicalError> {
        let tenant = request
            .subject
            .properties
            .get("tenant_id")
            .and_then(Value::as_str)
            .and_then(|raw| Uuid::parse_str(raw).ok())
            .unwrap_or_else(Uuid::nil);
        Ok(EvaluationResponse {
            decision: true,
            context: EvaluationResponseContext {
                constraints: vec![Constraint {
                    predicates: vec![Predicate::In(InPredicate::new(
                        pep_properties::OWNER_TENANT_ID,
                        [tenant],
                    ))],
                }],
                deny_reason: None,
            },
        })
    }
}

/// The gear under its default configuration.
pub fn client() -> Arc<dyn GraphStorageClientV1> {
    client_with(GraphStorageConfig::default())
}

/// The gear with a traversal budget small enough for a test to exceed:
/// `max_nodes` nodes a walk, the seeds included.
pub fn client_with_budget(max_nodes: u32) -> Arc<dyn GraphStorageClientV1> {
    client_with(GraphStorageConfig {
        traversal_max_nodes: max_nodes,
        ..GraphStorageConfig::default()
    })
}

fn client_with(config: GraphStorageConfig) -> Arc<dyn GraphStorageClientV1> {
    let store = Arc::new(FakeGraphStore::new());
    let engine = Arc::new(FakeGraphEngine::new(Arc::clone(&store)));
    let embedding = EmbeddingCoordinator::new(
        Arc::new(FakeEmbeddingProvider::new(384)),
        SpaceState::Active { epoch: 1 },
        8 * 1024,
    );
    let services = GraphServices::new(
        ValidatedConfig::unchecked(config),
        store,
        engine,
        PolicyEnforcer::new(Arc::new(AllowInOwnTenant)),
        embedding,
    );
    Arc::new(GraphStorageLocalClient::new(Arc::new(services)))
}

/// A caller in `tenant`.
pub fn ctx(tenant: Uuid) -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::now_v7())
        .subject_tenant_id(tenant)
        .build()
        .expect("a valid security context")
}
