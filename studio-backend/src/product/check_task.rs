//! `product.check` -- the engine's check of a project's saved description,
//! run on the queue and kept, so nobody waits on it over HTTP.
//!
//! A check of a product of sixty gears reads the project's repository (a
//! fetch, a clone the first time) and runs the engine for seconds to a
//! minute -- more than the gateway's 30 s. Asked over a request, the page sat
//! on a 504 and asked again. Here it is queued (`POST product-check-runs`),
//! run by studio-tasks, and its verdict kept on the product record:
//!
//! - `checks.<profile>`: the last verdict, as before (ADR-0057), with when it
//!   was made (`checked_at`), the revision and the commits it was made
//!   against, and its first diagnostics. The kept result a page shows.
//! - `check_runs.<profile>`: the latest queued check -- its run, its state
//!   and, when it failed, why. A failed check leaves the verdict before it.
//!
//! The pair is the shape of a derived view (a stored computed result, when it
//! was computed, and its background recompute), so it can move onto the
//! shared mechanism when there is one.

use std::sync::OnceLock;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use toolkit::client_hub::ClientScope;

use super::descriptions_rest::{SavedCheck, check_saved_revision};
use super::*;
use crate::tasks::sdk::{TaskContext, TaskHandler, TaskOutcome};

/// Stable: stored on every run.
pub const TASK_TYPE: &str = "product.check";

/// How many of a check's diagnostics (errors first, then warnings) are kept
/// with its verdict; the whole list is one `POST product-description-checks`
/// away.
const KEPT_DIAGNOSTICS: usize = 40;

/// The product handle the queued checks run through: set when the routes are
/// registered, which is after the handler is (at `init`).
static PRODUCT: OnceLock<Product> = OnceLock::new();

pub(super) fn serve(product: &Product) {
    let _ = PRODUCT.set(product.clone());
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Payload {
    pub project_id: Uuid,
    pub profile: String,
    #[serde(default)]
    pub strictness: Option<String>,
}

pub struct ProductCheckTask;

/// The worker's identity in the tenant the run belongs to: where the request
/// that queued it acted, so it reads the same record and description.
fn acting_in(base: &SecurityContext, tenant: Uuid) -> anyhow::Result<SecurityContext> {
    let mut b = SecurityContext::builder()
        .subject_id(base.subject_id())
        .subject_tenant_id(tenant)
        .token_scopes(base.token_scopes().to_vec());
    if let Some(kind) = base.subject_type() {
        b = b.subject_type(kind);
    }
    b.build()
        .map_err(|e| anyhow::anyhow!("cannot act in tenant {tenant}: {e}"))
}

fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

/// The verdict kept under `checks.<profile>`: [`check_record`]'s, with when
/// and against what it was made, and its first diagnostics.
fn kept_check(checked: &SavedCheck, run_id: Uuid, at: &str) -> (Value, Value) {
    let (mut check, mut last) = check_record(&checked.preview, &checked.profile);
    let mut diagnostics: Vec<&crate::product::gearbox::EngineDiagnostic> = checked
        .preview
        .resolution
        .diagnostics
        .iter()
        .filter(|d| d.is_error())
        .chain(
            checked
                .preview
                .resolution
                .diagnostics
                .iter()
                .filter(|d| d.severity == "warning"),
        )
        .collect();
    diagnostics.truncate(KEPT_DIAGNOSTICS);
    let extra = serde_json::json!({
        "checked_at": at,
        "revision": checked.revision.revision,
        "home_commit": checked.home_commit,
        "run_id": run_id.to_string(),
        "diagnostics": diagnostics
            .iter()
            .map(|d| serde_json::json!({
                "code": d.code,
                "severity": d.severity,
                "message": d.message,
                "file": d.file,
                "line": d.line,
            }))
            .collect::<Vec<_>>(),
    });
    for v in [&mut check, &mut last] {
        if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
            o.extend(e.clone());
        }
    }
    (check, last)
}

/// `check_runs.<profile>` as a patch of the record.
fn run_patch(profile: &str, run: Value) -> serde_json::Map<String, Value> {
    let mut runs = serde_json::Map::new();
    runs.insert(profile.to_owned(), run);
    let mut patch = serde_json::Map::new();
    patch.insert("check_runs".into(), Value::Object(runs));
    patch
}

/// Whether a refusal may pass on its own: the repository still being
/// cloned or read, a dependency briefly away.
fn transient(e: &CanonicalError) -> bool {
    matches!(
        e,
        CanonicalError::ServiceUnavailable { .. } | CanonicalError::DeadlineExceeded { .. }
    )
}

