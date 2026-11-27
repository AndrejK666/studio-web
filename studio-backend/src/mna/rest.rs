//! M&A due diligence's routes (studio-web#1024): a deal's attributes and
//! sign-off, its findings, risks and open questions, and its evidence.
//! The function is [`super::deal`]; the writes are claimed by the kit
//! (`builtin/mna.kit.json`), so they answer `KIT_NOT_INSTALLED` where it does
//! not apply to the project.

use std::sync::Arc;

use axum::http::HeaderMap;
use axum::{Extension, Router, extract::Path, extract::Query};
use serde_json::{Value, json};
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::deal::{Deal, DealPatch, Evidence, Item, Kind, Mna};
use crate::kit_registry::runtime::{ProjectKitQuery, refused};
use crate::org_scope::OrgAccess;
use crate::pagination::{PageQuery, page_of};

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

/// A deal: the M&A subtype's fields on the project.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct MnaDealDto {
    pub project_id: String,
    /// The kit applies to the project; everything else is empty when not.
    pub installed: bool,
    /// The company being evaluated.
    pub target: Option<String>,
    /// The strategic thesis.
    pub thesis: Option<String>,
    /// `screening`, `confirmatory_dd`, `signing` or `integration`.
    pub deal_phase: Option<String>,
    /// When the investment committee decides, `YYYY-MM-DD`.
    pub ic_date: Option<String>,
    /// `proceed`, `proceed_with_conditions` or `stop`.
    pub recommendation: Option<String>,
    pub conditions: Vec<String>,
    /// Who signed the recommendation off: a subject id.
    pub signed_off_by: Option<String>,
    /// When, RFC 3339.
    pub signed_off_at: Option<String>,
    /// The deal lead, who signs off: the project's owner
    /// (`project.config` `owner_id`), a subject id. Null when the project
    /// names no owner, and then nobody signs off.
    pub deal_lead: Option<String>,
    /// The caller is the deal lead.
    pub may_sign_off: bool,
    /// The phases a deal moves through, in order.
    pub phases: Vec<String>,
    /// The recommendations a deal may carry.
    pub recommendations: Vec<String>,
}

/// A change to a deal: a field present replaces, an empty string clears;
/// `conditions` replaces the list.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct MnaDealPatchDto {
    pub target: Option<String>,
    pub thesis: Option<String>,
    pub deal_phase: Option<String>,
    /// `YYYY-MM-DD`.
    pub ic_date: Option<String>,
    pub recommendation: Option<String>,
    pub conditions: Option<Vec<String>>,
}

/// A finding of the deal.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct MnaFindingDto {
    pub id: String,
    pub title: String,
    /// `critical`, `high`, `medium`, `low` or `info`.
    pub severity: String,
    /// The repository or part of the target it is about.
    pub source: Option<String>,
    /// What shows it.
    pub evidence: Option<String>,
    /// Where it came from: `manual`, `spec_check`, `ci`, `git`, `interview`, ...
    pub origin: String,
    /// `open`, `accepted` or `resolved`.
    pub status: String,
    /// Who recorded it: a subject id.
    pub created_by: Option<String>,
    /// RFC 3339.
    pub created_at: Option<String>,
    /// RFC 3339.
    pub updated_at: Option<String>,
}

/// A finding as written. `origin` is `manual` and `status` `open` when absent.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct MnaFindingBodyDto {
    pub title: String,
    pub severity: String,
    pub source: Option<String>,
    pub evidence: Option<String>,
    pub origin: Option<String>,
    pub status: Option<String>,
}

/// A risk of the deal's ledger.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct MnaRiskDto {
    pub id: String,
    pub title: String,
    /// `low`, `medium` or `high`.
    pub likelihood: String,
    /// `low`, `medium`, `high` or `critical`.
    pub impact: String,
    pub owner: Option<String>,
    pub mitigation: Option<String>,
    /// The finding it comes from.
    pub finding_id: Option<String>,
    /// `open`, `mitigating`, `accepted` or `closed`.
    pub status: String,
    pub created_by: Option<String>,
    /// RFC 3339.
    pub created_at: Option<String>,
    /// RFC 3339.
    pub updated_at: Option<String>,
}

/// A risk as written. `status` is `open` when absent; `finding_id` names
/// one of the deal's findings.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct MnaRiskBodyDto {
    pub title: String,
    pub likelihood: String,
    pub impact: String,
    pub owner: Option<String>,
    pub mitigation: Option<String>,
    pub finding_id: Option<String>,
    pub status: Option<String>,
}

