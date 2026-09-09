//! `SeaORM` entity for the `studio_notify_deliveries` table.
//!
//! One row per accepted notification — what was asked for, and what became of
//! it. This is *not* the queue: the queue is the `toolkit-db` outbox, which is
//! append-only, acks by advancing a cursor, and garbage-collects processed rows
//! on a vacuum pass. Nothing durable survives there to answer "what happened to
//! the message I sent an hour ago", which is exactly the question an operator
//! asks. So the queue carries this row's id and nothing else, and the row
//! carries the history.

use sea_orm::entity::prelude::*;
use time::OffsetDateTime;
use toolkit_db::secure::Scopable;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Scopable)]
#[sea_orm(table_name = "studio_notify_deliveries")]
// `no_owner`: a delivery belongs to the tenant, not to the person who asked
// for it. `requested_by` is recorded for the audit trail, and a colleague must
// be able to see why the release channel went quiet — so it is not an
// authorization dimension and must not become a scope filter.
#[secure(tenant_col = "tenant_id", resource_col = "id", no_owner, no_type)]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub tenant_id: Uuid,
    /// The connection this is delivered through. Not a foreign key: connections
    /// live in account-management's tenant metadata, not in this database.
    pub connection_id: Uuid,
    /// Provider key at accept time (`slack`, `zulip_webhook`, …). Denormalized
    /// on purpose — a delivery's history should still read correctly after the
    /// connection it went through has been deleted.
    pub provider: String,
    /// Channel asked for. `None` for a provider whose credential fixes it.
    pub target: Option<String>,
    pub title: Option<String>,
    pub body: String,
    pub link: Option<String>,
    /// Zulip topic; ignored by the other platforms.
    pub topic: Option<String>,
    /// `queued` | `sent` | `failed` — see [`super::DeliveryState`].
    pub state: String,
    /// Delivery attempts made so far. Written by the dispatcher, so a stuck
    /// message is visible without reading the outbox's internals.
    pub attempts: i16,
    /// Why the last attempt failed, in the platform's own words.
    pub last_error: Option<String>,
    /// Where it actually landed, as the platform reported it. Differs from
    /// `target` for a webhook connection, which resolves its own channel.
    pub delivered_target: Option<String>,
    /// Provider-native message id, where the platform returns one.
    pub platform_message_id: Option<String>,
    /// Caller-supplied key that makes a repeated accept a no-op. Unique per
    /// tenant; `None` opts out.
    pub idempotency_key: Option<String>,
    /// Subject that asked for the delivery.
    pub requested_by: Uuid,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
