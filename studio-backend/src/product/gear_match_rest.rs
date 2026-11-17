//! Gear matches over REST (`docs/design/product-gear-match.md`). All under
//! `/studio-product/v1`, the project in `?project_id=`:
//!
//! - `POST gear-matches` -- read the project's specifications as the caller,
//!   send them to the gears-matcher service in one studio-tasks run; 202.
//! - `GET  gear-matches` -- the project's matches, newest first.
//! - `GET  gear-matches/{match_id}` (or `latest`) -- one match with its report
//!   read for a person: per requirement the verdict, candidates, evidence,
//!   passage, Studio's action, decisions and answers.
//! - `GET  gear-matches/{match_id}/diff?base=` -- what changed since another.
//! - `POST gear-matches/{match_id}/cancel` -- stop it, and the matcher's run.
//! - `PUT  gear-match-decisions` -- a member accepts or rejects a proposed gear.
//! - `PUT  gear-match-answers` -- a member answers a question; the next match
//!   reads the answer beside the requirement.
//! - `GET  inbox/gear-match-questions` -- the Inbox's `endpoint` source: the
//!   open questions of the matches the caller asked for.
//!
//! Every route answers 503 saying why when the matcher or the gear's database
//! is not here; nothing else of the product depends on them.

use std::collections::BTreeMap;

use axum::http::HeaderMap;

use super::*;
use crate::product::gear_match::report::{self, SentDocument};
use crate::product::gear_match::store::{self as match_store, Match};
use crate::product::gear_match::{self, GearMatches, Refusal, StartRequest};

#[derive(Debug, serde::Deserialize)]
pub struct GearMatchQuery {
    pub project_id: Uuid,
}

#[derive(Debug, serde::Deserialize)]
pub struct GearMatchDiffQuery {
    pub project_id: Uuid,
    /// The earlier match; the one before `match_id` when absent.
    pub base: Option<Uuid>,
}

/// What to read.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct StartGearMatchRequest {
    /// The documents of the project's model to send (`docs/…`, `studio:<id>`,
    /// `upload:<name>`); with `glob` empty too, the project's PRDs, else all.
    pub paths: Option<Vec<String>>,
    /// `*` within a directory, `**` across.
    pub glob: Option<String>,
    /// Gears that are the product itself, never offered (`<repo>/<gear>`).
    pub own_gears: Option<Vec<String>>,
    /// Also read documents not in the spec format, with at most this many
    /// model calls; the deployment's setting when absent.
    pub extract_max_calls: Option<u32>,
    /// The same key answers the match it made first (also the
    /// `Idempotency-Key` header).
    pub idempotency_key: Option<String>,
}

/// A match started.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearMatchStartedDto {
    /// The studio-tasks run (`GET /studio-tasks/v1/runs/{id}`).
    pub run_id: String,
    pub match_id: String,
    pub state: String,
}

/// One document as it was sent.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearMatchDocumentDto {
    /// The project's path (`docs/…`, `studio:<id>`, `upload:<name>`).
    pub path: String,
    /// The path the matcher was given.
    pub matcher_path: String,
    /// SHA-256 of the text sent.
    pub sha256: String,
    pub bytes: u64,
    pub doc_type: Option<String>,
    /// The commit and branch a repository document was read at.
    pub commit: Option<String>,
    pub branch: Option<String>,
    /// The questions whose answers went into the text sent.
    pub answered: Vec<String>,
}

/// A report's counts.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearMatchTotalsDto {
    pub requirements: u32,
    pub covered: u32,
    pub partial: u32,
    pub gap: u32,
    pub clarification_needed: u32,
    pub not_assessed: u32,
}

/// A match as a list shows it.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearMatchItemDto {
    pub match_id: String,
    pub run_id: Option<String>,
    /// `queued`, `running`, `cancelling`, `succeeded`, `partial` (some
    /// requirements not assessed), `failed` or `cancelled`.
    pub state: String,
    /// The subject id of who asked.
    pub requested_by: String,
    /// RFC 3339.
    pub created_at: String,
    pub finished_at: Option<String>,
    /// The matcher's own run id.
    pub matcher_run_id: Option<String>,
    pub totals: Option<GearMatchTotalsDto>,
    /// `{requirements_done, requirements_total, usage}` while it runs.
    #[schema(value_type = Object)]
    pub progress: Option<Value>,
    pub error: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearMatchListDto {
    /// Newest first.
    pub items: Vec<GearMatchItemDto>,
    pub total: u32,
}

