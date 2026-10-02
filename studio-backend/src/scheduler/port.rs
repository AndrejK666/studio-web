//! What another gear may do with schedules, in-process: find the one it
//! keeps, and make sure it exists, at the expression and enabled state it
//! wants. The reports gear keeps a report current this way (ADR-0033).
//!
//! Narrow on purpose. Schedules are platform-level (see the module note on
//! [`super`]): a gear that keeps one for an organization names the
//! organization in the payload, and it is that gear, not its caller, that
//! writes it -- so a client never hands a tenant to the API.

use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;
use serde_json::Value;
use time::format_description::well_known::Rfc3339;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::service::{NewSchedule, ScheduleUpdate, SchedulerService};

/// A schedule, as the gear that keeps it sees it.
#[derive(Clone, Debug, PartialEq)]
pub struct ScheduleView {
    pub id: Uuid,
    pub expression: String,
    pub enabled: bool,
    /// RFC 3339.
    pub next_run_at: String,
    pub last_run_id: Option<Uuid>,
}

/// The schedule a gear wants: a cron expression in UTC, at most one run at a
/// time, missed firings skipped.
#[derive(Clone, Debug)]
pub struct ScheduleSpec {
    pub name: String,
    pub task_type: &'static str,
    pub payload: Value,
    pub cron: String,
    pub enabled: bool,
}

#[async_trait]
pub trait Schedules: Send + Sync {
    /// The schedule of this task type whose payload holds every field of
    /// `matching` with the same value.
    async fn find(&self, task_type: &str, matching: &Value) -> Result<Option<ScheduleView>>;

    /// Create it, or bring the one `find` answers to this expression and
    /// enabled state.
    async fn ensure(&self, ctx: &SecurityContext, spec: ScheduleSpec) -> Result<ScheduleView>;
}

/// Whether `payload` holds every field of `matching`.
pub fn payload_matches(payload: &Value, matching: &Value) -> bool {
    match (payload, matching) {
        (Value::Object(p), Value::Object(m)) => m.iter().all(|(k, v)| p.get(k) == Some(v)),
        _ => payload == matching,
    }
}

fn view(m: &super::entity::Model) -> ScheduleView {
    ScheduleView {
        id: m.id,
        expression: m.expression.clone(),
        enabled: m.enabled,
        next_run_at: m.next_run_at.format(&Rfc3339).unwrap_or_default(),
        last_run_id: m.last_run_id,
    }
}

#[async_trait]
impl Schedules for SchedulerService {
    async fn find(&self, task_type: &str, matching: &Value) -> Result<Option<ScheduleView>> {
        Ok(self
            .list()
            .await?
            .iter()
            .find(|s| s.task_type == task_type && payload_matches(&s.payload, matching))
            .map(view))
    }

    async fn ensure(&self, ctx: &SecurityContext, spec: ScheduleSpec) -> Result<ScheduleView> {
        let existing =
            self.list().await?.into_iter().find(|s| {
                s.task_type == spec.task_type && payload_matches(&s.payload, &spec.payload)
            });
        let model = match existing {
            Some(s) if s.expression == spec.cron && s.enabled == spec.enabled => s,
            Some(s) => {
                self.patch(
                    ctx,
                    s.id,
                    ScheduleUpdate {
                        expression_kind: Some("cron"),
                        expression: Some(&spec.cron),
                        enabled: Some(spec.enabled),
                        ..ScheduleUpdate::default()
                    },
                )
                .await?
            }
            None => {
                self.create(
                    ctx,
                    NewSchedule {
                        name: &spec.name,
                        task_type: spec.task_type,
                        payload: spec.payload.clone(),
                        expression_kind: "cron",
                        expression: &spec.cron,
                        timezone: Some("UTC"),
                        // A refresh still running when the next is due is let finish.
                        concurrency: Some("forbid"),
                        missed_policy: Some("skip"),
                        max_catch_up_runs: None,
                        enabled: spec.enabled,
                    },
                )
                .await?
            }
        };
        Ok(view(&model))
    }
}

/// Publish the port. Called once the service exists.
pub fn publish(hub: &toolkit::client_hub::ClientHub, service: &Arc<SchedulerService>) {
    hub.register::<dyn Schedules>(Arc::clone(service) as Arc<dyn Schedules>);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_payload_matches_when_it_holds_every_field_asked_for() {
        let p = json!({ "report": "roadmap", "organization_id": "o1", "extra": 1 });
        assert!(payload_matches(
            &p,
            &json!({ "report": "roadmap", "organization_id": "o1" })
        ));
        assert!(payload_matches(&p, &json!({})));
        assert!(!payload_matches(
            &p,
            &json!({ "report": "roadmap", "organization_id": "o2" })
        ));
        assert!(!payload_matches(
            &json!({ "report": "roadmap" }),
            &json!({ "report": "roadmap", "organization_id": "o1" })
        ));
        assert!(!payload_matches(
            &json!("x"),
            &json!({ "report": "roadmap" })
        ));
    }
}
