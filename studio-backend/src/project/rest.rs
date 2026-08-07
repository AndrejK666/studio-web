//! REST surface for projects.
//!
//! Shapes follow the creation screen: the client picks a mode, ticks journey
//! stages, and — for a modernization — names a source. `GET /stages` exists so
//! the UI does not have to hardcode the catalogue that this gear validates
//! against; a stage list that disagrees with the server is a bug waiting to be
//! reported as "my checkbox does nothing".

use std::sync::Arc;

use axum::extract::{Path, Query};
use axum::{Extension, Router};
use serde::Deserialize;
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_canonical_errors::resource_error;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::model::{Mode, NewProject, Project, ProjectSource, STAGES, Status};
use super::service::{ProjectService, ServiceError};

/// Errors attributable to a project as a resource.
///
/// Five tokens in the segment, not four: a GTS segment is
/// `vendor.package.namespace.type.vN`, and `cf.studio.project.v1~` is rejected
/// at compile time with "Too few tokens (got 4, min 5)". `_` is the empty
/// namespace slot, the same placeholder the connector instance ids use.
#[resource_error(gts_id!("cf.studio._.project.v1~"))]
pub struct StudioProjectError;

/// Service handle. `None` = the gear booted without a database.
#[derive(Clone)]
pub struct Projects(pub Option<Arc<ProjectService>>);

impl Projects {
    fn get(&self) -> ApiResult<&Arc<ProjectService>> {
        self.0.as_ref().ok_or_else(|| {
            CanonicalError::service_unavailable()
                .with_detail("projects are not available in this deployment")
                .create()
        })
    }
}

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

/// Map a domain failure onto the canonical error the gateway renders.
///
/// `resource` is what the client used to address the thing — the id for reads
/// and writes, the name for a create that collided — so the error names
/// something the caller recognises instead of an id they never saw.
fn to_api(e: ServiceError, resource: &str) -> CanonicalError {
    match e {
        ServiceError::Invalid(v) => StudioProjectError::invalid_argument()
            .with_constraint(v.to_string())
            .create(),
        ServiceError::Conflict(m) => StudioProjectError::already_exists(m)
            .with_resource(resource.to_owned())
            .create(),
        ServiceError::NotFound => StudioProjectError::not_found("Project not found")
            .with_resource(resource.to_owned())
            .create(),
        ServiceError::Storage(m) => CanonicalError::internal(m).create(),
    }
}