/// The passage a requirement was read from.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearMatchPassageDto {
    pub path: String,
    pub line: u32,
    pub text: String,
}

/// A candidate gear for one requirement.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearMatchCandidateDto {
    /// `<repository>/<gear>`, as the matcher names it.
    pub gear_id: String,
    /// The name a product picks it by.
    pub pick: String,
    pub name: Option<String>,
    /// `covered`, `partial`, `none` or `unjudgeable`.
    pub verdict: String,
    pub confidence: Option<f64>,
    /// `chosen`, `alternative` or `other`.
    pub role: String,
    pub evidence: String,
    pub covers: String,
    pub missing: String,
    pub rationale: String,
    /// Whether it has code; a future part has none.
    pub in_code: Option<bool>,
    /// `recommended`, `also_possible` or `future_part`.
    pub listed: Option<String>,
    /// Studio proposes it for the product.
    pub proposed: bool,
    /// A member's `accepted` or `rejected`, kept with the project.
    pub decision: Option<String>,
}

/// One requirement of the report.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearMatchRequirementDto {
    pub requirement_id: String,
    /// `fr` or `nfr`.
    pub kind: String,
    /// `covered`, `partial`, `gap`, `clarification_needed` or `not_assessed`.
    pub coverage: String,
    pub confidence: Option<f64>,
    pub low_confidence: bool,
    pub extracted: bool,
    pub reason: String,
    pub gear_provides: String,
    pub remaining_work: String,
    /// `propose` (add a candidate to the product), `review` (only future
    /// parts fit), `create_gear` (a gap), `answer` (a question), `rerun` (not
    /// assessed) or `none`.
    pub action: String,
    pub candidates: Vec<GearMatchCandidateDto>,
    pub passage: Option<GearMatchPassageDto>,
}

/// A question the matcher asks.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearMatchQuestionDto {
    /// The requirement's id, or `c-…` for the report's own.
    pub id: String,
    pub requirement_id: Option<String>,
    pub topic: String,
    pub reason: String,
    pub quote: Option<String>,
    pub path: Option<String>,
    /// The project's answer, when there is one.
    pub answer: Option<String>,
    pub answered_by: Option<String>,
}

/// One match with its report read for a person.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearMatchDto {
    /// Its state, as the list shows it.
    pub summary: GearMatchItemDto,
    pub project_id: String,
    /// The product id the matcher was given.
    pub product: String,
    pub documents: Vec<GearMatchDocumentDto>,
    /// What the service said when the run started: its versions, the models,
    /// the catalogue's commits.
    #[schema(value_type = Object)]
    pub matcher: Option<Value>,
    /// The catalogue's commits the report names (`gears_md_commit`,
    /// `gear_gdl_commit`).
    pub catalogue_commit: Option<String>,
    pub schema_version: Option<String>,
    #[schema(value_type = Object)]
    pub usage: Option<Value>,
    pub requirements: Vec<GearMatchRequirementDto>,
    pub questions: Vec<GearMatchQuestionDto>,
    /// The report as the matcher wrote it, with `?raw=true` only.
    #[schema(value_type = Object)]
    pub report: Option<Value>,
}

#[derive(Debug, serde::Deserialize)]
pub struct GearMatchGetQuery {
    pub project_id: Uuid,
    pub raw: Option<bool>,
}

/// How one requirement moved.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearMatchChangeDto {
    pub requirement_id: String,
    pub before: Option<String>,
    pub after: Option<String>,
    pub gears_before: Vec<String>,
    pub gears_after: Vec<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearMatchDiffDto {
    pub match_id: String,
    pub base: String,
    pub changes: Vec<GearMatchChangeDto>,
    /// Requirements the two runs read alike.
    pub same: u32,
}

/// A member's decision on a proposed gear.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct GearMatchDecisionRequest {
    pub requirement_id: String,
    pub gear_id: String,
    /// `accepted`, `rejected`, or `undecided` to forget it.
    pub decision: String,
    pub match_id: Option<Uuid>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearMatchNoteDto {
    pub subject: String,
    pub gear_id: Option<String>,
    pub value: Option<String>,
    pub author: String,
    pub updated_at: String,
}