#[async_trait]
impl TaskHandler for ProductCheckTask {
    fn task_type(&self) -> &'static str {
        TASK_TYPE
    }

    /// A clone of a large repository on a first check can take minutes; the
    /// attempts after it read it from the server.
    fn max_attempts(&self) -> i16 {
        4
    }

    async fn run(&self, ctx: &TaskContext) -> TaskOutcome {
        let Some(product) = PRODUCT.get() else {
            return TaskOutcome::Retry("studio-product's routes are not registered yet".into());
        };
        let payload: Payload = match serde_json::from_value(ctx.payload.clone()) {
            Ok(p) => p,
            Err(e) => return TaskOutcome::Failed(format!("unreadable product check payload: {e}")),
        };
        let security = match acting_in(&ctx.security, ctx.tenant) {
            Ok(s) => s,
            Err(e) => return TaskOutcome::Failed(format!("{e:#}")),
        };
        let project = payload.project_id;
        ctx.progress("reading the project's repository and checking its description")
            .await;
        let started = std::time::Instant::now();
        let checked = check_saved_revision(
            product,
            &security,
            project,
            None,
            payload.profile.clone(),
            payload.strictness.as_deref(),
            true,
        )
        .await;
        let at = now_rfc3339();
        match checked {
            Ok(checked) => {
                let (check, last) = kept_check(&checked, ctx.run_id, &at);
                let errors = check.get("errors").and_then(Value::as_u64).unwrap_or(0);
                let warnings = check.get("warnings").and_then(Value::as_u64).unwrap_or(0);
                let mut patch = run_patch(
                    &checked.profile,
                    serde_json::json!({
                        "run_id": ctx.run_id.to_string(),
                        "state": "succeeded",
                        "finished_at": at,
                        "revision": checked.revision.revision,
                    }),
                );
                let mut checks = serde_json::Map::new();
                checks.insert(checked.profile.clone(), check);
                patch.insert("checks".into(), Value::Object(checks));
                patch.insert("last_preview".into(), last);
                record_product(&product.service, &security, project, patch).await;
                tracing::info!(
                    project_id = %project,
                    profile = %checked.profile,
                    revision = checked.revision.revision,
                    errors,
                    warnings,
                    elapsed_ms = started.elapsed().as_millis(),
                    "studio-product: a queued check is kept"
                );
                TaskOutcome::done_with(
                    format!(
                        "revision {} for {}: {errors} error(s), {warnings} warning(s)",
                        checked.revision.revision, checked.profile
                    ),
                    serde_json::json!({
                        "revision": checked.revision.revision,
                        "profile": checked.profile,
                        "errors": errors,
                        "warnings": warnings,
                    }),
                )
            }
            Err(e) => {
                let cause = e.to_string();
                let again = transient(&e) && ctx.attempt < self.max_attempts();
                tracing::warn!(
                    project_id = %project,
                    profile = %payload.profile,
                    attempt = ctx.attempt,
                    error = %cause,
                    "studio-product: a queued check did not finish"
                );
                record_product(
                    &product.service,
                    &security,
                    project,
                    run_patch(
                        &payload.profile,
                        serde_json::json!({
                            "run_id": ctx.run_id.to_string(),
                            "state": if again { "queued" } else { "failed" },
                            "finished_at": at,
                            "error": cause,
                        }),
                    ),
                )
                .await;
                if again {
                    TaskOutcome::Retry(cause)
                } else {
                    TaskOutcome::Failed(cause)
                }
            }
        }
    }
}

/// Ask for a check of the project's latest saved revision, for one profile.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct ProductCheckRunRequest {
    /// The deployment profile's id in the description; absent: `prod`.
    pub profile: Option<String>,
    /// `dev` checks the profile as a development one (ADR-0060 §5).
    pub strictness: Option<String>,
}

/// A queued check.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ProductCheckRunDto {
    /// The studio-tasks run (`GET /studio-tasks/v1/runs/{id}`).
    pub run_id: String,
    pub profile: String,
    /// `queued`: the verdict lands in the product's `checks.<profile>`.
    pub state: String,
}

