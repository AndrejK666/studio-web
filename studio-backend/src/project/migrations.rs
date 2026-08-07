//! `SeaORM` migrations for the `studio-project` gear.
//!
//! Raw per-backend `SQL` so the CHECK constraints survive verbatim — the same
//! approach credstore and `studio-credstore-pg` take, for the same reason.

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

    const MYSQL_NOT_SUPPORTED: &str = "studio-project migrations: MySQL is not supported \
        (this migration set targets PostgreSQL/SQLite)";

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m0001_studio_projects"
        }
    }

    // The shape invariant, spelled once per backend:
    //   mode 1 (greenfield) -> no source columns at all
    //   mode 2 (modernize)  -> source_kind set, and exactly the matching column
    // Without this a bug in the service layer could persist a "modernize
    // project with nothing to modernize", which then fails much later, in the
    // pipeline, where the cause is no longer visible.
    const SHAPE_CHECK: &str = "
    CHECK (
        (mode = 1 AND source_kind IS NULL AND source_git_url IS NULL AND source_file_id IS NULL)
     OR (mode = 2 AND source_kind = 1 AND source_git_url IS NOT NULL AND source_file_id IS NULL)
     OR (mode = 2 AND source_kind = 2 AND source_file_id IS NOT NULL AND source_git_url IS NULL)
    )";

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            let backend = manager.get_database_backend();
            let conn = manager.get_connection();

            let table = match backend {
                sea_orm::DatabaseBackend::Postgres => format!(
                    "
CREATE TABLE IF NOT EXISTS studio_projects (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    mode SMALLINT NOT NULL CHECK (mode IN (1, 2)),
    status SMALLINT NOT NULL CHECK (status IN (1, 2, 3)),
    stages TEXT NOT NULL,
    brief TEXT NULL,
    source_kind SMALLINT NULL CHECK (source_kind IS NULL OR source_kind IN (1, 2)),
    source_git_url TEXT NULL,
    source_file_id UUID NULL,
    rg_group_id UUID NULL,
    created_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    {SHAPE_CHECK}
);"
                ),
                sea_orm::DatabaseBackend::Sqlite => format!(
                    "
CREATE TABLE IF NOT EXISTS studio_projects (
    id BLOB PRIMARY KEY NOT NULL,
    tenant_id BLOB NOT NULL,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    mode SMALLINT NOT NULL CHECK (mode IN (1, 2)),
    status SMALLINT NOT NULL CHECK (status IN (1, 2, 3)),
    stages TEXT NOT NULL,
    brief TEXT NULL,
    source_kind SMALLINT NULL CHECK (source_kind IS NULL OR source_kind IN (1, 2)),
    source_git_url TEXT NULL,
    source_file_id BLOB NULL,
    rg_group_id BLOB NULL,
    created_by BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    {SHAPE_CHECK}
);"
                ),
                sea_orm::DatabaseBackend::MySql => {
                    return Err(DbErr::Custom(MYSQL_NOT_SUPPORTED.to_owned()));
                }
            };

            conn.execute(sea_orm::Statement::from_string(backend, table))
                .await?;

            // A project name is how people refer to it in conversation, so two
            // projects with one name inside a workspace is a usability bug, not
            // a modelling nicety. Unique per tenant, not globally: two
            // workspaces may each have their own "Payments v2".
            conn.execute(sea_orm::Statement::from_string(
                backend,
                "CREATE UNIQUE INDEX IF NOT EXISTS ux_studio_projects_tenant_name \
                 ON studio_projects (tenant_id, name);"
                    .to_owned(),
            ))
            .await?;

            // Listing a workspace's projects is the only hot read.
            conn.execute(sea_orm::Statement::from_string(
                backend,
                "CREATE INDEX IF NOT EXISTS ix_studio_projects_tenant_status \
                 ON studio_projects (tenant_id, status);"
                    .to_owned(),
            ))
            .await?;

            Ok(())
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            let backend = manager.get_database_backend();
            if matches!(backend, sea_orm::DatabaseBackend::MySql) {
                return Err(DbErr::Custom(MYSQL_NOT_SUPPORTED.to_owned()));
            }
            conn_exec(manager, "DROP INDEX IF EXISTS ix_studio_projects_tenant_status;").await?;
            conn_exec(manager, "DROP INDEX IF EXISTS ux_studio_projects_tenant_name;").await?;
            conn_exec(manager, "DROP TABLE IF EXISTS studio_projects;").await?;
            Ok(())
        }
    }

    async fn conn_exec(manager: &SchemaManager<'_>, sql: &str) -> Result<(), DbErr> {
        let backend = manager.get_database_backend();
        manager
            .get_connection()
            .execute(sea_orm::Statement::from_string(backend, sql.to_owned()))
            .await?;
        Ok(())
    }
}
