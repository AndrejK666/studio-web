//! Who reads the artifact listings (`GET /nodes`, `GET /runs`): the question
//! `POST /studio-domain-model/v1/query` asks of the same objects (ADR-0035).
//!
//! The gear reads its records as itself (`KeptByGear`, ADR-0066 §8a), so the
//! store hands over whatever is in the scope. These routes ask the
//! domain-object policy for `domain.view` as the caller, in the organization
//! the scope hangs under, and keep only the artifacts whose owner (their
//! project, else their workspace, else the organization: the `_scope` the
//! model keeps them under) the answer admits, as the query does. No grant is a
//! 403; a policy that cannot be asked is a 503, never everything.

use serde_json::Value;
use toolkit::api::canonical_prelude::*;
use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::graph::GtsNode;
use super::rest::StudioArtifactIngestError;
use crate::domain_model::port::{Access, AccessError, DomainObjects, access_error};

/// The model type `type_filter` names, when it names exactly one: sent with
/// the question, as the query sends the type it reads.
pub(super) fn entity_of(type_filter: Option<&str>) -> Option<&'static str> {
    match super::gts::resolve_listable_types(type_filter).as_slice() {
        [one] => super::model_store::entity_of(one),
        _ => None,
    }
}

/// What `ctx` may read of `entity`'s artifacts, or the refusal as the
/// routes answer it.
pub(super) async fn ask(
    hub: &ClientHub,
    ctx: &SecurityContext,
    entity: Option<&str>,
) -> ApiResult<Access> {
    let port = hub.get::<dyn DomainObjects>().map_err(|_| {
        CanonicalError::service_unavailable()
            .with_detail("authorization unavailable: the domain model is not available")
            .create()
    })?;
    port.read_access(ctx, entity).await.map_err(|e| refusal(&e))
}

/// 403 for a refusal, 503 for anything else: an answer that is not a grant
/// is never read as one.
fn refusal(e: &anyhow::Error) -> CanonicalError {
    match access_error(e) {
        Some(AccessError::Unavailable(m)) => CanonicalError::service_unavailable()
            .with_detail(format!("authorization unavailable: {m}"))
            .create(),
        Some(_) => StudioArtifactIngestError::permission_denied()
            .with_reason("DOMAIN_OBJECT_ACCESS_DENIED")
            .create(),
        None => CanonicalError::service_unavailable()
            .with_detail(format!("authorization unavailable: {e:#}"))
            .create(),
    }
}

/// The tenant an artifact belongs to for authorization.
fn owner(access: &Access, value: &Value) -> Uuid {
    let scope = ["project_id", "workspace_id"]
        .iter()
        .find_map(|k| value.get(*k).and_then(Value::as_str));
    access.owner_of_scope(scope)
}

/// May the caller read what is owned by `scope` itself?
pub(super) async fn admits_scope(access: &Access, ctx: &SecurityContext, scope: &str) -> bool {
    access
        .admits_owner(ctx, access.owner_of_scope(Some(scope)))
        .await
}

/// May the caller read `value`, an artifact's payload?
pub(super) async fn admits(access: &Access, ctx: &SecurityContext, value: &Value) -> bool {
    access.admits_owner(ctx, owner(access, value)).await
}

/// The nodes the caller may read, in their order.
pub(super) async fn retain(
    access: &Access,
    ctx: &SecurityContext,
    nodes: Vec<GtsNode>,
) -> Vec<GtsNode> {
    if access.is_unconstrained() {
        return nodes;
    }
    let mut out = Vec::with_capacity(nodes.len());
    for n in nodes {
        if admits(access, ctx, &n.value).await {
            out.push(n);
        }
    }
    out
}
