//! The store, against the engine the assembly actually runs.
//!
//! These are the tests the whole change exists for. The claim being made is
//! that two replicas publishing for one tenant cannot take the same sequence
//! number — and that claim is about PostgreSQL row locking, so proving it
//! anywhere else proves nothing. The server comes from
//! [`crate::test_pg`]; `cargo test` needs a Docker daemon and nothing else.

use std::sync::Arc;

use serde_json::json;
use tokio::sync::OnceCell;
use toolkit_db::migration_runner::run_migrations_for_testing;
use toolkit_db::sea_orm_migration::MigratorTrait;
use toolkit_db::{ConnectOpts, DBProvider, connect_db};
use uuid::Uuid;

use super::migrations::Migrator;
use super::store::{EventStore, PendingEvent};

/// The migrations, run once against the shared database. A `OnceCell` so no
/// two test threads race to create the same tables.
static MIGRATED: OnceCell<&'static str> = OnceCell::const_new();

async fn dsn() -> &'static str {
    MIGRATED
        .get_or_init(|| async {
            let dsn = crate::test_pg::shared_dsn().await;
            let conn = connect_db(dsn, ConnectOpts::default())
                .await
                .unwrap_or_else(|e| panic!("connect to {dsn} failed: {e}"));
            run_migrations_for_testing(&conn, Migrator::migrations())
                .await
                .expect("run migrations");
            dsn
        })
        .await
}

/// A store with a pool big enough to let concurrent appends actually be
/// concurrent — with one connection they would serialize in the pool and the
/// test would prove nothing about the database.
async fn store() -> Arc<EventStore> {
    let conn = connect_db(
        dsn().await,
        ConnectOpts {
            max_conns: Some(8),
            min_conns: Some(2),
            ..Default::default()
        },
    )
    .await
    .expect("connect");
    Arc::new(EventStore::new(DBProvider::<anyhow::Error>::new(conn).db()))
}

/// A tenant id no other test uses: the suite shares one database and keeps
/// itself apart by tenant, which is also the boundary under test.
fn tenant() -> Uuid {
    Uuid::new_v4()
}

fn event(tenant_id: Uuid, kind: &str) -> PendingEvent {
    PendingEvent {
        tenant_id,
        at_ms: 1_700_000_000_000,
        kind: kind.to_owned(),
        subject_type: "task".to_owned(),
        subject_id: "run-1".to_owned(),
        source: "test".to_owned(),
        payload: json!({ "ok": true }),
    }
}

#[tokio::test]
async fn a_tenants_sequence_starts_at_one_and_is_dense() {
    let store = store().await;
    let tenant = tenant();

    for expected in 1..=3 {
        let seq = store.append(&event(tenant, "task.running")).await.unwrap();
        assert_eq!(seq, expected);
    }
    assert_eq!(store.latest_seq(tenant).await.unwrap(), 3);
}

/// THE POINT OF THE WHOLE CHANGE.
///
/// Eight publishers going at one tenant at once — which is what two replicas
/// under load are — must leave with eight distinct numbers. The in-process
/// counter this replaced could not promise that across processes at all: each
/// replica handed out 1, 2, 3 of its own.
#[tokio::test]
async fn concurrent_publishers_never_take_the_same_number() {
    let store = store().await;
    let tenant = tenant();

    let mut handles = Vec::new();
    for i in 0..8 {
        let store = store.clone();
        handles.push(tokio::spawn(async move {
            store
                .append(&event(tenant, &format!("task.progress.{i}")))
                .await
                .unwrap()
        }));
    }

    let mut seqs = Vec::new();
    for handle in handles {
        seqs.push(handle.await.unwrap());
    }
    seqs.sort_unstable();

    assert_eq!(
        seqs,
        (1..=8).collect::<Vec<i64>>(),
        "eight concurrent appends must take 1..=8, each exactly once"
    );
    assert_eq!(store.latest_seq(tenant).await.unwrap(), 8);
}

#[tokio::test]
async fn replay_returns_only_what_is_newer_than_the_cursor() {
    let store = store().await;
    let tenant = tenant();
    for kind in ["task.queued", "task.running", "task.succeeded"] {
        store.append(&event(tenant, kind)).await.unwrap();
    }

    let (all, latest) = store.after(tenant, 0, 10).await.unwrap();
    assert_eq!(latest, 3);
    assert_eq!(
        all.iter().map(|e| e.seq).collect::<Vec<_>>(),
        vec![1, 2, 3],
        "oldest first, so a client can apply them in order"
    );
    assert_eq!(all[2].kind, "task.succeeded");
    assert_eq!(all[0].payload, json!({ "ok": true }), "payload is verbatim");

    let (tail, _) = store.after(tenant, 2, 10).await.unwrap();
    assert_eq!(tail.len(), 1);
    assert_eq!(tail[0].kind, "task.succeeded");
}

/// The tenant boundary, which is the channel's only visibility rule — and the
/// reason the sequence is per tenant rather than global: `b` must not be able
/// to infer how much `a` published.
#[tokio::test]
async fn one_tenant_cannot_see_or_count_anothers_events() {
    let store = store().await;
    let (a, b) = (tenant(), tenant());
    store.append(&event(a, "task.queued")).await.unwrap();
    store.append(&event(a, "task.succeeded")).await.unwrap();

    let (theirs, latest) = store.after(b, 0, 10).await.unwrap();
    assert!(theirs.is_empty(), "b sees nothing a published");
    assert_eq!(latest, 0, "and cannot infer a's volume from the cursor");

    store.append(&event(b, "task.queued")).await.unwrap();
    let (theirs, latest) = store.after(b, 0, 10).await.unwrap();
    assert_eq!(theirs.len(), 1);
    assert_eq!(latest, 1, "b's own sequence starts at 1, not after a's");
}

/// Pruning bounds the window and leaves the mark alone. That gap is the
/// signal: a client whose cursor is older than the window sees `latest_seq`
/// run past the last event it received and knows it lost some.
#[tokio::test]
async fn pruning_bounds_the_window_without_moving_the_mark() {
    let store = store().await;
    let tenant = tenant();
    for _ in 0..10 {
        store.append(&event(tenant, "task.progress")).await.unwrap();
    }

    let removed = store.prune(tenant, 3).await.unwrap();
    assert_eq!(removed, 7);

    let (retained, latest) = store.after(tenant, 0, 100).await.unwrap();
    assert_eq!(retained.len(), 3, "only the window is kept");
    assert_eq!(
        retained.first().map(|e| e.seq),
        Some(8),
        "and it is the newest end of it"
    );
    assert_eq!(latest, 10, "the mark still counts what was pruned");

    // Idempotent: a second replica pruning the same tenant removes nothing.
    assert_eq!(store.prune(tenant, 3).await.unwrap(), 0);
}

/// A window shorter than the tenant's history is the normal case; one longer
/// than it must not delete anything or wrap around a negative floor.
#[tokio::test]
async fn pruning_a_short_history_removes_nothing() {
    let store = store().await;
    let tenant = tenant();
    store.append(&event(tenant, "task.queued")).await.unwrap();

    assert_eq!(store.prune(tenant, 500).await.unwrap(), 0);
    let (retained, _) = store.after(tenant, 0, 100).await.unwrap();
    assert_eq!(retained.len(), 1);
}
