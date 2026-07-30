use std::sync::Arc;

use axum::extract::Path;
use axum::{Extension, Router};
use serde::{Deserialize, Serialize};
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_canonical_errors::{gts_id, resource_error};
use toolkit_security::SecurityContext;
use utoipa::ToSchema;
use uuid::Uuid;

use super::service::{Session, SessionService};

/// Errors attributable to an IDE session as a resource.
#[resource_error(gts_id!("cf.studio.session.session.v1~"))]
pub struct StudioSessionError;

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

/* ── DTOs ── */

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateSessionRequest {
    /// Workspace tenant id the IDE session is for.
    pub workspace_id: Uuid,
    /// Optional Git repository cloned into the workspace on first launch.
    #[serde(default)]
    pub repo_url: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SessionDto {
    pub id: Uuid,
    pub workspace_id: Uuid,
    /// starting | running | stopped
    pub state: String,
    /// Browser URL of the Theia IDE (loopback-published).
    pub url: String,
    pub created_at_epoch_secs: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_url: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SessionListDto {
    pub items: Vec<SessionDto>,
}

fn to_dto(svc: &SessionService, s: Session) -> SessionDto {
    SessionDto {
        id: s.id,
        workspace_id: s.workspace_id,
        state: s.state.as_str().to_string(),
        url: svc.session_url(s.port),
        created_at_epoch_secs: s.created_at_epoch_secs,
        repo_url: s.repo_url,
    }
}

/* ── Handlers ── */

async fn create_session(
    Extension(ctx): Extension<SecurityContext>,
    Extension(svc): Extension<Arc<SessionService>>,
    Json(req): Json<CreateSessionRequest>,
) -> ApiResult<impl IntoResponse> {
    let (session, existed) = svc
        .create(
            ctx.subject_tenant_id(),
            ctx.subject_id(),
            req.workspace_id,
            req.repo_url,
        )
        .await
        .map_err(|e| CanonicalError::internal(format!("session launch failed: {e:#}")).create())?;
    let status = if existed { StatusCode::OK } else { StatusCode::CREATED };
    Ok((status, Json(to_dto(&svc, session))))
}

async fn list_sessions(
    Extension(ctx): Extension<SecurityContext>,
    Extension(svc): Extension<Arc<SessionService>>,
) -> ApiResult<JsonBody<SessionListDto>> {
    let items = svc
        .list(ctx.subject_tenant_id())
        .await
        .into_iter()
        .map(|s| to_dto(&svc, s))
        .collect();
    Ok(Json(SessionListDto { items }))
}

async fn get_session(
    Extension(ctx): Extension<SecurityContext>,
    Extension(svc): Extension<Arc<SessionService>>,
    Path(id): Path<Uuid>,
) -> ApiResult<JsonBody<SessionDto>> {
    let session = svc.get(ctx.subject_tenant_id(), id).await.ok_or_else(|| {
        StudioSessionError::not_found("Session not found")
            .with_resource(id.to_string())
            .create()
    })?;
    Ok(Json(to_dto(&svc, session)))
}

async fn delete_session(
    Extension(ctx): Extension<SecurityContext>,
    Extension(svc): Extension<Arc<SessionService>>,
    Path(id): Path<Uuid>,
) -> ApiResult<impl IntoResponse> {
    let removed = svc
        .stop(ctx.subject_tenant_id(), id)
        .await
        .map_err(|e| CanonicalError::internal(format!("session stop failed: {e:#}")).create())?;
    if !removed {
        return Err(StudioSessionError::not_found("Session not found")
            .with_resource(id.to_string())
            .create());
    }
    Ok(StatusCode::NO_CONTENT)
}

/* ── Routes ── */

pub fn register_routes(
    mut router: Router,
    openapi: &dyn OpenApiRegistry,
    service: Arc<SessionService>,
) -> Router {
    router = OperationBuilder::post("/studio-session/v1/sessions")
        .operation_id("studio_session.create_session")
        .summary("Launch (or reuse) a Theia IDE session for a workspace")
        .description(
            "Starts a per-workspace IDE container. Idempotent per workspace: \
             an existing non-stopped session is returned with 200.",
        )
        .tag("StudioSessions")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<CreateSessionRequest>(openapi, "Session parameters")
        .handler(create_session)
        .json_response_with_schema::<SessionDto>(openapi, StatusCode::CREATED, "Session created")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-session/v1/sessions")
        .operation_id("studio_session.list_sessions")
        .summary("List IDE sessions of the caller's tenant")
        .tag("StudioSessions")
        .authenticated()
        .require_license_features::<License>([])
        .handler(list_sessions)
        .json_response_with_schema::<SessionListDto>(openapi, StatusCode::OK, "Sessions")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-session/v1/sessions/{id}")
        .operation_id("studio_session.get_session")
        .summary("Get one IDE session (state refreshes to running when ready)")
        .tag("StudioSessions")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("id", "Session id")
        .handler(get_session)
        .json_response_with_schema::<SessionDto>(openapi, StatusCode::OK, "Session")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::delete("/studio-session/v1/sessions/{id}")
        .operation_id("studio_session.delete_session")
        .summary("Stop and remove an IDE session")
        .tag("StudioSessions")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("id", "Session id")
        .handler(delete_session)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router.layer(Extension(service))
}
