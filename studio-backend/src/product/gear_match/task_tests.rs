//! The `product.gear_match` run against PostgreSQL ([`crate::test_pg`]) and a
//! fake gears-matcher: it submits once, follows the run, keeps the report and
//! says how it ended; a cancel through the match stops the matcher's run.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::sync::OnceCell;
use toolkit_db::migration_runner::run_migrations_for_testing;
use toolkit_db::sea_orm_migration::MigratorTrait;
use toolkit_db::{ConnectOpts, DBProvider, connect_db};
use uuid::Uuid;

use super::super::GearMatches;
use super::super::client::{Matcher, MatcherError, Result};
use super::super::config::MatcherConfig;
use super::super::store::{self, Match, MatchStore};
use super::{GearMatchTask, Payload};
use crate::product::migrations::Migrator;
use crate::tasks::sdk::{TaskContext, TaskHandler, TaskOutcome};

static DSN: OnceCell<String> = OnceCell::const_new();

async fn store() -> Arc<MatchStore> {
    let dsn = DSN
        .get_or_init(|| async {
            let dsn = crate::test_pg::fresh_database("product_gear_match").await;
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
    Arc::new(MatchStore::new(DBProvider::<anyhow::Error>::new(conn).db()))
}

/// A matcher that answers `states` one poll at a time, then the last for ever.
struct Fake {
    states: Mutex<Vec<&'static str>>,
    submits: Mutex<Vec<String>>,
    cancels: Mutex<Vec<String>>,
    refuse_submit: Option<MatcherError>,
}

impl Fake {
    fn new(states: Vec<&'static str>) -> Self {
        Self {
            states: Mutex::new(states),
            submits: Mutex::new(Vec::new()),
            cancels: Mutex::new(Vec::new()),
            refuse_submit: None,
        }
    }
}

#[async_trait]
impl Matcher for Fake {
    fn missing(&self) -> Option<String> {
        None
    }
    async fn info(&self) -> Result<Value> {
        Ok(json!({"limits": {}}))
    }
    async fn submit(&self, key: &str, _body: &Value) -> Result<Value> {
        if let Some(e) = &self.refuse_submit {
            return Err(e.clone());
        }
        self.submits.lock().unwrap().push(key.to_owned());
        Ok(json!({"id": "run-1", "state": "queued"}))
    }
    async fn run(&self, id: &str) -> Result<Value> {
        let mut s = self.states.lock().unwrap();
        let state = if s.len() > 1 { s.remove(0) } else { s[0] };
        Ok(json!({
            "id": id, "state": state,
            "progress": {"requirements_done": 1, "requirements_total": 2},
            "usage": {"calls": 3, "cache_hits": 0},
            "error": {"kind": "input", "message": "no requirement was found"}
        }))
    }
    async fn report(&self, _id: &str) -> Result<Value> {
        Ok(json!({
            "schema_version": "1.2.0",
            "requirements": [
                {"requirement_id": "cpt-a-fr-one", "kind": "fr", "coverage": "covered", "gears": []},
                {"requirement_id": "cpt-a-fr-two", "kind": "fr", "coverage": "gap", "gears": []}
            ],
            "totals": {"requirements": 2,
                "fr": {"covered": 1, "partial": 0, "gap": 1, "clarification_needed": 0, "not_assessed": 0},
                "nfr": {}}
        }))
    }
    async fn cancel(&self, id: &str) -> Result<Value> {
        self.cancels.lock().unwrap().push(id.to_owned());
        Ok(json!({"id": id, "state": "cancelling"}))
    }
}

fn ctx_in(tenant: Uuid, payload: Value) -> TaskContext {
    let security = toolkit_security::SecurityContext::builder()
        .subject_id(Uuid::from_u128(9))
        .subject_tenant_id(tenant)
        .build()
        .unwrap();
    TaskContext::for_tests(payload, security)
}

async fn queued(store: &MatchStore) -> (Uuid, Uuid, Uuid) {
    let (org, project, id) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    store
        .insert(Match {
            tenant_id: org,
            project_id: project,
            id,
            run_id: None,
            state: store::QUEUED.into(),
            requested_by: "person-1".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
            finished_at_ms: None,
            idempotency_key: format!("studio-{id}"),
            product: "todo-app".into(),
            documents: "[]".into(),
            request: json!({"product": "todo-app", "documents": []}).to_string(),
            matcher_run_id: None,
            info: None,
            progress: None,
            report: None,
            totals: None,
            usage: None,
            error: None,
            cancel_requested: false,
        })
        .await
        .unwrap();
    (org, project, id)
}

fn task(store: Arc<MatchStore>, fake: Arc<Fake>) -> GearMatchTask {
    GearMatchTask::new(Arc::new(GearMatches::new(
        MatcherConfig::default(),
        fake,
        Some(store),
        Arc::new(toolkit::client_hub::ClientHub::new()),
    )))
}

#[tokio::test]
async fn a_run_submits_once_follows_it_and_keeps_the_report() {
    let store = store().await;
    let (org, project, id) = queued(&store).await;
    let fake = Arc::new(Fake::new(vec!["queued", "running", "succeeded"]));
    let handler = task(Arc::clone(&store), Arc::clone(&fake));
    let payload = json!(Payload {
        match_id: id,
        project_id: project
    });

    let outcome = handler.run(&ctx_in(org, payload.clone())).await;
    let TaskOutcome::Done { summary, result } = outcome else {
        panic!("the run finishes: {outcome:?}");
    };
    assert_eq!(
        summary.as_deref(),
        Some("2 requirements: 1 covered, 0 partial, 1 gap, 0 to clarify, 0 not assessed")
    );
    assert_eq!(result.unwrap()["matcher_run_id"], "run-1");
    assert_eq!(*fake.submits.lock().unwrap(), vec![format!("studio-{id}")]);

    let row = store.get(org, project, id).await.unwrap().unwrap();
    assert_eq!(row.state, store::SUCCEEDED);
    assert_eq!(row.matcher_run_id.as_deref(), Some("run-1"));
    assert!(row.report.unwrap().contains("cpt-a-fr-two"));
    assert!(row.totals.unwrap().contains("\"gap\":1"));
    assert!(row.finished_at_ms.is_some());

    // A second delivery of the same run changes nothing and pays nothing.
    let again = handler.run(&ctx_in(org, payload)).await;
    assert!(matches!(again, TaskOutcome::Done { .. }));
    assert_eq!(fake.submits.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_failed_matcher_run_fails_the_match_with_its_reason() {
    let store = store().await;
    let (org, project, id) = queued(&store).await;
    let fake = Arc::new(Fake::new(vec!["failed"]));
    let outcome = task(Arc::clone(&store), fake)
        .run(&ctx_in(
            org,
            json!(Payload {
                match_id: id,
                project_id: project
            }),
        ))
        .await;
    assert!(
        matches!(&outcome, TaskOutcome::Failed(why) if why.contains("no requirement was found"))
    );
    let row = store.get(org, project, id).await.unwrap().unwrap();
    assert_eq!(row.state, store::FAILED);
}

#[tokio::test]
async fn a_refused_submit_is_the_matches_failure_and_a_busy_one_a_retry() {
    let store = store().await;
    let (org, project, id) = queued(&store).await;
    let mut fake = Fake::new(vec!["queued"]);
    fake.refuse_submit = Some(MatcherError::Upstream {
        status: 422,
        code: Some("not_a_template".into()),
        detail: "the documents are not in the spec format".into(),
    });
    let outcome = task(Arc::clone(&store), Arc::new(fake))
        .run(&ctx_in(
            org,
            json!(Payload {
                match_id: id,
                project_id: project
            }),
        ))
        .await;
    assert!(matches!(&outcome, TaskOutcome::Failed(why) if why.contains("not_a_template")));
    assert_eq!(
        store.get(org, project, id).await.unwrap().unwrap().state,
        store::FAILED
    );

    let (org, project, id) = queued(&store).await;
    let mut busy = Fake::new(vec!["queued"]);
    busy.refuse_submit = Some(MatcherError::Upstream {
        status: 429,
        code: Some("busy".into()),
        detail: "too many runs".into(),
    });
    let outcome = task(Arc::clone(&store), Arc::new(busy))
        .run(&ctx_in(
            org,
            json!(Payload {
                match_id: id,
                project_id: project
            }),
        ))
        .await;
    assert!(matches!(outcome, TaskOutcome::Retry(_)));
    assert_eq!(
        store.get(org, project, id).await.unwrap().unwrap().state,
        store::QUEUED
    );
}

#[tokio::test]
async fn a_cancel_through_the_match_stops_the_matchers_run_and_a_shutdown_does_not() {
    let store = store().await;
    let fake = Arc::new(Fake::new(vec!["running"]));

    // A shutdown: the token is cancelled, the match never asked to stop.
    let (org, project, id) = queued(&store).await;
    let ctx = ctx_in(
        org,
        json!(Payload {
            match_id: id,
            project_id: project
        }),
    );
    ctx.cancel.cancel();
    let outcome = task(Arc::clone(&store), Arc::clone(&fake)).run(&ctx).await;
    assert!(matches!(outcome, TaskOutcome::Retry(_)), "{outcome:?}");
    assert!(fake.cancels.lock().unwrap().is_empty());

    // The match's own cancel.
    store
        .update(
            org,
            project,
            id,
            store::Change {
                cancel_requested: Some(true),
                state: Some(store::CANCELLING),
                ..store::Change::default()
            },
        )
        .await
        .unwrap();
    let ctx = ctx_in(
        org,
        json!(Payload {
            match_id: id,
            project_id: project
        }),
    );
    ctx.cancel.cancel();
    let outcome = task(Arc::clone(&store), Arc::clone(&fake)).run(&ctx).await;
    assert!(matches!(outcome, TaskOutcome::Failed(_)), "{outcome:?}");
    assert_eq!(*fake.cancels.lock().unwrap(), vec!["run-1".to_owned()]);
    assert_eq!(
        store.get(org, project, id).await.unwrap().unwrap().state,
        store::CANCELLED
    );
}

#[tokio::test]
async fn notes_are_kept_one_per_subject_and_replaced() {
    let store = store().await;
    let (org, project) = (Uuid::new_v4(), Uuid::new_v4());
    let note = |value: &str| store::Note {
        tenant_id: org,
        project_id: project,
        kind: store::NOTE_DECISION.into(),
        subject: "cpt-a-fr-one".into(),
        gear_id: "gears-rust/event-broker".into(),
        value: value.into(),
        author: "person-1".into(),
        updated_at_ms: 1,
        match_id: None,
    };
    store.put_note(note("accepted")).await.unwrap();
    store.put_note(note("rejected")).await.unwrap();
    let kept = store
        .notes(org, project, store::NOTE_DECISION)
        .await
        .unwrap();
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].value, "rejected");
    assert!(
        store
            .notes(org, project, store::NOTE_ANSWER)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .delete_note(
                org,
                project,
                store::NOTE_DECISION,
                "cpt-a-fr-one",
                "gears-rust/event-broker"
            )
            .await
            .unwrap()
    );
    assert!(
        store
            .notes(org, project, store::NOTE_DECISION)
            .await
            .unwrap()
            .is_empty()
    );
}
