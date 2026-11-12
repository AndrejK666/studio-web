//! The clone status: what a row says, and the store against Postgres.

use serde_json::json;
use tokio::sync::OnceCell;
use toolkit_db::migration_runner::run_migrations_for_testing;
use toolkit_db::sea_orm_migration::MigratorTrait;
use toolkit_db::{ConnectOpts, DBProvider, connect_db};
use uuid::Uuid;

use super::super::migrations::Migrator;
use super::super::port::CloneOutcomes;
use super::*;

const API: &str = "https://github.com/acme/api.git";
const WEB: &str = "https://github.com/acme/web.git";

fn sources() -> Vec<crate::project_sources::ProjectSource> {
    crate::project_sources::parse(&json!({ "sources": [
        { "full_path": "acme/api", "clone_url": API },
        { "full_path": "acme/web", "clone_url": WEB },
    ]}))
}

#[test]
fn every_cause_names_the_action_that_fixes_it() {
    assert_eq!(
        CloneCause::ConnectionNotFound.action(),
        CloneAction::Reconnect
    );
    assert_eq!(CloneCause::ProviderRefused.action(), CloneAction::Reconnect);
    assert_eq!(CloneCause::NoConnection.action(), CloneAction::Connect);
    assert_eq!(CloneCause::HeldOutside.action(), CloneAction::AskAdmin);
    assert_eq!(
        CloneCause::RepositoryNotFound.action(),
        CloneAction::CheckRepository
    );
    assert_eq!(CloneCause::Unreachable.action(), CloneAction::Retry);
    for cause in CloneCause::ALL {
        assert_eq!(CloneCause::parse(cause.as_str()), Some(cause));
        assert!(!cause.text().is_empty());
        assert!(!cause.action().text().is_empty());
    }
    assert_eq!(CloneCause::parse("nonsense"), None);
}

#[test]
fn a_detail_keeps_no_credential() {
    assert_eq!(
        redact("fatal: could not read from https://oauth2:ghp_abc123@github.com/acme/api.git"),
        "fatal: could not read from ***"
    );
    assert_eq!(
        redact("remote https://user:secret@gitlab.example/acme/api.git refused"),
        "remote https://***@gitlab.example/acme/api.git refused"
    );
    assert_eq!(
        redact("Authorization: Bearer abc.def"),
        "Authorization: Bearer ***"
    );
    assert_eq!(redact("token glpat-xyz leaked"), "token *** leaked");
    assert_eq!(redact("the host answered 404"), "the host answered 404");
    let long = "x".repeat(DETAIL_MAX + 50);
    assert_eq!(redact(&long).chars().count(), DETAIL_MAX + 1);
}

#[test]
fn a_source_with_nothing_recorded_was_never_cloned() {
    let got = statuses(&sources(), &[]);
    assert_eq!(got.len(), 2);
    assert!(
        got.iter()
            .all(|s| s.state == "never" && s.at.is_none() && s.by.is_none())
    );
    assert_eq!(got[0].clone_url, API);
    assert_eq!(got[1].full_path, "acme/web");
}

#[test]
fn a_recorded_outcome_is_matched_to_its_source_by_repository() {
    let stored = [
        LastClone {
            repository: "github.com/acme/api".into(),
            at_ms: 1_700_000_000_000,
            channel: "desktop".into(),
            cause: None,
            upstream_status: None,
            detail: String::new(),
        },
        LastClone {
            repository: "github.com/acme/web".into(),
            at_ms: 1_700_000_100_000,
            channel: "ide_session".into(),
            cause: Some("connection_not_found".into()),
            upstream_status: None,
            detail: String::new(),
        },
    ];
    let got = statuses(&sources(), &stored);
    assert_eq!(got[0].state, "cloned");
    assert_eq!(got[0].by.as_deref(), Some("desktop"));
    assert_eq!(got[0].at.as_deref(), Some("2023-11-14T22:13:20Z"));
    assert_eq!(got[0].cause, None);
    assert_eq!(got[1].state, "failed");
    assert_eq!(got[1].by.as_deref(), Some("ide_session"));
    assert_eq!(got[1].cause.as_deref(), Some("connection_not_found"));
    assert_eq!(got[1].action.as_deref(), Some("reconnect"));
    assert!(
        got[1]
            .cause_text
            .as_deref()
            .is_some_and(|t| t.contains("not found"))
    );
    assert_eq!(got[1].detail, None);
}