/// An open question the deal team asks.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct MnaQuestionDto {
    pub id: String,
    /// The question.
    pub what: String,
    /// Who is asked.
    pub who: Option<String>,
    pub answer: Option<String>,
    /// `open`, `answered` or `closed`.
    pub status: String,
    pub created_by: Option<String>,
    /// RFC 3339.
    pub created_at: Option<String>,
    /// RFC 3339.
    pub updated_at: Option<String>,
}

/// An open question as written. `status` is `answered` when an answer is
/// given and `open` otherwise, when absent.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct MnaQuestionBodyDto {
    pub what: String,
    pub who: Option<String>,
    pub answer: Option<String>,
    pub status: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct MnaFindingListDto {
    pub items: Vec<MnaFindingDto>,
    pub total: u32,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct MnaRiskListDto {
    pub items: Vec<MnaRiskDto>,
    pub total: u32,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct MnaQuestionListDto {
    pub items: Vec<MnaQuestionDto>,
    pub total: u32,
}

/// One of the target's repositories in the evidence.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct MnaEvidenceRepositoryDto {
    pub full_path: String,
    pub branch: Option<String>,
    /// When its last sync finished, RFC 3339; null when it never did.
    pub synced_at: Option<String>,
    /// People (not bots) the provider lists as contributors, up to 100;
    /// null when the provider could not be asked.
    pub contributors: Option<u32>,
    /// The fewest of them who made more than half of its commits.
    pub truck_factor: Option<u32>,
}

/// One fact of the evidence: a number and where it came from, or why
/// there is none.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct MnaEvidenceFactDto {
    /// `repositories`, `repositories_synced`, `contributors`,
    /// `truck_factor`, `active_contributors`, `ci_pass_rate` (0..1),
    /// `mainline_build` (1 passed, 0 not), `specs_checked`, `specs_failing`,
    /// `spec_findings_open`, `findings_open`, `risks_open`,
    /// `questions_open`.
    pub key: String,
    /// Null when not available: never a guess.
    pub value: Option<f64>,
    /// What `value` is out of, where that says something.
    pub total: Option<f64>,
    pub available: bool,
    /// Where the number came from.
    pub source: String,
    /// What it means, or why it is not available.
    pub detail: Option<String>,
}

/// What Studio already holds about the target, computed on the server.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct MnaEvidenceDto {
    pub project_id: String,
    /// When it was read, RFC 3339.
    pub read_at: String,
    pub repositories: Vec<MnaEvidenceRepositoryDto>,
    pub facts: Vec<MnaEvidenceFactDto>,
}

/// A list's query: the project and a page.
#[derive(Debug, serde::Deserialize)]
pub struct ProjectPageQuery {
    pub project_id: Uuid,
    #[serde(flatten)]
    pub page: PageQuery,
}

fn deal_dto(project: Uuid, d: Deal) -> MnaDealDto {
    MnaDealDto {
        project_id: project.to_string(),
        installed: d.installed,
        target: d.target,
        thesis: d.thesis,
        deal_phase: d.deal_phase,
        ic_date: d.ic_date,
        recommendation: d.recommendation,
        conditions: d.conditions,
        signed_off_by: d.signed_off_by,
        signed_off_at: d.signed_off_at,
        deal_lead: d.deal_lead,
        may_sign_off: d.may_sign_off,
        phases: d.phases,
        recommendations: d.recommendations,
    }
}

fn finding_dto(i: Item) -> MnaFindingDto {
    MnaFindingDto {
        title: i.text("title").unwrap_or_default(),
        severity: i.text("severity").unwrap_or_default(),
        source: i.text("source"),
        evidence: i.text("evidence"),
        origin: i.text("origin").unwrap_or_else(|| "manual".into()),
        status: i.text("status").unwrap_or_else(|| "open".into()),
        created_by: i.text("created_by"),
        created_at: i.text("created_at"),
        updated_at: i.text("updated_at"),
        id: i.id,
    }
}

fn risk_dto(i: Item) -> MnaRiskDto {
    MnaRiskDto {
        title: i.text("title").unwrap_or_default(),
        likelihood: i.text("likelihood").unwrap_or_default(),
        impact: i.text("impact").unwrap_or_default(),
        owner: i.text("owner"),
        mitigation: i.text("mitigation"),
        finding_id: i.text("finding_id"),
        status: i.text("status").unwrap_or_else(|| "open".into()),
        created_by: i.text("created_by"),
        created_at: i.text("created_at"),
        updated_at: i.text("updated_at"),
        id: i.id,
    }
}