async fn start_product_check(
    OrgCtx(ctx): OrgCtx,
    Extension(product): Extension<Product>,
    Query(descriptions_rest::ProductDescriptionQuery { project_id }): Query<
        descriptions_rest::ProductDescriptionQuery,
    >,
    Json(body): Json<ProductCheckRunRequest>,
) -> ApiResult<(StatusCode, JsonBody<ProductCheckRunDto>)> {
    product.require_descriptions()?;
    product.gearbox()?;
    let profile = body
        .profile
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .unwrap_or("prod")
        .to_owned();
    if !PROFILES.contains(&profile.as_str()) && !crate::product::gearbox::is_kebab_id(&profile) {
        return Err(StudioProductError::invalid_argument()
            .with_constraint(format!("`{profile}` is not a profile id"))
            .create());
    }
    // The caller must read the description it asks to have checked: the
    // queue acts as itself later (studio-tasks), so this is the gate.
    let latest = product
        .service
        .latest_description(&ctx, project_id)
        .await
        .map_err(|e| descriptions_rest::internal(&e))?
        .ok_or_else(|| {
            StudioProductError::not_found("the project's description has no revision yet")
                .with_resource(format!("{project_id}/description"))
                .create()
        })?;
    let queue = product
        .hub
        .get_scoped::<dyn crate::tasks::TaskQueue>(&ClientScope::gts_id(
            crate::tasks::TASK_QUEUE_INSTANCE_ID,
        ))
        .map_err(|_| {
            CanonicalError::service_unavailable()
                .with_detail("a check cannot be queued here: studio-tasks has no database")
                .create()
        })?;
    let payload = Payload {
        project_id,
        profile: profile.clone(),
        strictness: body
            .strictness
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty()),
    };
    let partition = project_id.to_string();
    let run_id = queue
        .enqueue(
            &ctx,
            crate::tasks::sdk::NewRun {
                tenant: ctx.subject_tenant_id(),
                task_type: TASK_TYPE,
                payload: serde_json::to_value(&payload).unwrap_or(Value::Null),
                // One project's checks one after another; the same check
                // asked again while it waits is the same run.
                partition_key: Some(&partition),
                idempotency_key: None,
                coalesce_queued: true,
                notify_workspace_id: None,
            },
        )
        .await
        .map_err(|e| {
            CanonicalError::service_unavailable()
                .with_detail(format!("the check could not be queued: {e:#}"))
                .create()
        })?;
    record_product(
        &product.service,
        &ctx,
        project_id,
        run_patch(
            &profile,
            serde_json::json!({
                "run_id": run_id.to_string(),
                "state": "queued",
                "queued_at": now_rfc3339(),
                "revision": latest.revision,
            }),
        ),
    )
    .await;
    Ok((
        StatusCode::ACCEPTED,
        Json(ProductCheckRunDto {
            run_id: run_id.to_string(),
            profile,
            state: "queued".into(),
        }),
    ))
}

pub(super) fn register(router: Router, openapi: &dyn OpenApiRegistry) -> Router {
    OperationBuilder::post("/studio-product/v1/product-check-runs")
        .operation_id("studio_product.create_product_check_run")
        .summary("Queue a check of the product's saved description")
        .description(
            "Queues the Gearbox engine's check of the latest saved revision of the product's \
             description for one deployment `profile` (default `prod`) on studio-tasks \
             (`product.check`) and answers at once. The run fetches the project's repository \
             and checks the revision as it is written, as `POST product-description-checks` \
             does; its verdict is kept on the product under `checks.<profile>` with \
             `checked_at`, the revision and the commits it read, and the run's state under \
             `check_runs.<profile>` (with the cause when it failed). Asked again while the same \
             check still waits, it answers the same run. Progress is the run in Background \
             work and `task.*` studio-events.",
        )
        .tag("StudioProduct")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project (its tenant id)")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(start_product_check)
        .json_request::<ProductCheckRunRequest>(openapi, "Which profile")
        .json_response_with_schema::<ProductCheckRunDto>(openapi, StatusCode::ACCEPTED, "Queued")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_payload_reads_back_and_strictness_is_optional() {
        let p: Payload = serde_json::from_value(serde_json::json!({
            "project_id": "00000000-0000-0000-0000-000000000007",
            "profile": "prod",
        }))
        .expect("an older payload without strictness reads");
        assert_eq!(p.strictness, None);
        let back: Payload =
            serde_json::from_value(serde_json::to_value(&p).unwrap()).expect("round trip");
        assert_eq!(back, p);
    }

    #[test]
    fn a_run_is_kept_beside_the_other_profiles() {
        let patch = run_patch("dev", serde_json::json!({"state": "queued"}));
        assert_eq!(patch["check_runs"]["dev"]["state"], "queued");
        assert_eq!(patch.len(), 1, "nothing but the run is written");
    }

    #[test]
    fn only_a_refusal_that_can_pass_is_retried() {
        let away = CanonicalError::service_unavailable()
            .with_detail("still cloning")
            .create();
        assert!(transient(&away));
        let wrong = StudioProductError::invalid_argument()
            .with_constraint("no gear")
            .create();
        assert!(!transient(&wrong));
    }
}
