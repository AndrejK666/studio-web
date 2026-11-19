//! `product.gear_match` -- one gear match, followed to its report.
//!
//! The request was checked and prepared as the person who asked
//! ([`super::GearMatches::start`]); the run acts as studio-tasks in the
//! organization's tenant and only talks to the matcher and to its own table.
//! Each step is recorded on the match before the next, so an attempt that
//! dies -- a restart, a lease that ran out -- continues where it stopped: the
//! submit carries the match's own idempotency key, so a second submit answers
//! the same matcher run and nothing is paid twice.
//!
//! A run takes minutes (the todo-app PRD about two, a real PRD more). One
//! attempt follows it for at most [`ATTEMPT_DEADLINE`], inside the queue's
//! fifteen-minute lease, then hands it to the next attempt.

use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use super::GearMatches;
use super::client::MatcherError;
use super::report;
use super::store::{self, Change};
use crate::tasks::sdk::{TaskContext, TaskHandler, TaskOutcome};

/// Stable: stored on every run.
pub const TASK_TYPE: &str = "product.gear_match";

const ATTEMPT_DEADLINE: Duration = Duration::from_secs(12 * 60);
const POLL_FIRST: Duration = Duration::from_secs(2);
const POLL_MAX: Duration = Duration::from_secs(10);
/// Unanswered polls in a row before the attempt hands over.
const UNANSWERED_MAX: u32 = 6;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Payload {
    pub match_id: Uuid,
    pub project_id: Uuid,
}

pub struct GearMatchTask {
    matches: Arc<GearMatches>,
}

impl GearMatchTask {
    pub fn new(matches: Arc<GearMatches>) -> Self {
        Self { matches }
    }
}

/// The matcher's run states that are final.
fn matcher_final(state: &str) -> bool {
    matches!(state, "succeeded" | "partial" | "failed" | "cancelled")
}

#[async_trait]
impl TaskHandler for GearMatchTask {
    fn task_type(&self) -> &'static str {
        TASK_TYPE
    }

    /// Five attempts of twelve minutes cover the matcher's own hour.
    fn max_attempts(&self) -> i16 {
        6
    }

    async fn run(&self, ctx: &TaskContext) -> TaskOutcome {
        let payload: Payload = match serde_json::from_value(ctx.payload.clone()) {
            Ok(p) => p,
            Err(e) => return TaskOutcome::Failed(format!("unreadable gear match payload: {e}")),
        };
        let store = match self.matches.store() {
            Ok(s) => Arc::clone(s),
            Err(e) => return TaskOutcome::Failed(e.to_string()),
        };
        let (tenant, project, id) = (ctx.tenant, payload.project_id, payload.match_id);
        let row = match store.get(tenant, project, id).await {
            Ok(Some(row)) => row,
            Ok(None) => return TaskOutcome::Failed(format!("there is no gear match {id}")),
            Err(e) => return TaskOutcome::Retry(format!("the match could not be read: {e:#}")),
        };
        if store::is_final(&row.state) {
            return TaskOutcome::done(format!("the match had already ended: {}", row.state));
        }
        let fail = |why: String| {
            let store = Arc::clone(&store);
            async move {
                let _ = store
                    .update(
                        tenant,
                        project,
                        id,
                        Change {
                            state: Some(store::FAILED),
                            error: Some(why.clone()),
                            finished: true,
                            ..Change::default()
                        },
                    )
                    .await;
                TaskOutcome::Failed(why)
            }
        };
        let matcher = Arc::clone(&self.matches.matcher);
        if let Some(why) = matcher.missing() {
            return fail(why).await;
        }

        // 1. Submit, once: the key makes a resend the same run.
        let run_id = match row.matcher_run_id.clone() {
            Some(r) => r,
            None => {
                ctx.progress("submitting the specifications to the gears-matcher")
                    .await;
                let body: Value = match serde_json::from_str(&row.request) {
                    Ok(b) => b,
                    Err(e) => {
                        return fail(format!("the prepared request is unreadable: {e}")).await;
                    }
                };
                match matcher.submit(&row.idempotency_key, &body).await {
                    Ok(run) => {
                        let Some(rid) = run["id"].as_str().map(str::to_owned) else {
                            return fail("the matcher accepted the run without an id".into()).await;
                        };
                        if let Err(e) = store
                            .update(
                                tenant,
                                project,
                                id,
                                Change {
                                    state: Some(store::RUNNING),
                                    matcher_run_id: Some(rid.clone()),
                                    ..Change::default()
                                },
                            )
                            .await
                        {
                            return TaskOutcome::Retry(format!(
                                "the matcher's run {rid} could not be recorded: {e:#}"
                            ));
                        }
                        rid
                    }
                    Err(e) if e.is_transient() => return TaskOutcome::Retry(e.to_string()),
                    Err(e) => return fail(e.to_string()).await,
                }
            }
        };

        // 2. Follow it.
        let started = Instant::now();
        let mut pause = POLL_FIRST;
        let mut unanswered = 0u32;
        let mut last_progress = String::new();
        loop {
            if ctx.cancelled() {
                return self.stopped(&store, tenant, project, id, &run_id).await;
            }
            match matcher.run(&run_id).await {
                Ok(run) => {
                    unanswered = 0;
                    let state = run["state"].as_str().unwrap_or_default().to_owned();
                    let done = run["progress"]["requirements_done"].as_u64();
                    let total = run["progress"]["requirements_total"].as_u64();
                    let line = match (done, total) {
                        (Some(d), Some(t)) if t > 0 => {
                            format!("matching: {d} of {t} requirements assessed")
                        }
                        _ => format!(
                            "matching: {}",
                            if state.is_empty() { "waiting" } else { &state }
                        ),
                    };
                    if line != last_progress {
                        ctx.progress(line.clone()).await;
                        last_progress = line;
                        let _ = store
                            .update(
                                tenant,
                                project,
                                id,
                                Change {
                                    progress: Some(
                                        json!({"requirements_done": done, "requirements_total": total, "usage": run["usage"]})
                                            .to_string(),
                                    ),
                                    ..Change::default()
                                },
                            )
                            .await;
                    }
                    if matcher_final(&state) {
                        return self
                            .finish(&store, tenant, project, id, &run_id, &state, &run)
                            .await;
                    }
                }
                Err(MatcherError::Upstream { status: 404, .. }) => {
                    return fail(format!(
                        "the matcher no longer knows run {run_id}: ask for a new match"
                    ))
                    .await;
                }
                Err(e) if e.is_transient() => {
                    unanswered += 1;
                    if unanswered >= UNANSWERED_MAX {
                        return TaskOutcome::Retry(e.to_string());
                    }
                }
                Err(e) => return fail(e.to_string()).await,
            }
            if started.elapsed() > ATTEMPT_DEADLINE {
                return TaskOutcome::Retry(format!(
                    "the matcher's run {run_id} is still working after {} minutes; the next \
                     attempt follows it on",
                    ATTEMPT_DEADLINE.as_secs() / 60
                ));
            }
            tokio::select! {
                () = tokio::time::sleep(pause) => {}
                () = ctx.cancel.cancelled() => {}
            }
            pause = (pause * 2).min(POLL_MAX);
        }
    }
}