fn question_dto(i: Item) -> MnaQuestionDto {
    MnaQuestionDto {
        what: i.text("what").unwrap_or_default(),
        who: i.text("who"),
        answer: i.text("answer"),
        status: i.text("status").unwrap_or_else(|| "open".into()),
        created_by: i.text("created_by"),
        created_at: i.text("created_at"),
        updated_at: i.text("updated_at"),
        id: i.id,
    }
}

fn evidence_dto(project: Uuid, e: Evidence) -> MnaEvidenceDto {
    MnaEvidenceDto {
        project_id: project.to_string(),
        read_at: e.read_at,
        repositories: e
            .repositories
            .into_iter()
            .map(|r| MnaEvidenceRepositoryDto {
                full_path: r.full_path,
                branch: r.branch,
                synced_at: r.synced_at,
                contributors: r.contributors,
                truck_factor: r.truck_factor,
            })
            .collect(),
        facts: e
            .facts
            .into_iter()
            .map(|f| MnaEvidenceFactDto {
                key: f.key.to_owned(),
                value: f.value,
                total: f.total,
                available: f.available,
                source: f.source,
                detail: f.detail,
            })
            .collect(),
    }
}

/// The caller, checked to reach the project.
async fn reach(
    access: &OrgAccess,
    ctx: &SecurityContext,
    project: Uuid,
) -> ApiResult<SecurityContext> {
    crate::org_scope::resolve(access.0.as_ref(), ctx, Some(project)).await
}

async fn get_deal(
    Extension(ctx): Extension<SecurityContext>,
    Extension(access): Extension<OrgAccess>,
    Extension(mna): Extension<Arc<Mna>>,
    Query(ProjectKitQuery { project_id }): Query<ProjectKitQuery>,
) -> ApiResult<JsonBody<MnaDealDto>> {
    let ctx = reach(&access, &ctx, project_id).await?;
    let deal = mna.deal(&ctx, project_id).await.map_err(refused)?;
    Ok(Json(deal_dto(project_id, deal)))
}

async fn patch_deal(
    Extension(ctx): Extension<SecurityContext>,
    Extension(access): Extension<OrgAccess>,
    Extension(mna): Extension<Arc<Mna>>,
    Query(ProjectKitQuery { project_id }): Query<ProjectKitQuery>,
    Json(body): Json<MnaDealPatchDto>,
) -> ApiResult<JsonBody<MnaDealDto>> {
    let ctx = reach(&access, &ctx, project_id).await?;
    let patch = DealPatch {
        target: body.target,
        thesis: body.thesis,
        deal_phase: body.deal_phase,
        ic_date: body.ic_date,
        recommendation: body.recommendation,
        conditions: body.conditions,
    };
    let deal = mna
        .update_deal(&ctx, project_id, patch)
        .await
        .map_err(refused)?;
    Ok(Json(deal_dto(project_id, deal)))
}

async fn confirm_sign_off(
    Extension(ctx): Extension<SecurityContext>,
    Extension(access): Extension<OrgAccess>,
    Extension(mna): Extension<Arc<Mna>>,
    Query(ProjectKitQuery { project_id }): Query<ProjectKitQuery>,
) -> ApiResult<JsonBody<MnaDealDto>> {
    let ctx = reach(&access, &ctx, project_id).await?;
    let deal = mna.sign_off(&ctx, project_id).await.map_err(refused)?;
    Ok(Json(deal_dto(project_id, deal)))
}

async fn get_evidence(
    Extension(ctx): Extension<SecurityContext>,
    Extension(access): Extension<OrgAccess>,
    Extension(mna): Extension<Arc<Mna>>,
    headers: HeaderMap,
    Query(ProjectKitQuery { project_id }): Query<ProjectKitQuery>,
) -> ApiResult<JsonBody<MnaEvidenceDto>> {
    let ctx = reach(&access, &ctx, project_id).await?;
    let api = crate::mcp::api_as(headers.get(axum::http::header::AUTHORIZATION).cloned())
        .ok_or_else(|| {
            CanonicalError::service_unavailable()
                .with_detail("studio-mcp is not running here, so the other gears cannot be read")
                .create()
        })?;
    let evidence = mna
        .evidence(&ctx, project_id, &api)
        .await
        .map_err(refused)?;
    Ok(Json(evidence_dto(project_id, evidence)))
}

