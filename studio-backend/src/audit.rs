//! The audit port: who did what, in which organization, and when, as the
//! gears that act say it (`docs/glasshouse-plan.md`, "Core adaptations", A5).
//!
//! An [`AuditEvent`] is one action a person took through Studio: an
//! organization's kit installed, a feature started, a staging deployed. It
//! names the person, the tenant it happened in, the action and what it acted
//! on. It **never carries code or a secret**: what the action touched is named
//! by its id or its path, never copied in.
//!
//! A gear that acts holds an [`Audit`] handle. Where events go is an
//! [`AuditRecorder`] the audit kit registers in the `ClientHub`, resolved when
//! an event is recorded, not when the handle is made: Studio gears share one
//! crate, so the toolkit's `deps` cannot order a writer after the recorder. An
//! assembly without one records nothing, and a writer goes on: the core never
//! names the kit. This is the cost-metering port's shape ([`crate::metering`]).

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use time::OffsetDateTime;
use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;
use uuid::Uuid;

/// One action a person took.
#[derive(Clone, Debug, PartialEq)]
pub struct AuditEvent {
    /// When it happened.
    pub at: OffsetDateTime,
    /// Who acted: the caller's subject.
    pub actor: Uuid,
    /// The tenant it happened in: an organization, a workspace or a project.
    pub tenant: Uuid,
    /// The gear that recorded it (`studio-kits`).
    pub gear: &'static str,
    /// What was done, as `<object>.<verb>` in the past tense
    /// (`kit.installed`).
    pub action: String,
    /// What it was done to, by id or name (`org-costs`), when it names one.
    pub subject: Option<String>,
    /// More about it, as data: never code, never a secret.
    pub detail: Value,
}

impl AuditEvent {
    /// `actor` did `action` in `tenant`, now.
    pub fn new(
        ctx: &SecurityContext,
        tenant: Uuid,
        gear: &'static str,
        action: impl Into<String>,
    ) -> Self {
        Self {
            at: OffsetDateTime::now_utc(),
            actor: ctx.subject_id(),
            tenant,
            gear,
            action: action.into(),
            subject: None,
            detail: Value::Null,
        }
    }

    /// What the action was done to.
    #[must_use]
    pub fn on(mut self, subject: impl Into<String>) -> Self {
        self.subject = Some(subject.into());
        self
    }

    /// More about the action.
    #[must_use]
    pub fn with(mut self, detail: Value) -> Self {
        self.detail = detail;
        self
    }
}

/// Where events go: the audit kit's recorder, or a test's.
#[async_trait]
pub trait AuditRecorder: Send + Sync {
    /// Keep `events`, recorded by `ctx`.
    async fn record(&self, ctx: &SecurityContext, events: Vec<AuditEvent>) -> anyhow::Result<()>;
}

/// What a gear holds to record what people do through it.
#[derive(Clone)]
pub struct Audit(Recorder);

#[derive(Clone)]
enum Recorder {
    /// The [`AuditRecorder`] registered in the hub, looked up per event.
    Hub(Arc<ClientHub>),
    /// A given recorder: what a test reads back.
    #[cfg(test)]
    Fixed(Arc<dyn AuditRecorder>),
}

impl Audit {
    /// The recorder registered in the hub, looked up per event.
    pub fn new(hub: Arc<ClientHub>) -> Self {
        Self(Recorder::Hub(hub))
    }

    /// A given recorder: what a test reads back.
    #[cfg(test)]
    pub fn fixed(recorder: Arc<dyn AuditRecorder>) -> Self {
        Self(Recorder::Fixed(recorder))
    }

    /// Keep `events`. Without a recorder in this assembly, nothing is kept
    /// and the call succeeds.
    pub async fn record(
        &self,
        ctx: &SecurityContext,
        events: Vec<AuditEvent>,
    ) -> anyhow::Result<()> {
        if events.is_empty() {
            return Ok(());
        }
        match &self.0 {
            Recorder::Hub(hub) => {
                let Ok(recorder) = hub.get::<dyn AuditRecorder>() else {
                    tracing::debug!("no audit recorder in this assembly: the audit is not kept");
                    return Ok(());
                };
                recorder.record(ctx, events).await
            }
            #[cfg(test)]
            Recorder::Fixed(recorder) => recorder.record(ctx, events).await,
        }
    }

    /// Keep `event`; a recorder that fails is logged, and the action it
    /// records stands. For actions the audit does not gate.
    pub async fn note(&self, ctx: &SecurityContext, event: AuditEvent) {
        let action = event.action.clone();
        if let Err(error) = self.record(ctx, vec![event]).await {
            tracing::warn!(action, "audit: the event was not kept: {error:#}");
        }
    }
}

#[cfg(test)]
#[path = "audit_tests.rs"]
mod tests;