/// A member's answer to a question.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct GearMatchAnswerRequest {
    /// The question's id (a requirement's id, or `c-…`).
    pub question_id: String,
    /// The answer; empty forgets it.
    pub text: String,
    /// The question's topic, for a question of the report's own.
    pub topic: Option<String>,
    pub match_id: Option<Uuid>,
}

/// An open question, as the Inbox lists it.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearMatchInboxItemDto {
    /// `<match_id>:<question id>`.
    pub id: String,
    pub title: String,
    pub project_id: String,
    pub match_id: String,
    pub question_id: String,
    pub detail: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearMatchInboxListDto {
    pub items: Vec<GearMatchInboxItemDto>,
    pub total: u32,
}

fn problem(r: Refusal) -> CanonicalError {
    match r {
        Refusal::Unavailable(m) => CanonicalError::service_unavailable()
            .with_detail(m)
            .create(),
        Refusal::NotFound(m) => StudioProductError::not_found(m)
            .with_resource("gear-match")
            .create(),
        Refusal::Invalid { field, why } => StudioProductError::invalid_argument()
            .with_field_violation(field, why, "INVALID")
            .create(),
        Refusal::Internal(e) => CanonicalError::internal(format!("{e:#}")).create(),
    }
}

/// The organization the project hangs under, as the caller reads the tree.
async fn organization(product: &Product, ctx: &SecurityContext, project: Uuid) -> ApiResult<Uuid> {
    product
        .service
        .organization_of_project(ctx, project)
        .await
        .ok_or_else(|| {
            problem(Refusal::NotFound(format!(
                "there is no project {project} for this caller"
            )))
        })
}

fn rfc3339(ms: i64) -> String {
    crate::product::descriptions::rfc3339(ms)
}

fn totals_dto(t: report::Totals) -> GearMatchTotalsDto {
    GearMatchTotalsDto {
        requirements: t.requirements,
        covered: t.covered,
        partial: t.partial,
        gap: t.gap,
        clarification_needed: t.clarification_needed,
        not_assessed: t.not_assessed,
    }
}

fn item_dto(m: &Match) -> GearMatchItemDto {
    GearMatchItemDto {
        match_id: m.id.to_string(),
        run_id: m.run_id.map(|r| r.to_string()),
        state: m.state.clone(),
        requested_by: m.requested_by.clone(),
        created_at: rfc3339(m.created_at_ms),
        finished_at: m.finished_at_ms.map(rfc3339),
        matcher_run_id: m.matcher_run_id.clone(),
        totals: m
            .totals
            .as_deref()
            .and_then(|t| serde_json::from_str::<report::Totals>(t).ok())
            .map(totals_dto),
        progress: m
            .progress
            .as_deref()
            .and_then(|p| serde_json::from_str(p).ok()),
        error: m.error.clone(),
    }
}

/// The documents sent, and their texts by project path (from the request).
fn sent(m: &Match) -> (Vec<SentDocument>, Vec<(String, String)>) {
    let docs: Vec<SentDocument> = serde_json::from_str(&m.documents).unwrap_or_default();
    let body: Value = serde_json::from_str(&m.request).unwrap_or(Value::Null);
    let by_matcher: BTreeMap<&str, &str> = body["documents"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|d| Some((d["path"].as_str()?, d["content"].as_str()?)))
        .collect();
    let texts = docs
        .iter()
        .filter_map(|d| {
            by_matcher
                .get(d.matcher_path.as_str())
                .map(|t| (d.path.clone(), (*t).to_owned()))
        })
        .collect();
    (docs, texts)
}

fn requirements_of(m: &Match) -> Vec<report::Requirement> {
    let Some(r) = m
        .report
        .as_deref()
        .and_then(|r| serde_json::from_str::<Value>(r).ok())
    else {
        return Vec::new();
    };
    if !report::readable(&r) {
        return Vec::new();
    }
    report::requirements(&r, &sent(m).1)
}

