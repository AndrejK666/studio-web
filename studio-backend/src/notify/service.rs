//! Accepting, recording and re-queuing deliveries.
//!
//! ## What makes a notification not get lost
//!
//! One transaction. The delivery row and its queue entry are written together
//! or not at all:
//!
//! ```text
//! BEGIN
//!   INSERT INTO studio_notify_deliveries ...      -- the history
//!   INSERT INTO studio_notify_outbox_incoming ... -- the queue (toolkit-db)
//! COMMIT
//! ```
//!
//! That is the whole point of a transactional outbox, and it is why the queue
//! lives in the same PostgreSQL database as the record rather than in a
//! separate broker: a queue the business transaction cannot commit *with* is a
//! queue that disagrees with the database every time one of the two writes
//! fails. After the commit the message is the queue's problem — it survives a
//! restart, it is retried with backoff, and it is dead-lettered rather than
//! dropped.
//!
//! What this does not promise is exactly-once *delivery*. The processor runs
//! leased (at-least-once), so a lease that expires after Slack accepted a
//! message but before the ack committed will hand the message to another
//! worker. [`super::dispatch`] narrows that to the width of one ack by
//! checking the recorded state first, but none of these three platforms offers
//! an idempotency key on a post, so a duplicate in that window is possible.
//! Losing a message is not.

use std::sync::Arc;

use anyhow::anyhow;
use sea_orm::sea_query::Expr;
use sea_orm::{ActiveValue, ColumnTrait, Condition, EntityTrait, Order};
use time::OffsetDateTime;
use toolkit_db::Db;
use toolkit_db::outbox::Outbox;
use toolkit_db::secure::{SecureEntityExt, SecureInsertExt, SecureUpdateExt};
use toolkit_security::{AccessScope, SecurityContext};
use uuid::Uuid;

use toolkit::client_hub::{ClientHub, ClientScope};

use crate::connectors::{NOTIFY_SENDER_INSTANCE_ID, NotificationSender};

use super::entity;
use super::{DeliveryState, PARTITIONS, PAYLOAD_TYPE, QUEUE, encode_payload};

/// One request to deliver a notification.
#[derive(Debug, Clone)]
pub struct NewDelivery<'a> {
    /// Tenant the delivery belongs to — the one that owns the connection.
    pub tenant: Uuid,
    pub connection_id: Uuid,
    /// Channel, for a provider that takes one.
    pub target: Option<&'a str>,
    pub title: Option<&'a str>,
    pub text: &'a str,
    pub link: Option<&'a str>,
    pub topic: Option<&'a str>,
    /// Repeat-safe key. A second accept with the same key in the same tenant
    /// returns the first delivery instead of queuing another.
    pub idempotency_key: Option<&'a str>,
}

/// Filter for the delivery listing.
#[derive(Debug, Clone, Default)]
pub struct DeliveryQuery {
    pub state: Option<DeliveryState>,
    pub connection_id: Option<Uuid>,
    pub limit: u64,
}

pub struct NotifyService {
    db: Db,
    outbox: Arc<Outbox>,
    hub: Arc<ClientHub>,
}

impl NotifyService {
    pub fn new(db: Db, outbox: Arc<Outbox>, hub: Arc<ClientHub>) -> Arc<Self> {
        Arc::new(Self { db, outbox, hub })
    }

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

    /// Which partition a connection's deliveries go to.
    ///
    /// Keyed by connection so one connection's messages stay in order relative
    /// to each other — a "build started" that overtakes its "build finished"
    /// reads as a bug in Studio, not as a scheduling detail. The cost is that
    /// connections sharing a partition also share its head-of-line delay; see
    /// [`super::dispatch::MAX_ATTEMPTS`], which bounds it.
    ///
    /// FNV-1a rather than `DefaultHasher`: the standard hasher is explicitly
    /// not stable across builds, and a partition assignment that moves on
    /// upgrade would reorder messages across a restart.
    fn partition_of(connection_id: Uuid) -> u32 {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in connection_id.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        u32::try_from(hash % u64::from(PARTITIONS)).unwrap_or(0)
    }

