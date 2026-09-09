//! studio-notify — notifications that survive the thing that was going to send
//! them.
//!
//! ## Why this gear exists
//!
//! `studio-connector` can post a message to Slack, Zulip or Discord while a
//! request waits for it. That is the right shape for "test this connection",
//! and the wrong shape for a notification: the caller is usually some other
//! piece of Studio that has just finished a job, the platform may be rate-
//! limiting or down, and an HTTP handler is a bad place to discover either. A
//! message dropped there is dropped for good — nothing recorded that it was
//! ever meant to be sent.
//!
//! So this gear accepts a notification, writes it down, and answers. Delivery
//! happens afterwards, from a queue, with retries, and what is left over lands
//! in a dead-letter table instead of nowhere.
//!
//! ## The queue is not ours
//!
//! `toolkit-db` ships a transactional outbox — incoming → sequencer →
//! outgoing → processor, leased or transactional handlers, exponential backoff
//! on `Retry`, a dead-letter table on `Reject`, and `FOR UPDATE SKIP LOCKED`
//! for partition locking on PostgreSQL. This gear supplies a handler, a table
//! prefix and a partition count; it implements no queue of its own.
//!
//! Two tables, two jobs: the `studio_notify_outbox_*` family is the queue, and
//! [`entity`] is the history. The queue is append-only and vacuums what it has
//! processed, so it cannot answer "what happened to the message I sent an hour
//! ago"; the history can, and is tenant-scoped so a person only sees their own.
//!
//! ## Why PostgreSQL and not Redis
//!
//! Because the enqueue has to be part of the transaction that caused it. Every
//! cause Studio has lives in PostgreSQL, and a queue in a different system
//! turns one commit into two writes that can disagree — which is the exact
//! failure a durable queue was supposed to prevent. Throughput is not the
//! deciding factor either way: the ceiling here is the platforms', not ours
//! (Slack accepts about one message per second per channel), and it is orders
//! of magnitude below what one PostgreSQL can absorb.
//!
//! Redis would earn its place for state this design deliberately does not
//! keep: a rate-limit budget shared across replicas, or a cross-replica
//! deduplication window. Both are ephemeral, and neither is needed while one
//! process holds the queue.

mod dispatch;
mod entity;
mod migrations;
mod rest;
mod service;

use std::sync::{Arc, Mutex, OnceLock};

use async_trait::async_trait;
use axum::Router;
use tokio_util::sync::CancellationToken;
use toolkit::api::OpenApiRegistry;
use toolkit::contracts::{DatabaseCapability, RunnableCapability};
use toolkit::{Gear, GearCtx};
use toolkit_db::outbox::{Outbox, OutboxHandle, Partitions, outbox_migrations_with_prefix};
use tracing::{info, warn};
use uuid::Uuid;

use dispatch::DeliveryHandler;
use service::NotifyService;

/// Table-name prefix for this gear's outbox family. Its own, not the default:
/// the tables belong to `studio-notify`'s database and to nothing else, and a
/// prefix is how `toolkit-db` keeps two outboxes from sharing one.
const TABLE_PREFIX: &str = "studio_notify_outbox";

/// The one queue this gear runs.
const QUEUE: &str = "deliveries";

/// How many partitions the queue has, i.e. how many deliveries can be in
/// flight at once. Four, because a partition delivers in order and the useful
/// parallelism is across connections rather than within one — see
/// [`service::NotifyService::partition_of`].
const PARTITIONS: u32 = 4;

/// Payload type on the queue. One producer, one shape; the handler refuses
/// anything else rather than guessing.
const PAYLOAD_TYPE: &str = "cf.studio.notify.delivery.v1";

/// Where a delivery has got to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeliveryState {
    /// Accepted and on the queue — including a delivery that has failed an
    /// attempt and is waiting for the next one.
    Queued,
    /// The platform took it.
    Sent,
    /// Given up on: a permanent refusal, or too many attempts. The message is
    /// in the outbox's dead-letter table and this row says why.
    Failed,
}

