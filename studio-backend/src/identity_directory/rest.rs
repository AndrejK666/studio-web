use std::sync::Arc;

use axum::{Extension, Router, extract::Path};
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_canonical_errors::resource_error;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::service::{DirectoryIdentity, IdentityDirectoryService, PLATFORM_ROOT_TENANT_ID};

#[resource_error(gts_id!("cf.studio.identity.directory.v1~"))]
pub struct IdentityDirectoryError;

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct PlatformIdentityDto {
    pub id: String,
    pub username: String,
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub identity_provider: Option<String>,
    pub first_seen_at_epoch_ms: Option<i64>,
    pub status: String,
    #[schema(value_type = Option<String>)]
    pub home_tenant_id: Option<Uuid>,
    pub home_tenant_name: Option<String>,
    pub organization_role: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct AssignIdentityRequest {
    #[schema(value_type = String)]
    pub tenant_id: Uuid,
    /// Organization-level designation. Access roles inside projects remain
    /// managed independently by the organization's People/Access screens.
    pub role: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct PlatformIdentityListDto {
    pub items: Vec<PlatformIdentityDto>,
    /// `true` when the realm holds more identities than one read of it takes.
    ///
    /// Sorting happens after reading, so a partial read is not the first page
    /// of this list — it is a different set of people, and the ones waiting to
    /// be placed may be among those missing. A screen that shows the list
    /// without saying this looks complete and is not.
    pub truncated: bool,
}

fn to_dto(identity: DirectoryIdentity) -> PlatformIdentityDto {
    PlatformIdentityDto {
        id: identity.id,
        username: identity.username,
        email: identity.email,
        display_name: identity.display_name,
        identity_provider: identity.identity_provider,
        first_seen_at_epoch_ms: identity.first_seen_at_epoch_ms,
        status: identity.status.to_owned(),
        home_tenant_id: identity.home_tenant_id,
        home_tenant_name: identity.home_tenant_name,
        organization_role: identity.organization_role,
    }
}

fn require_platform_admin(ctx: &SecurityContext) -> ApiResult<()> {
    if ctx.subject_tenant_id() != PLATFORM_ROOT_TENANT_ID {
        return Err(IdentityDirectoryError::permission_denied()
            .with_reason("PLATFORM_ADMIN_REQUIRED")
            .create());
    }
    Ok(())
}

fn configured_service(
    service: Option<Arc<IdentityDirectoryService>>,
) -> ApiResult<Arc<IdentityDirectoryService>> {
    service.ok_or_else(|| {
        CanonicalError::service_unavailable()
            .with_detail(
                "identity directory is not configured; set the Keycloak admin base URL and secret",
            )
            .create()
    })
}

async fn list_identities(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityDirectoryService>>>,
) -> ApiResult<JsonBody<PlatformIdentityListDto>> {
    require_platform_admin(&ctx)?;
    let service = configured_service(service)?;
    let directory = service.list(&ctx).await.map_err(|error| {
        CanonicalError::internal(format!("identity directory failed: {error:#}")).create()
    })?;
    Ok(Json(PlatformIdentityListDto {
        items: directory.identities.into_iter().map(to_dto).collect(),
        truncated: directory.truncated,
    }))
}

async fn assign_identity(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Option<Arc<IdentityDirectoryService>>>,
    Path(identity_id): Path<String>,
    Json(req): Json<AssignIdentityRequest>,
) -> ApiResult<StatusCode> {
    require_platform_admin(&ctx)?;
    let role = req.role.trim().to_ascii_lowercase();
    if !matches!(role.as_str(), "owner" | "member") {
        return Err(IdentityDirectoryError::invalid_argument()
            .with_constraint("role must be owner or member")
            .create());
    }
    configured_service(service)?
        .assign(&ctx, &identity_id, req.tenant_id, &role)
        .await
        .map_err(|error| {
            CanonicalError::internal(format!("identity assignment failed: {error:#}")).create()
        })?;
    Ok(StatusCode::NO_CONTENT)
}

pub fn register_routes(
    router: Router,
    openapi: &dyn OpenApiRegistry,
    service: Option<Arc<IdentityDirectoryService>>,
) -> Router {
    let router = OperationBuilder::get("/studio-identity/v1/users")
        .operation_id("studio_identity.list_users")
        .summary("List identities known to Studio's Keycloak realm")
        .description(
            "Platform-admin-only identity directory. Includes authenticated but unassigned users; \
             organization owners must use their tenant-scoped People endpoint instead. Newest \
             first. The realm is read a page at a time up to a ceiling, and `truncated` says \
             whether that ceiling was reached — the list is then part of the directory rather \
             than its first page, since the sort happens after the read.",
        )
        .tag("StudioIdentity")
        .authenticated()
        .require_license_features::<License>([])
        .handler(list_identities)
        .json_response_with_schema::<PlatformIdentityListDto>(
            openapi,
            StatusCode::OK,
            "Identity directory",
        )
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi)
        .layer(Extension(service.clone()));

    OperationBuilder::post("/studio-identity/v1/users/{identity_id}/assignment")
        .operation_id("studio_identity.assign_user")
        .summary("Assign an identity to an organization")
        .description(
            "Platform-admin-only onboarding action. Updates the Keycloak tenant membership and the organization-level Owner/Member designation.",
        )
        .tag("StudioIdentity")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("identity_id", "Keycloak user id")
        .json_request::<AssignIdentityRequest>(openapi, "Organization assignment")
        .handler(assign_identity)
        .no_content_response(StatusCode::NO_CONTENT, "Identity assigned")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi)
        .layer(Extension(service))
}
