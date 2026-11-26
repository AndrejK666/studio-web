//! The routes under `/studio-spec-graph/v1`: a project's spec graph, its
//! checks, reviews, runs and findings, through the spec-graph service.
//!
//! Every route takes `?project_id=` and first shows that the caller reaches the
//! project (the documents gear's `SpecNeeds::project_workspace`). The reads stay
//! open to whoever reaches it; the writes are refused by the kit registry's
//! shared check where the Spec graph kit does not apply (ADR-0071 §4). The service is
//! called with its own key; a call that reads the project's repository passes
//! the caller's `Authorization` header on, for the service to fetch the
//! project's sources through this backend's Git proxy.

use std::sync::Arc;

use axum::extract::{Path, Query};
use axum::http::{HeaderMap, HeaderValue};
use axum::{Extension, Router};
use reqwest::Method;
use serde_json::{Value, json};
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit::client_hub::ClientHub;
use toolkit_canonical_errors::resource_error;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::client::{CallHeaders, Client, UpstreamError};
use crate::documents::port::SpecNeeds;

#[resource_error(gts_id!("cf.studio._.spec_graph.v1~"))]
pub struct SpecGraphError;

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

/// The longest a route waits for a run: under the gateway's 30 s.
const MAX_WAIT: u32 = 25;

pub struct State {
    pub client: Client,
    /// How the service reaches this backend's gateway (with `/cf`).
    pub git_url: String,
    pub hub: Arc<ClientHub>,
}

// ── errors and checks ─────────────────────────────────────────────────────

fn invalid(field: &str, why: impl Into<String>) -> CanonicalError {
    SpecGraphError::invalid_argument()
        .with_field_violation(field, why.into(), "INVALID")
        .create()
}

fn unavailable(why: impl Into<String>) -> CanonicalError {
    CanonicalError::service_unavailable()
        .with_detail(why.into())
        .create()
}

fn upstream(e: UpstreamError) -> CanonicalError {
    match e {
        UpstreamError::Unconfigured(_) | UpstreamError::Unavailable(_) => {
            unavailable(e.to_string())
        }
        UpstreamError::Refused(404, msg) if msg.contains("register it first") => {
            SpecGraphError::failed_precondition()
                .with_precondition_violation(
                    "project",
                    "the project is not set up for the spec graph: \
                     PUT /studio-spec-graph/v1/project first",
                    "NOT_SET_UP",
                )
                .create()
        }
        UpstreamError::Refused(404, msg) => SpecGraphError::not_found(msg)
            .with_resource("spec-graph")
            .create(),
        UpstreamError::Refused(400, msg) => invalid("body", msg),
        // 401 and 403 are the service refusing this gear's key, not the caller.
        UpstreamError::Refused(code, msg) => unavailable(format!(
            "the spec-graph service refused this backend ({code}): {msg}"
        )),
    }
}

fn parse_project(raw: &str) -> ApiResult<Uuid> {
    Uuid::parse_str(raw.trim())
        .map_err(|_| invalid("project_id", format!("`{}` is not a uuid", raw.trim())))
}

/// The project, after showing the caller reaches it: one answer for a project
/// that does not exist and one that is not theirs. This is every route's
/// check: the reads stay open to whoever reaches the project (ADR-0071 §4),
/// and the kit claims the writes and the MCP tools (`with_claimed_routes`).
async fn reach(st: &State, ctx: &SecurityContext, raw: &str) -> ApiResult<Uuid> {
    let project_id = parse_project(raw)?;
    let docs = st
        .hub
        .get::<dyn SpecNeeds>()
        .map_err(|_| unavailable("the documents gear is not part of this deployment"))?;
    docs.project_workspace(ctx, project_id)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?
        .ok_or_else(|| {
            SpecGraphError::not_found("no such project, or not one the caller reaches")
                .with_resource("project")
                .create()
        })?;
    Ok(project_id)
}

/// The Git source a registered project reads: the last segment of its clone
/// URL (`…/sources/{name}`), else the name it was registered under.
fn source_name(project: &Value) -> Option<&str> {
    project
        .pointer("/repository/url")
        .and_then(Value::as_str)
        .and_then(|u| u.trim_end_matches('/').rsplit_once("/sources/"))
        .map(|(_, name)| name)
        .filter(|n| !n.is_empty() && !n.contains('/'))
        .or_else(|| project.get("name").and_then(Value::as_str))
}

/// `owner/name` of the project's source the graph reads (`ProjectSource::dir`
/// is the source's name in the Git proxy). Best effort: `None` when the
/// project is not registered, the source is gone, or the config is not read.
async fn repository_of(
    st: &State,
    ctx: &SecurityContext,
    project_id: Uuid,
    project: &Value,
) -> Option<String> {
    let name = source_name(project)?;
    let am = st
        .hub
        .get::<dyn account_management_sdk::AccountManagementClient>()
        .ok()?;
    let sources = crate::project_sources::read(am.as_ref(), ctx, project_id).await?;
    sources
        .into_iter()
        .find(|s| s.dir == name)
        .map(|s| s.full_path)
}

fn caller(headers: &HeaderMap) -> Option<HeaderValue> {
    headers.get(axum::http::header::AUTHORIZATION).cloned()
}

fn with_repository(headers: &HeaderMap) -> CallHeaders {
    CallHeaders {
        repository: caller(headers),
        idempotency_key: headers
            .get("Idempotency-Key")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned),
    }
}

fn project_path(project_id: Uuid, rest: &str) -> String {
    format!("/v1/projects/{project_id}{rest}")
}

fn u32_of(v: &Value, key: &str) -> u32 {
    v.get(key)
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or(0)
}

