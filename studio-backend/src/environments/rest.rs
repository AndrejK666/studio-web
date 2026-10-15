//! REST surface of `studio-environments` (ADR-0043).
//!
//! An organization's environments are addressed through `?organization_id=`
//! (the `OrgCtx` extractor), a project's bindings and deploys through
//! `?project_id=`: a scope never goes in the path (`api_contract`, rule C).

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

use super::deploy::Rollout;
use super::model::{Binding, DatabaseMode, DeployImage, Deployment, Environment, EnvironmentInput};
use super::service::{DeployRequest, EnvironmentService, Refusal};
use crate::org_scope::OrgCtx;

/// Errors attributable to an environment or a deployment as a resource.
#[resource_error(gts_id!("cf.studio.environments.environment.v1~"))]
pub struct StudioEnvironmentsError;

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

#[derive(Clone)]
pub struct Environments(pub Arc<EnvironmentService>);

fn problem(r: Refusal) -> CanonicalError {
    match r {
        Refusal::Forbidden(reason) => StudioEnvironmentsError::permission_denied()
            .with_reason(reason)
            .create(),
        Refusal::NotFound(id, detail) => StudioEnvironmentsError::not_found(detail)
            .with_resource(id)
            .create(),
        Refusal::Invalid(detail) => StudioEnvironmentsError::invalid_argument()
            .with_constraint(detail)
            .create(),
        Refusal::Precondition(kind, detail) => StudioEnvironmentsError::failed_precondition()
            .with_precondition_violation("environment", detail, kind)
            .create(),
        Refusal::Unavailable(detail) => CanonicalError::service_unavailable()
            .with_detail(detail)
            .create(),
        Refusal::Internal(detail) => CanonicalError::internal(detail).create(),
    }
}

/* ── DTOs ── */

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct EnvironmentDto {
    #[schema(value_type = String)]
    pub id: Uuid,
    pub name: String,
    pub description: String,
    /// The `kubernetes` connection the cluster is reached through.
    #[schema(value_type = String)]
    pub connection_id: Uuid,
    /// Image registry prefix (`ghcr.io/acme`); empty for images as generated.
    pub registry: String,
    pub namespace_pattern: String,
    /// `none` | `shared`.
    pub database: String,
    /// Whether a deploy waits for an organization administrator's approval.
    pub protected: bool,
    /// The projects that may deploy here; absent for all of them.
    #[schema(value_type = Option<Vec<String>>)]
    pub projects: Option<Vec<Uuid>>,
    pub updated_by: String,
    pub updated_at: String,
}

fn database_str(d: DatabaseMode) -> &'static str {
    match d {
        DatabaseMode::None => "none",
        DatabaseMode::Shared => "shared",
    }
}