impl DeliveryState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Sent => "sent",
            Self::Failed => "failed",
        }
    }

    pub fn parse(raw: &str) -> anyhow::Result<Self> {
        match raw.trim().to_lowercase().as_str() {
            "queued" => Ok(Self::Queued),
            "sent" => Ok(Self::Sent),
            "failed" => Ok(Self::Failed),
            other => Err(anyhow::anyhow!(
                "unknown state '{other}' (expected queued | sent | failed)"
            )),
        }
    }
}

/// The queue carries a tenant and a delivery id, and nothing else.
///
/// Not the message: a payload is immutable once enqueued, so a copy of the
/// text there would go stale against the row the operator reads and the row
/// the retry path resets. One id keeps a single source of truth.
///
/// The tenant rides along because the worker needs it *before* it can read
/// anything — every read in this gear is tenant-scoped, and a worker that
/// learned the tenant from an unscoped read of the row would be reaching
/// across tenants to find out which tenant it was allowed to reach. Both
/// values are immutable for the life of a delivery, so the copy cannot go
/// stale.
fn encode_payload(tenant: Uuid, id: Uuid) -> Vec<u8> {
    let mut out = Vec::with_capacity(32);
    out.extend_from_slice(tenant.as_bytes());
    out.extend_from_slice(id.as_bytes());
    out
}

fn decode_payload(payload: &[u8]) -> Option<(Uuid, Uuid)> {
    let bytes = <[u8; 32]>::try_from(payload).ok()?;
    let (tenant, id) = bytes.split_at(16);
    Some((
        Uuid::from_bytes(<[u8; 16]>::try_from(tenant).ok()?),
        Uuid::from_bytes(<[u8; 16]>::try_from(id).ok()?),
    ))
}

#[toolkit::gear(
    name = "studio-notify",
    deps = [account_management],
    capabilities = [rest, db, stateful]
)]
#[derive(Default)]
pub struct StudioNotifyGear {
    service: OnceLock<Option<Arc<NotifyService>>>,
    /// Held so `stop` can shut the pipeline down gracefully. A `Mutex<Option>`
    /// rather than a `OnceLock` because `OutboxHandle::stop` consumes it.
    queue: Mutex<Option<OutboxHandle>>,
}

#[async_trait]
impl Gear for StudioNotifyGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        // No database, no queue. Stand down rather than fail the boot: the REST
        // surface answers 503 with the reason, which is what every other
        // optional gear in this assembly does.
        let db = match ctx.db_required() {
            Ok(db) => db.db(),
            Err(e) => {
                warn!(
                    "studio-notify: no database configured — gear stands down (the notify API \
                     answers 503 until a `database:` section with server + dbname is added): {e}"
                );
                self.service
                    .set(None)
                    .map_err(|_| anyhow::anyhow!("studio-notify already initialized"))?;
                return Ok(());
            }
        };

        // The pipeline is started here rather than in `RunnableCapability::start`
        // because the REST phase runs first and needs the queue handle to build
        // the service. Starting early is harmless: the processors find an empty
        // queue until something is accepted, and the handler resolves its
        // sender per message, so it does not race studio-connector's init.
        let handle = Outbox::builder(db.clone())
            .table_prefix(TABLE_PREFIX)?
            .queue(
                QUEUE,
                Partitions::of(u16::try_from(PARTITIONS).unwrap_or(u16::MAX)),
            )
            // Leased, not transactional: the handler makes an HTTP call to a
            // chat platform, and holding a database transaction open across
            // that would pin a partition lock for as long as Slack feels like
            // taking. The cost is at-least-once instead of exactly-once — see
            // `service`'s note on duplicates.
            //
            // `LeasedMessageHandler` is bridged to `LeasedHandler` by a blanket
            // impl, so no adapter is needed here (`PerMessageAdapter` is for
            // the transactional path).
            .leased(DeliveryHandler::new(db.clone(), ctx.client_hub()))
            .start()
            .await?;

        let service = NotifyService::new(db, Arc::clone(handle.outbox()), ctx.client_hub());
        *self
            .queue
            .lock()
            .map_err(|_| anyhow::anyhow!("studio-notify: queue lock poisoned"))? = Some(handle);
        self.service
            .set(Some(service))
            .map_err(|_| anyhow::anyhow!("studio-notify already initialized"))?;

        info!(
            queue = QUEUE,
            partitions = PARTITIONS,
            "studio-notify: delivery queue running"
        );
        Ok(())
    }
}