async fn items(
    access: &OrgAccess,
    mna: &Mna,
    ctx: &SecurityContext,
    query: ProjectPageQuery,
    kind: Kind,
) -> ApiResult<(Vec<Item>, u32)> {
    let ctx = reach(access, ctx, query.project_id).await?;
    let all = mna
        .items(&ctx, query.project_id, kind)
        .await
        .map_err(refused)?;
    Ok(page_of(all, query.page))
}

async fn save(
    access: &OrgAccess,
    mna: &Mna,
    ctx: &SecurityContext,
    project: Uuid,
    kind: Kind,
    id: Option<&str>,
    body: &Value,
) -> ApiResult<Item> {
    let ctx = reach(access, ctx, project).await?;
    mna.save_item(&ctx, project, kind, id, body)
        .await
        .map_err(refused)
}

async fn delete(
    access: &OrgAccess,
    mna: &Mna,
    ctx: &SecurityContext,
    project: Uuid,
    kind: Kind,
    id: &str,
) -> ApiResult<StatusCode> {
    let ctx = reach(access, ctx, project).await?;
    mna.delete_item(&ctx, project, kind, id)
        .await
        .map_err(refused)?;
    Ok(StatusCode::NO_CONTENT)
}

fn finding_body(b: MnaFindingBodyDto) -> Value {
    json!({ "title": b.title, "severity": b.severity, "source": b.source,
        "evidence": b.evidence, "origin": b.origin, "status": b.status })
}

fn risk_body(b: MnaRiskBodyDto) -> Value {
    json!({ "title": b.title, "likelihood": b.likelihood, "impact": b.impact,
        "owner": b.owner, "mitigation": b.mitigation, "finding_id": b.finding_id,
        "status": b.status })
}

fn question_body(b: MnaQuestionBodyDto) -> Value {
    json!({ "what": b.what, "who": b.who, "answer": b.answer, "status": b.status })
}

async fn list_findings(
    Extension(ctx): Extension<SecurityContext>,
    Extension(access): Extension<OrgAccess>,
    Extension(mna): Extension<Arc<Mna>>,
    Query(query): Query<ProjectPageQuery>,
) -> ApiResult<JsonBody<MnaFindingListDto>> {
    let (items, total) = items(&access, &mna, &ctx, query, Kind::Finding).await?;
    Ok(Json(MnaFindingListDto {
        items: items.into_iter().map(finding_dto).collect(),
        total,
    }))
}

async fn create_finding(
    Extension(ctx): Extension<SecurityContext>,
    Extension(access): Extension<OrgAccess>,
    Extension(mna): Extension<Arc<Mna>>,
    Query(ProjectKitQuery { project_id }): Query<ProjectKitQuery>,
    Json(body): Json<MnaFindingBodyDto>,
) -> ApiResult<(StatusCode, JsonBody<MnaFindingDto>)> {
    let item = save(
        &access,
        &mna,
        &ctx,
        project_id,
        Kind::Finding,
        None,
        &finding_body(body),
    )
    .await?;
    Ok((StatusCode::CREATED, Json(finding_dto(item))))
}

async fn update_finding(
    Extension(ctx): Extension<SecurityContext>,
    Extension(access): Extension<OrgAccess>,
    Extension(mna): Extension<Arc<Mna>>,
    Path(finding_id): Path<String>,
    Query(ProjectKitQuery { project_id }): Query<ProjectKitQuery>,
    Json(body): Json<MnaFindingBodyDto>,
) -> ApiResult<JsonBody<MnaFindingDto>> {
    let item = save(
        &access,
        &mna,
        &ctx,
        project_id,
        Kind::Finding,
        Some(&finding_id),
        &finding_body(body),
    )
    .await?;
    Ok(Json(finding_dto(item)))
}

async fn delete_finding(
    Extension(ctx): Extension<SecurityContext>,
    Extension(access): Extension<OrgAccess>,
    Extension(mna): Extension<Arc<Mna>>,
    Path(finding_id): Path<String>,
    Query(ProjectKitQuery { project_id }): Query<ProjectKitQuery>,
) -> ApiResult<StatusCode> {
    delete(&access, &mna, &ctx, project_id, Kind::Finding, &finding_id).await
}

