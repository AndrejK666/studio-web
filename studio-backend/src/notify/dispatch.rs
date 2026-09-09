//! The queue worker: takes a delivery off the outbox and posts it.
//!
//! ## Who the worker is
//!
//! A queued delivery is performed minutes after the request that asked for it,
//! by a process that has no request. It therefore cannot act as the person who
//! asked — and deliberately does not try: nothing persists the caller's bearer
//! token, and nothing replays their authorization. The worker acts as
//! `studio-notify` itself ([`SERVICE_SUBJECT_ID`]), scoped to the tenant
//! recorded on the delivery row.
//!
//! The authorization that mattered happened at accept time, against the
//! caller's own context: the connection was resolved, its credential was read,
//! and a connection the caller could not use was refused with a 400 while
//! there was still a request to answer (see
//! [`ConnectorService::delivery_preflight`](crate::connectors::service::ConnectorService::delivery_preflight)).
//! What the worker does later is the mechanical part.
//!
//! The one thing this identity cannot do is read a `personal`-scoped
//! credential, which credstore keeps readable only by its owner. That is why
//! the accept path refuses to queue one at all rather than leaving it to fail
//! here — see [`super::service`].
//!
//! ## Transient or permanent
//!
//! The driver contract answers with `anyhow::Error`, so the verdict is read
//! out of the message text. That is not a pleasing way to make a retry
//! decision, and the honest fix is a typed error on the driver contract — a
//! refactor across eleven drivers, none of which exists yet. Until then
//! [`classify`] matches the shapes the drivers actually produce, and its
//! **default is to retry with a cap**: an error nobody has classified is tried
//! [`MAX_ATTEMPTS`] times and then dead-lettered. Never dropped, never retried
//! forever.

use std::sync::Arc;

use async_trait::async_trait;
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, Condition, EntityTrait};
use time::OffsetDateTime;
use toolkit::client_hub::{ClientHub, ClientScope};
use toolkit_db::Db;
use toolkit_db::outbox::{LeasedMessageHandler, MessageResult, OutboxMessage};
use toolkit_db::secure::{SecureEntityExt, SecureUpdateExt};
use toolkit_security::AccessScope;
use toolkit_security::SecurityContext;
use tracing::{info, warn};
use uuid::Uuid;

use crate::connectors::driver::NotifyMessage;
use crate::connectors::{NOTIFY_SENDER_INSTANCE_ID, NotificationSender};

use super::entity;
use super::{DeliveryState, PAYLOAD_TYPE};

/// The identity the queue worker acts as. A fixed constant rather than a
/// generated id: it appears in audit trails and in credstore reads, and a
/// subject that changed on every boot would make both unreadable.
pub const SERVICE_SUBJECT_ID: Uuid = Uuid::from_u128(0x5f2a_9c31_47b8_4d06_a1e5_3b7c_28f0_9d44);

/// How many times one delivery is attempted before it is dead-lettered.
///
/// With the processor's exponential backoff this spans minutes, not seconds —
/// long enough to ride out a platform outage or a rate-limit window, short
/// enough that a message nobody can deliver stops occupying its partition. A
/// partition processes in order, so an undeliverable message ahead of the queue
/// delays the ones behind it until it gives up; that is the cost of ordering,
/// and the cap is what bounds it.
pub const MAX_ATTEMPTS: i16 = 8;

