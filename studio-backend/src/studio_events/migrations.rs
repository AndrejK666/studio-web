//! `SeaORM` migrations for the `studio-events` gear.
//!
//! Two tables: the per-tenant sequence and the replay window. See
//! [`super::entity`] for why they are separate.
//!
//! PostgreSQL only, and not merely by house rule: the sequence is an
//! `UPDATE ... RETURNING` that relies on row-level locking to serialize two
//! replicas publishing at the same instant, and the pruning is a window
//! function. Neither has a SQLite equivalent worth pretending about.

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

    const ONLY_POSTGRES: &str =
        "studio-events migrations: only PostgreSQL is supported (see the module docs)";

    pub struct Migration;

    // Spelled out: the name is a schema-history key and must survive a rename
    // of this module.
    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0001_studio_events_log"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if manager.get_database_backend() != sea_orm::DatabaseBackend::Postgres {
                return Err(DbErr::Custom(ONLY_POSTGRES.to_owned()));
            }
            manager
                .get_connection()
                .execute_unprepared(
                    r"
-- The sequence. One row per tenant, and the only thing two replicas contend
-- on: `UPDATE ... RETURNING latest_seq` takes the row lock, so concurrent
-- publishers serialize here and each leaves with a distinct number.
CREATE TABLE IF NOT EXISTS studio_events_cursor (
    tenant_id  UUID PRIMARY KEY,
    latest_seq BIGINT NOT NULL DEFAULT 0
);

-- The replay window. Deliberately not a ledger: it is pruned to the configured
-- depth, and a client that falls further behind learns so from `latest_seq`
-- running past the last event it holds.
CREATE TABLE IF NOT EXISTS studio_events_log (
    tenant_id    UUID   NOT NULL,
    seq          BIGINT NOT NULL,
    at_ms        BIGINT NOT NULL,
    kind         TEXT   NOT NULL,
    subject_type TEXT   NOT NULL,
    subject_id   TEXT   NOT NULL,
    source       TEXT   NOT NULL,
    payload      JSONB  NOT NULL DEFAULT 'null'::jsonb,
    PRIMARY KEY (tenant_id, seq)
);

-- Both reads this table serves are `WHERE tenant_id = $1 AND seq > $2 ORDER BY
-- seq`, which the primary key already answers: a tenant's rows are contiguous
-- and ordered by seq within it. No second index, on a table whose write rate
-- is its whole cost.
                    ",
                )
                .await?;
            Ok(())
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if manager.get_database_backend() != sea_orm::DatabaseBackend::Postgres {
                return Err(DbErr::Custom(ONLY_POSTGRES.to_owned()));
            }
            manager
                .get_connection()
                .execute_unprepared(
                    "DROP TABLE IF EXISTS studio_events_log; \
                     DROP TABLE IF EXISTS studio_events_cursor;",
                )
                .await?;
            Ok(())
        }
    }
}