impl GearMatchTask {
    /// The run's token was cancelled: by this gear's cancel (the match says
    /// so), which stops the matcher's run too; else by a shutdown or a cancel
    /// in Background work, which leaves the matcher's run to the next attempt
    /// or to the next read of the match.
    async fn stopped(
        &self,
        store: &store::MatchStore,
        tenant: Uuid,
        project: Uuid,
        id: Uuid,
        run_id: &str,
    ) -> TaskOutcome {
        let asked = store
            .get(tenant, project, id)
            .await
            .ok()
            .flatten()
            .is_some_and(|r| r.cancel_requested);
        if !asked {
            return TaskOutcome::Retry("stopped before the matcher finished".into());
        }
        if let Err(e) = self.matches.matcher.cancel(run_id).await {
            tracing::warn!(error = %e, "studio-product: the matcher's run could not be cancelled");
        }
        let _ = store
            .update(
                tenant,
                project,
                id,
                Change {
                    state: Some(store::CANCELLED),
                    finished: true,
                    ..Change::default()
                },
            )
            .await;
        TaskOutcome::Failed("cancelled: the matcher was asked to stop".into())
    }

    #[allow(clippy::too_many_arguments)]
    async fn finish(
        &self,
        store: &store::MatchStore,
        tenant: Uuid,
        project: Uuid,
        id: Uuid,
        run_id: &str,
        state: &str,
        run: &Value,
    ) -> TaskOutcome {
        let usage = Some(run["usage"].to_string());
        match state {
            "succeeded" | "partial" => {
                let report = match self.matches.matcher.report(run_id).await {
                    Ok(r) => r,
                    Err(e) if e.is_transient() => return TaskOutcome::Retry(e.to_string()),
                    Err(e) => {
                        let why = format!("the report could not be read: {e}");
                        let _ = store
                            .update(
                                tenant,
                                project,
                                id,
                                Change {
                                    state: Some(store::FAILED),
                                    error: Some(why.clone()),
                                    usage,
                                    finished: true,
                                    ..Change::default()
                                },
                            )
                            .await;
                        return TaskOutcome::Failed(why);
                    }
                };
                let totals = report::totals(&report);
                let readable = report::readable(&report);
                let saved = store
                    .update(
                        tenant,
                        project,
                        id,
                        Change {
                            state: Some(if state == "partial" {
                                store::PARTIAL
                            } else {
                                store::SUCCEEDED
                            }),
                            report: Some(report.to_string()),
                            totals: Some(json!(totals).to_string()),
                            usage,
                            error: (!readable).then(|| {
                                format!(
                                    "the report's schema_version {} is not one Studio reads (major {})",
                                    report["schema_version"], report::SCHEMA_MAJOR
                                )
                            }),
                            finished: true,
                            ..Change::default()
                        },
                    )
                    .await;
                if let Err(e) = saved {
                    return TaskOutcome::Retry(format!("the report could not be kept: {e:#}"));
                }
                TaskOutcome::done_with(
                    totals.line(),
                    json!({ "match_id": id, "project_id": project, "matcher_run_id": run_id, "totals": totals }),
                )
            }
            "cancelled" => {
                let _ = store
                    .update(
                        tenant,
                        project,
                        id,
                        Change {
                            state: Some(store::CANCELLED),
                            usage,
                            finished: true,
                            ..Change::default()
                        },
                    )
                    .await;
                TaskOutcome::Failed(format!("the matcher's run {run_id} was cancelled"))
            }
            _ => {
                let why = format!(
                    "the matcher's run failed ({}): {}",
                    run["error"]["kind"].as_str().unwrap_or("unknown"),
                    run["error"]["message"].as_str().unwrap_or("no message")
                );
                let _ = store
                    .update(
                        tenant,
                        project,
                        id,
                        Change {
                            state: Some(store::FAILED),
                            error: Some(why.clone()),
                            usage,
                            finished: true,
                            ..Change::default()
                        },
                    )
                    .await;
                TaskOutcome::Failed(why)
            }
        }
    }
}

#[cfg(test)]
#[path = "task_tests.rs"]
mod tests;
