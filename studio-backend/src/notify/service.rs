//! Accepting a notification: validate it, then hand it to the task queue.
//!
//! Everything durable belongs to `studio-tasks` now — the run *is* the record.
//! What is left here is the part that has to happen while there is still a
//! request to answer: resolving the connection with the caller's own context,
//! and refusing the three things that would otherwise become a dead letter
//! nobody is watching.

use std::sync::Arc;

use anyhow::anyhow;
use toolkit::client_hub::{ClientHub, ClientScope};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use crate::connectors::{NOTIFY_SENDER_INSTANCE_ID, NotificationSender};
use crate::tasks::service::NewRun;
use crate::tasks::{TASK_QUEUE_INSTANCE_ID, TaskQueue};

use super::handler::TASK_TYPE;

/// One request to deliver a notification.
#[derive(Debug, Clone)]
pub struct NewDelivery<'a> {
    /// Tenant that owns the connection.
    pub tenant: Uuid,
    pub connection_id: Uuid,
    /// Channel, for a provider that takes one.
    pub target: Option<&'a str>,
    pub title: Option<&'a str>,
    pub text: &'a str,
    pub link: Option<&'a str>,
    pub topic: Option<&'a str>,
    /// Repeat-safe key. A second accept with the same key in the same tenant
    /// returns the first run rather than queuing another.
    pub idempotency_key: Option<&'a str>,
}

pub struct NotifyService {
    hub: Arc<ClientHub>,
}

impl NotifyService {
    pub fn new(hub: Arc<ClientHub>) -> Arc<Self> {
        Arc::new(Self { hub })
    }

    /// Both clients are resolved per request rather than at init, which is what
    /// makes this gear independent of the order the others initialize in.
    fn sender(&self) -> anyhow::Result<Arc<dyn NotificationSender>> {
        self.hub
            .get_scoped::<dyn NotificationSender>(&ClientScope::gts_id(NOTIFY_SENDER_INSTANCE_ID))
            .map_err(|_| {
                anyhow!(
                    "notification delivery is not available in this deployment \
                     (studio-connector registered no driver plugin)"
                )
            })
    }

    fn queue(&self) -> anyhow::Result<Arc<dyn TaskQueue>> {
        self.hub
            .get_scoped::<dyn TaskQueue>(&ClientScope::gts_id(TASK_QUEUE_INSTANCE_ID))
            .map_err(|_| {
                anyhow!(
                    "the task queue is not available in this deployment \
                     (studio-tasks has no database configured), so nothing can be queued"
                )
            })
    }

    /// Verify and queue one notification. Returns the run id.
    pub async fn accept(
        &self,
        ctx: &SecurityContext,
        req: NewDelivery<'_>,
    ) -> anyhow::Result<Uuid> {
        let text = req.text.trim();
        let title = req.title.map(str::trim).filter(|t| !t.is_empty());
        if text.is_empty() && title.is_none() {
            return Err(anyhow!("a notification needs a text or a title"));
        }

        // With the caller's own context, before anything is queued. A
        // connection that cannot deliver is a 400 now rather than a dead letter
        // later, when nobody is watching.
        let preflight = self
            .sender()?
            .preflight(ctx, req.tenant, req.connection_id)
            .await?;

        // A personal credential is readable only by its owner, and a queued
        // delivery is performed by a service identity — which is not its owner.
        // Refusing here is the difference between an error the caller can act
        // on and a dead letter that says "not readable".
        if preflight.scope == "personal" {
            return Err(anyhow!(
                "connection '{}' is personal to the person who created it, so a background \
                 worker cannot read its credential. Queue through a workspace- or \
                 organization-scoped connection, or post it synchronously with \
                 POST /studio-connector/v1/connections/{}/messages",
                preflight.label,
                req.connection_id
            ));
        }

        let target = req.target.map(str::trim).filter(|t| !t.is_empty());
        match (preflight.fixed_target, target) {
            (true, Some(_)) => {
                return Err(anyhow!(
                    "connection '{}' is an incoming webhook: its channel is fixed in the URL it \
                     was created from, so a target cannot be chosen per message. Send no target, \
                     or use a bot-token connection",
                    preflight.label
                ));
            }
            (false, None) => {
                return Err(anyhow!(
                    "connection '{}' reaches every channel it was invited to, so the delivery \
                     must name one — see GET /studio-connector/v1/connections/{}/targets",
                    preflight.label,
                    req.connection_id
                ));
            }
            _ => {}
        }

        // The message travels in the payload because the run is the only
        // record: a copy in a table of our own would be a second write in a
        // second database, and the crash between those two writes is the lost
        // notification this queue exists to prevent.
        let payload = serde_json::json!({
            "connection_id": req.connection_id,
            "target": target,
            "title": title,
            "text": text,
            "link": req.link.map(str::trim).filter(|l| !l.is_empty()),
            "topic": req.topic.map(str::trim).filter(|t| !t.is_empty()),
        });

        self.queue()?
            .enqueue(
                ctx,
                NewRun {
                    tenant: req.tenant,
                    task_type: TASK_TYPE,
                    payload,
                    // One connection's notifications never overtake each other:
                    // a "build finished" arriving before its "build started"
                    // reads as a bug in Studio.
                    partition_key: Some(&req.connection_id.to_string()),
                    idempotency_key: req.idempotency_key,
                },
            )
            .await
    }
}
