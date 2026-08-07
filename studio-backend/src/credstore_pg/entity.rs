//! `SeaORM` entity for the `studio_credstore_values` table.
//!
//! One row per credstore key class: `(tenant_id, reference, owner_id)`, where
//! `owner_id` is the nil UUID for the tenant key class (`owner_id = None` on
//! the plugin API) and the subject id for the private class. That mirrors how
//! `credstore_secrets` stores its own non-owned rows, so the two tables read
//! the same way side by side.
//!
//! `id` is not a surrogate: it is the deterministic v5 UUID of the triple
//! above (see `store::row_id`), which makes the primary key itself the
//! uniqueness constraint on the key class and gives `put` an idempotent
//! `ON CONFLICT` target without a second index.

use sea_orm::entity::prelude::*;
use time::OffsetDateTime;
use toolkit_db::secure::Scopable;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Scopable)]
#[sea_orm(table_name = "studio_credstore_values")]
// `no_owner`: `owner_id` here discriminates the KEY CLASS, it is not an
// authorization dimension. The gear has already authorized the request and
// resolved tenant/owner before it reaches a plugin, and every query below is
// keyed by the exact row — declaring it as `owner_col` would invite the scope
// builder to filter on a caller subject the plugin contract never receives.
#[secure(tenant_col = "tenant_id", resource_col = "id", no_owner, no_type)]
pub struct Model {
    /// Deterministic v5 UUID of `(tenant_id, reference, owner_id)`.
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub reference: String,
    /// Nil UUID for the tenant key class; the subject id for the private class.
    pub owner_id: Uuid,
    /// 96-bit AES-GCM nonce, fresh on every write.
    pub nonce: Vec<u8>,
    /// AES-256-GCM ciphertext with the appended 128-bit tag.
    pub ciphertext: Vec<u8>,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
