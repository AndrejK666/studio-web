//! `SeaORM` migrations for the `studio-notify` gear.
//!
//! Only the delivery-history table is here. The queue's own tables — the
//! `studio_notify_outbox_*` family — are `toolkit-db`'s, created by
//! [`toolkit_db::outbox::outbox_migrations_with_prefix`] and listed alongside
//! these by the gear's `DatabaseCapability`. Both run in this gear's database,
//! which is what lets one transaction write a delivery row and enqueue its
//! delivery together.
//!
//! PostgreSQL only. Every gear database in this deployment is PostgreSQL, and a
//! second dialect here would be a second set of statements to keep honest for
//! an engine nothing runs on.

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
        "studio-notify migrations: only PostgreSQL is supported (see the module docs)";

    pub struct Migration;

    // Spelled out rather than derived: the name is a schema-history key and
    // must not change if this module is renamed or moved.
    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0001_studio_notify_deliveries"
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
CREATE TABLE IF NOT EXISTS studio_notify_deliveries (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    connection_id UUID NOT NULL,
    provider TEXT NOT NULL,
    target TEXT,
    title TEXT,
    body TEXT NOT NULL,
    link TEXT,
    topic TEXT,
    state TEXT NOT NULL CHECK (state IN ('queued', 'sent', 'failed')),
    attempts SMALLINT NOT NULL DEFAULT 0,
    last_error TEXT,
    delivered_target TEXT,
    platform_message_id TEXT,
    idempotency_key TEXT,
    requested_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The listing every operator screen and every support question starts from:
-- one tenant, newest first.
CREATE INDEX IF NOT EXISTS idx_studio_notify_deliveries_tenant_created
    ON studio_notify_deliveries (tenant_id, created_at DESC);

-- 'sent' is the overwhelming majority of rows and the least interesting, so
-- the index that answers 'what is stuck or broken' deliberately excludes it.
CREATE INDEX IF NOT EXISTS idx_studio_notify_deliveries_unfinished
    ON studio_notify_deliveries (tenant_id, state)
    WHERE state <> 'sent';

-- Makes a retried accept a no-op rather than a second message. Partial, so
-- opting out (NULL) does not collide with every other opt-out.
CREATE UNIQUE INDEX IF NOT EXISTS uq_studio_notify_deliveries_idempotency
    ON studio_notify_deliveries (tenant_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
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
                .execute_unprepared("DROP TABLE IF EXISTS studio_notify_deliveries;")
                .await?;
            Ok(())
        }
    }
}
