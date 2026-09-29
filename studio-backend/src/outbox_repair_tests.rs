//! The repair against a real PostgreSQL: an outbox shaped the way toolkit-db
//! before 0.16 left it, and one shaped the way 0.16 makes it.

use super::*;
use tokio_postgres::NoTls;

async fn connect(prefix: &str) -> Client {
    let dsn = crate::test_pg::fresh_database(prefix).await;
    let (client, connection) = tokio_postgres::connect(&dsn, NoTls).await.expect("connect");
    tokio::spawn(connection);
    client
}

/// The tables and journal toolkit-db before 0.16 created: body and dead
/// letters with no `trace` column, no trace table, and m001 recorded.
async fn old_outbox(client: &Client, prefix: &str, journal: &str, version: &str) {
    client
        .batch_execute(&format!(
            "CREATE TABLE {prefix}_outbox_body (id BIGSERIAL PRIMARY KEY, payload BYTEA NOT NULL);
             CREATE TABLE {prefix}_outbox_dead_letters (id BIGSERIAL PRIMARY KEY, payload BYTEA NOT NULL);
             CREATE TABLE IF NOT EXISTS \"{journal}\" (
                 version VARCHAR(255) PRIMARY KEY,
                 applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
             INSERT INTO \"{journal}\" (version) VALUES ('{version}'), ('m002_something_else');"
        ))
        .await
        .expect("create the old outbox");
}

async fn has_column(client: &Client, table: &str, column: &str) -> bool {
    client
        .query_opt(
            "SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2",
            &[&table, &column],
        )
        .await
        .unwrap()
        .is_some()
}

async fn versions(client: &Client, journal: &str) -> Vec<String> {
    client
        .query(
            &format!("SELECT version FROM \"{journal}\" ORDER BY version"),
            &[],
        )
        .await
        .unwrap()
        .into_iter()
        .map(|r| r.get(0))
        .collect()
}

#[tokio::test]
async fn an_old_outbox_gets_its_column_and_runs_its_migration_again() {
    let c = connect("outbox_repair_old").await;
    let journal = "toolkit_migrations__studio_tasks__0123abcd";
    old_outbox(
        &c,
        "studio_tasks",
        journal,
        "m001_create_toolkit_outbox_schema",
    )
    .await;

    let r = repair(&c).await.unwrap();
    assert_eq!(
        r.columns_added,
        vec![
            "studio_tasks_outbox_body".to_string(),
            "studio_tasks_outbox_dead_letters".to_string(),
        ]
    );
    assert_eq!(r.migrations_reset, 1);
    assert!(has_column(&c, "studio_tasks_outbox_body", "trace").await);
    assert!(has_column(&c, "studio_tasks_outbox_dead_letters", "trace").await);
    // Only the outbox migration is forgotten; the gear's own history stays.
    assert_eq!(versions(&c, journal).await, vec!["m002_something_else"]);
}

#[tokio::test]
async fn a_suffixed_outbox_migration_is_found_too() {
    // mini-chat names its outbox migration with a suffix.
    let c = connect("outbox_repair_suffix").await;
    let journal = "toolkit_migrations__mini_chat__89abcdef";
    old_outbox(
        &c,
        "studio_mini_chat",
        journal,
        "m001_create_toolkit_outbox_schema__mini_chat_outbox",
    )
    .await;

    let r = repair(&c).await.unwrap();
    assert_eq!(r.migrations_reset, 1);
    assert_eq!(versions(&c, journal).await, vec!["m002_something_else"]);
}

#[tokio::test]
async fn repairing_twice_changes_nothing_the_second_time() {
    let c = connect("outbox_repair_twice").await;
    let journal = "toolkit_migrations__studio_tasks__0123abcd";
    old_outbox(
        &c,
        "studio_tasks",
        journal,
        "m001_create_toolkit_outbox_schema",
    )
    .await;
    repair(&c).await.unwrap();
    // What the re-run migration creates.
    c.batch_execute(
        "CREATE TABLE studio_tasks_outbox_trace (id BIGSERIAL PRIMARY KEY, trace VARCHAR(256) NOT NULL);",
    )
    .await
    .unwrap();

    assert!(repair(&c).await.unwrap().is_empty());
}

/// What the first repair (#521) left: body and trace table fixed, the dead
/// letters still without `trace` -- so a rejected message fails. Only the
/// missing column is added; m001 is not reset again.
#[tokio::test]
async fn an_outbox_repaired_before_the_dead_letters_were_known_gets_them() {
    let c = connect("outbox_repair_half").await;
    let journal = "toolkit_migrations__studio_tasks__0123abcd";
    c.batch_execute(&format!(
        "CREATE TABLE studio_tasks_outbox_body (id BIGSERIAL PRIMARY KEY, trace VARCHAR(256) NULL);
         CREATE TABLE studio_tasks_outbox_dead_letters (id BIGSERIAL PRIMARY KEY, payload BYTEA NOT NULL);
         CREATE TABLE studio_tasks_outbox_trace (id BIGSERIAL PRIMARY KEY, trace VARCHAR(256) NOT NULL);
         CREATE TABLE \"{journal}\" (version VARCHAR(255) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
         INSERT INTO \"{journal}\" (version) VALUES ('m001_create_toolkit_outbox_schema');"
    ))
    .await
    .unwrap();

    let r = repair(&c).await.unwrap();
    assert_eq!(
        r.columns_added,
        vec!["studio_tasks_outbox_dead_letters".to_string()]
    );
    assert_eq!(r.migrations_reset, 0);
    assert!(has_column(&c, "studio_tasks_outbox_dead_letters", "trace").await);
}

#[tokio::test]
async fn a_current_outbox_is_left_alone() {
    let c = connect("outbox_repair_current").await;
    let journal = "toolkit_migrations__studio_tasks__0123abcd";
    c.batch_execute(&format!(
        "CREATE TABLE studio_tasks_outbox_body (id BIGSERIAL PRIMARY KEY, trace VARCHAR(256) NULL);
         CREATE TABLE studio_tasks_outbox_dead_letters (id BIGSERIAL PRIMARY KEY, trace VARCHAR(256) NULL);
         CREATE TABLE studio_tasks_outbox_trace (id BIGSERIAL PRIMARY KEY, trace VARCHAR(256) NOT NULL);
         CREATE TABLE \"{journal}\" (version VARCHAR(255) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
         INSERT INTO \"{journal}\" (version) VALUES ('m001_create_toolkit_outbox_schema');"
    ))
    .await
    .unwrap();

    assert!(repair(&c).await.unwrap().is_empty());
    assert_eq!(
        versions(&c, journal).await,
        vec!["m001_create_toolkit_outbox_schema"]
    );
}

#[tokio::test]
async fn a_database_without_an_outbox_is_left_alone() {
    let c = connect("outbox_repair_none").await;
    c.batch_execute("CREATE TABLE unrelated (id INT); CREATE TABLE my_outbox_bodyguard (id INT);")
        .await
        .unwrap();
    assert!(repair(&c).await.unwrap().is_empty());
}