impl DatabaseCapability for StudioNotifyGear {
    fn migrations(&self) -> Vec<Box<dyn toolkit_db::sea_orm_migration::MigrationTrait>> {
        use toolkit_db::sea_orm_migration::MigratorTrait;
        let mut all = migrations::Migrator::migrations();
        // The queue's own tables, in the same database and the same migration
        // run as the history table — which is what makes one transaction able
        // to write both.
        match outbox_migrations_with_prefix(TABLE_PREFIX) {
            Ok(mut outbox) => all.append(&mut outbox),
            // The prefix is a compile-time constant validated as a SQL
            // identifier, so this cannot happen without an edit to it. Loud
            // rather than silent: without these tables the gear has no queue.
            Err(e) => panic!("studio-notify: invalid outbox table prefix {TABLE_PREFIX}: {e}"),
        }
        all
    }
}

#[async_trait]
impl RunnableCapability for StudioNotifyGear {
    /// Nothing to do: the pipeline came up in `init` (see the note there).
    /// Declared so this gear gets a shutdown hook at all.
    async fn start(&self, _cancel: CancellationToken) -> anyhow::Result<()> {
        Ok(())
    }

    /// Let in-flight deliveries finish and their acks commit.
    ///
    /// Skipping this would not lose a message — an unacked leased message is
    /// redelivered once its lease expires — but it would turn every shutdown
    /// into a source of duplicate posts.
    async fn stop(&self, _deadline: CancellationToken) -> anyhow::Result<()> {
        let handle = self
            .queue
            .lock()
            .map_err(|_| anyhow::anyhow!("studio-notify: queue lock poisoned"))?
            .take();
        if let Some(handle) = handle {
            handle.stop().await;
            info!("studio-notify: delivery queue stopped");
        }
        Ok(())
    }
}

#[async_trait]
impl toolkit::contracts::RestApiCapability for StudioNotifyGear {
    fn register_rest(
        &self,
        _ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        Ok(rest::register_routes(
            router,
            openapi,
            self.service.get().cloned().flatten(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_delivery_survives_the_queue_round_trip() {
        let tenant = Uuid::new_v4();
        let id = Uuid::new_v4();
        assert_eq!(
            decode_payload(&encode_payload(tenant, id)),
            Some((tenant, id))
        );
    }

    #[test]
    fn the_two_ids_do_not_get_swapped() {
        // Order matters and both halves are Uuids, which is exactly the kind
        // of pair that gets transposed unnoticed.
        let tenant = Uuid::from_u128(1);
        let id = Uuid::from_u128(2);
        let payload = encode_payload(tenant, id);
        assert_eq!(&payload[..16], tenant.as_bytes());
        assert_eq!(&payload[16..], id.as_bytes());
    }

    #[test]
    fn a_payload_that_is_not_a_delivery_is_refused_rather_than_guessed() {
        assert!(decode_payload(b"").is_none());
        assert!(decode_payload(b"not-a-uuid").is_none());
        // A single uuid: the old payload shape, and the one an upgrade could
        // leave in a queue. Refused rather than read as half a pair.
        assert!(decode_payload(&[0u8; 16]).is_none());
        assert!(decode_payload(&[0u8; 33]).is_none());
    }

    #[test]
    fn every_state_round_trips_through_its_wire_form() {
        for state in [
            DeliveryState::Queued,
            DeliveryState::Sent,
            DeliveryState::Failed,
        ] {
            assert_eq!(DeliveryState::parse(state.as_str()).unwrap(), state);
        }
        assert!(DeliveryState::parse("delivered").is_err());
    }
}