fn env_dto(e: Environment) -> EnvironmentDto {
    EnvironmentDto {
        id: e.id,
        name: e.name,
        description: e.description,
        connection_id: e.connection_id,
        registry: e.registry,
        namespace_pattern: e.namespace_pattern,
        database: database_str(e.database).to_owned(),
        protected: e.protected,
        projects: e.projects,
        updated_by: e.updated_by,
        updated_at: e.updated_at,
    }
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct EnvironmentListDto {
    pub items: Vec<EnvironmentDto>,
    pub total: u32,
    /// Whether the caller may change them and decide about deploys.
    pub may_manage: bool,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct EnvironmentRequest {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[schema(value_type = String)]
    pub connection_id: Uuid,
    #[serde(default)]
    pub registry: String,
    /// Default `{project}-{environment}`.
    #[serde(default)]
    pub namespace_pattern: Option<String>,
    /// `none` (default) | `shared`.
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub protected: bool,
    /// Absent: every project of the organization.
    #[schema(value_type = Option<Vec<String>>)]
    #[serde(default)]
    pub projects: Option<Vec<Uuid>>,
}

fn env_input(r: EnvironmentRequest) -> Result<EnvironmentInput, CanonicalError> {
    let database = match r.database.as_deref().map(str::trim) {
        None | Some("" | "none") => DatabaseMode::None,
        Some("shared") => DatabaseMode::Shared,
        Some(other) => {
            return Err(StudioEnvironmentsError::invalid_argument()
                .with_constraint(format!("database is none or shared, not '{other}'"))
                .create());
        }
    };
    Ok(EnvironmentInput {
        name: r.name,
        description: r.description,
        connection_id: r.connection_id,
        registry: r.registry,
        namespace_pattern: r.namespace_pattern,
        database,
        protected: r.protected,
        projects: r.projects,
    })
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct EnvironmentTestDto {
    /// What answered, e.g. "https://k8s.acme:6443 answers: Kubernetes v1.32.1".
    pub message: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct BindingDto {
    pub profile: String,
    #[schema(value_type = String)]
    pub environment_id: Uuid,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct BindingListDto {
    pub items: Vec<BindingDto>,
    pub total: u32,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct BindingItem {
    pub profile: String,
    #[schema(value_type = String)]
    pub environment_id: Uuid,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct BindingsRequest {
    pub items: Vec<BindingItem>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct TargetDto {
    pub environment: EnvironmentDto,
    /// The namespace this project's release gets in this environment.
    pub namespace: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ProjectTargetsDto {
    #[schema(value_type = String)]
    pub organization_id: Uuid,
    pub project_name: String,
    /// The environments this project may deploy to.
    pub environments: Vec<TargetDto>,
    /// Its product's profiles bound to them.
    pub bindings: Vec<BindingDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ImageDto {
    pub app: String,
    pub image: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DeploymentDto {
    #[schema(value_type = String)]
    pub id: Uuid,
    #[schema(value_type = String)]
    pub project_id: Uuid,
    pub project_name: String,
    #[schema(value_type = String)]
    pub environment_id: Uuid,
    pub environment_name: String,
    pub profile: String,
    pub product: String,
    pub commit: Option<String>,
    pub lock_hash: Option<String>,
    /// The build it came from (ADR-0045 §4), when the IDE deployed one.
    pub build: Option<String>,
    pub images: Vec<ImageDto>,
    pub namespace: String,
    pub chart_sha256: String,
    /// `awaiting_approval` | `declined` | `queued` | `running` | `succeeded` |
    /// `failed` | `cancelled`.
    pub state: String,
    #[schema(value_type = Option<String>)]
    pub run_id: Option<Uuid>,
    pub requested_by: String,
    pub requested_by_name: String,
    pub requested_at: String,
    pub decided_by: Option<String>,
    pub decided_by_name: Option<String>,
    pub decided_at: Option<String>,
    pub reason: Option<String>,
    pub outcome: Option<String>,
}

fn deployment_dto(d: Deployment) -> DeploymentDto {
    DeploymentDto {
        id: d.id,
        project_id: d.project_id,
        project_name: d.project_name,
        environment_id: d.environment_id,
        environment_name: d.environment_name,
        profile: d.profile,
        product: d.product,
        commit: d.commit,
        lock_hash: d.lock_hash,
        build: d.build,
        images: d
            .images
            .into_iter()
            .map(|i| ImageDto {
                app: i.app,
                image: i.image,
            })
            .collect(),
        namespace: d.namespace,
        chart_sha256: d.chart_sha256,
        state: d.state.as_str().to_owned(),
        run_id: d.run_id,
        requested_by: d.requested_by,
        requested_by_name: d.requested_by_name,
        requested_at: d.requested_at,
        decided_by: d.decided_by,
        decided_by_name: d.decided_by_name,
        decided_at: d.decided_at,
        reason: d.reason,
        outcome: d.outcome,
    }
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DeploymentListDto {
    pub items: Vec<DeploymentDto>,
    pub total: u32,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct DeployImageItem {
    pub app: String,
    /// `repository:tag` as Generate built it, without a registry.
    pub image: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct CreateDeploymentRequest {
    #[schema(value_type = String)]
    pub environment_id: Uuid,
    /// The `kubernetes` profile the chart was generated for.
    pub profile: String,
    /// The product id: the Helm release.
    pub product: String,
    #[serde(default)]
    pub commit: Option<String>,
    #[serde(default)]
    pub lock_hash: Option<String>,
    /// The build it came from: the IDE's build id (ADR-0045 §4).
    #[serde(default)]
    pub build: Option<String>,
    #[serde(default)]
    pub images: Vec<DeployImageItem>,
    /// The generated chart, packaged (`.tgz`), base64; at most 512 KiB.
    pub chart: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct DeploymentDecisionRequest {
    /// `approve` | `decline`.
    pub action: String,
    /// Required to decline.
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct WorkloadDto {
    pub name: String,
    pub ready: i32,
    pub desired: i32,
    pub images: Vec<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DeploymentStatusDto {
    pub deployment: DeploymentDto,
    pub workloads: Vec<WorkloadDto>,
    /// Hosts the release's ingresses answer on.
    pub hosts: Vec<String>,
}

fn status_dto(d: Deployment, r: Rollout) -> DeploymentStatusDto {
    DeploymentStatusDto {
        deployment: deployment_dto(d),
        workloads: r
            .workloads
            .into_iter()
            .map(|w| WorkloadDto {
                name: w.name,
                ready: w.ready,
                desired: w.desired,
                images: w.images,
            })
            .collect(),
        hosts: r.hosts,
    }
}

#[derive(Debug, Deserialize)]
pub struct ProjectQuery {
    project_id: Uuid,
}

#[derive(Debug, Deserialize)]
pub struct DeploymentFilter {
    #[serde(default)]
    project_id: Option<Uuid>,
    #[serde(default)]
    environment_id: Option<Uuid>,
}

fn total(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/* ── Handlers ── */

async fn list_environments(
    OrgCtx(ctx): OrgCtx,
    Extension(envs): Extension<Environments>,
) -> ApiResult<JsonBody<EnvironmentListDto>> {
    let org = ctx.subject_tenant_id();
    let list = envs.0.environments(&ctx, org).await.map_err(problem)?;
    let may_manage = envs.0.may_manage(&ctx, org).await;
    Ok(Json(EnvironmentListDto {
        total: total(list.items.len()),
        items: list.items.into_iter().map(env_dto).collect(),
        may_manage,
    }))
}

async fn create_environment(
    OrgCtx(ctx): OrgCtx,
    Extension(envs): Extension<Environments>,
    Json(body): Json<EnvironmentRequest>,
) -> ApiResult<(StatusCode, JsonBody<EnvironmentDto>)> {
    let input = env_input(body)?;
    let env = envs
        .0
        .put_environment(&ctx, ctx.subject_tenant_id(), None, input)
        .await
        .map_err(problem)?;
    Ok((StatusCode::CREATED, Json(env_dto(env))))
}

async fn update_environment(
    OrgCtx(ctx): OrgCtx,
    Extension(envs): Extension<Environments>,
    Path(environment_id): Path<Uuid>,
    Json(body): Json<EnvironmentRequest>,
) -> ApiResult<JsonBody<EnvironmentDto>> {
    let input = env_input(body)?;
    let env = envs
        .0
        .put_environment(&ctx, ctx.subject_tenant_id(), Some(environment_id), input)
        .await
        .map_err(problem)?;
    Ok(Json(env_dto(env)))
}

async fn delete_environment(
    OrgCtx(ctx): OrgCtx,
    Extension(envs): Extension<Environments>,
    Path(environment_id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    envs.0
        .delete_environment(&ctx, ctx.subject_tenant_id(), environment_id)
        .await
        .map_err(problem)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn test_environment(
    OrgCtx(ctx): OrgCtx,
    Extension(envs): Extension<Environments>,
    Path(environment_id): Path<Uuid>,
) -> ApiResult<JsonBody<EnvironmentTestDto>> {
    let message = envs
        .0
        .test_environment(&ctx, ctx.subject_tenant_id(), environment_id)
        .await
        .map_err(problem)?;
    Ok(Json(EnvironmentTestDto { message }))
}

fn binding_dto(b: Binding) -> BindingDto {
    BindingDto {
        profile: b.profile,
        environment_id: b.environment_id,
    }
}

async fn get_project_targets(
    Extension(ctx): Extension<SecurityContext>,
    Extension(envs): Extension<Environments>,
    Query(q): Query<ProjectQuery>,
) -> ApiResult<JsonBody<ProjectTargetsDto>> {
    let t = envs.0.targets(&ctx, q.project_id).await.map_err(problem)?;
    Ok(Json(ProjectTargetsDto {
        organization_id: t.organization_id,
        project_name: t.project_name,
        environments: t
            .environments
            .into_iter()
            .map(|(e, namespace)| TargetDto {
                environment: env_dto(e),
                namespace,
            })
            .collect(),
        bindings: t.bindings.into_iter().map(binding_dto).collect(),
    }))
}

async fn update_bindings(
    Extension(ctx): Extension<SecurityContext>,
    Extension(envs): Extension<Environments>,
    Query(q): Query<ProjectQuery>,
    Json(body): Json<BindingsRequest>,
) -> ApiResult<JsonBody<BindingListDto>> {
    let items = body
        .items
        .into_iter()
        .map(|b| Binding {
            profile: b.profile.trim().to_owned(),
            environment_id: b.environment_id,
        })
        .collect();
    let saved = envs
        .0
        .put_bindings(&ctx, q.project_id, items)
        .await
        .map_err(problem)?;
    Ok(Json(BindingListDto {
        total: total(saved.len()),
        items: saved.into_iter().map(binding_dto).collect(),
    }))
}

async fn create_deployment(
    Extension(ctx): Extension<SecurityContext>,
    Extension(envs): Extension<Environments>,
    Query(q): Query<ProjectQuery>,
    Json(body): Json<CreateDeploymentRequest>,
) -> ApiResult<(StatusCode, JsonBody<DeploymentDto>)> {
    let req = DeployRequest {
        environment_id: body.environment_id,
        profile: body.profile,
        product: body.product,
        commit: body.commit,
        lock_hash: body.lock_hash,
        build: body.build,
        images: body
            .images
            .into_iter()
            .map(|i| DeployImage {
                app: i.app.trim().to_owned(),
                image: i.image.trim().to_owned(),
            })
            .collect(),
        chart: body.chart,
    };
    let d = envs
        .0
        .request_deploy(&ctx, q.project_id, req)
        .await
        .map_err(problem)?;
    // 202: queued, or waiting for an approval; the record says which.
    Ok((StatusCode::ACCEPTED, Json(deployment_dto(d))))
}

async fn list_deployments(
    OrgCtx(ctx): OrgCtx,
    Extension(envs): Extension<Environments>,
    Query(f): Query<DeploymentFilter>,
) -> ApiResult<JsonBody<DeploymentListDto>> {
    // A project's history is its organization's, filtered: the organization is
    // found from the project when the request names one.
    let org = match f.project_id {
        Some(project) => envs
            .0
            .organization_of_project(&ctx, project)
            .await
            .map_err(problem)?,
        None => ctx.subject_tenant_id(),
    };
    let items = envs
        .0
        .deployments(&ctx, org, f.project_id, f.environment_id)
        .await
        .map_err(problem)?;
    Ok(Json(DeploymentListDto {
        total: total(items.len()),
        items: items.into_iter().map(deployment_dto).collect(),
    }))
}

async fn decide_deployment(
    OrgCtx(ctx): OrgCtx,
    Extension(envs): Extension<Environments>,
    Path(deployment_id): Path<Uuid>,
    Json(body): Json<DeploymentDecisionRequest>,
) -> ApiResult<JsonBody<DeploymentDto>> {
    let approve = match body.action.trim() {
        "approve" => true,
        "decline" => false,
        other => {
            return Err(StudioEnvironmentsError::invalid_argument()
                .with_constraint(format!("action is approve or decline, not '{other}'"))
                .create());
        }
    };
    let d = envs
        .0
        .decide(
            &ctx,
            ctx.subject_tenant_id(),
            deployment_id,
            approve,
            body.reason,
        )
        .await
        .map_err(problem)?;
    Ok(Json(deployment_dto(d)))
}

async fn get_deployment_status(
    OrgCtx(ctx): OrgCtx,
    Extension(envs): Extension<Environments>,
    Path(deployment_id): Path<Uuid>,
) -> ApiResult<JsonBody<DeploymentStatusDto>> {
    let (d, r) = envs
        .0
        .status(&ctx, ctx.subject_tenant_id(), deployment_id)
        .await
        .map_err(problem)?;
    Ok(Json(status_dto(d, r)))
}

/* ── Registration ── */

const TAG: &str = "StudioEnvironments";

pub fn register_routes(
    mut router: Router,
    openapi: &dyn OpenApiRegistry,
    service: Arc<EnvironmentService>,
) -> Router {
    router = OperationBuilder::get("/studio-environments/v1/environments")
        .operation_id("studio_environments.list_environments")
        .summary("List an organization's deployment environments")
        .description(
            "The places the organization's products run (ADR-0043): each with its cluster \
             connection, registry, namespace pattern and whether a deploy needs approval. \
             Name the organization with `?organization_id=`. `may_manage` says whether \
             the caller may change them.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("organization_id", false, "The organization", "string")
        .handler(list_environments)
        .json_response_with_schema::<EnvironmentListDto>(openapi, StatusCode::OK, "Environments")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-environments/v1/environments")
        .operation_id("studio_environments.create_environment")
        .summary("Add a deployment environment")
        .description(
            "Organization administrators only. The cluster is a `kubernetes` connection the \
             organization holds and shares (not a personal one): deploys run on the server, \
             as the service, and read it from there.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("organization_id", false, "The organization", "string")
        .json_request::<EnvironmentRequest>(openapi, "The environment")
        .handler(create_environment)
        .json_response_with_schema::<EnvironmentDto>(openapi, StatusCode::CREATED, "Added")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::put("/studio-environments/v1/environments/{environment_id}")
        .operation_id("studio_environments.update_environment")
        .summary("Change a deployment environment")
        .description(
            "Organization administrators only. The whole environment is sent. A deploy \
             already queued keeps what it was given; the next one uses the change.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .path_param("environment_id", "Environment id")
        .query_param_typed("organization_id", false, "The organization", "string")
        .json_request::<EnvironmentRequest>(openapi, "The environment")
        .handler(update_environment)
        .json_response_with_schema::<EnvironmentDto>(openapi, StatusCode::OK, "Changed")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::delete("/studio-environments/v1/environments/{environment_id}")
        .operation_id("studio_environments.delete_environment")
        .summary("Remove a deployment environment")
        .description(
            "Organization administrators only. What already runs in the cluster stays \
             there, and its deployment records stay in the history.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .path_param("environment_id", "Environment id")
        .query_param_typed("organization_id", false, "The organization", "string")
        .handler(delete_environment)
        .no_content_response(StatusCode::NO_CONTENT, "Removed")
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-environments/v1/environments/{environment_id}/test")
        .operation_id("studio_environments.test_environment")
        .summary("Reach an environment's cluster")
        .description(
            "Asks the cluster's API server for its version with the environment's \
             connection, as a deploy would reach it. Nothing is changed in the cluster.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .path_param("environment_id", "Environment id")
        .query_param_typed("organization_id", false, "The organization", "string")
        .handler(test_environment)
        .json_response_with_schema::<EnvironmentTestDto>(
            openapi,
            StatusCode::OK,
            "The cluster answered",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-environments/v1/targets")
        .operation_id("studio_environments.get_project_targets")
        .summary("Where a project's product can be deployed")
        .description(
            "For `?project_id=`: the organization's environments that take the project's \
             deploys, the namespace its release gets in each, and how its product's \
             kubernetes profiles are bound to them. What the portal's product card and the \
             desktop's Deploy read.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("project_id", true, "The project", "string")
        .handler(get_project_targets)
        .json_response_with_schema::<ProjectTargetsDto>(openapi, StatusCode::OK, "Targets")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::put("/studio-environments/v1/bindings")
        .operation_id("studio_environments.update_bindings")
        .summary("Bind a project's product profiles to environments")
        .description(
            "For `?project_id=`: the whole list, each kubernetes profile at most once, each \
             to an environment that takes the project's deploys. A binding grants nothing: \
             every deploy is still checked against its environment.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("project_id", true, "The project", "string")
        .json_request::<BindingsRequest>(openapi, "The bindings")
        .handler(update_bindings)
        .json_response_with_schema::<BindingListDto>(openapi, StatusCode::OK, "Saved")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-environments/v1/deployments")
        .operation_id("studio_environments.create_deployment")
        .summary("Ask to deploy a project's product into an environment")
        .description(
            "For `?project_id=`, with the generated chart packaged and the images Generate \
             built (pushed to the environment's registry beforehand). The server installs \
             it as a background run with the environment's connection; a protected \
             environment holds it until an organization administrator approves. Answers \
             202 with the record: `queued` or `awaiting_approval`.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("project_id", true, "The project", "string")
        .json_request::<CreateDeploymentRequest>(openapi, "The deploy")
        .handler(create_deployment)
        .json_response_with_schema::<DeploymentDto>(openapi, StatusCode::ACCEPTED, "Accepted")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-environments/v1/deployments")
        .operation_id("studio_environments.list_deployments")
        .summary("What runs where: an organization's deployments")
        .description(
            "Newest first, each with where its run has got to. Filter by `?project_id=` or \
             `?environment_id=`; name the organization with `?organization_id=` when no \
             project is named. The latest deployment of every project and environment is \
             always kept.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("organization_id", false, "The organization", "string")
        .query_param_typed("project_id", false, "Only this project's", "string")
        .query_param_typed("environment_id", false, "Only this environment's", "string")
        .handler(list_deployments)
        .json_response_with_schema::<DeploymentListDto>(openapi, StatusCode::OK, "Deployments")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router =
        OperationBuilder::post("/studio-environments/v1/deployments/{deployment_id}/decisions")
            .operation_id("studio_environments.decide_deployment")
            .summary("Approve or decline a deploy to a protected environment")
            .description(
                "Organization administrators only, for a deploy `awaiting_approval`. Approving \
             queues it; declining needs a reason. Who decided, when and why is kept on the \
             record.",
            )
            .tag(TAG)
            .authenticated()
            .require_license_features::<License>([])
            .path_param("deployment_id", "Deployment id")
            .query_param_typed("organization_id", false, "The organization", "string")
            .json_request::<DeploymentDecisionRequest>(openapi, "The decision")
            .handler(decide_deployment)
            .json_response_with_schema::<DeploymentDto>(openapi, StatusCode::OK, "Decided")
            .error_400(openapi)
            .error_401(openapi)
            .error_403(openapi)
            .error_404(openapi)
            .error_500(openapi)
            .error_503(openapi)
            .register(router, openapi);

    router = OperationBuilder::get("/studio-environments/v1/deployments/{deployment_id}/status")
        .operation_id("studio_environments.get_deployment_status")
        .summary("A deployed release as its cluster reports it now")
        .description(
            "Reads the release's workloads (ready of desired, images) and the hosts its \
             ingresses answer on from the environment's cluster, through the environment's \
             connection. Asked on demand: the cluster is not polled.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .path_param("deployment_id", "Deployment id")
        .query_param_typed("organization_id", false, "The organization", "string")
        .handler(get_deployment_status)
        .json_response_with_schema::<DeploymentStatusDto>(openapi, StatusCode::OK, "Status")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router.layer(Extension(Environments(service)))
}