fn items_of(v: &Value, key: &str) -> Vec<Value> {
    v.get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

// ── DTOs ──────────────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
pub struct ProjectQuery {
    pub project_id: String,
}

#[derive(serde::Deserialize)]
pub struct FindingsQuery {
    pub project_id: String,
    pub limit: Option<u32>,
}

#[derive(serde::Deserialize)]
pub struct RunQuery {
    pub project_id: String,
    pub wait: Option<u32>,
}

#[derive(serde::Deserialize)]
pub struct KeyQuery {
    pub project_id: String,
    pub key: String,
}

#[derive(serde::Deserialize)]
pub struct NodeQuery {
    pub project_id: String,
    pub key: String,
    pub direction: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct SubgraphQuery {
    pub project_id: String,
    pub key: String,
    pub depth: Option<u32>,
    /// Node type names, comma-separated: only those nodes on the way.
    pub types: Option<String>,
    pub limit: Option<u32>,
}

#[derive(serde::Deserialize)]
pub struct OverviewQuery {
    pub project_id: String,
    /// Node type names, comma-separated; every type but sections and facts when absent.
    pub types: Option<String>,
    pub limit: Option<u32>,
}

#[derive(serde::Deserialize)]
pub struct RunListQuery {
    pub project_id: String,
    pub job: Option<String>,
    pub limit: Option<u32>,
}

#[derive(serde::Deserialize)]
pub struct CalibrationQuery {
    pub project_id: String,
    pub rule: Option<String>,
}

/// How the project is read: which of its sources, at which branch, and which
/// documents (`gears/a gears/b`, or `--docs-root docs --name LABEL .`).
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SpecGraphProjectRequest {
    /// The source's name (`GET /studio-git/v1/sources`); the first when absent.
    pub source: Option<String>,
    /// The branch to read; the source's own when absent.
    pub branch: Option<String>,
    pub scope: String,
}

/// The project as the spec-graph service holds it.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SpecGraphProjectDto {
    pub project_id: String,
    /// Set up: the service knows the project.
    pub registered: bool,
    /// `{tenant, name, repository {url, ref}, scope}`, or null.
    pub project: Value,
    /// The repository the graph reads, as the provider names it (`owner/name`),
    /// from the project's source; null when the source is no longer among the
    /// project's. A pull request of another repository is not this graph's.
    pub repository: Option<String>,
    /// The service's `/v1/info`: its version and capabilities.
    pub service: Value,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SpecGraphCheckRequest {
    /// Another branch than the project's.
    pub branch: Option<String>,
}

/// Every deterministic finding now, one entry per document, each finding in
/// the shape Studio keeps under `spec_finding` `details.findings[]`.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SpecGraphCheckDto {
    pub revision: String,
    pub count: u32,
    pub blocking: u32,
    pub dismissed: u32,
    pub documents: Vec<Value>,
}

/// The findings stored in the project's graph, one entry per document.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SpecGraphFindingListDto {
    pub items: Vec<Value>,
    pub total: u32,
    pub dismissed: u32,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SpecGraphReviewRequest {
    /// The pull request's base branch.
    pub base: String,
    /// Its head branch.
    pub head: String,
    /// Also the model's rules (contradictions): a run, minutes and model cost.
    pub model: Option<bool>,
}

/// A pull request's review: the findings it brings and the threads to post
/// (`review`), or, with the model, the run that computes them (`run`).
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SpecGraphReviewDto {
    pub review: Value,
    pub run: Value,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SpecGraphRunRequest {
    /// `index`, `prepare` (the facts and embeddings a model review reads, made ahead),
    /// `contradictions`, `realization` or `status`.
    pub job: String,
    /// The job's options: `facts` (index), `cap`, `skip_judged` (contradictions).
    pub params: Option<Value>,
}

/// A project's runs on the service, newest first; a running one with its `progress`.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SpecGraphRunListDto {
    pub items: Vec<Value>,
    pub total: u32,
}

/// The latest review of each pull request branch: `{kind: review|model, base, head, head_rev,
/// at, result | run}`, newest first.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SpecGraphReviewListDto {
    pub items: Vec<Value>,
    pub total: u32,
}

/// A run on the service: `{id, job, state, revision, steps, result, error, log_tail}`.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SpecGraphRunDto {
    pub run: Value,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SpecGraphDecisionRequest {
    /// `confirmed` or `dismissed`.
    pub decision: String,
    /// The finding's rule: the decision is also a label for its calibration.
    pub rule: String,
    pub note: Option<String>,
}