async fn match_dto(matches: &GearMatches, m: Match, raw: bool) -> ApiResult<GearMatchDto> {
    let decisions = matches
        .notes(m.tenant_id, m.project_id, match_store::NOTE_DECISION)
        .await
        .map_err(problem)?;
    let answers = matches
        .notes(m.tenant_id, m.project_id, match_store::NOTE_ANSWER)
        .await
        .map_err(problem)?;
    let (docs, texts) = sent(&m);
    let report_value: Option<Value> = m
        .report
        .as_deref()
        .and_then(|r| serde_json::from_str(r).ok());
    let reqs = match &report_value {
        Some(r) if report::readable(r) => report::requirements(r, &texts),
        _ => Vec::new(),
    };
    let by_matcher: BTreeMap<String, String> = docs
        .iter()
        .map(|d| (d.matcher_path.clone(), d.path.clone()))
        .collect();
    let questions = report_value
        .as_ref()
        .filter(|r| report::readable(r))
        .map(|r| report::questions(r, &reqs, |p| by_matcher.get(p).cloned()))
        .unwrap_or_default();
    let requirements = reqs
        .into_iter()
        .map(|r| GearMatchRequirementDto {
            candidates: r
                .candidates
                .into_iter()
                .map(|c| GearMatchCandidateDto {
                    decision: decisions
                        .get(&(r.requirement_id.clone(), c.gear_id.clone()))
                        .map(|n| n.value.clone()),
                    gear_id: c.gear_id,
                    pick: c.pick,
                    name: c.name,
                    verdict: c.verdict,
                    confidence: c.confidence,
                    role: c.role,
                    evidence: c.evidence,
                    covers: c.covers,
                    missing: c.missing,
                    rationale: c.rationale,
                    in_code: c.in_code,
                    listed: c.listed,
                    proposed: c.proposed,
                })
                .collect(),
            passage: r.passage.map(|p| GearMatchPassageDto {
                path: p.path,
                line: p.line,
                text: p.text,
            }),
            requirement_id: r.requirement_id,
            kind: r.kind,
            coverage: r.coverage,
            confidence: r.confidence,
            low_confidence: r.low_confidence,
            extracted: r.extracted,
            reason: r.reason,
            gear_provides: r.gear_provides,
            remaining_work: r.remaining_work,
            action: r.action,
        })
        .collect();
    let questions = questions
        .into_iter()
        .map(|q| {
            let answer = answers.get(&(q.id.clone(), String::new()));
            GearMatchQuestionDto {
                answer: answer.map(|n| gear_match::answer_of(n).0),
                answered_by: answer.map(|n| n.author.clone()),
                id: q.id,
                requirement_id: q.requirement_id,
                topic: q.topic,
                reason: q.reason,
                quote: q.quote,
                path: q.path,
            }
        })
        .collect();
    let provenance = report_value.as_ref().map(|r| &r["provenance"]);
    Ok(GearMatchDto {
        summary: item_dto(&m),
        project_id: m.project_id.to_string(),
        product: m.product.clone(),
        documents: docs
            .into_iter()
            .map(|d| GearMatchDocumentDto {
                path: d.path,
                matcher_path: d.matcher_path,
                sha256: d.sha256,
                bytes: d.bytes,
                doc_type: d.doc_type,
                commit: d.commit,
                branch: d.branch,
                answered: d.answered,
            })
            .collect(),
        matcher: m.info.as_deref().and_then(|i| serde_json::from_str(i).ok()),
        catalogue_commit: provenance
            .and_then(|p| {
                p["gear_gdl_commit"]
                    .as_str()
                    .or(p["gears_md_commit"].as_str())
            })
            .map(str::to_owned),
        schema_version: report_value
            .as_ref()
            .and_then(|r| r["schema_version"].as_str())
            .map(str::to_owned),
        usage: m
            .usage
            .as_deref()
            .and_then(|u| serde_json::from_str(u).ok()),
        requirements,
        questions,
        report: if raw { report_value } else { None },
    })
}

fn idempotency_header(headers: &HeaderMap) -> Option<String> {
    headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
}