async fn list_risks(
    Extension(ctx): Extension<SecurityContext>,
    Extension(access): Extension<OrgAccess>,
    Extension(mna): Extension<Arc<Mna>>,
    Query(query): Query<ProjectPageQuery>,
) -> ApiResult<JsonBody<MnaRiskListDto>> {
    let (items, total) = items(&access, &mna, &ctx, query, Kind::Risk).await?;
    Ok(Json(MnaRiskListDto {
        items: items.into_iter().map(risk_dto).collect(),
        total,
    }))
}

async fn create_risk(
    Extension(ctx): Extension<SecurityContext>,
    Extension(access): Extension<OrgAccess>,
    Extension(mna): Extension<Arc<Mna>>,
    Query(ProjectKitQuery { project_id }): Query<ProjectKitQuery>,
    Json(body): Json<MnaRiskBodyDto>,
) -> ApiResult<(StatusCode, JsonBody<MnaRiskDto>)> {
    let item = save(
        &access,
        &mna,
        &ctx,
        project_id,
        Kind::Risk,
        None,
        &risk_body(body),
    )
    .await?;
    Ok((StatusCode::CREATED, Json(risk_dto(item))))
}

async fn update_risk(
    Extension(ctx): Extension<SecurityContext>,
    Extension(access): Extension<OrgAccess>,
    Extension(mna): Extension<Arc<Mna>>,
    Path(risk_id): Path<String>,
    Query(ProjectKitQuery { project_id }): Query<ProjectKitQuery>,
    Json(body): Json<MnaRiskBodyDto>,
) -> ApiResult<JsonBody<MnaRiskDto>> {
    let item = save(
        &access,
        &mna,
        &ctx,
        project_id,
        Kind::Risk,
        Some(&risk_id),
        &risk_body(body),
    )
    .await?;
    Ok(Json(risk_dto(item)))
}

async fn delete_risk(
    Extension(ctx): Extension<SecurityContext>,
    Extension(access): Extension<OrgAccess>,
    Extension(mna): Extension<Arc<Mna>>,
    Path(risk_id): Path<String>,
    Query(ProjectKitQuery { project_id }): Query<ProjectKitQuery>,
) -> ApiResult<StatusCode> {
    delete(&access, &mna, &ctx, project_id, Kind::Risk, &risk_id).await
}

async fn list_questions(
    Extension(ctx): Extension<SecurityContext>,
    Extension(access): Extension<OrgAccess>,
    Extension(mna): Extension<Arc<Mna>>,
    Query(query): Query<ProjectPageQuery>,
) -> ApiResult<JsonBody<MnaQuestionListDto>> {
    let (items, total) = items(&access, &mna, &ctx, query, Kind::Question).await?;
    Ok(Json(MnaQuestionListDto {
        items: items.into_iter().map(question_dto).collect(),
        total,
    }))
}

async fn create_question(
    Extension(ctx): Extension<SecurityContext>,
    Extension(access): Extension<OrgAccess>,
    Extension(mna): Extension<Arc<Mna>>,
    Query(ProjectKitQuery { project_id }): Query<ProjectKitQuery>,
    Json(body): Json<MnaQuestionBodyDto>,
) -> ApiResult<(StatusCode, JsonBody<MnaQuestionDto>)> {
    let item = save(
        &access,
        &mna,
        &ctx,
        project_id,
        Kind::Question,
        None,
        &question_body(body),
    )
    .await?;
    Ok((StatusCode::CREATED, Json(question_dto(item))))
}

async fn update_question(
    Extension(ctx): Extension<SecurityContext>,
    Extension(access): Extension<OrgAccess>,
    Extension(mna): Extension<Arc<Mna>>,
    Path(question_id): Path<String>,
    Query(ProjectKitQuery { project_id }): Query<ProjectKitQuery>,
    Json(body): Json<MnaQuestionBodyDto>,
) -> ApiResult<JsonBody<MnaQuestionDto>> {
    let item = save(
        &access,
        &mna,
        &ctx,
        project_id,
        Kind::Question,
        Some(&question_id),
        &question_body(body),
    )
    .await?;
    Ok(Json(question_dto(item)))
}

async fn delete_question(
    Extension(ctx): Extension<SecurityContext>,
    Extension(access): Extension<OrgAccess>,
    Extension(mna): Extension<Arc<Mna>>,
    Path(question_id): Path<String>,
    Query(ProjectKitQuery { project_id }): Query<ProjectKitQuery>,
) -> ApiResult<StatusCode> {
    delete(
        &access,
        &mna,
        &ctx,
        project_id,
        Kind::Question,
        &question_id,
    )
    .await
}

