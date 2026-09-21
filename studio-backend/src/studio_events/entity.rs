//! `SeaORM` entities for the studio-events channel.
//!
//! Two tables, and the split between them is the whole design.
//!
//! `studio_events_cursor` holds one row per tenant carrying that tenant's
//! high-water mark. It is the sequence: an `UPDATE ... RETURNING` on it takes
//! the row lock, so two replicas publishing at the same instant serialize and
//! each gets a distinct number. Nothing else in this channel needs to
//! coordinate.
//!
//! `studio_events_log` holds the events themselves, keyed `(tenant_id, seq)`.
//! It is a **window, not a ledger** — the same thing the in-process backlog
//! was, moved somewhere every replica can read it. It is pruned to the
//! configured depth and carries no history guarantee; a client that falls
//! further behind than the window learns so from `latest_seq` jumping past the
//! last event it received, exactly as before.
//!
//! PER-TENANT rather than one global sequence, deliberately, and this predates
//! durability: a client's cursor stays dense, and no tenant can infer another's
//! volume from the gaps in its own.

use sea_orm::entity::prelude::*;
use toolkit_db::secure::Scopable;
use uuid::Uuid;

pub mod log {
    use super::{DeriveEntityModel, Scopable, Uuid};
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Scopable)]
    #[sea_orm(table_name = "studio_events_log")]
    // A published event belongs to the tenant it names and to nobody inside
    // it: the channel's only visibility rule is the tenant boundary, and the
    // hub has enforced exactly that since it was in-process.
    #[secure(tenant_col = "tenant_id", no_owner, no_type, no_resource)]
    pub struct Model {
        /// `(tenant_id, seq)` is the identity. A surrogate key would add a
        /// column nothing reads and an index nothing uses.
        #[sea_orm(primary_key, auto_increment = false)]
        pub tenant_id: Uuid,
        #[sea_orm(primary_key, auto_increment = false)]
        pub seq: i64,
        /// Milliseconds since the Unix epoch, assigned when the event was
        /// published rather than when it was written, so a slow write does not
        /// backdate or postdate what a producer observed.
        pub at_ms: i64,
        pub kind: String,
        pub subject_type: String,
        pub subject_id: String,
        pub source: String,
        #[sea_orm(column_type = "JsonBinary")]
        pub payload: Json,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {}

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            unreachable!("studio_events_log has no relations")
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod cursor {
    use super::{DeriveEntityModel, Scopable, Uuid};
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Scopable)]
    #[sea_orm(table_name = "studio_events_cursor")]
    #[secure(tenant_col = "tenant_id", no_owner, no_type, no_resource)]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub tenant_id: Uuid,
        /// The last `seq` handed out for this tenant. Monotonic, never reused,
        /// and never reset by pruning the log — a cursor a client is holding
        /// must not become valid again for a different event.
        pub latest_seq: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {}

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            unreachable!("studio_events_cursor has no relations")
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}
