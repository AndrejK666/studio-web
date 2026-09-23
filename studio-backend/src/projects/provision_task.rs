//! The `project.provision` task: creating a project, as a run.
//!
//! ## Why this one moved
//!
//! It was a sequence in the browser — tenant, configuration, repository,
//! starter gear, spec — and it lived exactly as long as the page did. Closing
//! the tab on step three left a ZOMBIE: a tenant with no configuration, or a
//! configuration with no source. Nothing wrong enough to notice, nothing right
//! enough to use, and the only cure was opening the same form again.
//!
//! Now it is a run. The same steps, the same probes, the same order — what
//! changes is who holds it: the server does, so it finishes whether or not
//! anybody is watching, and the person who started it can close the tab.
//!
//! ## What a retry does, and what it must not do
//!
//! A run is retried with backoff. Every step asks before acting, and the
//! tenant step in particular finds-or-creates by name — so a retry HEALS the
//! project it half made rather than making a second one beside it. That is the
//! whole reason the probes exist, and it is why this task may be retried at
//! all: without them, a retry would be a duplicate-project machine.
//!
//! The one step that cannot ask is the starter gear, which writes onto a
//! branch of its own; a second attempt costs a branch.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::json;

use crate::tasks::registry::{TaskContext, TaskHandler, TaskOutcome};

use super::plan::{self, StepState};
use super::steps;
use super::steps::{Gears, Request};

/// Task type. A wire contract: stored on every queued run.
pub const TASK_TYPE: &str = "project.provision";

pub struct ProvisionTask {
    /// Resolved per run rather than held, so this gear does not care which
    /// gear initialised first — and so a deployment that gains a connector
    /// driver later does not have to restart to use it.
    hub: Arc<toolkit::client_hub::ClientHub>,
    am: Arc<dyn account_management_sdk::AccountManagementClient>,
}

impl ProvisionTask {
    pub fn new(
        hub: Arc<toolkit::client_hub::ClientHub>,
        am: Arc<dyn account_management_sdk::AccountManagementClient>,
    ) -> Self {
        Self { hub, am }
    }

    /// Built PER RUN, because the security context is the run's.
    ///
    /// A provisioning run acts as the person who asked for it, so the thing
    /// that writes tenants cannot be constructed once at registration and
    /// shared: it would then act as whoever happened to start the process.
    fn gears(&self, security: toolkit_security::SecurityContext) -> Gears {
        Gears {
            tenants: Arc::new(super::tenants::Tenants::new(
                self.am.clone(),
                security.clone(),
            )),
            security,
            repos: self
                .hub
                .get::<dyn crate::components_catalog::port::ProjectRepos>()
                .ok(),
            documents: self
                .hub
                .get::<dyn crate::documents::port::DocumentAuthor>()
                .ok(),
            kits: self
                .hub
                .get::<dyn crate::kit_registry::port::KitInstaller>()
                .ok(),
        }
    }
}

#[async_trait]
impl TaskHandler for ProvisionTask {
    fn task_type(&self) -> &'static str {
        TASK_TYPE
    }

    async fn run(&self, ctx: &TaskContext) -> TaskOutcome {
        let request: Request = match serde_json::from_value(ctx.payload.clone()) {
            Ok(request) => request,
            // Written by a different version of this route; a retry cannot
            // make it readable, so this is a failure rather than a retry.
            Err(e) => {
                return TaskOutcome::Failed(format!(
                    "this run's payload is not a project to create ({e})"
                ));
            }
        };

        let gears = self.gears(ctx.security.clone());
        let plan = steps::plan_for(&request, &gears);
        let mut context = plan::Context::new();

        // Progress is the checklist, phase by phase. A watcher joining late
        // sees the current step rather than having to accumulate the ones
        // before it — which is why the engine reports the whole list and this
        // names only the one that moved.
        let (progress, drain) = ctx.progress_bridge();
        let outcome = plan::run(&plan, &mut context, &|states: &[StepState]| {
            if let Some(current) = states
                .iter()
                .find(|s| s.status == plan::StepStatus::Running)
                .or_else(|| {
                    states
                        .iter()
                        .rev()
                        .find(|s| s.status != plan::StepStatus::Pending)
                })
            {
                let done = states
                    .iter()
                    .filter(|s| s.status == plan::StepStatus::Done)
                    .count();
                progress.set(format!("{}/{} · {}", done, states.len(), current.label));
            }
        })
        .await;
        drop(progress);
        let _ = drain.await;

        let states: Vec<_> = outcome
            .states
            .iter()
            .map(|s| {
                json!({
                    "key": s.key,
                    "label": s.label,
                    "status": s.status.as_str(),
                    "error": s.error,
                })
            })
            .collect();
        let result = json!({
            "project_id": context.get("tenant"),
            "repository": context.get("repo"),
            "document_id": context.get("document"),
            "steps": states,
        });

        if outcome.ok {
            let created = context
                .get("tenant")
                .map(|id| format!("project {id} created"))
                .unwrap_or_else(|| "project created".to_owned());
            return TaskOutcome::done_with(created, result);
        }

        // Whatever the project got to is REPORTED rather than discarded: the
        // tenant may exist, and the next attempt needs to know so it heals
        // that one instead of making another.
        let why = outcome
            .failure()
            .map(|s| {
                format!(
                    "{}: {}",
                    s.label,
                    s.error.as_deref().unwrap_or("failed without a reason")
                )
            })
            .unwrap_or_else(|| "the plan stopped without saying where".to_owned());

        // Retried, and safe to retry, BECAUSE every step asks before acting.
        // Most of what stops this sequence is transient — a provider rate
        // limit, a connection mid-rotation, a gear still starting — and the
        // rest costs one cheap probe per attempt before it stops again.
        TaskOutcome::Retry(why)
    }
}