async fn start_gear_match(
    OrgCtx(ctx): OrgCtx,
    Extension(product): Extension<Product>,
    Extension(matches): Extension<Arc<GearMatches>>,
    Query(GearMatchQuery { project_id }): Query<GearMatchQuery>,
    headers: HeaderMap,
    Json(body): Json<StartGearMatchRequest>,
) -> ApiResult<(StatusCode, JsonBody<GearMatchStartedDto>)> {
    // Unconfigured is said before anything is read.
    matches.available().map_err(problem)?;
    let org = organization(&product, &ctx, project_id).await?;
    let record = product
        .service
        .get_project_product(&ctx, &project_id.to_string())
        .await
        .ok()
        .flatten();
    let product_id = record
        .as_ref()
        .and_then(|n| n.value.get("product_id").and_then(Value::as_str))
        .filter(|p| !p.is_empty())
        .map_or_else(
            || format!("project-{}", &project_id.simple().to_string()[..8]),
            str::to_owned,
        );
    let request = StartRequest {
        paths: body.paths.unwrap_or_default(),
        glob: body.glob.filter(|g| !g.trim().is_empty()),
        own_gears: body.own_gears.unwrap_or_default(),
        extract_max_calls: body.extract_max_calls,
        idempotency_key: body
            .idempotency_key
            .or_else(|| idempotency_header(&headers)),
    };
    let m = matches
        .start(&ctx, org, project_id, &product_id, request)
        .await
        .map_err(problem)?;
    Ok((
        StatusCode::ACCEPTED,
        Json(GearMatchStartedDto {
            run_id: m.run_id.map(|r| r.to_string()).unwrap_or_default(),
            match_id: m.id.to_string(),
            state: m.state,
        }),
    ))
}

async fn list_gear_matches(
    OrgCtx(ctx): OrgCtx,
    Extension(product): Extension<Product>,
    Extension(matches): Extension<Arc<GearMatches>>,
    Query(GearMatchQuery { project_id }): Query<GearMatchQuery>,
) -> ApiResult<JsonBody<GearMatchListDto>> {
    let store = matches.store().map_err(problem)?;
    let org = organization(&product, &ctx, project_id).await?;
    let rows = store
        .list(org, project_id, gear_match::HISTORY_MAX)
        .await
        .map_err(|e| problem(e.into()))?;
    let items: Vec<GearMatchItemDto> = rows.iter().map(item_dto).collect();
    Ok(Json(GearMatchListDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
    }))
}

/// `latest`, or a match's id.
async fn one(matches: &GearMatches, org: Uuid, project: Uuid, id: &str) -> ApiResult<Match> {
    if id == "latest" {
        return matches
            .latest(org, project)
            .await
            .map_err(problem)?
            .ok_or_else(|| {
                problem(Refusal::NotFound(
                    "the project has no gear match yet".into(),
                ))
            });
    }
    let id = Uuid::parse_str(id)
        .map_err(|_| problem(Refusal::NotFound(format!("there is no gear match {id}"))))?;
    matches.read(org, project, id).await.map_err(problem)
}

async fn get_gear_match(
    OrgCtx(ctx): OrgCtx,
    Extension(product): Extension<Product>,
    Extension(matches): Extension<Arc<GearMatches>>,
    Path(match_id): Path<String>,
    Query(GearMatchGetQuery { project_id, raw }): Query<GearMatchGetQuery>,
) -> ApiResult<JsonBody<GearMatchDto>> {
    let org = organization(&product, &ctx, project_id).await?;
    let m = one(&matches, org, project_id, &match_id).await?;
    Ok(Json(match_dto(&matches, m, raw.unwrap_or(false)).await?))
}

async fn get_gear_match_diff(
    OrgCtx(ctx): OrgCtx,
    Extension(product): Extension<Product>,
    Extension(matches): Extension<Arc<GearMatches>>,
    Path(match_id): Path<String>,
    Query(GearMatchDiffQuery { project_id, base }): Query<GearMatchDiffQuery>,
) -> ApiResult<JsonBody<GearMatchDiffDto>> {
    let org = organization(&product, &ctx, project_id).await?;
    let head = one(&matches, org, project_id, &match_id).await?;
    let base = match base {
        Some(b) => matches.read(org, project_id, b).await.map_err(problem)?,
        None => {
            let store = matches.store().map_err(problem)?;
            store
                .list(org, project_id, gear_match::HISTORY_MAX)
                .await
                .map_err(|e| problem(e.into()))?
                .into_iter()
                .filter(|m| m.created_at_ms < head.created_at_ms && m.report.is_some())
                .max_by_key(|m| m.created_at_ms)
                .ok_or_else(|| {
                    problem(Refusal::NotFound(
                        "there is no earlier match with a report to compare with".into(),
                    ))
                })?
        }
    };
    let (changes, same) = report::diff(&requirements_of(&base), &requirements_of(&head));
    Ok(Json(GearMatchDiffDto {
        match_id: head.id.to_string(),
        base: base.id.to_string(),
        changes: changes
            .into_iter()
            .map(|c| GearMatchChangeDto {
                requirement_id: c.requirement_id,
                before: c.before,
                after: c.after,
                gears_before: c.gears_before,
                gears_after: c.gears_after,
            })
            .collect(),
        same,
    }))
}