    /// Verify, record and queue one delivery.
    pub async fn accept(
        &self,
        ctx: &SecurityContext,
        req: NewDelivery<'_>,
    ) -> anyhow::Result<entity::Model> {
        let text = req.text.trim();
        let title = req.title.map(str::trim).filter(|t| !t.is_empty());
        if text.is_empty() && title.is_none() {
            return Err(anyhow!("a notification needs a text or a title"));
        }

        // Resolved with the caller's own context, before anything is written.
        // A connection that cannot deliver is a 400 now rather than a dead
        // letter later, when nobody is watching.
        let preflight = self
            .sender()?
            .preflight(ctx, req.tenant, req.connection_id)
            .await?;

        // A personal credential is readable only by its owner, and a queued
        // delivery is performed by the gear's own service identity — which is
        // not its owner. Refusing here is the difference between an error the
        // caller can act on and a dead letter that says "not readable".
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

        let key = req
            .idempotency_key
            .map(str::trim)
            .filter(|k| !k.is_empty())
            .map(str::to_owned);
        if let Some(key) = key.as_deref()
            && let Some(existing) = self.find_by_idempotency_key(ctx, req.tenant, key).await?
        {
            return Ok(existing);
        }

        let now = OffsetDateTime::now_utc();
        let row = entity::Model {
            id: Uuid::new_v4(),
            tenant_id: req.tenant,
            connection_id: req.connection_id,
            provider: preflight.provider,
            target: target.map(str::to_owned),
            title: title.map(str::to_owned),
            body: text.to_owned(),
            link: req
                .link
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(str::to_owned),
            topic: req
                .topic
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map(str::to_owned),
            state: DeliveryState::Queued.as_str().to_owned(),
            attempts: 0,
            last_error: None,
            delivered_target: None,
            platform_message_id: None,
            idempotency_key: key,
            requested_by: ctx.subject_id(),
            created_at: now,
            updated_at: now,
        };

        self.enqueue(row.clone()).await?;
        // Wake the sequencer so a quiet queue does not wait out its idle
        // interval before noticing.
        self.outbox.flush();
        Ok(row)
    }

    /// The atomic half: the history row and the queue entry, one transaction.
    async fn enqueue(&self, row: entity::Model) -> anyhow::Result<()> {
        let outbox = Arc::clone(&self.outbox);
        let partition = Self::partition_of(row.connection_id);
        let payload = encode_payload(row.tenant_id, row.id);
        let tenant = row.tenant_id;

        self.db
            .transaction_ref_mapped::<_, (), anyhow::Error>(move |tx| {
                Box::pin(async move {
                    let am = entity::ActiveModel {
                        id: ActiveValue::Set(row.id),
                        tenant_id: ActiveValue::Set(row.tenant_id),
                        connection_id: ActiveValue::Set(row.connection_id),
                        provider: ActiveValue::Set(row.provider),
                        target: ActiveValue::Set(row.target),
                        title: ActiveValue::Set(row.title),
                        body: ActiveValue::Set(row.body),
                        link: ActiveValue::Set(row.link),
                        topic: ActiveValue::Set(row.topic),
                        state: ActiveValue::Set(row.state),
                        attempts: ActiveValue::Set(row.attempts),
                        last_error: ActiveValue::Set(row.last_error),
                        delivered_target: ActiveValue::Set(row.delivered_target),
                        platform_message_id: ActiveValue::Set(row.platform_message_id),
                        idempotency_key: ActiveValue::Set(row.idempotency_key),
                        requested_by: ActiveValue::Set(row.requested_by),
                        created_at: ActiveValue::Set(row.created_at),
                        updated_at: ActiveValue::Set(row.updated_at),
                    };
                    entity::Entity::insert(am)
                        .secure()
                        // scope_unchecked: the row does not exist yet, so there
                        // is nothing to clamp against, and `tenant_id` is the
                        // tenant whose connection the accept path just resolved.
                        .scope_unchecked(&AccessScope::for_tenant(tenant))?
                        .exec(tx)
                        .await?;

                    outbox
                        .enqueue(tx, QUEUE, partition, payload, PAYLOAD_TYPE)
                        .await?;
                    Ok(())
                })
            })
            .await
    }

