//! The `reports.refresh` task: read a report's plan again and queue a sync of
//! its board.
//!
//! What a person's "Refresh" queues, and what a schedule targets to keep a
//! report current on its own: a `studio-scheduler` schedule with this task
//! type and `{ "report": "roadmap" }` as its payload.

use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use super::service::{ReportsService, kind};
use crate::tasks::registry::{TaskContext, TaskHandler, TaskOutcome};

/// Task type. A wire contract: stored on every queued run and every schedule.
pub const TASK_TYPE: &str = "reports.refresh";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RefreshPayload {
    pub report: String,
}

pub struct RefreshTask {
    service: Arc<ReportsService>,
}

impl RefreshTask {
    pub fn new(service: Arc<ReportsService>) -> Self {
        Self { service }
    }
}

/// The run's payload, or why it cannot be one.
pub fn payload_of(v: &serde_json::Value) -> Result<RefreshPayload, String> {
    let p: RefreshPayload = serde_json::from_value(v.clone())
        .map_err(|e| format!("studio-reports: this run's payload is not a refresh ({e})"))?;
    if kind(&p.report).is_none() {
        return Err(format!("studio-reports: there is no report `{}`", p.report));
    }
    Ok(p)
}

#[async_trait]
impl TaskHandler for RefreshTask {
    fn task_type(&self) -> &'static str {
        TASK_TYPE
    }

    async fn run(&self, ctx: &TaskContext) -> TaskOutcome {
        let p = match payload_of(&ctx.payload) {
            Ok(p) => p,
            // Written by another version, or naming a report gone since: a
            // retry cannot fix either.
            Err(e) => return TaskOutcome::Failed(e),
        };
        match self.service.refresh(&ctx.security, &p.report).await {
            Ok(r) => {
                let summary = match r.sync_run {
                    Some(run) => format!("plan read; board sync {run} queued"),
                    None => "plan read".to_string(),
                };
                match serde_json::to_value(&r) {
                    Ok(result) => TaskOutcome::done_with(summary, result),
                    Err(_) => TaskOutcome::done(summary),
                }
            }
            // The usual causes -- a file the token cannot see, a plan that
            // names no board -- are a person's to fix, and are recorded on the
            // source for them to read; one retry covers a network blip.
            Err(e) => TaskOutcome::Retry(format!("{e:#}")),
        }
    }

    fn max_attempts(&self) -> i16 {
        2
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_payload_names_a_report_this_deployment_has() {
        assert_eq!(
            payload_of(&json!({ "report": "roadmap" })),
            Ok(RefreshPayload {
                report: "roadmap".into()
            })
        );
        assert!(
            payload_of(&json!({ "report": "weekly" }))
                .unwrap_err()
                .contains("no report")
        );
        assert!(
            payload_of(&json!({}))
                .unwrap_err()
                .contains("not a refresh")
        );
        assert!(payload_of(&json!("roadmap")).is_err());
    }

    #[test]
    fn a_payload_round_trips_through_the_queue() {
        let p = RefreshPayload {
            report: "roadmap".into(),
        };
        let back = payload_of(&serde_json::to_value(&p).unwrap()).unwrap();
        assert_eq!(back, p);
    }
}