/// A database of this suite's own, migrated once (`crate::test_pg`).
static MIGRATED: OnceCell<String> = OnceCell::const_new();

async fn store() -> CloneStatusStore {
    let dsn = MIGRATED
        .get_or_init(|| async {
            let dsn = crate::test_pg::fresh_database("clone_status").await;
            let conn = connect_db(&dsn, ConnectOpts::default())
                .await
                .unwrap_or_else(|e| panic!("connect to {dsn} failed: {e}"));
            run_migrations_for_testing(&conn, Migrator::migrations())
                .await
                .expect("run migrations");
            dsn
        })
        .await;
    let conn = connect_db(dsn, ConnectOpts::default())
        .await
        .expect("connect");
    CloneStatusStore::new(DBProvider::<anyhow::Error>::new(conn).db())
}

#[tokio::test]
async fn the_last_outcome_replaces_the_one_before() {
    let store = store().await;
    let project = Uuid::new_v4();
    store
        .record(
            project,
            "https://oauth2:secret@github.com/Acme/API.git",
            CloneOutcome::failed(
                CloneChannel::Desktop,
                CloneFailure::new(CloneCause::ProviderRefused)
                    .with_status(403)
                    .with_detail("refused https://oauth2:secret@github.com/acme/api"),
            ),
        )
        .await
        .expect("record");
    let rows = store.of_project(project).await.expect("read");
    assert_eq!(rows.len(), 1);
    // Keyed by host and path: no scheme, no credential, no case.
    assert_eq!(rows[0].repository, "github.com/acme/api");
    assert_eq!(rows[0].cause.as_deref(), Some("provider_refused"));
    assert_eq!(rows[0].upstream_status, Some(403));
    assert!(!rows[0].detail.contains("secret"), "{}", rows[0].detail);

    store
        .record(project, API, CloneOutcome::cloned(CloneChannel::Desktop))
        .await
        .expect("record");
    let rows = store.of_project(project).await.expect("read");
    assert_eq!(rows.len(), 1, "one row per source, not a history");
    assert_eq!(rows[0].cause, None);
    assert_eq!(rows[0].detail, "");
    let got = statuses(&sources(), &rows);
    assert_eq!(got[0].state, "cloned");
    assert_eq!(got[1].state, "never");

    // Another project sees none of it.
    assert!(
        store
            .of_project(Uuid::new_v4())
            .await
            .expect("read")
            .is_empty()
    );
}

#[tokio::test]
async fn a_session_launch_forgets_only_its_own_failure() {
    let store = store().await;
    let project = Uuid::new_v4();
    let session_failure = || {
        CloneOutcome::failed(
            CloneChannel::IdeSession,
            CloneFailure::new(CloneCause::ConnectionNotFound),
        )
    };
    store
        .record(project, API, session_failure())
        .await
        .expect("record");
    store
        .record(project, WEB, CloneOutcome::cloned(CloneChannel::Desktop))
        .await
        .expect("record");

    // A desktop's failure is not the session's to forget.
    store
        .clear_failure(project, API, CloneChannel::Desktop)
        .await
        .expect("clear");
    assert_eq!(store.of_project(project).await.expect("read").len(), 2);

    store
        .clear_failure(project, API, CloneChannel::IdeSession)
        .await
        .expect("clear");
    store
        .clear_failure(project, WEB, CloneChannel::IdeSession)
        .await
        .expect("clear");
    let rows = store.of_project(project).await.expect("read");
    assert_eq!(rows.len(), 1, "the desktop's clone stays: {rows:?}");
    assert_eq!(rows[0].repository, "github.com/acme/web");
}