/* ── DTOs ── */

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct StageDto {
    /// Wire key to send back in `stages`.
    pub key: String,
    /// Label to render.
    pub label: String,
    /// `true` = always applied; render it ticked and disabled.
    pub required: bool,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct StageListDto {
    /// In the order the screen should render them.
    pub items: Vec<StageDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct CreateProjectRequest {
    /// Unique within the workspace.
    pub name: String,
    /// `greenfield` ("Build Something New") | `modernize` ("Modernize Legacy Code").
    pub mode: String,
    /// Journey stage keys from `GET /stages`. Required stages are added for you.
    #[serde(default)]
    pub stages: Vec<String>,
    /// Greenfield: the product idea, pasted PRD or notes.
    #[serde(default)]
    pub brief: Option<String>,
    /// Modernize: repository to import. Mutually exclusive with `file_id`.
    #[serde(default)]
    pub git_url: Option<String>,
    /// Modernize: id of an archive already uploaded to the file-storage gear.
    /// Mutually exclusive with `git_url`.
    #[schema(value_type = Option<String>)]
    #[serde(default)]
    pub file_id: Option<Uuid>,
    /// Workspace the project belongs to. Omitted = the caller's own tenant.
    #[schema(value_type = Option<String>)]
    #[serde(default)]
    pub workspace_id: Option<Uuid>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct PatchProjectRequest {
    #[serde(default)]
    pub name: Option<String>,
    /// Full replacement of the selection, not a delta.
    #[serde(default)]
    pub stages: Option<Vec<String>>,
    /// `draft` | `active` | `archived`. Only forward; archived is terminal.
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ProjectDto {
    #[schema(value_type = String)]
    pub id: Uuid,
    #[schema(value_type = String)]
    pub workspace_id: Uuid,
    pub name: String,
    pub mode: String,
    pub status: String,
    pub stages: Vec<String>,
    pub brief: Option<String>,
    pub git_url: Option<String>,
    #[schema(value_type = Option<String>)]
    pub file_id: Option<Uuid>,
    /// Resource Group group holding the members, when there is one.
    #[schema(value_type = Option<String>)]
    pub members_group_id: Option<Uuid>,
    /// `false` when the project has no members group, so the UI can explain the
    /// missing member list instead of rendering an empty one.
    pub members_available: bool,
    #[schema(value_type = String)]
    pub created_by: Uuid,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ProjectListDto {
    pub items: Vec<ProjectDto>,
}

#[derive(Deserialize)]
struct TenantQuery {
    /// Workspace to read. Omitted = the caller's own tenant.
    tenant: Option<Uuid>,
}

fn to_dto(p: Project) -> ProjectDto {
    let (brief, git_url, file_id) = match &p.source {
        ProjectSource::Idea { brief } => (brief.clone(), None, None),
        ProjectSource::Git { url } => (None, Some(url.clone()), None),
        ProjectSource::Upload { file_id } => (None, None, Some(*file_id)),
    };
    ProjectDto {
        id: p.id,
        workspace_id: p.tenant_id,
        name: p.name.clone(),
        mode: p.mode().as_str().to_owned(),
        status: p.status.as_str().to_owned(),
        stages: p.stages.clone(),
        brief,
        git_url,
        file_id,
        members_group_id: p.rg_group_id,
        members_available: p.rg_group_id.is_some(),
        created_by: p.created_by,
        created_at: iso(p.created_at),
        updated_at: iso(p.updated_at),
    }
}

fn iso(t: time::OffsetDateTime) -> String {
    t.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| t.unix_timestamp().to_string())
}

/// Turn the request's three optional source fields into the domain's sum type.
///
/// This is where "two options" stops being two booleans: the mode decides which
/// shape is expected, and anything that does not fit exactly one is a 400 with
/// the reason rather than a half-populated row.
fn source_from(req: &CreateProjectRequest) -> Result<ProjectSource, CanonicalError> {
    let mode = Mode::parse(&req.mode).ok_or_else(|| {
        StudioProjectError::invalid_argument()
            .with_constraint(format!(
                "unknown mode '{}'; expected 'greenfield' or 'modernize'",
                req.mode
            ))
            .create()
    })?;

    let invalid = |msg: String| {
        StudioProjectError::invalid_argument()
            .with_constraint(msg)
            .create()
    };

    match mode {
        Mode::Greenfield => {
            if req.git_url.is_some() || req.file_id.is_some() {
                return Err(invalid(
                    "a greenfield project has nothing to import: drop git_url / file_id, \
                     or use mode 'modernize'"
                        .to_owned(),
                ));
            }
            Ok(ProjectSource::Idea { brief: req.brief.clone() })
        }
        Mode::Modernize => {
            if req.brief.is_some() {
                return Err(invalid(
                    "a modernization starts from code, not from a brief: drop brief, \
                     or use mode 'greenfield'"
                        .to_owned(),
                ));
            }
            match (req.git_url.as_deref(), req.file_id) {
                (Some(url), None) => Ok(ProjectSource::Git { url: url.to_owned() }),
                (None, Some(file_id)) => Ok(ProjectSource::Upload { file_id }),
                (Some(_), Some(_)) => Err(invalid(
                    "git_url and file_id are mutually exclusive — a project has one source"
                        .to_owned(),
                )),
                (None, None) => Err(invalid(
                    "a modernization needs a source: either git_url, or file_id of an \
                     archive uploaded to the file-storage gear"
                        .to_owned(),
                )),
            }
        }
    }
}

/* ── handlers ── */

async fn list_stages() -> ApiResult<JsonBody<StageListDto>> {
    Ok(Json(StageListDto {
        items: STAGES
            .iter()
            .map(|s| StageDto {
                key: s.key.to_owned(),
                label: s.label.to_owned(),
                required: s.required,
            })
            .collect(),
    }))
}

async fn list_projects(
    Extension(ctx): Extension<SecurityContext>,
    Extension(projects): Extension<Projects>,
    Query(q): Query<TenantQuery>,
) -> ApiResult<JsonBody<ProjectListDto>> {
    let svc = projects.get()?;
    let tenant = q.tenant.unwrap_or_else(|| ctx.subject_tenant_id());
    let items = svc
        .list(tenant)
        .await
        .map_err(|e| to_api(e, &tenant.to_string()))?;
    Ok(Json(ProjectListDto {
        items: items.into_iter().map(to_dto).collect(),
    }))
}

async fn create_project(
    Extension(ctx): Extension<SecurityContext>,
    Extension(projects): Extension<Projects>,
    Json(req): Json<CreateProjectRequest>,
) -> ApiResult<(StatusCode, JsonBody<ProjectDto>)> {
    let svc = projects.get()?;
    let source = source_from(&req)?;
    let tenant = req.workspace_id.unwrap_or_else(|| ctx.subject_tenant_id());

    let new = NewProject::build(tenant, ctx.subject_id(), &req.name, source, &req.stages)
        .map_err(|e| to_api(ServiceError::Invalid(e), &req.name))?;

    let project = svc
        .create(&ctx, new)
        .await
        .map_err(|e| to_api(e, &req.name))?;
    Ok((StatusCode::CREATED, Json(to_dto(project))))
}

async fn get_project(
    Extension(ctx): Extension<SecurityContext>,
    Extension(projects): Extension<Projects>,
    Path(id): Path<Uuid>,
    Query(q): Query<TenantQuery>,
) -> ApiResult<JsonBody<ProjectDto>> {
    let svc = projects.get()?;
    let tenant = q.tenant.unwrap_or_else(|| ctx.subject_tenant_id());
    let project = svc
        .get(tenant, id)
        .await
        .map_err(|e| to_api(e, &id.to_string()))?;
    Ok(Json(to_dto(project)))
}

async fn patch_project(
    Extension(ctx): Extension<SecurityContext>,
    Extension(projects): Extension<Projects>,
    Path(id): Path<Uuid>,
    Query(q): Query<TenantQuery>,
    Json(req): Json<PatchProjectRequest>,
) -> ApiResult<JsonBody<ProjectDto>> {
    let svc = projects.get()?;
    let tenant = q.tenant.unwrap_or_else(|| ctx.subject_tenant_id());

    let status = match req.status.as_deref() {
        None => None,
        Some(s) => Some(Status::parse(s).ok_or_else(|| {
            StudioProjectError::invalid_argument()
                .with_constraint(format!(
                    "unknown status '{s}'; expected 'draft', 'active' or 'archived'"
                ))
                .create()
        })?),
    };

    let project = svc
        .update(tenant, id, req.name.as_deref(), req.stages.as_deref(), status)
        .await
        .map_err(|e| to_api(e, &id.to_string()))?;
    Ok(Json(to_dto(project)))
}

async fn delete_project(
    Extension(ctx): Extension<SecurityContext>,
    Extension(projects): Extension<Projects>,
    Path(id): Path<Uuid>,
    Query(q): Query<TenantQuery>,
) -> ApiResult<StatusCode> {
    let svc = projects.get()?;
    let tenant = q.tenant.unwrap_or_else(|| ctx.subject_tenant_id());
    svc.delete(&ctx, tenant, id)
        .await
        .map_err(|e| to_api(e, &id.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}

/* ── routes ── */

const BASE: &str = "/studio-project/v1";

pub fn register_routes(
    mut router: Router,
    openapi: &dyn OpenApiRegistry,
    service: Option<Arc<ProjectService>>,
) -> Router {
    router = OperationBuilder::get(format!("{BASE}/stages"))
        .operation_id("studio_project.list_stages")
        .summary("Journey stages a project can select")
        .description(
            "The catalogue this gear validates against. Entries marked required are \
             applied whether or not the client sends them.",
        )
        .tag("StudioProjects")
        .authenticated()
        .require_license_features::<License>([])
        .handler(list_stages)
        .json_response_with_schema::<StageListDto>(openapi, StatusCode::OK, "Stage catalogue")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get(format!("{BASE}/projects"))
        .operation_id("studio_project.list_projects")
        .summary("List the workspace's projects")
        .tag("StudioProjects")
        .authenticated()
        .require_license_features::<License>([])
        .handler(list_projects)
        .json_response_with_schema::<ProjectListDto>(openapi, StatusCode::OK, "Projects")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post(format!("{BASE}/projects"))
        .operation_id("studio_project.create_project")
        .summary("Create a project")
        .description(
            "Two shapes, picked by `mode`: a greenfield project carries a brief and no \
             source; a modernization carries exactly one source (git_url or file_id) and \
             no brief. Uploads go to the file-storage gear first — only the id is stored \
             here. The project starts in status 'draft'.",
        )
        .tag("StudioProjects")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<CreateProjectRequest>(openapi, "Project parameters")
        .handler(create_project)
        .json_response_with_schema::<ProjectDto>(openapi, StatusCode::CREATED, "Project created")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get(format!("{BASE}/projects/{{id}}"))
        .operation_id("studio_project.get_project")
        .summary("Read one project")
        .tag("StudioProjects")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("id", "Project id")
        .handler(get_project)
        .json_response_with_schema::<ProjectDto>(openapi, StatusCode::OK, "Project")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::patch(format!("{BASE}/projects/{{id}}"))
        .operation_id("studio_project.patch_project")
        .summary("Rename, re-select stages, or move the status forward")
        .description(
            "Every field is optional. `stages` replaces the selection wholesale. \
             `status` only moves forward (draft -> active -> archived); archived is \
             terminal, so reopening means creating a new project.",
        )
        .tag("StudioProjects")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("id", "Project id")
        .json_request::<PatchProjectRequest>(openapi, "Fields to change")
        .handler(patch_project)
        .json_response_with_schema::<ProjectDto>(openapi, StatusCode::OK, "Updated project")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::delete(format!("{BASE}/projects/{{id}}"))
        .operation_id("studio_project.delete_project")
        .summary("Delete a project and its member group")
        .tag("StudioProjects")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("id", "Project id")
        .handler(delete_project)
        .no_content_response(StatusCode::NO_CONTENT, "Deleted")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router.layer(Extension(Projects(service)))
}
