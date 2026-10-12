//! The platform's publication queue and its gear curators over REST
//! (ADR-0042 §4, `registry_curation.rs`).
//!
//! - `GET /platform/publication-requests` -- every organization's open
//!   requests, for a platform curator (a platform administrator or one of
//!   the platform's gear curators).
//! - `POST /platform/publication-requests/{name}/decisions?organization_id=`
//!   -- a curator's answer, `publish` (opens the pull request into the
//!   platform's gear repository; `dry_run` previews it) or
//!   `decline_publication` (with a reason), made acting in the requesting
//!   organization so it is recorded on its entry, as the decisions route
//!   would.
//! - `GET` / `PUT /platform/curators` -- who curates beside the platform's
//!   administrators; a curator reads it, only an administrator changes it.

use super::*;
use crate::components_catalog::registry_curation::{Curator, PublicationRequest};

/// One organization's request that the platform take one of its gears.
#[derive(Debug, Clone, PartialEq)]
#[toolkit_macros::api_dto(response)]
pub struct PublicationRequestDto {
    pub organization_id: Uuid,
    pub organization_name: Option<String>,
    /// The registry entry's name.
    pub name: String,
    pub version: Option<String>,
    pub reason: Option<String>,
    pub requested_by: String,
    pub requested_by_name: Option<String>,
    /// RFC 3339.
    pub at: String,
}

/// The platform's queue.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct PublicationRequestsDto {
    /// Oldest first; every open request, never paged.
    pub items: Vec<PublicationRequestDto>,
    pub total: u32,
}

/// A platform gear curator.
#[derive(Debug, Clone, PartialEq)]
#[toolkit_macros::api_dto(request, response)]
pub struct CuratorDto {
    /// Their Studio person id.
    pub id: String,
    pub name: Option<String>,
}

/// The platform's gear curators, and whether the caller may change them.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct CuratorsDto {
    /// Every curator, never paged.
    pub items: Vec<CuratorDto>,
    pub total: u32,
    /// A platform administrator: may replace the list.
    pub may_manage: bool,
}

/// The platform's gear curators, as they are to be.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SetCuratorsRequest {
    pub items: Vec<CuratorDto>,
}

fn request_dto(r: PublicationRequest) -> PublicationRequestDto {
    PublicationRequestDto {
        organization_id: r.organization_id,
        organization_name: r.organization_name,
        name: r.name,
        version: r.version,
        reason: r.reason,
        requested_by: r.requested_by,
        requested_by_name: r.requested_by_name,
        at: r.at,
    }
}

fn curator_dto(c: Curator) -> CuratorDto {
    CuratorDto {
        id: c.id,
        name: c.name,
    }
}

pub(super) async fn list_publication_requests(
    Extension(ctx): Extension<SecurityContext>,
    Extension(catalog): Extension<Catalog>,
) -> ApiResult<JsonBody<PublicationRequestsDto>> {
    if !catalog.may_curate(&ctx).await {
        return Err(curator_refusal());
    }
    let items = catalog
        .service
        .publication_requests(&ctx)
        .await
        .map_err(internal)?;
    Ok(Json(PublicationRequestsDto {
        total: items.len() as u32,
        items: items.into_iter().map(request_dto).collect(),
    }))
}

/// The requesting organization. Not `OrgCtx`: a curator need not be one of
/// its members, and acts in it for this one answer only.
#[derive(Debug, serde::Deserialize)]
pub(super) struct RequestingOrganization {
    pub(super) organization_id: Uuid,
}

pub(super) async fn decide_publication_request(
    Extension(ctx): Extension<SecurityContext>,
    Extension(catalog): Extension<Catalog>,
    Path(name): Path<String>,
    Query(RequestingOrganization { organization_id }): Query<RequestingOrganization>,
    Json(body): Json<RegistryDecisionRequest>,
) -> ApiResult<JsonBody<RegistryEntryDto>> {
    use super::super::registry_decisions::Action;
    if !matches!(
        Action::parse(&body.action),
        Some(Action::Publish | Action::DeclinePublication)
    ) {
        return Err(StudioComponentsCatalogError::invalid_argument()
            .with_field_violation(
                "action",
                "the platform answers a request with `publish` or `decline_publication`",
                "INVALID",
            )
            .create());
    }
    if !catalog.may_curate(&ctx).await {
        return Err(curator_refusal());
    }
    if catalog
        .service
        .publication_request(&ctx, organization_id, &name)
        .await
        .map_err(internal)?
        .is_none()
    {
        return Err(StudioComponentsCatalogError::not_found(format!(
            "no open publication request for `{name}` from organization {organization_id}"
        ))
        .with_resource(name)
        .create());
    }
    // Recorded on the organization's own entry, as the decisions route
    // would: the curator acts in the organization for this one answer.
    let org_ctx = super::super::registry::in_tenant(&ctx, organization_id).map_err(internal)?;
    decide_as(&catalog, &org_ctx, &name, decision_input(body))
        .await
        .map(Json)
}

