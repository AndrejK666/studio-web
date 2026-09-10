use std::sync::Arc;

use axum::{Extension, Router, extract::Path};
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_canonical_errors::resource_error;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::service::{
    KitDescriptor, KitInstallation, KitMaterialization, KitRegistryService, ProjectRepository,
};

#[resource_error(gts_id!("cf.studio.kits.registry.v1~"))]
pub struct KitRegistryError;

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct KitDto {
    pub slug: String,
    pub name: String,
    pub description: String,
    pub publisher: String,
    pub visibility: String,
    pub source: String,
    pub repository_url: String,
    pub default_version: String,
    pub manifest_path: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct KitListDto {
    pub items: Vec<KitDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct KitMaterializationDto {
    pub repository_id: String,
    pub repository_label: Option<String>,
    /// The version actually in this repository, which can lag the
    /// installation's `version` when a bump has not reached every target.
    pub version: String,
    /// "installed" or "failed", for this repository alone.
    pub status: String,
    pub materialized_at: String,
    pub failure_reason: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct KitInstallationDto {
    pub kit_slug: String,
    pub version: String,
    pub source: String,
    pub repository_url: String,
    pub install_mode: String,
    pub status: String,
    pub requested_by: String,
    pub requested_at: String,
    /// Where this kit belongs: "project" or "all-repositories". Intent, as
    /// opposed to `materializations`, which is where it actually is.
    pub scope: String,
    pub installed_at: Option<String>,
    /// The most recently materialized target, derived from `materializations`
    /// rather than stored. Kept because "install this again where it already
    /// is" is the common case and a caller should not have to sort the list to
    /// find it -- but it is a view of the list, so it cannot drift from it.
    pub repository_id: Option<String>,
    /// Every repository this kit has been materialized into, with its own
    /// version and outcome.
    pub materializations: Vec<KitMaterializationDto>,
    pub failure_reason: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct KitInstallationListDto {
    pub items: Vec<KitInstallationDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ProjectRepositoryDto {
    pub repository_id: String,
    pub label: String,
    /// "project" for the project's own repository (where `.cf-studio-kit.toml`
    /// lives, and the target the IDE picks when none is named), "source" for a
    /// checkout mounted below it.
    pub kind: String,
    pub git_mode: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ProjectRepositoryListDto {
    pub items: Vec<ProjectRepositoryDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct RequestKitInstallationDto {
    pub kit_slug: String,
    pub version: String,
    pub install_mode: String,
    /// "project" (default) or "all-repositories". Omitted means project-only:
    /// rolling a kit into every checkout writes files, so it is opted into.
    pub scope: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct MaterializeKitInstallationDto {
    pub repository_id: Option<String>,
}

impl From<KitDescriptor> for KitDto {
    fn from(value: KitDescriptor) -> Self {
        Self {
            slug: value.slug,
            name: value.name,
            description: value.description,
            publisher: value.publisher,
            visibility: value.visibility,
            source: value.source,
            repository_url: value.repository_url,
            default_version: value.default_version,
            manifest_path: value.manifest_path,
        }
    }
}

impl From<ProjectRepository> for ProjectRepositoryDto {
    fn from(value: ProjectRepository) -> Self {
        Self {
            repository_id: value.repository_id,
            label: value.label,
            kind: value.kind,
            git_mode: value.git_mode,
        }
    }
}

impl From<KitMaterialization> for KitMaterializationDto {
    fn from(value: KitMaterialization) -> Self {
        Self {
            repository_id: value.repository_id,
            repository_label: value.repository_label,
            version: value.version,
            status: value.status,
            materialized_at: value.materialized_at,
            failure_reason: value.failure_reason,
        }
    }
}

impl From<KitInstallation> for KitInstallationDto {
    fn from(value: KitInstallation) -> Self {
        // Timestamps are RFC 3339 UTC written by one writer, so the lexical
        // maximum is the chronological one.
        let repository_id = value
            .materializations
            .iter()
            .max_by(|left, right| left.materialized_at.cmp(&right.materialized_at))
            .map(|entry| entry.repository_id.clone());
        Self {
            kit_slug: value.kit_slug,
            version: value.version,
            source: value.source,
            repository_url: value.repository_url,
            install_mode: value.install_mode,
            status: value.status,
            requested_by: value.requested_by,
            requested_at: value.requested_at,
            scope: value.scope,
            installed_at: value.installed_at,
            repository_id,
            materializations: value.materializations.into_iter().map(Into::into).collect(),
            failure_reason: value.failure_reason,
        }
    }
}

fn internal(error: anyhow::Error) -> CanonicalError {
    CanonicalError::internal(format!("kit registry failed: {error:#}")).create()
}

async fn catalogue(
    Extension(_ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<KitRegistryService>>,
) -> ApiResult<JsonBody<KitListDto>> {
    Ok(Json(KitListDto {
        items: service.catalogue().into_iter().map(Into::into).collect(),
    }))
}

async fn list_installations(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<KitRegistryService>>,
    Path(project_id): Path<Uuid>,
) -> ApiResult<JsonBody<KitInstallationListDto>> {
    let items = service
        .list_installations(&ctx, project_id)
        .await
        .map_err(internal)?;
    Ok(Json(KitInstallationListDto {
        items: items.into_iter().map(Into::into).collect(),
    }))
}

async fn request_installation(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<KitRegistryService>>,
    Path(project_id): Path<Uuid>,
    Json(body): Json<RequestKitInstallationDto>,
) -> ApiResult<JsonBody<KitInstallationDto>> {
    let value = service
        .request_installation(
            &ctx,
            project_id,
            &body.kit_slug,
            &body.version,
            &body.install_mode,
            body.scope.as_deref().unwrap_or_default(),
        )
        .await
        .map_err(|error| {
            KitRegistryError::invalid_argument()
                .with_constraint(error.to_string())
                .create()
        })?;
    Ok(Json(value.into()))
}

async fn remove_installation(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<KitRegistryService>>,
    Path((project_id, kit_slug)): Path<(Uuid, String)>,
) -> ApiResult<StatusCode> {
    service
        .remove_installation(&ctx, project_id, &kit_slug)
        .await
        .map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

/// A missing bridge or a stopped IDE is an expected state, not a defect: the
/// repository set only exists while a session runs. 503 lets the portal say
/// "open the IDE first" instead of surfacing an internal error.
fn session_unavailable(error: anyhow::Error) -> CanonicalError {
    CanonicalError::service_unavailable()
        .with_detail(format!("project repositories are unavailable: {error:#}"))
        .create()
}

async fn list_repositories(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<KitRegistryService>>,
    Path(project_id): Path<Uuid>,
) -> ApiResult<JsonBody<ProjectRepositoryListDto>> {
    let items = service
        .list_repositories(&ctx, project_id)
        .await
        .map_err(session_unavailable)?;
    Ok(Json(ProjectRepositoryListDto {
        items: items.into_iter().map(Into::into).collect(),
    }))
}

async fn materialize_installation(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<KitRegistryService>>,
    Path((project_id, kit_slug)): Path<(Uuid, String)>,
    Json(body): Json<MaterializeKitInstallationDto>,
) -> ApiResult<JsonBody<KitInstallationDto>> {
    let value = service
        .materialize_installation(&ctx, project_id, &kit_slug, body.repository_id)
        .await
        .map_err(internal)?;
    Ok(Json(value.into()))
}

async fn reconcile_installation(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<KitRegistryService>>,
    Path((project_id, kit_slug)): Path<(Uuid, String)>,
) -> ApiResult<JsonBody<KitInstallationDto>> {
    let value = service
        .reconcile_installation(&ctx, project_id, &kit_slug)
        .await
        .map_err(session_unavailable)?;
    Ok(Json(value.into()))
}

pub fn register_routes(
    mut router: Router,
    openapi: &dyn OpenApiRegistry,
    service: Arc<KitRegistryService>,
) -> Router {
    router = OperationBuilder::get("/studio-kits/v1/catalog")
        .operation_id("studio_kits.list_catalog")
        .summary("List kits available to Constructor Studio")
        .description(
            "Returns the kits this deployment knows about — name, slug and where \
             the canonical repository is. The kit's files stay in Git; this is \
             the metadata about them.",
        )
        .tag("StudioKits")
        .authenticated()
        .require_license_features::<License>([])
        .handler(catalogue)
        .json_response_with_schema::<KitListDto>(openapi, StatusCode::OK, "Kit catalogue")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-kits/v1/projects/{project_id}/installations")
        .operation_id("studio_kits.list_project_installations")
        .summary("List desired kit installations for a project")
        .description(
            "Returns the kits a project wants installed. Desired state only: \
             materializing the files into a checkout is `cfs`'s job.",
        )
        .tag("StudioKits")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("project_id", "Project tenant id")
        .handler(list_installations)
        .json_response_with_schema::<KitInstallationListDto>(
            openapi,
            StatusCode::OK,
            "Project kit installations",
        )
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-kits/v1/projects/{project_id}/installations")
        .operation_id("studio_kits.request_installation")
        .summary("Request a registered kit for a project")
        .description("Records desired state as pending. A trusted cfs runner materializes it in a later phase.")
        .tag("StudioKits").authenticated().require_license_features::<License>([])
        .path_param("project_id", "Project tenant id")
        .json_request::<RequestKitInstallationDto>(openapi, "Kit installation request")
        .handler(request_installation)
        .json_response_with_schema::<KitInstallationDto>(openapi, StatusCode::OK, "Requested installation")
        .error_400(openapi).error_401(openapi).error_403(openapi).error_500(openapi).register(router, openapi);

    router = OperationBuilder::post(
        "/studio-kits/v1/projects/{project_id}/installations/{kit_slug}/materialize",
    )
    .operation_id("studio_kits.materialize_installation")
    .summary("Install a requested kit in the project's running IDE")
    .description("Calls the S2S-token-gated Theia runner. The kit and Git ref are independently validated by the IDE.")
    .tag("StudioKits")
    .authenticated()
    .require_license_features::<License>([])
    .path_param("project_id", "Project tenant id")
    .path_param("kit_slug", "Registered kit slug")
    .json_request::<MaterializeKitInstallationDto>(openapi, "Optional target repository")
    .handler(materialize_installation)
    .json_response_with_schema::<KitInstallationDto>(openapi, StatusCode::OK, "Materialized installation")
    .error_401(openapi)
    .error_403(openapi)
    .error_500(openapi)
    .register(router, openapi);

    router = OperationBuilder::post(
        "/studio-kits/v1/projects/{project_id}/installations/{kit_slug}/reconcile",
    )
    .operation_id("studio_kits.reconcile_installation")
    .summary("Materialize this kit wherever its scope says it belongs")
    .description("Idempotent: repositories already carrying the requested version are skipped, so this is the call that picks up a repository added after the kit was installed. Requires a running session.")
    .tag("StudioKits")
    .authenticated()
    .require_license_features::<License>([])
    .path_param("project_id", "Project tenant id")
    .path_param("kit_slug", "Registered kit slug")
    .handler(reconcile_installation)
    .json_response_with_schema::<KitInstallationDto>(openapi, StatusCode::OK, "Reconciled installation")
    .error_401(openapi)
    .error_403(openapi)
    .error_500(openapi)
    .register(router, openapi);

    router = OperationBuilder::get("/studio-kits/v1/projects/{project_id}/repositories")
        .operation_id("studio_kits.list_project_repositories")
        .summary("List the repositories the project's running IDE has mounted")
        .description("Live view from the IDE, not stored state: the project repository is listed first and is the target a materialize call without repositoryId will use. Requires a running session.")
        .tag("StudioKits")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("project_id", "Project tenant id")
        .handler(list_repositories)
        .json_response_with_schema::<ProjectRepositoryListDto>(
            openapi,
            StatusCode::OK,
            "Project repositories",
        )
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    OperationBuilder::delete("/studio-kits/v1/projects/{project_id}/installations/{kit_slug}")
        .operation_id("studio_kits.remove_installation")
        .summary("Remove a project's desired kit installation")
        .description(
            "Stops a project wanting a kit. Files already materialized into a \
             checkout are left alone.",
        )
        .tag("StudioKits")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("project_id", "Project tenant id")
        .path_param("kit_slug", "Kit slug")
        .handler(remove_installation)
        .no_content_response(StatusCode::NO_CONTENT, "Installation removed")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi)
        .layer(Extension(service))
}