    /// Put a failed delivery back on the queue.
    ///
    /// A fresh queue entry rather than `Outbox::dead_letter_replay`: a
    /// dead-letter row is keyed by partition and sequence with no tenant on it,
    /// so replaying through that API could not be scoped to the caller's
    /// tenant. The abandoned dead-letter row is garbage-collected by the
    /// outbox's own cleanup; this table stays the operator's source of truth.
    pub async fn retry(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        id: Uuid,
    ) -> anyhow::Result<entity::Model> {
        let row = self
            .get(ctx, tenant, id)
            .await?
            .ok_or_else(|| anyhow!("delivery {id} not found"))?;
        if row.state == DeliveryState::Sent.as_str() {
            return Err(anyhow!(
                "delivery {id} was already delivered — retrying it would post it twice"
            ));
        }
        if row.state == DeliveryState::Queued.as_str() {
            // Already in the queue. Saying "done" would be a lie and queuing a
            // second copy would be worse.
            return Err(anyhow!(
                "delivery {id} is still queued — it has not given up yet"
            ));
        }

        // Reset and re-enqueue in one transaction, for the same reason the
        // accept path is one transaction: a row that says `queued` with nothing
        // on the queue is a message that will never move again.
        let outbox = Arc::clone(&self.outbox);
        let partition = Self::partition_of(row.connection_id);
        let payload = encode_payload(tenant, id);
        self.db
            .transaction_ref_mapped::<_, (), anyhow::Error>(move |tx| {
                Box::pin(async move {
                    entity::Entity::update_many()
                        .secure()
                        .scope_with(&AccessScope::for_tenant(tenant))
                        .filter(Condition::all().add(entity::Column::Id.eq(id)))
                        .col_expr(
                            entity::Column::State,
                            Expr::value(DeliveryState::Queued.as_str()),
                        )
                        .col_expr(entity::Column::Attempts, Expr::value(0_i16))
                        .col_expr(entity::Column::LastError, Expr::value(None::<String>))
                        .col_expr(
                            entity::Column::UpdatedAt,
                            Expr::value(OffsetDateTime::now_utc()),
                        )
                        .exec(tx)
                        .await?;
                    outbox
                        .enqueue(tx, QUEUE, partition, payload, PAYLOAD_TYPE)
                        .await?;
                    Ok(())
                })
            })
            .await?;
        self.outbox.flush();

        self.get(ctx, tenant, id)
            .await?
            .ok_or_else(|| anyhow!("delivery {id} disappeared while being re-queued"))
    }

    pub async fn get(
        &self,
        _ctx: &SecurityContext,
        tenant: Uuid,
        id: Uuid,
    ) -> anyhow::Result<Option<entity::Model>> {
        let conn = self.db.conn()?;
        Ok(entity::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .filter(Condition::all().add(entity::Column::Id.eq(id)))
            .one(&conn)
            .await?)
    }

    async fn find_by_idempotency_key(
        &self,
        _ctx: &SecurityContext,
        tenant: Uuid,
        key: &str,
    ) -> anyhow::Result<Option<entity::Model>> {
        let conn = self.db.conn()?;
        Ok(entity::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .filter(Condition::all().add(entity::Column::IdempotencyKey.eq(key)))
            .one(&conn)
            .await?)
    }

    pub async fn list(
        &self,
        _ctx: &SecurityContext,
        tenant: Uuid,
        query: &DeliveryQuery,
    ) -> anyhow::Result<Vec<entity::Model>> {
        let mut filter = Condition::all();
        if let Some(state) = query.state {
            filter = filter.add(entity::Column::State.eq(state.as_str()));
        }
        if let Some(connection) = query.connection_id {
            filter = filter.add(entity::Column::ConnectionId.eq(connection));
        }
        let conn = self.db.conn()?;
        Ok(entity::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .filter(filter)
            .order_by(entity::Column::CreatedAt, Order::Desc)
            .limit(query.limit.max(1))
            .all(&conn)
            .await?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_connection_always_lands_on_the_same_partition() {
        let id = Uuid::from_u128(0x1234_5678_9abc_def0_1234_5678_9abc_def0);
        let first = NotifyService::partition_of(id);
        assert_eq!(first, NotifyService::partition_of(id));
        assert!(first < PARTITIONS);
    }

    #[test]
    fn partitions_are_actually_used() {
        // A hash that mapped everything onto partition 0 would serialize every
        // tenant's deliveries behind one processor and still pass the test
        // above.
        let seen: std::collections::BTreeSet<u32> = (0..200)
            .map(|n| NotifyService::partition_of(Uuid::from_u128(n)))
            .collect();
        assert_eq!(
            seen.len() as u32,
            PARTITIONS,
            "spread across all partitions"
        );
    }

    #[test]
    fn the_partition_of_a_known_id_is_pinned() {
        // FNV-1a is chosen for stability across builds; this pins that it is
        // actually FNV-1a, so a "harmless" hash swap cannot silently reorder
        // every queue on upgrade.
        assert_eq!(NotifyService::partition_of(Uuid::nil()), {
            let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
            for _ in 0..16 {
                hash ^= 0;
                hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
            }
            u32::try_from(hash % u64::from(PARTITIONS)).unwrap()
        });
    }
}