/// The routes, with the function as an `Extension`.
pub fn register_routes(
    mut router: Router,
    openapi: &dyn OpenApiRegistry,
    mna: Arc<Mna>,
    access: OrgAccess,
) -> Router {
    router = OperationBuilder::get("/studio-kits/v1/mna/deal")
        .operation_id("studio_kits.get_mna_deal")
        .summary("A deal: the M&A project's attributes and sign-off (M&A due diligence)")
        .description(
            "Any member who reaches the project. The target, the thesis, the phase, the IC date, \
             the recommendation with its conditions, who signed it off and when — fields of the \
             kit's subtype of Project, read from the project's object — and the deal lead (the \
             project's owner), with whether the caller is that person. `installed` is false, and \
             the rest empty, where the kit does not apply to the project.",
        )
        .tag("StudioKits")
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("project_id", true, "The project (the deal)", "string")
        .handler(get_deal)
        .json_response_with_schema::<MnaDealDto>(openapi, StatusCode::OK, "The deal")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::patch("/studio-kits/v1/mna/deal")
        .operation_id("studio_kits.patch_mna_deal")
        .summary("Change a deal's attributes (M&A due diligence)")
        .description(
            "Each field present replaces the deal's, an empty string clears it, `conditions` \
             replaces the list. `deal_phase` and `recommendation` take the kit's values (400 \
             `invalid_argument` otherwise), `ic_date` a day, `YYYY-MM-DD`. A change of the \
             recommendation or of its conditions takes an earlier sign-off back.",
        )
        .tag("StudioKits")
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("project_id", true, "The project (the deal)", "string")
        .json_request::<MnaDealPatchDto>(openapi, "The fields to change")
        .handler(patch_deal)
        .json_response_with_schema::<MnaDealDto>(openapi, StatusCode::OK, "The deal")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-kits/v1/mna/deal/sign-off")
        .operation_id("studio_kits.confirm_mna_deal_sign_off")
        .summary("Sign a deal's recommendation off, as its deal lead (M&A due diligence)")
        .description(
            "Only the deal lead — the project's owner, `project.config` `owner_id` — signs off \
             (403 `DEAL_LEAD_REQUIRED`); a deal with no recommendation is refused with 400 \
             `failed_precondition` (`NO_RECOMMENDATION`). Records the caller and the time on \
             the deal and answers it. Changing the recommendation or its conditions afterwards \
             takes the sign-off back.",
        )
        .tag("StudioKits")
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("project_id", true, "The project (the deal)", "string")
        .handler(confirm_sign_off)
        .json_response_with_schema::<MnaDealDto>(openapi, StatusCode::OK, "The deal, signed off")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-kits/v1/mna/evidence")
        .operation_id("studio_kits.get_mna_evidence")
        .summary("What Studio already holds about a deal's target (M&A due diligence)")
        .description(
            "Computed on the server from the project's existing data, read as the caller: the \
             target's repositories (the project's sources) and their last sync; contributors \
             and the truck factor from the provider through each source's connection; active \
             contributors over 90 days from Insight; the CI pass rate and the mainline's last \
             build; specs checked and failing and Spec Quality's open findings; the deal's own \
             open findings, risks and questions. Every fact says where it came from, and one \
             whose source could not be asked is `available: false` with the reason, never a \
             number. Where the kit does not apply, 400 `failed_precondition` \
             (`KIT_NOT_INSTALLED`).",
        )
        .tag("StudioKits")
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("project_id", true, "The project (the deal)", "string")
        .handler(get_evidence)
        .json_response_with_schema::<MnaEvidenceDto>(openapi, StatusCode::OK, "The evidence")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-kits/v1/mna/findings")
        .operation_id("studio_kits.list_mna_findings")
        .summary("A deal's findings (M&A due diligence)")
        .description(
            "Any member who reaches the project; newest first. Empty where the kit does not \
             apply.",
        )
        .tag("StudioKits")
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("project_id", true, "The project (the deal)", "string")
        .query_param_typed(
            "offset",
            false,
            "Zero-based index of the first item",
            "integer",
        )
        .query_param_typed("limit", false, "Page size, 1..=200 (default 50)", "integer")
        .handler(list_findings)
        .json_response_with_schema::<MnaFindingListDto>(openapi, StatusCode::OK, "The findings")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-kits/v1/mna/findings")
        .operation_id("studio_kits.create_mna_finding")
        .summary("Record a finding of a deal (M&A due diligence)")
        .description(
            "A finding of the deal (`mna-finding` in the project's scope): `title` and `severity` \
             (`critical`, `high`, `medium`, `low`, `info`) needed, `origin` `manual` and \
             `status` `open` when absent. Answers 201 with it. \
             Where the kit does not apply to the project, 400 `failed_precondition` \
             (`KIT_NOT_INSTALLED`). Written as the caller: the PDP's `domain.edit` decides \
             (403 `DOMAIN_EDIT_REQUIRED`).",
        )
        .tag("StudioKits")
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("project_id", true, "The project (the deal)", "string")
        .json_request::<MnaFindingBodyDto>(openapi, "The finding")
        .handler(create_finding)
        .json_response_with_schema::<MnaFindingDto>(openapi, StatusCode::CREATED, "The finding")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::put("/studio-kits/v1/mna/findings/{finding_id}")
        .operation_id("studio_kits.update_mna_finding")
        .summary("Replace a finding of a deal (M&A due diligence)")
        .description(
            "The finding as written, whole; who recorded it and when stay. 404 for a finding \
             the deal does not have. \
             Where the kit does not apply to the project, 400 `failed_precondition` \
             (`KIT_NOT_INSTALLED`). Written as the caller: the PDP's `domain.edit` decides \
             (403 `DOMAIN_EDIT_REQUIRED`).",
        )
        .tag("StudioKits")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("finding_id", "The finding")
        .query_param_typed("project_id", true, "The project (the deal)", "string")
        .json_request::<MnaFindingBodyDto>(openapi, "The finding")
        .handler(update_finding)
        .json_response_with_schema::<MnaFindingDto>(openapi, StatusCode::OK, "The finding")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::delete("/studio-kits/v1/mna/findings/{finding_id}")
        .operation_id("studio_kits.delete_mna_finding")
        .summary("Delete a finding of a deal (M&A due diligence)")
        .description(
            "404 for a finding the deal does not have. \
             Where the kit does not apply to the project, 400 `failed_precondition` \
             (`KIT_NOT_INSTALLED`). Written as the caller: the PDP's `domain.edit` decides \
             (403 `DOMAIN_EDIT_REQUIRED`).",
        )
        .tag("StudioKits")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("finding_id", "The finding")
        .query_param_typed("project_id", true, "The project (the deal)", "string")
        .handler(delete_finding)
        .no_content_response(StatusCode::NO_CONTENT, "Deleted")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-kits/v1/mna/risks")
        .operation_id("studio_kits.list_mna_risks")
        .summary("A deal's risk ledger (M&A due diligence)")
        .description(
            "Any member who reaches the project; newest first. Empty where the kit does not \
             apply.",
        )
        .tag("StudioKits")
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("project_id", true, "The project (the deal)", "string")
        .query_param_typed(
            "offset",
            false,
            "Zero-based index of the first item",
            "integer",
        )
        .query_param_typed("limit", false, "Page size, 1..=200 (default 50)", "integer")
        .handler(list_risks)
        .json_response_with_schema::<MnaRiskListDto>(openapi, StatusCode::OK, "The risks")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-kits/v1/mna/risks")
        .operation_id("studio_kits.create_mna_risk")
        .summary("Record a risk of a deal (M&A due diligence)")
        .description(
            "A risk of the deal's ledger (`mna-risk` in the project's scope): `title`, \
             `likelihood` (`low`, `medium`, `high`) and `impact` (`low`, `medium`, `high`, \
             `critical`) needed, `status` `open` when absent; `finding_id` names one of the \
             deal's findings. Answers 201 with it. \
             Where the kit does not apply to the project, 400 `failed_precondition` \
             (`KIT_NOT_INSTALLED`). Written as the caller: the PDP's `domain.edit` decides \
             (403 `DOMAIN_EDIT_REQUIRED`).",
        )
        .tag("StudioKits")
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("project_id", true, "The project (the deal)", "string")
        .json_request::<MnaRiskBodyDto>(openapi, "The risk")
        .handler(create_risk)
        .json_response_with_schema::<MnaRiskDto>(openapi, StatusCode::CREATED, "The risk")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::put("/studio-kits/v1/mna/risks/{risk_id}")
        .operation_id("studio_kits.update_mna_risk")
        .summary("Replace a risk of a deal (M&A due diligence)")
        .description(
            "The risk as written, whole; who recorded it and when stay. 404 for a risk the \
             deal does not have. \
             Where the kit does not apply to the project, 400 `failed_precondition` \
             (`KIT_NOT_INSTALLED`). Written as the caller: the PDP's `domain.edit` decides \
             (403 `DOMAIN_EDIT_REQUIRED`).",
        )
        .tag("StudioKits")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("risk_id", "The risk")
        .query_param_typed("project_id", true, "The project (the deal)", "string")
        .json_request::<MnaRiskBodyDto>(openapi, "The risk")
        .handler(update_risk)
        .json_response_with_schema::<MnaRiskDto>(openapi, StatusCode::OK, "The risk")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::delete("/studio-kits/v1/mna/risks/{risk_id}")
        .operation_id("studio_kits.delete_mna_risk")
        .summary("Delete a risk of a deal (M&A due diligence)")
        .description(
            "404 for a risk the deal does not have. \
             Where the kit does not apply to the project, 400 `failed_precondition` \
             (`KIT_NOT_INSTALLED`). Written as the caller: the PDP's `domain.edit` decides \
             (403 `DOMAIN_EDIT_REQUIRED`).",
        )
        .tag("StudioKits")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("risk_id", "The risk")
        .query_param_typed("project_id", true, "The project (the deal)", "string")
        .handler(delete_risk)
        .no_content_response(StatusCode::NO_CONTENT, "Deleted")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-kits/v1/mna/open-questions")
        .operation_id("studio_kits.list_mna_open_questions")
        .summary("A deal's open questions (M&A due diligence)")
        .description(
            "Any member who reaches the project; newest first. Empty where the kit does not \
             apply.",
        )
        .tag("StudioKits")
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("project_id", true, "The project (the deal)", "string")
        .query_param_typed(
            "offset",
            false,
            "Zero-based index of the first item",
            "integer",
        )
        .query_param_typed("limit", false, "Page size, 1..=200 (default 50)", "integer")
        .handler(list_questions)
        .json_response_with_schema::<MnaQuestionListDto>(openapi, StatusCode::OK, "The questions")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-kits/v1/mna/open-questions")
        .operation_id("studio_kits.create_mna_open_question")
        .summary("Ask an open question in a deal (M&A due diligence)")
        .description(
            "An open question of the deal (`mna-open-question` in the project's scope): `what` \
             needed; `status` `answered` when an `answer` is given and `open` otherwise, when \
             absent. Answers 201 with it. \
             Where the kit does not apply to the project, 400 `failed_precondition` \
             (`KIT_NOT_INSTALLED`). Written as the caller: the PDP's `domain.edit` decides \
             (403 `DOMAIN_EDIT_REQUIRED`).",
        )
        .tag("StudioKits")
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("project_id", true, "The project (the deal)", "string")
        .json_request::<MnaQuestionBodyDto>(openapi, "The question")
        .handler(create_question)
        .json_response_with_schema::<MnaQuestionDto>(openapi, StatusCode::CREATED, "The question")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::put("/studio-kits/v1/mna/open-questions/{question_id}")
        .operation_id("studio_kits.update_mna_open_question")
        .summary("Replace an open question of a deal (M&A due diligence)")
        .description(
            "The question as written, whole: its answer and status too; who asked it and when \
             stay. 404 for a question the deal does not have. \
             Where the kit does not apply to the project, 400 `failed_precondition` \
             (`KIT_NOT_INSTALLED`). Written as the caller: the PDP's `domain.edit` decides \
             (403 `DOMAIN_EDIT_REQUIRED`).",
        )
        .tag("StudioKits")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("question_id", "The question")
        .query_param_typed("project_id", true, "The project (the deal)", "string")
        .json_request::<MnaQuestionBodyDto>(openapi, "The question")
        .handler(update_question)
        .json_response_with_schema::<MnaQuestionDto>(openapi, StatusCode::OK, "The question")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::delete("/studio-kits/v1/mna/open-questions/{question_id}")
        .operation_id("studio_kits.delete_mna_open_question")
        .summary("Delete an open question of a deal (M&A due diligence)")
        .description(
            "404 for a question the deal does not have. \
             Where the kit does not apply to the project, 400 `failed_precondition` \
             (`KIT_NOT_INSTALLED`). Written as the caller: the PDP's `domain.edit` decides \
             (403 `DOMAIN_EDIT_REQUIRED`).",
        )
        .tag("StudioKits")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("question_id", "The question")
        .query_param_typed("project_id", true, "The project (the deal)", "string")
        .handler(delete_question)
        .no_content_response(StatusCode::NO_CONTENT, "Deleted")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router.layer(Extension(mna)).layer(Extension(access))
}