/// The decision as Project model recorded it, and the label the service keeps.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SpecGraphDecisionDto {
    pub decision: Value,
    pub label: Value,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SpecGraphLabelRequest {
    /// `real`, `not` or `unsure`.
    pub verdict: String,
    pub rule: String,
    pub note: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SpecGraphLabelDto {
    pub label: Value,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SpecGraphSearchRequest {
    pub query: String,
    /// Node types (`section`, `requirement`, …); every type when absent.
    pub types: Option<Vec<String>>,
    pub limit: Option<u32>,
}

/// The service's answer as it gave it.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SpecGraphAnswerDto {
    pub answer: Value,
}

// ── handlers ──────────────────────────────────────────────────────────────

async fn get_project(
    Extension(ctx): Extension<SecurityContext>,
    Extension(st): Extension<Arc<State>>,
    Query(q): Query<ProjectQuery>,
) -> ApiResult<JsonBody<SpecGraphProjectDto>> {
    let project_id = reach(&st, &ctx, &q.project_id).await?;
    let none = CallHeaders::default();
    let service = st
        .client
        .call(Method::GET, "/v1/info", &[], None, &none)
        .await
        .map_err(upstream)?;
    let project = match st
        .client
        .call(Method::GET, &project_path(project_id, ""), &[], None, &none)
        .await
    {
        Ok(p) => p,
        Err(UpstreamError::Refused(404, _)) => Value::Null,
        Err(e) => return Err(upstream(e)),
    };
    let repository = repository_of(&st, &ctx, project_id, &project).await;
    Ok(Json(SpecGraphProjectDto {
        project_id: project_id.to_string(),
        registered: !project.is_null(),
        project,
        repository,
        service,
    }))
}

async fn upsert_project(
    Extension(ctx): Extension<SecurityContext>,
    Extension(st): Extension<Arc<State>>,
    headers: HeaderMap,
    Query(q): Query<ProjectQuery>,
    Json(req): Json<SpecGraphProjectRequest>,
) -> ApiResult<JsonBody<SpecGraphProjectDto>> {
    let project_id = reach(&st, &ctx, &q.project_id).await?;
    if req.scope.trim().is_empty() {
        return Err(invalid(
            "scope",
            "the documents to read: `gears/a gears/b`, or `--docs-root docs --name LABEL .`",
        ));
    }
    if st.git_url.is_empty() {
        return Err(unavailable(
            "set STUDIO_SPEC_GRAPH_GIT_URL: how the spec-graph service reaches this backend's gateway",
        ));
    }
    // The project's Git sources as the caller reads them.
    let api = crate::mcp::api_as(caller(&headers)).ok_or_else(|| {
        unavailable("studio-mcp is not running here, or the request has no token")
    })?;
    let sources = api
        .get(
            "/studio-git/v1/sources",
            &[("project_id".to_owned(), project_id.to_string())],
        )
        .await
        .map_err(|e| unavailable(format!("reading the project's sources: {}", e.0)))?;
    let items = items_of(&sources, "items");
    let source = match &req.source {
        Some(name) => items
            .iter()
            .find(|s| s.get("name").and_then(Value::as_str) == Some(name.as_str())),
        None => items.first(),
    }
    .ok_or_else(|| {
        invalid(
            "source",
            match &req.source {
                Some(n) => format!("the project has no source `{n}`"),
                None => "the project has no Git source".to_owned(),
            },
        )
    })?;
    let clone_path = source
        .get("clone_path")
        .and_then(Value::as_str)
        .ok_or_else(|| unavailable("the source has no clone path"))?;
    let name = source
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("source");
    let branch = req
        .branch
        .clone()
        .or_else(|| {
            source
                .get("branch")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "main".to_owned());
    let body = json!({
        "tenant": project_id.to_string(),
        "name": name,
        "repository": {"url": format!("{}{clone_path}", st.git_url), "ref": branch},
        "scope": req.scope.trim(),
    });
    let project = st
        .client
        .call(
            Method::PUT,
            &project_path(project_id, ""),
            &[],
            Some(&body),
            &CallHeaders::default(),
        )
        .await
        .map_err(upstream)?;
    let service = st
        .client
        .call(Method::GET, "/v1/info", &[], None, &CallHeaders::default())
        .await
        .map_err(upstream)?;
    let repository = repository_of(&st, &ctx, project_id, &project).await;
    Ok(Json(SpecGraphProjectDto {
        project_id: project_id.to_string(),
        registered: true,
        project,
        repository,
        service,
    }))
}

async fn run_check(
    Extension(ctx): Extension<SecurityContext>,
    Extension(st): Extension<Arc<State>>,
    headers: HeaderMap,
    Query(q): Query<ProjectQuery>,
    Json(req): Json<SpecGraphCheckRequest>,
) -> ApiResult<JsonBody<SpecGraphCheckDto>> {
    let project_id = reach(&st, &ctx, &q.project_id).await?;
    let body = match &req.branch {
        Some(b) => json!({"ref": b}),
        None => json!({}),
    };
    let v = st
        .client
        .call(
            Method::POST,
            &project_path(project_id, "/check"),
            &[],
            Some(&body),
            &with_repository(&headers),
        )
        .await
        .map_err(upstream)?;
    Ok(Json(SpecGraphCheckDto {
        revision: v
            .get("revision")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        count: u32_of(&v, "count"),
        blocking: u32_of(&v, "blocking"),
        dismissed: u32_of(&v, "dismissed"),
        documents: items_of(&v, "documents"),
    }))
}

async fn list_findings(
    Extension(ctx): Extension<SecurityContext>,
    Extension(st): Extension<Arc<State>>,
    Query(q): Query<FindingsQuery>,
) -> ApiResult<JsonBody<SpecGraphFindingListDto>> {
    let project_id = reach(&st, &ctx, &q.project_id).await?;
    let limit = q.limit.unwrap_or(200).min(500).to_string();
    let v = st
        .client
        .call(
            Method::GET,
            &project_path(project_id, "/findings"),
            &[("limit", limit)],
            None,
            &CallHeaders::default(),
        )
        .await
        .map_err(upstream)?;
    Ok(Json(SpecGraphFindingListDto {
        items: items_of(&v, "documents"),
        total: u32_of(&v, "count"),
        dismissed: u32_of(&v, "dismissed"),
    }))
}

async fn run_review(
    Extension(ctx): Extension<SecurityContext>,
    Extension(st): Extension<Arc<State>>,
    headers: HeaderMap,
    Query(q): Query<ProjectQuery>,
    Json(req): Json<SpecGraphReviewRequest>,
) -> ApiResult<JsonBody<SpecGraphReviewDto>> {
    let project_id = reach(&st, &ctx, &q.project_id).await?;
    let model = req.model.unwrap_or(false);
    let body = json!({"base": req.base, "head": req.head, "model": model});
    let v = st
        .client
        .call(
            Method::POST,
            &project_path(project_id, "/reviews"),
            &[],
            Some(&body),
            &with_repository(&headers),
        )
        .await
        .map_err(upstream)?;
    Ok(Json(if model {
        SpecGraphReviewDto {
            review: Value::Null,
            run: v,
        }
    } else {
        SpecGraphReviewDto {
            review: v,
            run: Value::Null,
        }
    }))
}

async fn start_run(
    Extension(ctx): Extension<SecurityContext>,
    Extension(st): Extension<Arc<State>>,
    headers: HeaderMap,
    Query(q): Query<ProjectQuery>,
    Json(req): Json<SpecGraphRunRequest>,
) -> ApiResult<JsonBody<SpecGraphRunDto>> {
    let project_id = reach(&st, &ctx, &q.project_id).await?;
    if !matches!(
        req.job.as_str(),
        "index" | "prepare" | "contradictions" | "realization" | "status"
    ) {
        return Err(invalid(
            "job",
            "index, prepare, contradictions, realization or status",
        ));
    }
    let body = json!({
        "project": project_id.to_string(),
        "job": req.job,
        "params": req.params.unwrap_or_else(|| json!({})),
    });
    let run = st
        .client
        .call(
            Method::POST,
            "/v1/runs",
            &[],
            Some(&body),
            &with_repository(&headers),
        )
        .await
        .map_err(upstream)?;
    Ok(Json(SpecGraphRunDto { run }))
}

/// A run of another project reads as absent.
fn own_run(run: Value, project_id: Uuid) -> ApiResult<Value> {
    if run.get("project").and_then(Value::as_str) == Some(project_id.to_string().as_str()) {
        Ok(run)
    } else {
        Err(SpecGraphError::not_found("no such run for this project")
            .with_resource("run")
            .create())
    }
}

async fn get_run(
    Extension(ctx): Extension<SecurityContext>,
    Extension(st): Extension<Arc<State>>,
    Path(run_id): Path<String>,
    Query(q): Query<RunQuery>,
) -> ApiResult<JsonBody<SpecGraphRunDto>> {
    let project_id = reach(&st, &ctx, &q.project_id).await?;
    let wait = q.wait.unwrap_or(0).min(MAX_WAIT).to_string();
    let run = st
        .client
        .call(
            Method::GET,
            &format!("/v1/runs/{run_id}"),
            &[("wait", wait)],
            None,
            &CallHeaders::default(),
        )
        .await
        .map_err(upstream)?;
    Ok(Json(SpecGraphRunDto {
        run: own_run(run, project_id)?,
    }))
}

async fn list_runs(
    Extension(ctx): Extension<SecurityContext>,
    Extension(st): Extension<Arc<State>>,
    Query(q): Query<RunListQuery>,
) -> ApiResult<JsonBody<SpecGraphRunListDto>> {
    let project_id = reach(&st, &ctx, &q.project_id).await?;
    let mut query = vec![
        ("project", project_id.to_string()),
        ("limit", q.limit.unwrap_or(20).min(100).to_string()),
    ];
    if let Some(job) = q.job.filter(|j| !j.is_empty()) {
        query.push(("job", job));
    }
    let v = st
        .client
        .call(
            Method::GET,
            "/v1/runs",
            &query,
            None,
            &CallHeaders::default(),
        )
        .await
        .map_err(upstream)?;
    let items: Vec<Value> = v
        .get("runs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|r| own_run(r.clone(), project_id).is_ok())
        .collect();
    let total = u32::try_from(items.len()).unwrap_or(u32::MAX);
    Ok(Json(SpecGraphRunListDto { items, total }))
}

async fn list_reviews(
    Extension(ctx): Extension<SecurityContext>,
    Extension(st): Extension<Arc<State>>,
    Query(q): Query<ProjectQuery>,
) -> ApiResult<JsonBody<SpecGraphReviewListDto>> {
    let project_id = reach(&st, &ctx, &q.project_id).await?;
    let v = st
        .client
        .call(
            Method::GET,
            &project_path(project_id, "/reviews"),
            &[],
            None,
            &CallHeaders::default(),
        )
        .await
        .map_err(upstream)?;
    let items: Vec<Value> = v
        .get("reviews")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let total = u32::try_from(items.len()).unwrap_or(u32::MAX);
    Ok(Json(SpecGraphReviewListDto { items, total }))
}

async fn cancel_run(
    Extension(ctx): Extension<SecurityContext>,
    Extension(st): Extension<Arc<State>>,
    Path(run_id): Path<String>,
    Query(q): Query<ProjectQuery>,
) -> ApiResult<JsonBody<SpecGraphRunDto>> {
    let project_id = reach(&st, &ctx, &q.project_id).await?;
    let none = CallHeaders::default();
    let path = format!("/v1/runs/{run_id}");
    own_run(
        st.client
            .call(Method::GET, &path, &[], None, &none)
            .await
            .map_err(upstream)?,
        project_id,
    )?;
    let run = st
        .client
        .call(
            Method::POST,
            &format!("{path}/cancel"),
            &[],
            Some(&json!({})),
            &none,
        )
        .await
        .map_err(upstream)?;
    Ok(Json(SpecGraphRunDto { run }))
}

async fn decide_finding(
    Extension(ctx): Extension<SecurityContext>,
    Extension(st): Extension<Arc<State>>,
    headers: HeaderMap,
    Path(fingerprint): Path<String>,
    Query(q): Query<ProjectQuery>,
    Json(req): Json<SpecGraphDecisionRequest>,
) -> ApiResult<JsonBody<SpecGraphDecisionDto>> {
    let project_id = reach(&st, &ctx, &q.project_id).await?;
    let verdict = match req.decision.as_str() {
        "confirmed" => "real",
        "dismissed" => "not",
        _ => return Err(invalid("decision", "confirmed or dismissed")),
    };
    // The decision is Project model's (the kit requires it): one decision table
    // for every finding a project's people decide.
    let api = crate::mcp::api_as(caller(&headers)).ok_or_else(|| {
        unavailable("studio-mcp is not running here, or the request has no token")
    })?;
    let decision = api
        .post(
            &format!("/studio-documents/v1/project-domain-model/findings/{fingerprint}/decision"),
            &[],
            &json!({"project_id": project_id.to_string(), "decision": req.decision, "note": req.note}),
        )
        .await
        .map_err(|e| invalid("decision", e.0))?;
    // The service keeps it too: a label calibrates the rule, and a dismissal
    // leaves the finding out of checks and reviews.
    let note = req.note.clone().unwrap_or_default();
    let label = st
        .client
        .call(
            Method::PUT,
            &project_path(project_id, &format!("/findings/{fingerprint}/label")),
            &[],
            Some(&json!({"verdict": verdict, "rule": req.rule, "note": note, "by": ctx.subject_id().to_string()})),
            &CallHeaders::default(),
        )
        .await
        .map_err(upstream)?;
    if req.decision == "dismissed" {
        let reason = if note.is_empty() {
            "dismissed in Studio".to_owned()
        } else {
            note
        };
        st.client
            .call(
                Method::PUT,
                &project_path(project_id, &format!("/findings/{fingerprint}/dismissal")),
                &[],
                Some(&json!({"reason": reason, "by": ctx.subject_id().to_string()})),
                &CallHeaders::default(),
            )
            .await
            .map_err(upstream)?;
    }
    Ok(Json(SpecGraphDecisionDto { decision, label }))
}

async fn upsert_label(
    Extension(ctx): Extension<SecurityContext>,
    Extension(st): Extension<Arc<State>>,
    Path(fingerprint): Path<String>,
    Query(q): Query<ProjectQuery>,
    Json(req): Json<SpecGraphLabelRequest>,
) -> ApiResult<JsonBody<SpecGraphLabelDto>> {
    let project_id = reach(&st, &ctx, &q.project_id).await?;
    let label = st
        .client
        .call(
            Method::PUT,
            &project_path(project_id, &format!("/findings/{fingerprint}/label")),
            &[],
            Some(&json!({"verdict": req.verdict, "rule": req.rule, "note": req.note.unwrap_or_default(),
                         "by": ctx.subject_id().to_string()})),
            &CallHeaders::default(),
        )
        .await
        .map_err(upstream)?;
    Ok(Json(SpecGraphLabelDto { label }))
}

async fn get_calibration(
    Extension(ctx): Extension<SecurityContext>,
    Extension(st): Extension<Arc<State>>,
    Query(q): Query<CalibrationQuery>,
) -> ApiResult<JsonBody<SpecGraphAnswerDto>> {
    let project_id = reach(&st, &ctx, &q.project_id).await?;
    let query: Vec<(&str, String)> = q.rule.into_iter().map(|r| ("rule", r)).collect();
    let answer = st
        .client
        .call(
            Method::GET,
            &project_path(project_id, "/calibration"),
            &query,
            None,
            &CallHeaders::default(),
        )
        .await
        .map_err(upstream)?;
    Ok(Json(SpecGraphAnswerDto { answer }))
}

/// One of the service's tools on the project's graph.
async fn tool(st: &State, name: &str, project_id: Uuid, mut args: Value) -> ApiResult<Value> {
    args["project"] = json!(project_id.to_string());
    let v = st
        .client
        .call(
            Method::POST,
            &format!("/v1/tools/{name}"),
            &[],
            Some(&args),
            &CallHeaders::default(),
        )
        .await
        .map_err(upstream)?;
    Ok(v.get("result").cloned().unwrap_or(Value::Null))
}

async fn search_graph(
    Extension(ctx): Extension<SecurityContext>,
    Extension(st): Extension<Arc<State>>,
    Query(q): Query<ProjectQuery>,
    Json(req): Json<SpecGraphSearchRequest>,
) -> ApiResult<JsonBody<SpecGraphAnswerDto>> {
    let project_id = reach(&st, &ctx, &q.project_id).await?;
    let mut args = json!({"query": req.query, "limit": req.limit.unwrap_or(10).min(50)});
    if let Some(t) = req.types {
        args["types"] = json!(t);
    }
    Ok(Json(SpecGraphAnswerDto {
        answer: tool(&st, "search", project_id, args).await?,
    }))
}

async fn get_graph_node(
    Extension(ctx): Extension<SecurityContext>,
    Extension(st): Extension<Arc<State>>,
    Query(q): Query<KeyQuery>,
) -> ApiResult<JsonBody<SpecGraphAnswerDto>> {
    let project_id = reach(&st, &ctx, &q.project_id).await?;
    Ok(Json(SpecGraphAnswerDto {
        answer: tool(&st, "node", project_id, json!({"key": q.key})).await?,
    }))
}

async fn get_graph_neighbors(
    Extension(ctx): Extension<SecurityContext>,
    Extension(st): Extension<Arc<State>>,
    Query(q): Query<NodeQuery>,
) -> ApiResult<JsonBody<SpecGraphAnswerDto>> {
    let project_id = reach(&st, &ctx, &q.project_id).await?;
    let mut args = json!({"key": q.key});
    if let Some(d) = q.direction {
        args["direction"] = json!(d);
    }
    Ok(Json(SpecGraphAnswerDto {
        answer: tool(&st, "neighbors", project_id, args).await?,
    }))
}

/// `a, b ,c` -> `["a", "b", "c"]`.
fn type_list(raw: Option<&str>) -> Option<Vec<String>> {
    let v: Vec<String> = raw?
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    (!v.is_empty()).then_some(v)
}

async fn get_subgraph(
    Extension(ctx): Extension<SecurityContext>,
    Extension(st): Extension<Arc<State>>,
    Query(q): Query<SubgraphQuery>,
) -> ApiResult<JsonBody<SpecGraphAnswerDto>> {
    let project_id = reach(&st, &ctx, &q.project_id).await?;
    let mut args = json!({"key": q.key, "depth": q.depth.unwrap_or(2).clamp(1, 4)});
    if let Some(t) = type_list(q.types.as_deref()) {
        args["types"] = json!(t);
    }
    if let Some(l) = q.limit {
        args["limit"] = json!(l.min(1000));
    }
    Ok(Json(SpecGraphAnswerDto {
        answer: tool(&st, "subgraph", project_id, args).await?,
    }))
}

async fn get_overview(
    Extension(ctx): Extension<SecurityContext>,
    Extension(st): Extension<Arc<State>>,
    Query(q): Query<OverviewQuery>,
) -> ApiResult<JsonBody<SpecGraphAnswerDto>> {
    let project_id = reach(&st, &ctx, &q.project_id).await?;
    let mut args = json!({});
    if let Some(t) = type_list(q.types.as_deref()) {
        args["types"] = json!(t);
    }
    if let Some(l) = q.limit {
        args["limit"] = json!(l.min(4000));
    }
    Ok(Json(SpecGraphAnswerDto {
        answer: tool(&st, "graph", project_id, args).await?,
    }))
}

async fn get_ontology(
    Extension(ctx): Extension<SecurityContext>,
    Extension(st): Extension<Arc<State>>,
    Query(q): Query<ProjectQuery>,
) -> ApiResult<JsonBody<SpecGraphAnswerDto>> {
    let project_id = reach(&st, &ctx, &q.project_id).await?;
    Ok(Json(SpecGraphAnswerDto {
        answer: tool(&st, "ontology", project_id, json!({"counts": true})).await?,
    }))
}

async fn get_metrics(
    Extension(ctx): Extension<SecurityContext>,
    Extension(st): Extension<Arc<State>>,
    Query(q): Query<ProjectQuery>,
) -> ApiResult<JsonBody<SpecGraphAnswerDto>> {
    let project_id = reach(&st, &ctx, &q.project_id).await?;
    // The runs store the project's findings under its id (specq.runs).
    let args = json!({"repo": project_id.to_string()});
    Ok(Json(SpecGraphAnswerDto {
        answer: tool(&st, "metrics", project_id, args).await?,
    }))
}

// ── routes ────────────────────────────────────────────────────────────────

#[allow(clippy::too_many_lines)] // one builder per route, as the other gears register them
pub fn register_routes(router: Router, openapi: &dyn OpenApiRegistry, state: Arc<State>) -> Router {
    let router = OperationBuilder::get("/studio-spec-graph/v1/project")
    .operation_id("studio_spec_graph.get_project")
    .summary("Whether a project is set up for the spec graph, and the service's state")
    .description(
        "The project as the spec-graph service holds it (`registered`, and its repository, branch \
         and scope), the repository it reads as the provider names it (`repository`, \
         `owner/name`), and the service's version and capabilities.",
    )
    .tag("StudioSpecGraph")
    .authenticated()
    .require_license_features::<License>([])
    .query_param("project_id", true, "The project")
    .handler(get_project)
    .json_response_with_schema::<SpecGraphProjectDto>(openapi, StatusCode::OK, "The project")
    .error_400(openapi)
    .error_401(openapi)
    .error_404(openapi)
    .error_500(openapi)
    .register(router, openapi);

    let router = OperationBuilder::put("/studio-spec-graph/v1/project")
    .operation_id("studio_spec_graph.upsert_project")
    .summary("Set a project up for the spec graph: which source, branch and documents")
    .description(
        "Registers the project with the spec-graph service: one of the project's Git sources (the \
         first when `source` is absent), cloned through this backend's Git proxy with the \
         caller's token, at `branch` (the source's own when absent), reading the documents \
         `scope` names (`gears/a gears/b`, or `--docs-root docs --name LABEL .`). The graph lives \
         in the project's tenant. Again replaces it.",
    )
    .tag("StudioSpecGraph")
    .authenticated()
    .require_license_features::<License>([])
    .query_param("project_id", true, "The project")
    .handler(upsert_project)
    .json_request::<SpecGraphProjectRequest>(openapi, "The source, branch and documents")
    .json_response_with_schema::<SpecGraphProjectDto>(openapi, StatusCode::OK, "The project as registered")
    .error_400(openapi)
    .error_401(openapi)
    .error_404(openapi)
    .error_500(openapi)
    .register(router, openapi);

    let router = OperationBuilder::post("/studio-spec-graph/v1/checks")
        .operation_id("studio_spec_graph.run_check")
        .summary("Every deterministic spec finding of a project now, by document")
        .description(
            "Runs the deterministic rules (traceability, links and anchors, supersession, rules as \
         data) over the project's repository at its branch, or `branch`, in seconds. One entry per \
         document, each finding in the shape Studio keeps under spec_finding details.findings: \
         id (the fingerprint), rule, severity, gate, anchor, related, suggestion. Dismissed \
         findings are left out and counted.",
        )
        .tag("StudioSpecGraph")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project")
        .handler(run_check)
        .json_request::<SpecGraphCheckRequest>(openapi, "Another branch, optionally")
        .json_response_with_schema::<SpecGraphCheckDto>(openapi, StatusCode::OK, "The findings")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-spec-graph/v1/findings")
        .operation_id("studio_spec_graph.list_findings")
        .summary("The spec findings stored in a project's graph, by document")
        .description(
            "What the project's runs stored in its graph: contradictions confirmed by the judges, \
         with both passages, and the other rules' findings. One entry per document; dismissed \
         findings left out and counted.",
        )
        .tag("StudioSpecGraph")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project")
        .query_param(
            "limit",
            false,
            "At most this many findings (default 200, at most 500)",
        )
        .handler(list_findings)
        .json_response_with_schema::<SpecGraphFindingListDto>(
            openapi,
            StatusCode::OK,
            "The findings",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-spec-graph/v1/reviews")
    .operation_id("studio_spec_graph.run_review")
    .summary("Review a pull request of a project: its findings and the threads to post")
    .description(
        "The findings a pull request brings (head against base), and the review threads to post \
         on its head: path, line, body with specq fingerprint markers, computed from the diff. \
         `fingerprints` lists every finding the change brings, so open threads whose fingerprints \
         are gone can be resolved. With `model`, the model's rules too (contradictions): then a \
         run, answered in `run`, whose result holds the threads.",
    )
    .tag("StudioSpecGraph")
    .authenticated()
    .require_license_features::<License>([])
    .query_param("project_id", true, "The project")
    .handler(run_review)
    .json_request::<SpecGraphReviewRequest>(openapi, "The pull request's branches")
    .json_response_with_schema::<SpecGraphReviewDto>(openapi, StatusCode::OK, "The review, or its run")
    .error_400(openapi)
    .error_401(openapi)
    .error_404(openapi)
    .error_500(openapi)
    .register(router, openapi);

    let router = OperationBuilder::post("/studio-spec-graph/v1/runs")
    .operation_id("studio_spec_graph.start_run")
    .summary("Start a long spec-graph job on a project: index, contradictions or a judge")
    .description(
        "A run on the spec-graph service at the head of the project's branch: `index` builds the \
         project's graph (`params.facts: false` for the structure only), `prepare` makes the \
         facts and embeddings a review with the model reads, ahead of the first one (minutes and \
         model cost once; the reviews after it take a minute), `contradictions` judges \
         the corpus (`params.cap`), `realization` and `status` run those judges. Minutes, and \
         model cost for all but a structure index. The same Idempotency-Key header answers the \
         same run. Follow it with GET /studio-spec-graph/v1/runs/{run_id}.",
    )
    .tag("StudioSpecGraph")
    .authenticated()
    .require_license_features::<License>([])
    .query_param("project_id", true, "The project")
    .handler(start_run)
    .json_request::<SpecGraphRunRequest>(openapi, "The job and its options")
    .json_response_with_schema::<SpecGraphRunDto>(openapi, StatusCode::OK, "The run, queued")
    .error_400(openapi)
    .error_401(openapi)
    .error_404(openapi)
    .error_500(openapi)
    .register(router, openapi);

    let router = OperationBuilder::get("/studio-spec-graph/v1/runs/{run_id}")
    .operation_id("studio_spec_graph.get_run")
    .summary("A spec-graph run's state, steps and result")
    .description(
        "The run's state (queued, running, succeeded, failed, cancelled, interrupted), its steps \
         with exit codes and seconds, its result (counts, cost, revision; for a review, the \
         threads) and its log's tail. `wait` waits up to that many seconds (at most 25) for it to \
         end. A run of another project reads as absent.",
    )
    .tag("StudioSpecGraph")
    .authenticated()
    .require_license_features::<License>([])
    .query_param("project_id", true, "The project")
    .path_param("run_id", "The run")
    .query_param("wait", false, "Seconds to wait for the run to end, at most 25")
    .handler(get_run)
    .json_response_with_schema::<SpecGraphRunDto>(openapi, StatusCode::OK, "The run")
    .error_400(openapi)
    .error_401(openapi)
    .error_404(openapi)
    .error_500(openapi)
    .register(router, openapi);

    let router = OperationBuilder::post("/studio-spec-graph/v1/runs/{run_id}/cancel")
        .operation_id("studio_spec_graph.cancel_run")
        .summary("Cancel a project's spec-graph run")
        .description(
            "A queued run is dropped; a running one has its step's processes ended and reads \
         `cancelled`. A run that already ended is answered as it is.",
        )
        .tag("StudioSpecGraph")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project")
        .path_param("run_id", "The run")
        .handler(cancel_run)
        .json_response_with_schema::<SpecGraphRunDto>(openapi, StatusCode::OK, "The run")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-spec-graph/v1/findings/{fingerprint}/decision")
        .operation_id("studio_spec_graph.decide_finding")
        .summary("Confirm or dismiss a spec-graph finding of a project")
        .description(
            "Records the decision in Project model's decision table (one table for every finding a \
         project's people decide), and with the spec-graph service: a label for the rule's \
         calibration (confirmed: real; dismissed: not), and for a dismissal, the finding left \
         out of checks and reviews while its fingerprint keeps appearing.",
        )
        .tag("StudioSpecGraph")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project")
        .path_param("fingerprint", "The finding's fingerprint")
        .handler(decide_finding)
        .json_request::<SpecGraphDecisionRequest>(openapi, "The decision")
        .json_response_with_schema::<SpecGraphDecisionDto>(
            openapi,
            StatusCode::OK,
            "What was recorded",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::put("/studio-spec-graph/v1/findings/{fingerprint}/label")
        .operation_id("studio_spec_graph.upsert_finding_label")
        .summary("Say whether a spec-graph finding is real, to calibrate its rule")
        .description(
            "A label (real, not or unsure) the spec-graph service keeps for the project. With at \
         least 10 decided labels and a 95 % lower bound of precision of 0.7, a model's rule may \
         be made blocking. Does not hide the finding; a decision does.",
        )
        .tag("StudioSpecGraph")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project")
        .path_param("fingerprint", "The finding's fingerprint")
        .handler(upsert_label)
        .json_request::<SpecGraphLabelRequest>(openapi, "The label")
        .json_response_with_schema::<SpecGraphLabelDto>(openapi, StatusCode::OK, "The label")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-spec-graph/v1/calibration")
        .operation_id("studio_spec_graph.get_calibration")
        .summary("Precision of each spec-graph rule from a project's labels")
        .description(
            "Per rule: decided labels, precision, its 95 % lower bound, and whether the rule may \
         block (at least 10 decided labels and a lower bound of 0.7), from the labels the service \
         keeps and those the repository commits.",
        )
        .tag("StudioSpecGraph")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project")
        .query_param("rule", false, "One rule")
        .handler(get_calibration)
        .json_response_with_schema::<SpecGraphAnswerDto>(openapi, StatusCode::OK, "The calibration")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-spec-graph/v1/graph/search")
    .operation_id("studio_spec_graph.search_graph")
    .summary("Search a project's spec graph: sections, requirements, decisions")
    .description(
        "Hybrid search (full text and vectors) over the project's graph, optionally only some node \
         types (`section`, `requirement`, `decision`, `design_element`, `finding`, …). Each hit has \
         its key, type, file and line; open one with GET /studio-spec-graph/v1/graph/node.",
    )
    .tag("StudioSpecGraph")
    .authenticated()
    .require_license_features::<License>([])
    .query_param("project_id", true, "The project")
    .handler(search_graph)
    .json_request::<SpecGraphSearchRequest>(openapi, "The query")
    .json_response_with_schema::<SpecGraphAnswerDto>(openapi, StatusCode::OK, "The hits")
    .error_400(openapi)
    .error_401(openapi)
    .error_404(openapi)
    .error_500(openapi)
    .register(router, openapi);

    let router = OperationBuilder::get("/studio-spec-graph/v1/graph/node")
    .operation_id("studio_spec_graph.get_graph_node")
    .summary("One node of a project's spec graph")
    .description(
        "A node by its key (a CPT id, `doc:<path>`, `sec:<path>#<anchor>`, …): its type, file, line, \
         verbatim quote and text.",
    )
    .tag("StudioSpecGraph")
    .authenticated()
    .require_license_features::<License>([])
    .query_param("project_id", true, "The project")
    .query_param("key", true, "The node's key")
    .handler(get_graph_node)
    .json_response_with_schema::<SpecGraphAnswerDto>(openapi, StatusCode::OK, "The node")
    .error_400(openapi)
    .error_401(openapi)
    .error_404(openapi)
    .error_500(openapi)
    .register(router, openapi);

    let router = OperationBuilder::get("/studio-spec-graph/v1/graph/neighbors")
    .operation_id("studio_spec_graph.get_graph_neighbors")
    .summary("The edges at a node of a project's spec graph")
    .description(
        "The node's edges grouped by type and direction: what realizes or addresses it, where it \
         is defined, what links to it; an analysis edge (a judge's conclusion) with its verdict, \
         quote and provenance.",
    )
    .tag("StudioSpecGraph")
    .authenticated()
    .require_license_features::<License>([])
    .query_param("project_id", true, "The project")
    .query_param("key", true, "The node's key")
    .query_param("direction", false, "incoming, outgoing or either (default)")
    .handler(get_graph_neighbors)
    .json_response_with_schema::<SpecGraphAnswerDto>(openapi, StatusCode::OK, "The edges")
    .error_400(openapi)
    .error_401(openapi)
    .error_404(openapi)
    .error_500(openapi)
    .register(router, openapi);

    let router = OperationBuilder::get("/studio-spec-graph/v1/graph/subgraph")
    .operation_id("studio_spec_graph.get_subgraph")
    .summary("The graph around one node of a project's spec graph")
    .description(
        "The nodes `depth` hops out from a node (1-4, default 2), both directions, and the edges \
         between them: each node with its key, type, name and file; each edge static (from the \
         documents) or analysis (a judge's conclusion). `types` (comma-separated node type names) \
         keeps only those nodes on the way; at most `limit` nodes (300 by default, 1000 at most), \
         `truncated` when there were more.",
    )
    .tag("StudioSpecGraph")
    .authenticated()
    .require_license_features::<License>([])
    .query_param("project_id", true, "The project")
    .query_param("key", true, "The node's key")
    .query_param("depth", false, "Hops out, 1-4 (default 2)")
    .query_param("types", false, "Node type names, comma-separated")
    .query_param("limit", false, "At most this many nodes (default 300, at most 1000)")
    .handler(get_subgraph)
    .json_response_with_schema::<SpecGraphAnswerDto>(openapi, StatusCode::OK, "The nodes and edges")
    .error_400(openapi)
    .error_401(openapi)
    .error_404(openapi)
    .error_500(openapi)
    .register(router, openapi);

    let router = OperationBuilder::get("/studio-spec-graph/v1/graph/overview")
    .operation_id("studio_spec_graph.get_graph_overview")
    .summary("A project's whole spec graph, or the nodes of some types")
    .description(
        "Every node of the given types (comma-separated names) and the edges between them, with \
         the count of each type in the graph. Without `types`, sections and facts are left out: \
         they are most of the nodes. At most `limit` nodes (4000).",
    )
    .tag("StudioSpecGraph")
    .authenticated()
    .require_license_features::<License>([])
    .query_param("project_id", true, "The project")
    .query_param("types", false, "Node type names, comma-separated")
    .query_param("limit", false, "At most this many nodes (4000)")
    .handler(get_overview)
    .json_response_with_schema::<SpecGraphAnswerDto>(openapi, StatusCode::OK, "The nodes and edges")
    .error_400(openapi)
    .error_401(openapi)
    .error_404(openapi)
    .error_500(openapi)
    .register(router, openapi);

    let router = OperationBuilder::get("/studio-spec-graph/v1/graph/ontology")
        .operation_id("studio_spec_graph.get_graph_ontology")
        .summary("The spec graph's ontology, with a project's count of each node type")
        .description(
            "The node types (document, section, requirement, design element, decision, …) and edge \
         types the spec graph is built of, what each edge connects and whether it is static or a \
         judge's conclusion, how keys are formed, and how many nodes of each type the project's \
         graph holds.",
        )
        .tag("StudioSpecGraph")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project")
        .handler(get_ontology)
        .json_response_with_schema::<SpecGraphAnswerDto>(openapi, StatusCode::OK, "The ontology")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-spec-graph/v1/runs")
        .operation_id("studio_spec_graph.list_runs")
        .summary("A project's runs, newest first")
        .description(
            "The project's runs on the spec-graph service (index, prepare, reviews with the model, \
         judges), newest first, optionally of one `job`; a running one with its `progress` \
         (stage, done, total).",
        )
        .tag("StudioSpecGraph")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project")
        .query_param("job", false, "Only runs of this job")
        .query_param(
            "limit",
            false,
            "At most this many (default 20, at most 100)",
        )
        .handler(list_runs)
        .json_response_with_schema::<SpecGraphRunListDto>(openapi, StatusCode::OK, "The runs")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-spec-graph/v1/reviews")
    .operation_id("studio_spec_graph.list_reviews")
    .summary("The latest review of each pull request branch")
    .description(
        "For each pull request branch reviewed: the latest deterministic review (its threads) and \
         the latest review with the model (its run, finished or still going), newest first.",
    )
    .tag("StudioSpecGraph")
    .authenticated()
    .require_license_features::<License>([])
    .query_param("project_id", true, "The project")
    .handler(list_reviews)
    .json_response_with_schema::<SpecGraphReviewListDto>(openapi, StatusCode::OK, "The reviews")
    .error_400(openapi)
    .error_401(openapi)
    .error_404(openapi)
    .error_500(openapi)
    .register(router, openapi);

    let router = OperationBuilder::get("/studio-spec-graph/v1/metrics")
    .operation_id("studio_spec_graph.get_metrics")
    .summary("A project's spec quality in numbers")
    .description(
        "Findings per rule and gate, p1 requirements realized in the markup and with the judges' \
         verdicts, the build-status verdicts, and the share of conflicting pairs whose sections do \
         not link to each other, from the project's graph.",
    )
    .tag("StudioSpecGraph")
    .authenticated()
    .require_license_features::<License>([])
    .query_param("project_id", true, "The project")
    .handler(get_metrics)
    .json_response_with_schema::<SpecGraphAnswerDto>(openapi, StatusCode::OK, "The metrics")
    .error_400(openapi)
    .error_401(openapi)
    .error_404(openapi)
    .error_500(openapi)
    .register(router, openapi);

    router.layer(Extension(state))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_run_of_another_project_reads_as_absent() {
        let p = Uuid::new_v4();
        assert!(own_run(json!({"project": p.to_string()}), p).is_ok());
        assert!(own_run(json!({"project": Uuid::new_v4().to_string()}), p).is_err());
        assert!(own_run(json!({}), p).is_err());
    }

    #[test]
    fn the_source_is_named_by_its_clone_url_first() {
        let p = json!({"name": "other", "repository": {
            "url": "http://gw/cf/studio-git/v1/workspaces/w/sources/gears-rust", "ref": "main"}});
        assert_eq!(source_name(&p), Some("gears-rust"));
        assert_eq!(source_name(&json!({"name": "api"})), Some("api"));
        assert_eq!(source_name(&Value::Null), None);
    }

    #[test]
    fn type_lists_are_comma_separated_and_never_empty() {
        assert_eq!(
            type_list(Some(" document, requirement ,,")),
            Some(vec!["document".to_owned(), "requirement".to_owned()])
        );
        assert_eq!(type_list(Some(" , ")), None);
        assert_eq!(type_list(None), None);
    }

    #[test]
    fn an_unregistered_project_is_a_precondition_not_a_404() {
        let e = upstream(UpstreamError::Refused(
            404,
            "unknown project x: register it first".into(),
        ));
        assert!(format!("{e:?}").contains("NOT_SET_UP"));
    }
}
