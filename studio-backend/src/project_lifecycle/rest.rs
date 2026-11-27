//! Project lifecycle's routes: a project's phase, a move along the
//! lifecycle, and every project's phase in an organization. Served on
//! studio-kits through the kit-runtime port; `PUT /project-phase` is claimed
//! by the kit (`builtin/project-lifecycle.kit.json`), so it answers
//! `KIT_NOT_INSTALLED` where the kit does not apply.

use std::sync::Arc;

use axum::{Extension, Router, extract::Query};
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::phase::{Phase, ProjectLifecycle};
use crate::kit_registry::runtime::{ProjectKitQuery, refused};
use crate::org_scope::{OrgAccess, OrgCtx};
use crate::pagination::{PageQuery, page_of};

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

/// A move a project's phase may make.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct PhaseMoveDto {
    /// The lifecycle's name for it (`start` when the project has no phase).
    pub transition: String,
    pub to: String,
}

/// A project's phase (Project lifecycle, a built-in kit).
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ProjectPhaseDto {
    pub project_id: String,
    /// Project lifecycle applies to the project; everything else is empty
    /// when it does not.
    pub installed: bool,
    pub phase: Option<String>,
    /// Who moves it on: a subject id.
    pub phase_owner: Option<String>,
    /// When it entered its phase, RFC 3339.
    pub phase_since: Option<String>,
    /// The lifecycle's phases, in order.
    pub states: Vec<String>,
    /// The moves open from the current phase.
    pub next: Vec<PhaseMoveDto>,
}

/// Move a project to a phase.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SetProjectPhaseDto {
    pub phase: String,
    /// Who moves it on from there; the project's current owner, else the
    /// caller, when absent.
    pub owner: Option<String>,
}

/// One project's phase in an organization's list.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ProjectPhaseRowDto {
    pub project_id: String,
    pub phase: String,
    pub phase_owner: Option<String>,
    pub phase_since: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ProjectPhaseListDto {
    /// Project lifecycle applies to the organization.
    pub installed: bool,
    pub items: Vec<ProjectPhaseRowDto>,
    pub total: u32,
}

fn phase_dto(project: Uuid, p: Phase) -> ProjectPhaseDto {
    ProjectPhaseDto {
        project_id: project.to_string(),
        installed: p.installed,
        phase: p.phase,
        phase_owner: p.owner,
        phase_since: p.since,
        states: p.states,
        next: p
            .next
            .into_iter()
            .map(|(transition, to)| PhaseMoveDto { transition, to })
            .collect(),
    }
}

async fn get_project_phase(
    Extension(ctx): Extension<SecurityContext>,
    Extension(access): Extension<OrgAccess>,
    Extension(lifecycle): Extension<Arc<ProjectLifecycle>>,
    Query(ProjectKitQuery { project_id }): Query<ProjectKitQuery>,
) -> ApiResult<JsonBody<ProjectPhaseDto>> {
    let ctx = crate::org_scope::resolve(access.0.as_ref(), &ctx, Some(project_id)).await?;
    let phase = lifecycle
        .project_phase(&ctx, project_id)
        .await
        .map_err(refused)?;
    Ok(Json(phase_dto(project_id, phase)))
}

async fn put_project_phase(
    Extension(ctx): Extension<SecurityContext>,
    Extension(access): Extension<OrgAccess>,
    Extension(lifecycle): Extension<Arc<ProjectLifecycle>>,
    Query(ProjectKitQuery { project_id }): Query<ProjectKitQuery>,
    Json(body): Json<SetProjectPhaseDto>,
) -> ApiResult<JsonBody<ProjectPhaseDto>> {
    let ctx = crate::org_scope::resolve(access.0.as_ref(), &ctx, Some(project_id)).await?;
    let phase = lifecycle
        .set_project_phase(&ctx, project_id, &body.phase, body.owner.as_deref())
        .await
        .map_err(refused)?;
    Ok(Json(phase_dto(project_id, phase)))
}

async fn list_project_phases(
    OrgCtx(ctx): OrgCtx,
    Extension(lifecycle): Extension<Arc<ProjectLifecycle>>,
    Query(page): Query<PageQuery>,
) -> ApiResult<JsonBody<ProjectPhaseListDto>> {
    let (installed, rows) = lifecycle
        .project_phases(&ctx, ctx.subject_tenant_id())
        .await
        .map_err(refused)?;
    let items: Vec<ProjectPhaseRowDto> = rows
        .into_iter()
        .map(
            |(project_id, phase, phase_owner, phase_since)| ProjectPhaseRowDto {
                project_id,
                phase,
                phase_owner,
                phase_since,
            },
        )
        .collect();
    let (items, total) = page_of(items, page);
    Ok(Json(ProjectPhaseListDto {
        installed,
        items,
        total,
    }))
}

/// The kit's routes, with its function layered on.
pub fn register_routes(
    mut router: Router,
    openapi: &dyn OpenApiRegistry,
    lifecycle: Arc<ProjectLifecycle>,
    access: OrgAccess,
) -> Router {
    router = OperationBuilder::get("/studio-kits/v1/project-phase")
        .operation_id("studio_kits.get_project_phase")
        .summary("A project's phase (Project lifecycle)")
        .description(
            "Any member who reaches the project. The phase, its owner and since when, read from \
             the project's object in the organization's model, with the lifecycle's phases and \
             the moves open from the current one. `installed` is false, and the rest empty, \
             where Project lifecycle does not apply to the project.",
        )
        .tag("StudioKits")
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("project_id", true, "The project", "string")
        .handler(get_project_phase)
        .json_response_with_schema::<ProjectPhaseDto>(openapi, StatusCode::OK, "The phase")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::put("/studio-kits/v1/project-phase")
        .operation_id("studio_kits.update_project_phase")
        .summary("Move a project to a phase (Project lifecycle)")
        .description(
            "Only along a transition the kit's lifecycle declares (400 `failed_precondition`, \
             `NO_SUCH_TRANSITION`); a project with no phase may start in any. Sets `phase`, \
             `phase_owner` (`owner`, else the project's, else the caller) and `phase_since` on \
             the project's object, written as the caller: the PDP's `domain.edit` decides (403 \
             `DOMAIN_EDIT_REQUIRED`). Where Project lifecycle does not apply, 400 \
             `failed_precondition` (`KIT_NOT_INSTALLED`).",
        )
        .tag("StudioKits")
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("project_id", true, "The project", "string")
        .json_request::<SetProjectPhaseDto>(openapi, "The phase, and optionally its owner")
        .handler(put_project_phase)
        .json_response_with_schema::<ProjectPhaseDto>(openapi, StatusCode::OK, "The phase")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-kits/v1/project-phases")
        .operation_id("studio_kits.list_project_phases")
        .summary("Every project of an organization with its phase (Project lifecycle)")
        .description(
            "Any member. The projects whose object carries a phase, by project id. `installed` \
             is false, and the list empty, where Project lifecycle does not apply to the \
             organization.",
        )
        .tag("StudioKits")
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed(
            crate::org_scope::PARAM,
            false,
            crate::org_scope::PARAM_DOC,
            "string",
        )
        .query_param_typed(
            "offset",
            false,
            "Zero-based index of the first item",
            "integer",
        )
        .query_param_typed("limit", false, "Page size, 1..=200 (default 50)", "integer")
        .handler(list_project_phases)
        .json_response_with_schema::<ProjectPhaseListDto>(openapi, StatusCode::OK, "The phases")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router.layer(Extension(lifecycle)).layer(Extension(access))
}
