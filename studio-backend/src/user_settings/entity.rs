//! SeaORM entity for the settings gear's one table.
//!
//! One row per **person**, not per sign-in method and not per organization.
//!
//! That is the whole reason this gear is ours (ADR-0017). The platform's
//! `simple-user-settings` files a row under `(ctx.subject_id(), subject_tenant)`:
//! the identity that signed in, in the organization it signed into. Studio has
//! several logins per person and several organizations per person, so under that
//! key a preference forks the moment somebody signs in the other way or
//! switches organization — their theme is simply gone, with nothing logged and
//! nothing to see.
//!
//! The row therefore carries the platform-root tenant like every other
//! identity-owned record (see `user_profile::entity`): the data is global
//! because a person is global, and "one shared partition = the root tenant" is
//! what toolkit-db's secure runner needs to scope a query at all.

use uuid::Uuid;

/// The single partition every settings row lives in.
///
/// Same value and same reasoning as the identity tables: a person spans
/// organizations, so their preferences cannot belong to one of them.
pub const ROOT_TENANT: Uuid = Uuid::from_u128(1);

pub mod setting {
    use sea_orm::entity::prelude::*;
    use time::OffsetDateTime;
    use toolkit_db::secure::Scopable;
    use uuid::Uuid;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Scopable)]
    #[sea_orm(table_name = "user_setting")]
    #[secure(tenant_col = "tenant_id", resource_col = "user_id", no_owner, no_type)]
    pub struct Model {
        /// The canonical Studio person. The primary key, so one person has one
        /// set of preferences wherever and however they signed in.
        #[sea_orm(primary_key, auto_increment = false)]
        pub user_id: Uuid,
        pub tenant_id: Uuid,
        pub theme: Option<String>,
        pub language: Option<String>,
        pub created_at: OffsetDateTime,
        pub updated_at: OffsetDateTime,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}
    impl ActiveModelBehavior for ActiveModel {}
}
