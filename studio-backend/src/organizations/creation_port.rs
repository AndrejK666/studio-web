//! The project creation port (ADR-0079 §4): what kits do when a project is
//! created, without the core naming them.
//!
//! Two things a kit's gear registers in its own module:
//!
//! - a [`CreationStep`]: the work behind one step of the creation run
//!   (`repository`, `scaffold`, `prd`). Which steps a plan takes and in what
//!   order is the plan's ([`super::project_create::steps_of`]), because the
//!   step keys are the run's recorded progress; a kit says how its step is
//!   done. Its failure is the run's: [`StepError::Retry`] tries the run
//!   again, [`StepError::Fail`] stops it for a person.
//! - a [`CreationField`]: a field the project's configuration starts with,
//!   read as the caller when the creation is asked for (the stages the
//!   workspace's catalogue marks required).
//!
//! ```ignore
//! inventory::submit! {
//!     crate::organizations::port::CreationStep {
//!         gear: "studio-documents",
//!         key: "prd",
//!         step: &PrdStep,
//!     }
//! }
//! ```

use async_trait::async_trait;
use axum::http::HeaderValue;
use serde_json::Value;
use toolkit::client_hub::ClientHub;
use uuid::Uuid;

use super::project_create::{MadeRepo, Plan, StepError};

/// A step of a project's creation, done by a kit's gear.
pub struct CreationStep {
    /// The gear that does it, for logs and readers.
    pub gear: &'static str,
    /// The step it does (`repository`, `scaffold`, `prd`): one gear per key.
    pub key: &'static str,
    pub step: &'static dyn CreationStepRun,
}

inventory::collect!(CreationStep);

/// What a step ended with.
pub enum StepDone {
    /// The line the run records for it.
    Line(String),
    /// The repository the project's gears go to, for the steps after it.
    Repository(MadeRepo),
}

#[async_trait]
pub trait CreationStepRun: Send + Sync {
    /// Do the step for `plan`, as the organizations gear's service in the
    /// scope the step needs ([`super::project_create::service_ctx`]), after
    /// checking what is there already: a step runs again on a retry.
    /// `repo` is what the repository step made, when the plan has one.
    async fn run(
        &self,
        hub: &ClientHub,
        plan: &Plan,
        repo: Option<&MadeRepo>,
    ) -> Result<StepDone, StepError>;
}

/// The gear that does step `key`, if any in this assembly does.
pub fn step(key: &str) -> Option<&'static CreationStep> {
    inventory::iter::<CreationStep>
        .into_iter()
        .filter(|s| crate::composition::contributes(s.gear))
        .find(|s| s.key == key)
}

/// Step `key`, by the gear registered for it; a step no gear does is a plan
/// this deployment cannot carry out.
pub async fn run_step(
    hub: &ClientHub,
    key: &str,
    plan: &Plan,
    repo: Option<&MadeRepo>,
) -> Result<StepDone, StepError> {
    match step(key) {
        Some(s) => s.step.run(hub, plan, repo).await,
        None => Err(StepError::Fail(format!(
            "no gear in this deployment does the `{key}` step"
        ))),
    }
}

/// A field of a new project's configuration, filled by a kit's gear.
pub struct CreationField {
    pub gear: &'static str,
    /// The configuration field (`stages`): one gear per field.
    pub field: &'static str,
    pub source: &'static dyn CreationFieldSource,
}

inventory::collect!(CreationField);

#[async_trait]
pub trait CreationFieldSource: Send + Sync {
    /// The field's value for a project created in `workspace`, read as the
    /// caller (`authorization`, their bearer). Creation never fails on it:
    /// what cannot be read is the field's empty value.
    async fn value(&self, authorization: Option<HeaderValue>, workspace: Uuid) -> Value;
}

/// Every registered field, by field name.
pub fn fields() -> Vec<&'static CreationField> {
    let mut out: Vec<&'static CreationField> = inventory::iter::<CreationField>
        .into_iter()
        .filter(|f| crate::composition::contributes(f.gear))
        .collect();
    out.sort_by(|a, b| a.field.cmp(b.field));
    out
}

impl StepDone {
    /// The line the run records for it.
    pub fn line(self) -> String {
        match self {
            StepDone::Line(line) => line,
            StepDone::Repository(made) => format!("{} on {}", made.full_name, made.default_branch),
        }
    }
}