/// Whether an error is worth another attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// The platform, the network or the deployment might behave differently in
    /// a minute.
    Transient,
    /// Nothing will change without a human: a revoked credential, a channel the
    /// bot was never invited to, a message the platform refuses.
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
        // The connection itself is gone from the catalogue, or its provider is
        // not in this deployment. Neither reappears by waiting, and a delivery
        // that outlived the connection it was queued against is the ordinary
        // way this happens.
        "not found",
        "no driver for provider",
    ];
    if PERMANENT.iter().any(|p| e.contains(p)) {
        return Verdict::Permanent;
    }

    // A credential this worker cannot read will never become readable by
    // waiting. The accept path refuses personal-scoped connections for exactly
    // this reason; anything that still lands here is a misconfiguration.
    if e.contains("is not readable") || e.contains("not readable") {
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

/// Delivers queued notifications. One instance, shared by every partition
/// processor.
pub struct DeliveryHandler {
    db: Db,
    hub: Arc<ClientHub>,
}

impl DeliveryHandler {
    pub fn new(db: Db, hub: Arc<ClientHub>) -> Self {
        Self { db, hub }
    }

    /// The identity the worker acts as for one tenant's delivery.
    fn worker_context(tenant: Uuid) -> anyhow::Result<SecurityContext> {
        SecurityContext::builder()
            .subject_id(SERVICE_SUBJECT_ID)
            .subject_type("service")
            .subject_tenant_id(tenant)
            // First-party: this is the gear's own background work, not a
            // third-party token with a narrowed grant.
            .token_scopes(vec!["*".to_owned()])
            .build()
            .map_err(|e| anyhow::anyhow!("studio-notify: cannot build a worker context: {e}"))
    }

    /// The delivery, read within its own tenant's scope.
    ///
    /// The tenant comes off the queue payload beside the id rather than out of
    /// the row, so this read is scoped like every other read in the gear — a
    /// worker never has to read across tenants to discover which tenant it is
    /// allowed to read.
    async fn row(&self, tenant: Uuid, id: Uuid) -> anyhow::Result<Option<entity::Model>> {
        let conn = self.db.conn()?;
        Ok(entity::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .filter(Condition::all().add(entity::Column::Id.eq(id)))
            .one(&conn)
            .await?)
    }

    /// Record the outcome on the delivery row.
    ///
    /// Best-effort by design: the queue, not this table, decides whether a
    /// message is done. A failed write here loses a line of history; refusing
    /// the message over it would lose the message.
    async fn record(&self, tenant: Uuid, id: Uuid, attempts: i16, outcome: Outcome<'_>) {
        let (state, last_error, delivered_target, platform_message_id) = match outcome {
            Outcome::Sent { target, message_id } => (
                DeliveryState::Sent,
                None,
                Some(target.to_owned()),
                message_id.map(str::to_owned),
            ),
            Outcome::Retrying(error) => (
                DeliveryState::Queued,
                Some(truncate_error(error)),
                None,
                None,
            ),
            Outcome::Failed(error) => (
                DeliveryState::Failed,
                Some(truncate_error(error)),
                None,
                None,
            ),
        };

        let write = async {
            let conn = self.db.conn()?;
            let mut update = entity::Entity::update_many()
                .secure()
                .scope_with(&AccessScope::for_tenant(tenant))
                .filter(Condition::all().add(entity::Column::Id.eq(id)))
                .col_expr(entity::Column::State, Expr::value(state.as_str()))
                .col_expr(entity::Column::Attempts, Expr::value(attempts))
                .col_expr(
                    entity::Column::UpdatedAt,
                    Expr::value(OffsetDateTime::now_utc()),
                )
                .col_expr(entity::Column::LastError, Expr::value(last_error));
            // Only written on success, and only then: a retry must not erase
            // where a previous attempt landed.
            if let Some(target) = delivered_target {
                update = update
                    .col_expr(entity::Column::DeliveredTarget, Expr::value(target))
                    .col_expr(
                        entity::Column::PlatformMessageId,
                        Expr::value(platform_message_id),
                    );
            }
            update.exec(&conn).await?;
            Ok::<(), anyhow::Error>(())
        };
        if let Err(e) = write.await {
            warn!(delivery_id = %id, "studio-notify: could not record the delivery outcome: {e:#}");
        }
    }
}

enum Outcome<'a> {
    Sent {
        target: &'a str,
        message_id: Option<&'a str>,
    },
    Retrying(&'a str),
    Failed(&'a str),
}

/// `last_error` is read by a person, and some platforms answer with an HTML
/// page. Keep a sentence, not a document.
fn truncate_error(error: &str) -> String {
    const LIMIT: usize = 500;
    if error.chars().count() <= LIMIT {
        return error.to_owned();
    }
    error.chars().take(LIMIT - 1).chain(['…']).collect()
}

#[async_trait]
impl LeasedMessageHandler for DeliveryHandler {
    async fn handle(&self, msg: &OutboxMessage) -> MessageResult {
        if msg.payload_type != PAYLOAD_TYPE {
            // Nothing else enqueues onto this queue, so this is a bug rather
            // than a condition. Reject: retrying cannot change the payload.
            return MessageResult::Reject(format!(
                "studio-notify: unexpected payload type '{}'",
                msg.payload_type
            ));
        }
        let Some((tenant, id)) = super::decode_payload(&msg.payload) else {
            return MessageResult::Reject(
                "studio-notify: queue payload is not a tenant and a delivery id".to_owned(),
            );
        };

        let row = match self.row(tenant, id).await {
            Ok(Some(row)) => row,
            // The row is gone (a retention sweep, a manual delete). There is
            // nothing left to deliver and nothing to fix.
            Ok(None) => {
                warn!(delivery_id = %id, "studio-notify: queued delivery has no row — dropping");
                return MessageResult::Ok;
            }
            // The database is unreachable; that is the definition of transient.
            Err(e) => {
                warn!(delivery_id = %id, "studio-notify: cannot read the delivery: {e:#}");
                return MessageResult::Retry;
            }
        };

        // At-least-once means this can be a redelivery of something already
        // posted (a lease that expired after the platform accepted the message
        // but before the ack landed). The state check makes the common case of
        // that harmless.
        if row.state == DeliveryState::Sent.as_str() {
            return MessageResult::Ok;
        }

        let attempts = msg.attempts.saturating_add(1);

        let sender = match self
            .hub
            .get_scoped::<dyn NotificationSender>(&ClientScope::gts_id(NOTIFY_SENDER_INSTANCE_ID))
        {
            Ok(sender) => sender,
            // studio-connector stood down (no driver plugin linked). Retry:
            // this is a deployment state, not a property of the message.
            Err(e) => {
                warn!("studio-notify: no notification sender registered — waiting: {e}");
                return MessageResult::Retry;
            }
        };

        let ctx = match Self::worker_context(row.tenant_id) {
            Ok(ctx) => ctx,
            Err(e) => return MessageResult::Reject(format!("{e:#}")),
        };

        let message = NotifyMessage {
            text: row.body.clone(),
            title: row.title.clone(),
            link: row.link.clone(),
            topic: row.topic.clone(),
        };

        match sender
            .deliver(
                &ctx,
                row.tenant_id,
                row.connection_id,
                row.target.as_deref(),
                &message,
            )
            .await
        {
            Ok(sent) => {
                info!(
                    delivery_id = %id,
                    provider = %row.provider,
                    target = %sent.target,
                    attempts,
                    "studio-notify: delivered"
                );
                self.record(
                    tenant,
                    id,
                    attempts,
                    Outcome::Sent {
                        target: &sent.target,
                        message_id: sent.id.as_deref(),
                    },
                )
                .await;
                MessageResult::Ok
            }
            Err(e) => {
                let error = format!("{e:#}");
                let verdict = classify(&error);
                let giving_up = verdict == Verdict::Permanent || attempts >= MAX_ATTEMPTS;
                if giving_up {
                    warn!(
                        delivery_id = %id,
                        provider = %row.provider,
                        attempts,
                        ?verdict,
                        "studio-notify: giving up — dead-lettering: {error}"
                    );
                    self.record(tenant, id, attempts, Outcome::Failed(&error))
                        .await;
                    MessageResult::Reject(error)
                } else {
                    warn!(
                        delivery_id = %id,
                        provider = %row.provider,
                        attempts,
                        "studio-notify: attempt failed, will retry: {error}"
                    );
                    self.record(tenant, id, attempts, Outcome::Retrying(&error))
                        .await;
                    MessageResult::Retry
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
    fn a_long_platform_error_is_cut_to_a_sentence() {
        let long = "x".repeat(900);
        let cut = truncate_error(&long);
        assert_eq!(cut.chars().count(), 500);
        assert!(cut.ends_with('…'));
        // Multi-byte input must not panic or split a character.
        assert_eq!(truncate_error(&"я".repeat(600)).chars().count(), 500);
    }
}
