//! Routes for ADR-0081's records: the platform's roles, its resources granted
//! to an organization, and the terms a person accepts.
//!
//! Who the caller is (their person id, whether they administer the platform,
//! their organizations) is read from the identity service here; the rules are
//! [`PlatformAccess`]'s.

use std::sync::Arc;

use axum::{
    Extension, Router,
    extract::{Path, Query},
};
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::platform_access::{Caller, Grant, PlatformAccess, Refusal, Terms};
use super::rest::UserProfileError;
use super::service::IdentityService;

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

/// The services a route needs: both, or 503.
type Services = (Arc<IdentityService>, Arc<PlatformAccess>);

fn services(
    identity: Option<Arc<IdentityService>>,
    access: Option<Arc<PlatformAccess>>,
) -> ApiResult<Services> {
    match (identity, access) {
        (Some(i), Some(a)) => Ok((i, a)),
        _ => Err(CanonicalError::service_unavailable()
            .with_detail("studio-user has no database configured")
            .create()),
    }
}

fn internal(error: &anyhow::Error) -> CanonicalError {
    CanonicalError::internal(format!("studio-user failed: {error:#}")).create()
}

fn refused(refusal: Refusal) -> CanonicalError {
    match refusal {
        Refusal::Forbidden(reason) => UserProfileError::permission_denied()
            .with_reason(reason)
            .create(),
        Refusal::Invalid(why) => UserProfileError::invalid_argument()
            .with_constraint(why)
            .create(),
        Refusal::NotFound => UserProfileError::not_found("not found".to_owned())
            .with_resource("platform".to_owned())
            .create(),
        Refusal::Stale(latest) => UserProfileError::failed_precondition()
            .with_precondition_violation(
                "version".to_owned(),
                format!("the latest version is {latest}; read it and accept that one"),
                "TERMS_VERSION_STALE",
            )
            .create(),
        Refusal::Internal(e) => internal(&e),
    }
}

async fn caller(ctx: &SecurityContext, identity: &IdentityService) -> ApiResult<Caller> {
    let person = identity
        .resolve_caller(ctx)
        .await
        .map_err(|e| internal(&e))?;
    Ok(Caller {
        person: parse_uuid(&person, "person")?,
        administrator: identity
            .is_platform_admin(&ctx.subject_id().to_string())
            .await
            .unwrap_or(false),
    })
}

fn parse_uuid(raw: &str, what: &str) -> ApiResult<Uuid> {
    Uuid::parse_str(raw.trim()).map_err(|_| {
        UserProfileError::invalid_argument()
            .with_constraint(format!("`{raw}` is not a {what} id"))
            .create()
    })
}

/// The caller's active memberships: `(organization, role)`.
async fn memberships(identity: &IdentityService, person: Uuid) -> ApiResult<Vec<(Uuid, String)>> {
    Ok(identity
        .list_memberships(&person.to_string())
        .await
        .map_err(|e| internal(&e))?
        .into_iter()
        .filter(|m| m.status == "active")
        .filter_map(|m| Some((Uuid::parse_str(&m.org_id).ok()?, m.role)))
        .collect())
}

/// The caller's role in `org`, refused unless they are an active member.
async fn role_in(identity: &IdentityService, person: Uuid, org: Uuid) -> ApiResult<String> {
    memberships(identity, person)
        .await?
        .into_iter()
        .find(|(o, _)| *o == org)
        .map(|(_, role)| role)
        .ok_or_else(|| {
            refused(Refusal::Forbidden(
                super::platform_access::ORG_MEMBER_REQUIRED,
            ))
        })
}

// ── DTOs ─────────────────────────────────────────────────────────────────────

/// The caller's platform roles.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct MyPlatformRolesDto {
    /// `operator`, `code_owner`, `account_manager`; every one for an
    /// administrator.
    pub roles: Vec<String>,
    /// Whether the caller administers the platform.
    pub administrator: bool,
}

/// One person's platform roles.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct PlatformRoleHolderDto {
    pub person_id: String,
    pub roles: Vec<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct PlatformRoleHolderListDto {
    pub items: Vec<PlatformRoleHolderDto>,
    pub total: u32,
}

/// The roles a person is to hold, all of them.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SetPlatformRolesRequest {
    /// Exactly the roles the person holds afterwards; `[]` takes every one.
    pub roles: Vec<String>,
}