async fn cancel_gear_match(
    OrgCtx(ctx): OrgCtx,
    Extension(product): Extension<Product>,
    Extension(matches): Extension<Arc<GearMatches>>,
    Path(match_id): Path<Uuid>,
    Query(GearMatchQuery { project_id }): Query<GearMatchQuery>,
) -> ApiResult<JsonBody<GearMatchItemDto>> {
    let org = organization(&product, &ctx, project_id).await?;
    let m = matches
        .cancel(org, project_id, match_id)
        .await
        .map_err(problem)?;
    Ok(Json(item_dto(&m)))
}

fn note_dto(n: &match_store::Note) -> GearMatchNoteDto {
    GearMatchNoteDto {
        subject: n.subject.clone(),
        gear_id: (!n.gear_id.is_empty()).then(|| n.gear_id.clone()),
        value: Some(n.value.clone()),
        author: n.author.clone(),
        updated_at: rfc3339(n.updated_at_ms),
    }
}

fn subject_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 200 && !s.chars().any(char::is_control)
}

async fn upsert_gear_match_decision(
    OrgCtx(ctx): OrgCtx,
    Extension(product): Extension<Product>,
    Extension(matches): Extension<Arc<GearMatches>>,
    Query(GearMatchQuery { project_id }): Query<GearMatchQuery>,
    Json(body): Json<GearMatchDecisionRequest>,
) -> ApiResult<JsonBody<GearMatchNoteDto>> {
    let store = matches.store().map_err(problem)?;
    let org = organization(&product, &ctx, project_id).await?;
    let invalid = |field: &'static str, why: &str| {
        problem(Refusal::Invalid {
            field,
            why: why.to_owned(),
        })
    };
    if !subject_ok(&body.requirement_id) {
        return Err(invalid("requirement_id", "a requirement's id"));
    }
    if !subject_ok(&body.gear_id) {
        return Err(invalid("gear_id", "a gear's id, `<repository>/<gear>`"));
    }
    let author = ctx.subject_id().to_string();
    match body.decision.as_str() {
        "accepted" | "rejected" => {
            let note = match_store::Note {
                tenant_id: org,
                project_id,
                kind: match_store::NOTE_DECISION.into(),
                subject: body.requirement_id,
                gear_id: body.gear_id,
                value: body.decision,
                author,
                updated_at_ms: match_store::now_ms(),
                match_id: body.match_id,
            };
            store
                .put_note(note.clone())
                .await
                .map_err(|e| problem(e.into()))?;
            Ok(Json(note_dto(&note)))
        }
        "undecided" => {
            store
                .delete_note(
                    org,
                    project_id,
                    match_store::NOTE_DECISION,
                    &body.requirement_id,
                    &body.gear_id,
                )
                .await
                .map_err(|e| problem(e.into()))?;
            Ok(Json(GearMatchNoteDto {
                subject: body.requirement_id,
                gear_id: Some(body.gear_id),
                value: None,
                author,
                updated_at: rfc3339(match_store::now_ms()),
            }))
        }
        _ => Err(invalid("decision", "`accepted`, `rejected` or `undecided`")),
    }
}

async fn upsert_gear_match_answer(
    OrgCtx(ctx): OrgCtx,
    Extension(product): Extension<Product>,
    Extension(matches): Extension<Arc<GearMatches>>,
    Query(GearMatchQuery { project_id }): Query<GearMatchQuery>,
    Json(body): Json<GearMatchAnswerRequest>,
) -> ApiResult<JsonBody<GearMatchNoteDto>> {
    let store = matches.store().map_err(problem)?;
    let org = organization(&product, &ctx, project_id).await?;
    if !subject_ok(&body.question_id) {
        return Err(problem(Refusal::Invalid {
            field: "question_id",
            why: "a question's id, as the match lists it".into(),
        }));
    }
    if body.text.len() > 4000 {
        return Err(problem(Refusal::Invalid {
            field: "text",
            why: "an answer is at most 4000 characters".into(),
        }));
    }
    let author = ctx.subject_id().to_string();
    if body.text.trim().is_empty() {
        store
            .delete_note(
                org,
                project_id,
                match_store::NOTE_ANSWER,
                &body.question_id,
                "",
            )
            .await
            .map_err(|e| problem(e.into()))?;
        return Ok(Json(GearMatchNoteDto {
            subject: body.question_id,
            gear_id: None,
            value: None,
            author,
            updated_at: rfc3339(match_store::now_ms()),
        }));
    }
    let note = match_store::Note {
        tenant_id: org,
        project_id,
        kind: match_store::NOTE_ANSWER.into(),
        subject: body.question_id,
        gear_id: String::new(),
        value: gear_match::answer_value(body.text.trim(), body.topic.as_deref()),
        author,
        updated_at_ms: match_store::now_ms(),
        match_id: body.match_id,
    };
    store
        .put_note(note.clone())
        .await
        .map_err(|e| problem(e.into()))?;
    let mut dto = note_dto(&note);
    dto.value = Some(body.text.trim().to_owned());
    Ok(Json(dto))
}

