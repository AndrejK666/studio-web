//! The `notify.deliver` task: post one queued notification.
//!
//! ## The run is the record
//!
//! There is no delivery table. The message is the run's payload, the outcome is
//! the run's `summary` or `last_error`, and "what happened to the notification
//! I sent an hour ago" is `GET /studio-tasks/v1/runs/{id}`. That is not a
//! simplification for its own sake — it is what keeps the accept path a single
//! transaction. A separate deliveries table in this gear's own database would
//! mean writing the record in one database and the queue entry in another, and
//! a crash between those two writes is exactly the lost notification the queue
//! exists to prevent.
//!
//! ## Who delivers
//!
//! A queued delivery runs minutes after the request that asked for it, in a
//! process that has no request. It acts as `studio-tasks`' service identity
//! scoped to the run's tenant ([`TaskContext::security`]) — nothing persists a
//! caller's bearer token. Whatever authorization mattered happened at accept
//! time, against the caller's own context: the connection was resolved, its
//! credential read, and an unusable one refused with a 400 while there was
//! still a request to answer.
//!
//! ## Transient or permanent
//!
//! The driver contract answers with `anyhow::Error`, so the verdict is read out
//! of the message text. That is not a pleasing way to decide a retry, and the
//! honest fix is a typed error across all eleven drivers. Until then
//! [`classify`] matches the shapes the drivers actually produce, and its
//! **default is to retry**: an error nobody has classified is tried
//! [`MAX_ATTEMPTS`] times and then dead-lettered. Never dropped, never retried
//! forever.

use std::sync::Arc;

use async_trait::async_trait;
use serde::Deserialize;
use toolkit::client_hub::{ClientHub, ClientScope};
use tracing::warn;
use uuid::Uuid;

use crate::connectors::driver::NotifyMessage;
use crate::connectors::{NOTIFY_SENDER_INSTANCE_ID, NotificationSender};
use crate::tasks::registry::{TaskContext, TaskHandler, TaskOutcome};

/// Task type. A wire contract: it is stored on every queued run, so renaming
/// it orphans the notifications already in flight.
pub const TASK_TYPE: &str = "notify.deliver";

/// Attempts before a notification is dead-lettered.
///
/// More than the task default because a chat platform's refusals skew
/// transient — a 429 clears on its own, and giving up after five backoffs
/// would drop a message the platform was only asking us to slow down about.
pub const MAX_ATTEMPTS: i16 = 8;

// Not decoration, and checked at compile time: chat-platform failures skew
// transient, so inheriting the task default would drop messages on a rate
// limit. If the default ever rises past this, the override has stopped meaning
// anything and should be revisited rather than left as a smaller number.
const _: () = assert!(MAX_ATTEMPTS > crate::tasks::DEFAULT_MAX_ATTEMPTS);

/// What the accept path puts on the queue. The message itself, because the run
/// is the only record there is.
#[derive(Debug, Clone, Deserialize)]
pub struct DeliveryPayload {
    pub connection_id: Uuid,
    /// Channel, for a provider that takes one. Absent for an incoming webhook,
    /// whose channel is fixed in the URL.
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub link: Option<String>,
    /// Zulip topic; ignored by the other platforms.
    #[serde(default)]
    pub topic: Option<String>,
}

/// Whether an error is worth another attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// The platform, the network or the deployment might behave differently in
    /// a minute.
    Transient,
    /// Nothing will change without a human: a revoked credential, a channel the
    /// bot was never invited to, a connection that has been deleted.
    Permanent,
}

/// Read a verdict out of a driver's error message.
///
/// Ordered permanent-first: `invalid_auth` is decisive even when it arrives
/// inside a response whose status might otherwise read as transient.
pub fn classify(error: &str) -> Verdict {
    let e = error.to_lowercase();

    // Credentials, permissions and addressing. A human has to fix these.
    const PERMANENT: [&str; 18] = [
        "invalid_auth",
        "not_authed",
        "account_inactive",
        "token_revoked",
        "missing_scope",
        "no_permission",
        "channel_not_found",
        "not_in_channel",
        "is_archived",
        "missing access",
        "unknown channel",
        "unknown webhook",
        "no_service",
        "invalid_payload",
        "does not exist",
        // The URL guard and the credential-shape checks in this crate.
        "must be an https:// url",
        // The connection is gone from the catalogue, or its provider is not in
        // this deployment. Neither reappears by waiting, and a queued delivery
        // outliving its connection is the ordinary way this happens.
        "not found",
        "no driver for provider",
    ];
    if PERMANENT.iter().any(|p| e.contains(p)) {
        return Verdict::Permanent;
    }

    // A credential this worker cannot read will never become readable by
    // waiting. The accept path refuses personal-scoped connections for exactly
    // this reason; anything that still lands here is a misconfiguration.
    if e.contains("not readable") {
        return Verdict::Permanent;
    }

    // Rate limits and the platform being unwell.
    const TRANSIENT: [&str; 8] = [
        "ratelimited",
        "rate limit",
        "429",
        " 500",
        " 502",
        " 503",
        " 504",
        "timed out",
    ];
    if TRANSIENT.iter().any(|t| e.contains(t)) {
        return Verdict::Transient;
    }

    // Unknown. Retry, bounded by MAX_ATTEMPTS — see the module note.
    Verdict::Transient
}