/// A platform resource granted to one organization.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct PlatformGrantDto {
    pub id: String,
    /// A kit's word for the resource (`repository`).
    pub kind: String,
    pub resource: String,
    pub organization_id: String,
    pub granted_by: String,
    pub granted_at_epoch_ms: i64,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct PlatformGrantListDto {
    pub items: Vec<PlatformGrantDto>,
    pub total: u32,
}

/// Grant a resource to an organization.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct CreatePlatformGrantRequest {
    pub kind: String,
    pub resource: String,
    pub organization_id: String,
}

#[derive(Debug, serde::Deserialize)]
pub struct GrantQuery {
    #[serde(default)]
    organization_id: Option<String>,
    #[serde(default)]
    kind: Option<String>,
}

/// One version of an audience's terms.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct TermsDto {
    /// `organization_admin` or `member`.
    pub audience: String,
    pub version: i32,
    pub title: String,
    pub body: String,
    pub published_by: String,
    pub published_at_epoch_ms: i64,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct TermsListDto {
    pub items: Vec<TermsDto>,
    pub total: u32,
}

/// Publish the next version of an audience's terms.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct PublishTermsRequest {
    pub audience: String,
    pub title: String,
    pub body: String,
}

/// Accept a version of an audience's terms in an organization.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct AcceptTermsRequest {
    pub organization_id: String,
    pub audience: String,
    pub version: i32,
}

#[derive(Debug, serde::Deserialize)]
pub struct MyTermsQuery {
    organization_id: String,
}

fn ms(at: time::OffsetDateTime) -> i64 {
    (at.unix_timestamp_nanos() / 1_000_000) as i64
}

fn grant_dto(g: Grant) -> PlatformGrantDto {
    PlatformGrantDto {
        id: g.id.to_string(),
        kind: g.kind,
        resource: g.resource,
        organization_id: g.organization_id.to_string(),
        granted_by: g.granted_by,
        granted_at_epoch_ms: ms(g.granted_at),
    }
}