/// The open questions of the latest finished match of each project the
/// caller asked a match for, in the organization the Inbox is read for.
async fn list_inbox_gear_match_questions(
    OrgCtx(ctx): OrgCtx,
    Extension(matches): Extension<Arc<GearMatches>>,
) -> ApiResult<JsonBody<GearMatchInboxListDto>> {
    // An Inbox source answers empty rather than failing the whole Inbox.
    let Ok(store) = matches.store() else {
        return Ok(Json(GearMatchInboxListDto {
            items: Vec::new(),
            total: 0,
        }));
    };
    let org = ctx.subject_tenant_id();
    let me = ctx.subject_id().to_string();
    let rows = store
        .finished_by(org, &me, 200)
        .await
        .map_err(|e| problem(e.into()))?;
    let mut seen = std::collections::BTreeSet::new();
    let mut items = Vec::new();
    for m in rows {
        // Only each project's latest finished match: an earlier one's
        // questions were asked again or settled.
        if !seen.insert(m.project_id) {
            continue;
        }
        let answers = matches
            .notes(org, m.project_id, match_store::NOTE_ANSWER)
            .await
            .map_err(problem)?;
        let dto = match_dto(&matches, m.clone(), false).await?;
        for q in dto.questions {
            if answers.contains_key(&(q.id.clone(), String::new())) {
                continue;
            }
            items.push(GearMatchInboxItemDto {
                id: format!("{}:{}", m.id, q.id),
                title: format!("The gear match asks about {} ({})", q.topic, m.product),
                project_id: m.project_id.to_string(),
                match_id: m.id.to_string(),
                question_id: q.id,
                detail: Some(q.reason).filter(|r| !r.is_empty()),
            });
        }
    }
    Ok(Json(GearMatchInboxListDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
    }))
}

