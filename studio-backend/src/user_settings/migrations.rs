//! SeaORM migration for the settings gear's one table.
//!
//! Raw SQL, PostgreSQL only, same as the identity gear beside it — and for the
//! same reason: a second dialect nothing executes and no test covers drifts
//! quietly until the day it is needed.

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

    const UNSUPPORTED: &str = "studio-user-settings migrations: PostgreSQL only";

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0001_user_setting"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            let sql = match manager.get_database_backend() {
                sea_orm::DatabaseBackend::Postgres => {
                    // `user_id` alone is the primary key: one person, one set of
                    // preferences. The platform gear keys on
                    // (tenant_id, user_id), which is what this gear exists to
                    // stop doing — see entity.rs and ADR-0017.
                    r"
CREATE TABLE IF NOT EXISTS user_setting (
    user_id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    theme TEXT,
    language TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
                    "
                }
                _ => return Err(DbErr::Custom(UNSUPPORTED.to_owned())),
            };
            manager.get_connection().execute_unprepared(sql).await?;
            Ok(())
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .get_connection()
                .execute_unprepared("DROP TABLE IF EXISTS user_setting;")
                .await?;
            Ok(())
        }
    }
}