fn terms_dto(t: Terms) -> TermsDto {
    TermsDto {
        audience: t.audience,
        version: t.version,
        title: t.title,
        body: t.body,
        published_by: t.published_by,
        published_at_epoch_ms: ms(t.published_at),
    }
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

// ── Handlers ─────────────────────────────────────────────────────────────────

async fn get_my_platform_roles(
    Extension(ctx): Extension<SecurityContext>,
    Extension(identity): Extension<Option<Arc<IdentityService>>>,
    Extension(access): Extension<Option<Arc<PlatformAccess>>>,
) -> ApiResult<JsonBody<MyPlatformRolesDto>> {
    let (identity, access) = services(identity, access)?;
    let me = caller(&ctx, &identity).await?;
    let roles = access.roles(&me).await.map_err(|e| internal(&e))?;
    Ok(Json(MyPlatformRolesDto {
        roles,
        administrator: me.administrator,
    }))
}

async fn list_platform_roles(
    Extension(ctx): Extension<SecurityContext>,
    Extension(identity): Extension<Option<Arc<IdentityService>>>,
    Extension(access): Extension<Option<Arc<PlatformAccess>>>,
) -> ApiResult<JsonBody<PlatformRoleHolderListDto>> {
    let (identity, access) = services(identity, access)?;
    let me = caller(&ctx, &identity).await?;
    let items: Vec<PlatformRoleHolderDto> = access
        .list_roles(&me)
        .await
        .map_err(refused)?
        .into_iter()
        .map(|(person, roles)| PlatformRoleHolderDto {
            person_id: person.to_string(),
            roles,
        })
        .collect();
    Ok(Json(PlatformRoleHolderListDto {
        total: count(items.len()),
        items,
    }))
}

async fn update_platform_roles(
    Extension(ctx): Extension<SecurityContext>,
    Extension(identity): Extension<Option<Arc<IdentityService>>>,
    Extension(access): Extension<Option<Arc<PlatformAccess>>>,
    Path(person_id): Path<String>,
    Json(body): Json<SetPlatformRolesRequest>,
) -> ApiResult<JsonBody<PlatformRoleHolderDto>> {
    let (identity, access) = services(identity, access)?;
    let me = caller(&ctx, &identity).await?;
    let person = parse_uuid(&person_id, "person")?;
    let roles = access
        .set_roles(&ctx, &me, person, &body.roles)
        .await
        .map_err(refused)?;
    Ok(Json(PlatformRoleHolderDto {
        person_id: person.to_string(),
        roles,
    }))
}

async fn list_platform_grants(
    Extension(ctx): Extension<SecurityContext>,
    Extension(identity): Extension<Option<Arc<IdentityService>>>,
    Extension(access): Extension<Option<Arc<PlatformAccess>>>,
    Query(query): Query<GrantQuery>,
) -> ApiResult<JsonBody<PlatformGrantListDto>> {
    let (identity, access) = services(identity, access)?;
    let me = caller(&ctx, &identity).await?;
    let organization = match query.organization_id.as_deref().map(str::trim) {
        Some(o) if !o.is_empty() => Some(parse_uuid(o, "organization")?),
        _ => None,
    };
    let member_of: Vec<Uuid> = memberships(&identity, me.person)
        .await?
        .into_iter()
        .map(|(o, _)| o)
        .collect();
    let items: Vec<PlatformGrantDto> = access
        .grants(&me, &member_of, organization, query.kind.as_deref())
        .await
        .map_err(refused)?
        .into_iter()
        .map(grant_dto)
        .collect();
    Ok(Json(PlatformGrantListDto {
        total: count(items.len()),
        items,
    }))
}

async fn create_platform_grant(
    Extension(ctx): Extension<SecurityContext>,
    Extension(identity): Extension<Option<Arc<IdentityService>>>,
    Extension(access): Extension<Option<Arc<PlatformAccess>>>,
    Json(body): Json<CreatePlatformGrantRequest>,
) -> ApiResult<JsonBody<PlatformGrantDto>> {
    let (identity, access) = services(identity, access)?;
    let me = caller(&ctx, &identity).await?;
    let org = parse_uuid(&body.organization_id, "organization")?;
    let grant = access
        .grant(&ctx, &me, &body.kind, &body.resource, org)
        .await
        .map_err(refused)?;
    Ok(Json(grant_dto(grant)))
}

async fn delete_platform_grant(
    Extension(ctx): Extension<SecurityContext>,
    Extension(identity): Extension<Option<Arc<IdentityService>>>,
    Extension(access): Extension<Option<Arc<PlatformAccess>>>,
    Path(grant_id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    let (identity, access) = services(identity, access)?;
    let me = caller(&ctx, &identity).await?;
    let id = parse_uuid(&grant_id, "grant")?;
    access.revoke(&ctx, &me, id).await.map_err(refused)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_terms(
    Extension(identity): Extension<Option<Arc<IdentityService>>>,
    Extension(access): Extension<Option<Arc<PlatformAccess>>>,
) -> ApiResult<JsonBody<TermsListDto>> {
    let (_, access) = services(identity, access)?;
    let items: Vec<TermsDto> = access
        .latest_terms()
        .await
        .map_err(|e| internal(&e))?
        .into_iter()
        .map(terms_dto)
        .collect();
    Ok(Json(TermsListDto {
        total: count(items.len()),
        items,
    }))
}

async fn publish_terms(
    Extension(ctx): Extension<SecurityContext>,
    Extension(identity): Extension<Option<Arc<IdentityService>>>,
    Extension(access): Extension<Option<Arc<PlatformAccess>>>,
    Json(body): Json<PublishTermsRequest>,
) -> ApiResult<JsonBody<TermsDto>> {
    let (identity, access) = services(identity, access)?;
    let me = caller(&ctx, &identity).await?;
    let terms = access
        .publish_terms(&ctx, &me, &body.audience, &body.title, &body.body)
        .await
        .map_err(refused)?;
    Ok(Json(terms_dto(terms)))
}

async fn list_my_terms(
    Extension(ctx): Extension<SecurityContext>,
    Extension(identity): Extension<Option<Arc<IdentityService>>>,
    Extension(access): Extension<Option<Arc<PlatformAccess>>>,
    Query(query): Query<MyTermsQuery>,
) -> ApiResult<JsonBody<TermsListDto>> {
    let (identity, access) = services(identity, access)?;
    let me = caller(&ctx, &identity).await?;
    let org = parse_uuid(&query.organization_id, "organization")?;
    let role = role_in(&identity, me.person, org).await?;
    let items: Vec<TermsDto> = access
        .pending(me.person, org, &role)
        .await
        .map_err(|e| internal(&e))?
        .into_iter()
        .map(terms_dto)
        .collect();
    Ok(Json(TermsListDto {
        total: count(items.len()),
        items,
    }))
}

async fn accept_my_terms(
    Extension(ctx): Extension<SecurityContext>,
    Extension(identity): Extension<Option<Arc<IdentityService>>>,
    Extension(access): Extension<Option<Arc<PlatformAccess>>>,
    Json(body): Json<AcceptTermsRequest>,
) -> ApiResult<impl IntoResponse> {
    let (identity, access) = services(identity, access)?;
    let me = caller(&ctx, &identity).await?;
    let org = parse_uuid(&body.organization_id, "organization")?;
    let role = role_in(&identity, me.person, org).await?;
    access
        .accept(&ctx, me.person, org, &role, &body.audience, body.version)
        .await
        .map_err(refused)?;
    Ok(StatusCode::NO_CONTENT)
}

// ── Routes ───────────────────────────────────────────────────────────────────

#[allow(clippy::too_many_lines)] // one builder per route, read top to bottom
pub fn register_routes(
    router: Router,
    openapi: &dyn OpenApiRegistry,
    identity: Option<Arc<IdentityService>>,
    access: Option<Arc<PlatformAccess>>,
) -> Router {
    let layers = |r: Router| {
        r.layer(Extension(identity.clone()))
            .layer(Extension(access.clone()))
    };

    let router = layers(
        OperationBuilder::get("/studio-user/v1/me/platform-roles")
            .operation_id("studio_user.get_my_platform_roles")
            .summary("The caller's platform roles")
            .description(
                "`operator`, `code_owner`, `account_manager` (ADR-0081 §1). A platform \
                 administrator holds every one. A platform role is not a membership and \
                 grants nothing inside an organization.",
            )
            .tag("StudioUser")
            .authenticated()
            .require_license_features::<License>([])
            .handler(get_my_platform_roles)
            .json_response_with_schema::<MyPlatformRolesDto>(openapi, StatusCode::OK, "The roles")
            .error_401(openapi)
            .error_500(openapi)
            .error_503(openapi)
            .register(router, openapi),
    );

    let router = layers(
        OperationBuilder::get("/studio-user/v1/platform/roles")
            .operation_id("studio_user.list_platform_roles")
            .summary("Everybody who holds a platform role")
            .description(
                "Each person and the platform roles they were given (administrators hold \
                 every role without being listed). For a platform administrator.",
            )
            .tag("StudioUser")
            .authenticated()
            .require_license_features::<License>([])
            .handler(list_platform_roles)
            .json_response_with_schema::<PlatformRoleHolderListDto>(
                openapi,
                StatusCode::OK,
                "The holders",
            )
            .error_401(openapi)
            .error_403(openapi)
            .error_500(openapi)
            .error_503(openapi)
            .register(router, openapi),
    );

    let router = layers(
        OperationBuilder::put("/studio-user/v1/platform/roles/{person_id}")
            .operation_id("studio_user.update_platform_roles")
            .summary("Give a person exactly these platform roles")
            .description(
                "Replaces the person's platform roles; `[]` takes every one. For a platform \
                 administrator. Audited.",
            )
            .tag("StudioUser")
            .authenticated()
            .require_license_features::<License>([])
            .path_param("person_id", "Canonical Studio person id")
            .json_request::<SetPlatformRolesRequest>(openapi, "The roles")
            .handler(update_platform_roles)
            .json_response_with_schema::<PlatformRoleHolderDto>(
                openapi,
                StatusCode::OK,
                "The roles the person holds now",
            )
            .error_400(openapi)
            .error_401(openapi)
            .error_403(openapi)
            .error_404(openapi)
            .error_500(openapi)
            .error_503(openapi)
            .register(router, openapi),
    );

    let router = layers(
        OperationBuilder::get("/studio-user/v1/platform/grants")
            .operation_id("studio_user.list_platform_grants")
            .summary("Platform resources granted to organizations")
            .description(
                "Every grant for the platform's people (an administrator or any platform \
                 role); a member of an organization reads its grants only, and names it \
                 (`organization_id`). `kind` keeps one kind (ADR-0081 §2).",
            )
            .tag("StudioUser")
            .authenticated()
            .require_license_features::<License>([])
            .query_param(
                "organization_id",
                false,
                "Only the grants to this organization",
            )
            .query_param("kind", false, "Only grants of this kind")
            .handler(list_platform_grants)
            .json_response_with_schema::<PlatformGrantListDto>(
                openapi,
                StatusCode::OK,
                "The grants",
            )
            .error_400(openapi)
            .error_401(openapi)
            .error_403(openapi)
            .error_500(openapi)
            .error_503(openapi)
            .register(router, openapi),
    );

    let router = layers(
        OperationBuilder::post("/studio-user/v1/platform/grants")
            .operation_id("studio_user.create_platform_grant")
            .summary("Grant a platform resource to an organization")
            .description(
                "`(kind, resource, organization)`; granting it again answers the first grant. \
                 For a platform administrator or an account manager. Audited.",
            )
            .tag("StudioUser")
            .authenticated()
            .require_license_features::<License>([])
            .json_request::<CreatePlatformGrantRequest>(openapi, "The grant")
            .handler(create_platform_grant)
            .json_response_with_schema::<PlatformGrantDto>(openapi, StatusCode::OK, "The grant")
            .error_400(openapi)
            .error_401(openapi)
            .error_403(openapi)
            .error_500(openapi)
            .error_503(openapi)
            .register(router, openapi),
    );

    let router = layers(
        OperationBuilder::delete("/studio-user/v1/platform/grants/{grant_id}")
            .operation_id("studio_user.delete_platform_grant")
            .summary("Take a grant back")
            .description(
                "For a platform administrator or an account manager. The audit keeps that it \
                 existed.",
            )
            .tag("StudioUser")
            .authenticated()
            .require_license_features::<License>([])
            .path_param("grant_id", "Grant id")
            .handler(delete_platform_grant)
            .no_content_response(StatusCode::NO_CONTENT, "Removed")
            .error_400(openapi)
            .error_401(openapi)
            .error_403(openapi)
            .error_404(openapi)
            .error_500(openapi)
            .error_503(openapi)
            .register(router, openapi),
    );

    let router = layers(
        OperationBuilder::get("/studio-user/v1/platform/terms")
            .operation_id("studio_user.list_terms")
            .summary("The latest version of each audience's terms")
            .description(
                "`organization_admin` and `member` (ADR-0081 §3); an audience with no terms \
                 published is absent. For anybody signed in.",
            )
            .tag("StudioUser")
            .authenticated()
            .require_license_features::<License>([])
            .handler(list_terms)
            .json_response_with_schema::<TermsListDto>(openapi, StatusCode::OK, "The terms")
            .error_401(openapi)
            .error_500(openapi)
            .error_503(openapi)
            .register(router, openapi),
    );

    let router = layers(
        OperationBuilder::post("/studio-user/v1/platform/terms")
            .operation_id("studio_user.create_terms")
            .summary("Publish the next version of an audience's terms")
            .description(
                "Each publication is a new version; nothing is edited in place. Everybody the \
                 audience covers has the new version pending until they accept it. For a \
                 platform administrator or an operator. Audited.",
            )
            .tag("StudioUser")
            .authenticated()
            .require_license_features::<License>([])
            .json_request::<PublishTermsRequest>(openapi, "The audience, title and text")
            .handler(publish_terms)
            .json_response_with_schema::<TermsDto>(openapi, StatusCode::OK, "The published version")
            .error_400(openapi)
            .error_401(openapi)
            .error_403(openapi)
            .error_500(openapi)
            .error_503(openapi)
            .register(router, openapi),
    );

    let router = layers(
        OperationBuilder::get("/studio-user/v1/me/terms")
            .operation_id("studio_user.list_my_pending_terms")
            .summary("The terms the caller has yet to accept in an organization")
            .description(
                "The latest version of each audience that applies to the caller there \
                 (`member`; `organization_admin` too for an owner or an administrator), \
                 when newer than what they accepted. Empty when nothing is published. For a \
                 member of the organization.",
            )
            .tag("StudioUser")
            .authenticated()
            .require_license_features::<License>([])
            .query_param("organization_id", true, "The organization")
            .handler(list_my_terms)
            .json_response_with_schema::<TermsListDto>(openapi, StatusCode::OK, "The pending terms")
            .error_400(openapi)
            .error_401(openapi)
            .error_403(openapi)
            .error_500(openapi)
            .error_503(openapi)
            .register(router, openapi),
    );

    layers(
        OperationBuilder::post("/studio-user/v1/me/terms/acceptances")
            .operation_id("studio_user.create_my_terms_acceptance")
            .summary("Accept a version of an audience's terms in an organization")
            .description(
                "Only the latest version is accepted; an older one answers \
                 `TERMS_VERSION_STALE` with the latest. For a member of the organization the \
                 audience applies to. Audited.",
            )
            .tag("StudioUser")
            .authenticated()
            .require_license_features::<License>([])
            .json_request::<AcceptTermsRequest>(openapi, "The organization, audience and version")
            .handler(accept_my_terms)
            .no_content_response(StatusCode::NO_CONTENT, "Accepted")
            .error_400(openapi)
            .error_401(openapi)
            .error_403(openapi)
            .error_404(openapi)
            .error_500(openapi)
            .error_503(openapi)
            .register(router, openapi),
    )
}