pub fn register(router: Router, openapi: &dyn OpenApiRegistry) -> Router {
    let router = OperationBuilder::post("/studio-product/v1/gear-matches")
        .operation_id("studio_product.start_gear_match")
        .summary("Match gears to the project's specifications with the gears-matcher")
        .description(
            "Reads the project's specifications as the caller (the documents its domain \
                 model reads: `paths` and `glob` select, else its PRDs, else all, at most the \
                 matcher's 20), puts the project's answers to earlier questions beside the \
                 requirements they answer, and queues one studio-tasks run \
                 (`product.gear_match`) that submits them to the gears-matcher service, follows \
                 its run and keeps the coverage report with the project. Paid model calls: a \
                 run takes minutes. Progress is the run in Background work, `task.*` \
                 studio-events and `GET gear-matches/{match_id}`. The same `Idempotency-Key` \
                 (header or `idempotency_key`) answers the same match. 503 naming what is \
                 missing when the matcher is not configured.",
        )
        .tag("StudioProduct")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project (its tenant id)")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(start_gear_match)
        .json_request::<StartGearMatchRequest>(openapi, "What to read")
        .json_response_with_schema::<GearMatchStartedDto>(openapi, StatusCode::ACCEPTED, "Queued")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-product/v1/gear-matches")
        .operation_id("studio_product.list_gear_matches")
        .summary("The project's gear matches, newest first")
        .description(
            "At most 50, without their reports: state, who asked, when, the matcher's run \
                 and the report's counts. A match's report is `GET gear-matches/{match_id}`; \
                 two of them compared is `…/diff`, since the matcher's results vary between \
                 runs.",
        )
        .tag("StudioProduct")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project (its tenant id)")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(list_gear_matches)
        .json_response_with_schema::<GearMatchListDto>(openapi, StatusCode::OK, "Matches")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-product/v1/gear-matches/{match_id}")
        .operation_id("studio_product.get_gear_match")
        .summary("One gear match, its report read per requirement")
        .description(
            "`match_id` is a match's id or `latest`. Per requirement: the verdict, the \
                 candidate gears with the matcher's evidence, the passage it was read from, \
                 the members' decisions, and what Studio offers (`propose` a gear into the \
                 product, `create_gear` for a gap, `answer` a question, `rerun`). Also the \
                 documents sent with their hashes and commits, the matcher's versions and \
                 catalogue commit, its usage, and its questions with the project's answers. \
                 `raw=true` adds the report as the matcher wrote it.",
        )
        .tag("StudioProduct")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("match_id", "A match's id, or `latest`")
        .query_param("raw", false, "Add the matcher's report as written")
        .query_param("project_id", true, "The project (its tenant id)")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(get_gear_match)
        .json_response_with_schema::<GearMatchDto>(openapi, StatusCode::OK, "The match")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-product/v1/gear-matches/{match_id}/diff")
        .operation_id("studio_product.get_gear_match_diff")
        .summary("What changed between two gear matches")
        .description(
            "Each requirement whose coverage or proposed gears differ between `base` (the \
                 match before this one when absent) and this one, and how many read alike. The \
                 matcher is not deterministic: read a change before acting on it.",
        )
        .tag("StudioProduct")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("match_id", "A match's id, or `latest`")
        .query_param("base", false, "The earlier match")
        .query_param("project_id", true, "The project (its tenant id)")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(get_gear_match_diff)
        .json_response_with_schema::<GearMatchDiffDto>(openapi, StatusCode::OK, "The changes")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-product/v1/gear-matches/{match_id}/cancel")
        .operation_id("studio_product.cancel_gear_match")
        .summary("Stop a gear match and the matcher's run")
        .description(
            "Asks the run to stop; the run asks the matcher to stop its own (calls already \
                 sent may still be billed). A match that has ended is answered as it is.",
        )
        .tag("StudioProduct")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("match_id", "The match's id")
        .query_param("project_id", true, "The project (its tenant id)")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(cancel_gear_match)
        .json_response_with_schema::<GearMatchItemDto>(openapi, StatusCode::OK, "The match")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    let router = OperationBuilder::put("/studio-product/v1/gear-match-decisions")
        .operation_id("studio_product.upsert_gear_match_decision")
        .summary("Accept or reject a gear a match proposes")
        .description(
            "Keeps a member's decision on one proposed gear for one requirement with the \
                 project, across matches; `undecided` forgets it. Nothing is added to the \
                 product here: adding is the product's own save, after its completion.",
        )
        .tag("StudioProduct")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project (its tenant id)")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(upsert_gear_match_decision)
        .json_request::<GearMatchDecisionRequest>(openapi, "The decision")
        .json_response_with_schema::<GearMatchNoteDto>(openapi, StatusCode::OK, "Kept")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    let router = OperationBuilder::put("/studio-product/v1/gear-match-answers")
        .operation_id("studio_product.upsert_gear_match_answer")
        .summary("Answer a question a gear match asks")
        .description(
            "Keeps the answer with the project; an empty text forgets it. The next match \
                 sends it beside the requirement it answers (in the copy sent, never in the \
                 document), and the question leaves the Inbox.",
        )
        .tag("StudioProduct")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project (its tenant id)")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(upsert_gear_match_answer)
        .json_request::<GearMatchAnswerRequest>(openapi, "The answer")
        .json_response_with_schema::<GearMatchNoteDto>(openapi, StatusCode::OK, "Kept")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    OperationBuilder::get("/studio-product/v1/inbox/gear-match-questions")
        .operation_id("studio_product.list_inbox_gear_match_questions")
        .summary("Questions the caller's gear matches wait on")
        .description(
            "An Inbox `endpoint` source (the Product kit's): for each project the caller asked \
             a gear match of, the latest finished match's questions nobody has answered yet. \
             An item is answered by `PUT gear-match-answers` and leaves.",
        )
        .tag("StudioProduct")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(list_inbox_gear_match_questions)
        .json_response_with_schema::<GearMatchInboxListDto>(openapi, StatusCode::OK, "Questions")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi)
}
