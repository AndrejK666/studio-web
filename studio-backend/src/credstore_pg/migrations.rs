//! `SeaORM` migrations for the `studio-credstore-pg` gear.
//!
//! Raw `SQL` (not the schema builder) so the `CHECK` constraint is preserved
//! verbatim — the same approach credstore's own `m0001` takes, for the same
//! reason.
//!
//! **PostgreSQL only.** This carried a parallel SQLite dialect so its tests
//! could run without a server. The gear never ran on SQLite in any deployment,
//! so that half was shipped code the product never executed — and the tests it
//! existed for now run on PostgreSQL, which is what they are meant to prove.
//! `studio-documents` dropped its own second dialect first, and for a sharper
//! reason: the two spellings had drifted into a real bug.

use toolkit_db::sea_orm_migration::prelude::*;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![Box::new(m0001::Migration)]
    }
}

mod m0001 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    const UNSUPPORTED: &str = "studio-credstore-pg migrations: PostgreSQL only";

    pub struct Migration;

    // Spelled out rather than derived: the name is a schema-history key, so it
    // must not silently change if this module is ever renamed or moved.
    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0001_studio_credstore_values"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            let sql = match manager.get_database_backend() {
                sea_orm::DatabaseBackend::Postgres => {
                    r"
CREATE TABLE IF NOT EXISTS studio_credstore_values (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    reference TEXT NOT NULL CHECK (length(reference) BETWEEN 1 AND 255),
    owner_id UUID NOT NULL,
    nonce BYTEA NOT NULL,
    ciphertext BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
                    "
                }
                // Every other backend falls through to the same error
                // (`DatabaseBackend` is `#[non_exhaustive]` in sea-orm 2.0), so a
                // deployment that points this gear at one fails at migration time
                // rather than at the first read.
                _ => {
                    return Err(DbErr::Custom(UNSUPPORTED.to_owned()));
                }
            };

            manager.get_connection().execute_unprepared(sql).await?;
            Ok(())
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if !matches!(
                manager.get_database_backend(),
                sea_orm::DatabaseBackend::Postgres
            ) {
                return Err(DbErr::Custom(UNSUPPORTED.to_owned()));
            }
            manager
                .get_connection()
                .execute_unprepared("DROP TABLE IF EXISTS studio_credstore_values;")
                .await?;
            Ok(())
        }
    }
}
