//! `SeaORM` migrations for the `studio-product` gear: a product's description
//! by revision (ADR-0053 §1, [`super::descriptions`]).
//!
//! PostgreSQL only (studio-backend/AGENTS.md).

use toolkit_db::sea_orm_migration::prelude::*;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m0001::Migration),
            Box::new(m0002::Migration),
            Box::new(m0003::Migration),
            Box::new(m0004::Migration),
            Box::new(m0005::Migration),
        ]
    }
}

mod m0001 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    const ONLY_POSTGRES: &str =
        "studio-product migrations: only PostgreSQL is supported (see the module docs)";

    pub struct Migration;

    // Spelled out: the name is a schema-history key and must survive a rename
    // of this module.
    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0001_studio_product_descriptions"
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
-- One row per revision of a project's product description. The primary key is
-- also the save's lock: two saves made against the same revision both try the
-- same next number, and the second is refused.
CREATE TABLE IF NOT EXISTS studio_product_descriptions (
    tenant_id     UUID   NOT NULL,
    project_id    UUID   NOT NULL,
    revision      BIGINT NOT NULL,
    text          TEXT   NOT NULL,
    author        TEXT   NOT NULL,
    created_at_ms BIGINT NOT NULL,
    sha256        TEXT   NOT NULL,
    source        TEXT   NOT NULL DEFAULT 'studio',
    PRIMARY KEY (tenant_id, project_id, revision)
);
-- The reads -- the latest, one revision, the list newest first -- are all
-- `WHERE tenant_id AND project_id ORDER BY revision`, which the key answers.
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
                .execute_unprepared("DROP TABLE IF EXISTS studio_product_descriptions;")
                .await?;
            Ok(())
        }
    }
}

/// Each revision's lock: the commit of every source its text uses, taken at
/// save (ADR-0060 §3).
mod m0002 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0002_studio_product_descriptions_sources_lock"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if manager.get_database_backend() != sea_orm::DatabaseBackend::Postgres {
                return Err(DbErr::Custom(
                    "studio-product migrations: only PostgreSQL is supported".to_owned(),
                ));
            }
            manager
                .get_connection()
                .execute_unprepared(
                    "ALTER TABLE studio_product_descriptions ADD COLUMN IF NOT EXISTS sources_lock TEXT NULL;",
                )
                .await?;
            Ok(())
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .get_connection()
                .execute_unprepared(
                    "ALTER TABLE studio_product_descriptions DROP COLUMN IF EXISTS sources_lock;",
                )
                .await?;
            Ok(())
        }
    }
}

/// A project's gear matches and its notes on them (`gear_match/store.rs`).
mod m0003 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0003_studio_product_gear_matches"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if manager.get_database_backend() != sea_orm::DatabaseBackend::Postgres {
                return Err(DbErr::Custom(
                    "studio-product migrations: only PostgreSQL is supported".to_owned(),
                ));
            }
            manager
                .get_connection()
                .execute_unprepared(
                    r"
-- One row per gear match of a project: what was sent to the gears-matcher
-- service, its run there, the catalogue it read and the report it wrote.
CREATE TABLE IF NOT EXISTS studio_product_gear_matches (
    tenant_id        UUID    NOT NULL,
    project_id       UUID    NOT NULL,
    id               UUID    NOT NULL,
    run_id           UUID    NULL,
    state            TEXT    NOT NULL,
    requested_by     TEXT    NOT NULL,
    created_at_ms    BIGINT  NOT NULL,
    updated_at_ms    BIGINT  NOT NULL,
    finished_at_ms   BIGINT  NULL,
    idempotency_key  TEXT    NOT NULL,
    product          TEXT    NOT NULL,
    documents        TEXT    NOT NULL,
    request          TEXT    NOT NULL,
    matcher_run_id   TEXT    NULL,
    info             TEXT    NULL,
    progress         TEXT    NULL,
    report           TEXT    NULL,
    totals           TEXT    NULL,
    usage            TEXT    NULL,
    error            TEXT    NULL,
    cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (tenant_id, project_id, id)
);
CREATE INDEX IF NOT EXISTS studio_product_gear_matches_newest
    ON studio_product_gear_matches (tenant_id, project_id, created_at_ms DESC);
-- A member's decision on a proposed gear, an answer to a question: the
-- project's, kept across matches.
CREATE TABLE IF NOT EXISTS studio_product_gear_match_notes (
    tenant_id     UUID   NOT NULL,
    project_id    UUID   NOT NULL,
    kind          TEXT   NOT NULL,
    subject       TEXT   NOT NULL,
    gear_id       TEXT   NOT NULL DEFAULT '',
    value         TEXT   NOT NULL,
    author        TEXT   NOT NULL,
    updated_at_ms BIGINT NOT NULL,
    match_id      UUID   NULL,
    PRIMARY KEY (tenant_id, project_id, kind, subject, gear_id)
);
                    ",
                )
                .await?;
            Ok(())
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .get_connection()
                .execute_unprepared(
                    "DROP TABLE IF EXISTS studio_product_gear_match_notes; \
                     DROP TABLE IF EXISTS studio_product_gear_matches;",
                )
                .await?;
            Ok(())
        }
    }
}

mod m0004 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0004_studio_product_assembly_strategies"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if manager.get_database_backend() != sea_orm::DatabaseBackend::Postgres {
                return Err(DbErr::Custom(
                    "studio-product migrations: only PostgreSQL is supported".to_owned(),
                ));
            }
            manager
                .get_connection()
                .execute_unprepared(
                    r"
-- How a product is assembled (ADR-0072): the organization's default
-- (scope_id = the organization) and each project's own choice over it.
CREATE TABLE IF NOT EXISTS studio_product_assembly_strategies (
    tenant_id     UUID   NOT NULL,
    scope_id      UUID   NOT NULL,
    strategy      TEXT   NOT NULL,
    set_by        TEXT   NOT NULL,
    updated_at_ms BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, scope_id)
);
                    ",
                )
                .await?;
            Ok(())
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .get_connection()
                .execute_unprepared("DROP TABLE IF EXISTS studio_product_assembly_strategies;")
                .await?;
            Ok(())
        }
    }
}

mod m0005 {
    use toolkit_db::sea_orm_migration::prelude::*;
    use toolkit_db::sea_orm_migration::sea_orm;
    use toolkit_db::sea_orm_migration::sea_orm::ConnectionTrait;

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0005_studio_product_gear_match_strategy"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            if manager.get_database_backend() != sea_orm::DatabaseBackend::Postgres {
                return Err(DbErr::Custom(
                    "studio-product migrations: only PostgreSQL is supported".to_owned(),
                ));
            }
            manager
                .get_connection()
                .execute_unprepared(
                    r"
-- The assembly strategy a match ran for (ADR-0074, amendment): every match
-- before it was the shipped gears-matcher's.
ALTER TABLE studio_product_gear_matches
    ADD COLUMN IF NOT EXISTS strategy TEXT NOT NULL DEFAULT 'gears_matcher';
CREATE INDEX IF NOT EXISTS studio_product_gear_matches_strategy_newest
    ON studio_product_gear_matches (tenant_id, project_id, strategy, created_at_ms DESC);
                    ",
                )
                .await?;
            Ok(())
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .get_connection()
                .execute_unprepared(
                    "DROP INDEX IF EXISTS studio_product_gear_matches_strategy_newest; \
                     ALTER TABLE studio_product_gear_matches DROP COLUMN IF EXISTS strategy;",
                )
                .await?;
            Ok(())
        }
    }
}
