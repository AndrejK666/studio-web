//! The durable half of the channel: the sequence, the replay window, pruning.
//!
//! Everything here is keyed by tenant and filtered by tenant. That is the
//! channel's only visibility rule, and it was the only one when this state
//! lived in a `HashMap<Uuid, TenantChannel>` — moving it into Postgres does
//! not widen it.

use sea_orm::sea_query::{Expr, ExprTrait, OnConflict};
use sea_orm::{ActiveValue, ColumnTrait, Condition, EntityTrait, Order};
use serde_json::Value;
use toolkit_db::Db;
use toolkit_db::secure::{SecureDeleteExt, SecureEntityExt, SecureInsertExt};
use toolkit_security::AccessScope;
use uuid::Uuid;

use super::dto::StudioEventDto;
use super::entity::{cursor, log};

pub struct EventStore {
    db: Db,
}

impl EventStore {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /// Take the tenant's next sequence number and write the event under it.
    ///
    /// The upsert is what serializes concurrent publishers — in this process
    /// and in every other replica. `ON CONFLICT DO UPDATE` takes the cursor
    /// row's lock, so the second publisher waits for the first to commit
    /// rather than reading a stale maximum, and they leave with 7 and 8 rather
    /// than both with 7.
    ///
    /// TWO STATEMENTS, NOT ONE TRANSACTION, deliberately. Wrapping them would
    /// hold the cursor row's lock for the whole append, serializing a tenant's
    /// publishers on the log write as well as on the number. The cost of not
    /// wrapping them is a gap: if the log insert fails after the number was
    /// taken, that `seq` is never written. A gap is harmless to the contract —
    /// clients need `seq` to be monotonic, not dense — and its only visible
    /// effect is that a client may see `latest_seq` run one ahead of the last
    /// event it holds and re-fetch, which is exactly what it does after
    /// falling out of the window anyway.
    pub async fn append(&self, event: &PendingEvent) -> anyhow::Result<i64> {
        let conn = self.db.conn()?;

        let fresh = cursor::ActiveModel {
            tenant_id: ActiveValue::Set(event.tenant_id),
            latest_seq: ActiveValue::Set(1),
        };
        // `latest_seq + 1` over the STORED row, not `EXCLUDED.latest_seq`:
        // the incoming row always carries 1, and what we want is the tenant's
        // own counter advanced by one.
        let bump = OnConflict::column(cursor::Column::TenantId)
            .value(
                cursor::Column::LatestSeq,
                Expr::col((cursor::Entity, cursor::Column::LatestSeq)).add(1),
            )
            .to_owned();

        let taken = cursor::Entity::insert(fresh)
            .secure()
            // The row does not exist on the first publish, so there is nothing
            // to clamp against; `tenant_id` is the scope, set from the event
            // whose tenant the producer already resolved.
            .scope_unchecked(&AccessScope::for_tenant(event.tenant_id))?
            .on_conflict_raw(bump)
            .exec_with_returning(&conn)
            .await?;
        let seq = taken.latest_seq;

        let row = log::ActiveModel {
            tenant_id: ActiveValue::Set(event.tenant_id),
            seq: ActiveValue::Set(seq),
            at_ms: ActiveValue::Set(event.at_ms),
            kind: ActiveValue::Set(event.kind.clone()),
            subject_type: ActiveValue::Set(event.subject_type.clone()),
            subject_id: ActiveValue::Set(event.subject_id.clone()),
            source: ActiveValue::Set(event.source.clone()),
            payload: ActiveValue::Set(event.payload.clone()),
        };
        log::Entity::insert(row)
            .secure()
            .scope_unchecked(&AccessScope::for_tenant(event.tenant_id))?
            .exec(&conn)
            .await?;

        Ok(seq)
    }

    /// Events after `after_seq`, oldest first, and the tenant's high-water mark.
    ///
    /// The mark comes from the cursor rather than from the rows on purpose: it
    /// is what tells a client it fell out of the window, so it has to keep
    /// counting events that pruning has already removed.
    pub async fn after(
        &self,
        tenant_id: Uuid,
        after_seq: i64,
        limit: u64,
    ) -> anyhow::Result<(Vec<StudioEventDto>, i64)> {
        let conn = self.db.conn()?;
        let rows = log::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant_id))
            .filter(Condition::all().add(log::Column::Seq.gt(after_seq)))
            .order_by(log::Column::Seq, Order::Asc)
            .limit(limit)
            .all(&conn)
            .await?;
        let latest = self.latest_seq(tenant_id).await?;
        Ok((rows.into_iter().map(to_dto).collect(), latest))
    }

    /// The tenant's high-water mark, or 0 for a tenant that has published
    /// nothing. Zero is safe as "nothing yet": sequences start at 1.
    pub async fn latest_seq(&self, tenant_id: Uuid) -> anyhow::Result<i64> {
        let conn = self.db.conn()?;
        Ok(cursor::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant_id))
            .one(&conn)
            .await?
            .map_or(0, |m| m.latest_seq))
    }

    /// Drop everything more than `keep` events behind the tenant's mark.
    ///
    /// The cursor is untouched, which is the point: a pruned `seq` is gone but
    /// never reissued, so a cursor a client is still holding cannot silently
    /// come to mean a different event.
    pub async fn prune(&self, tenant_id: Uuid, keep: i64) -> anyhow::Result<u64> {
        let latest = self.latest_seq(tenant_id).await?;
        let floor = latest - keep;
        if floor <= 0 {
            return Ok(0);
        }
        let conn = self.db.conn()?;
        let res = log::Entity::delete_many()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant_id))
            .filter(Condition::all().add(log::Column::Seq.lte(floor)))
            .exec(&conn)
            .await?;
        Ok(res.rows_affected)
    }
}

/// An event on its way to the log: everything a producer stated, plus the time
/// this process observed it.
#[derive(Debug, Clone)]
pub struct PendingEvent {
    pub tenant_id: Uuid,
    pub at_ms: i64,
    pub kind: String,
    pub subject_type: String,
    pub subject_id: String,
    pub source: String,
    pub payload: Value,
}

fn to_dto(row: log::Model) -> StudioEventDto {
    StudioEventDto {
        seq: row.seq,
        at_ms: row.at_ms,
        kind: row.kind,
        subject_type: row.subject_type,
        subject_id: row.subject_id,
        source: row.source,
        payload: row.payload,
    }
}