/// Delivers queued notifications.
pub struct DeliveryTask {
    hub: Arc<ClientHub>,
}

impl DeliveryTask {
    pub fn new(hub: Arc<ClientHub>) -> Self {
        Self { hub }
    }
}

#[async_trait]
impl TaskHandler for DeliveryTask {
    fn task_type(&self) -> &'static str {
        TASK_TYPE
    }

    fn max_attempts(&self) -> i16 {
        MAX_ATTEMPTS
    }

    async fn run(&self, ctx: &TaskContext) -> TaskOutcome {
        let payload: DeliveryPayload = match serde_json::from_value(ctx.payload.clone()) {
            Ok(payload) => payload,
            // A payload this code cannot read will not become readable on a
            // retry — it was written by a different version of this gear.
            Err(e) => {
                return TaskOutcome::Failed(format!(
                    "studio-notify: this run's payload is not a delivery ({e})"
                ));
            }
        };

        let sender = match self
            .hub
            .get_scoped::<dyn NotificationSender>(&ClientScope::gts_id(NOTIFY_SENDER_INSTANCE_ID))
        {
            Ok(sender) => sender,
            // studio-connector stood down (no driver plugin linked). A
            // deployment state, not a property of the message.
            Err(e) => {
                warn!("studio-notify: no notification sender registered — waiting: {e}");
                return TaskOutcome::Retry(format!("no notification sender available: {e}"));
            }
        };

        let message = NotifyMessage {
            text: payload.text,
            title: payload.title,
            link: payload.link,
            topic: payload.topic,
        };

        match sender
            .deliver(
                &ctx.security,
                ctx.tenant,
                payload.connection_id,
                payload.target.as_deref(),
                &message,
            )
            .await
        {
            Ok(sent) => TaskOutcome::Done(Some(match sent.id {
                Some(id) => format!("delivered to {} ({id})", sent.target),
                None => format!("delivered to {}", sent.target),
            })),
            Err(e) => {
                let error = format!("{e:#}");
                match classify(&error) {
                    Verdict::Permanent => TaskOutcome::Failed(error),
                    Verdict::Transient => TaskOutcome::Retry(error),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_and_addressing_failures_are_permanent() {
        for error in [
            "Slack auth.test: invalid_auth",
            "Slack chat.postMessage: not_in_channel",
            "Slack chat.postMessage: missing_scope (needs scope chat:write)",
            "Slack webhook 404: no_service",
            "Discord 403: Missing Access",
            "Zulip messages 400: Channel 'releases' does not exist",
            "Webhook URL must be an https:// URL — a token or webhook secret must not travel over http",
            "the token for connection 'Releases' is not readable",
            "connection 3f7c1d84-9b2e-4a55-8c17-6e0b2f9d41aa not found",
            "no driver for provider 'slack' in this deployment",
        ] {
            assert_eq!(classify(error), Verdict::Permanent, "{error}");
        }
    }

    #[test]
    fn rate_limits_and_outages_are_transient() {
        for error in [
            "Slack chat.postMessage: ratelimited",
            "Discord 429: {\"retry_after\": 2.5}",
            "Zulip messages 502: bad gateway",
            "Discord 503",
            "error sending request: operation timed out",
        ] {
            assert_eq!(classify(error), Verdict::Transient, "{error}");
        }
    }

    #[test]
    fn an_unrecognised_error_is_retried_rather_than_dropped() {
        // The default matters more than the list: a message must never be
        // discarded because nobody taught `classify` about its error. The cap
        // on attempts is what stops it retrying forever.
        assert_eq!(
            classify("something nobody has seen before"),
            Verdict::Transient
        );
    }

    #[test]
    fn a_payload_round_trips_through_the_queue() {
        let json = serde_json::json!({
            "connection_id": "11111111-2222-3333-4444-555555555555",
            "target": "C0ABC",
            "title": "Build failed",
            "text": "3 tests red",
            "link": "https://ci/1",
        });
        let payload: DeliveryPayload = serde_json::from_value(json).unwrap();
        assert_eq!(payload.target.as_deref(), Some("C0ABC"));
        assert_eq!(payload.text, "3 tests red");
        assert!(payload.topic.is_none());
    }

    #[test]
    fn a_payload_without_a_connection_is_refused_by_serde() {
        // The one required field. A run that named no connection could only
        // dead-letter, so it is better refused where the message is read.
        let json = serde_json::json!({ "text": "hello" });
        assert!(serde_json::from_value::<DeliveryPayload>(json).is_err());
    }
}