pub(super) async fn list_curators(
    Extension(ctx): Extension<SecurityContext>,
    Extension(catalog): Extension<Catalog>,
) -> ApiResult<JsonBody<CuratorsDto>> {
    if !catalog.may_curate(&ctx).await {
        return Err(curator_refusal());
    }
    let items = catalog
        .service
        .gear_curators(&ctx)
        .await
        .map_err(internal)?;
    Ok(Json(CuratorsDto {
        total: items.len() as u32,
        items: items.into_iter().map(curator_dto).collect(),
        may_manage: catalog.may_run_the_platform(&ctx).await,
    }))
}

pub(super) async fn update_curators(
    Extension(ctx): Extension<SecurityContext>,
    Extension(catalog): Extension<Catalog>,
    Json(body): Json<SetCuratorsRequest>,
) -> ApiResult<JsonBody<CuratorsDto>> {
    if !catalog.may_run_the_platform(&ctx).await {
        return Err(platform_refusal());
    }
    let items = catalog
        .service
        .set_gear_curators(
            &ctx,
            body.items
                .into_iter()
                .map(|c| Curator {
                    id: c.id,
                    name: c.name,
                })
                .collect(),
        )
        .await
        .map_err(internal)?;
    Ok(Json(CuratorsDto {
        total: items.len() as u32,
        items: items.into_iter().map(curator_dto).collect(),
        may_manage: true,
    }))
}

pub(super) fn register(router: Router, openapi: &dyn OpenApiRegistry) -> Router {
    let router =
        OperationBuilder::get("/studio-components-catalog/v1/platform/publication-requests")
            .operation_id("studio_components_catalog.list_publication_requests")
            .summary("Every organization's open requests to give a gear to the platform")
            .description(
                "The platform's queue (ADR-0042 §4): one row per registry entry an \
                 organization administrator asked the platform to take \
                 (`request_publication`), oldest first, with who asked, the version \
                 and why. 403 (`PLATFORM_CURATOR_REQUIRED`) for anyone but a platform \
                 administrator or one of the platform's gear curators.",
            )
            .tag("StudioComponentsCatalog")
            .authenticated()
            .require_license_features::<License>([])
            .handler(list_publication_requests)
            .json_response_with_schema::<PublicationRequestsDto>(
                openapi,
                StatusCode::OK,
                "The queue",
            )
            .error_401(openapi)
            .error_403(openapi)
            .error_500(openapi)
            .register(router, openapi);
    let router = OperationBuilder::post(
        "/studio-components-catalog/v1/platform/publication-requests/{name}/decisions",
    )
    .operation_id("studio_components_catalog.decide_publication_request")
    .summary("A platform curator publishes or declines an organization's request")
    .description(
        "`publish` opens the pull request into the platform's gear repository, as \
         the decisions route's `publish` (`dry_run` answers `publish_preview` and \
         writes nothing); `decline_publication` turns it down with a `reason`. \
         Either is recorded on the organization's entry and takes the request out \
         of the queue. 403 (`PLATFORM_CURATOR_REQUIRED`) for anyone but a platform \
         curator; 404 when the organization has no open request for the entry; \
         400 for any other action, or what a publish refuses.",
    )
    .tag("StudioComponentsCatalog")
    .authenticated()
    .require_license_features::<License>([])
    .path_param("name", "Component name")
    .query_param(crate::org_scope::PARAM, true, "The requesting organization")
    .json_request::<RegistryDecisionRequest>(openapi, "`publish` or `decline_publication`")
    .handler(decide_publication_request)
    .json_response_with_schema::<RegistryEntryDto>(openapi, StatusCode::OK, "The entry")
    .error_400(openapi)
    .error_401(openapi)
    .error_403(openapi)
    .error_404(openapi)
    .error_500(openapi)
    .error_503(openapi)
    .register(router, openapi);
    let router = OperationBuilder::get("/studio-components-catalog/v1/platform/curators")
        .operation_id("studio_components_catalog.list_gear_curators")
        .summary("The platform's gear curators")
        .description(
            "Who may publish into the platform beside its administrators \
             (`platform-gear-curator`), and whether the caller may change the list \
             (a platform administrator). 403 for anyone but a platform curator.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .handler(list_curators)
        .json_response_with_schema::<CuratorsDto>(openapi, StatusCode::OK, "The curators")
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);
    OperationBuilder::put("/studio-components-catalog/v1/platform/curators")
        .operation_id("studio_components_catalog.update_gear_curators")
        .summary("Name the platform's gear curators")
        .description(
            "Replaces the list, each person once by their Studio id. 403 \
             (`PLATFORM_ADMIN_REQUIRED`) for anyone but a platform administrator.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<SetCuratorsRequest>(openapi, "The curators")
        .handler(update_curators)
        .json_response_with_schema::<CuratorsDto>(openapi, StatusCode::OK, "The curators")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi)
}
