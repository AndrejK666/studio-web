//! The organization's use of the matcher, counted in PostgreSQL
//! ([`crate::test_pg`]): runs by state and model use in a period, each
//! project's last run, decisions, open questions and the median duration;
//! never another organization's rows, never a project not asked for.

use serde_json::json;
use tokio::sync::OnceCell;
use toolkit_db::migration_runner::run_migrations_for_testing;
use toolkit_db::sea_orm_migration::MigratorTrait;
use toolkit_db::{ConnectOpts, DBProvider, connect_db};
use uuid::Uuid;

use super::*;
use crate::product::gear_match::store::{Match, Note};
use crate::product::migrations::Migrator;

static DSN: OnceCell<String> = OnceCell::const_new();

async fn store() -> MatchStore {
    let dsn = DSN
        .get_or_init(|| async {
            let dsn = crate::test_pg::fresh_database("product_gear_match_usage").await;
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
    MatchStore::new(DBProvider::<anyhow::Error>::new(conn).db())
}

/// A report with one requirement to clarify and one question of its own.
fn report() -> String {
    json!({
        "schema_version": "1.2.0",
        "requirements": [
            {"requirement_id": "cpt-x-fr-a", "kind": "fr", "coverage": "clarification_needed",
             "reason": "unclear", "gears": []},
            {"requirement_id": "cpt-x-fr-b", "kind": "fr", "coverage": "covered", "gears": []}
        ],
        "clarifications": [
            {"topic": "Offline", "reason": "two documents disagree", "quote": "works offline", "path": "docs/PRD.md"}
        ]
    })
    .to_string()
}

#[allow(clippy::too_many_arguments)]
fn row(
    org: Uuid,
    project: Uuid,
    state: &str,
    created: i64,
    finished: Option<i64>,
    usage: Option<&str>,
    totals: Option<&str>,
    report: Option<String>,
) -> Match {
    let id = Uuid::new_v4();
    Match {
        tenant_id: org,
        project_id: project,
        id,
        run_id: None,
        state: state.into(),
        requested_by: "person".into(),
        created_at_ms: created,
        updated_at_ms: created,
        finished_at_ms: finished,
        idempotency_key: format!("studio-{id}"),
        product: "p".into(),
        documents: "[]".into(),
        request: "{}".into(),
        matcher_run_id: None,
        info: None,
        progress: None,
        report,
        totals: totals.map(str::to_owned),
        usage: usage.map(str::to_owned),
        error: None,
        cancel_requested: false,
        strategy: "gears_matcher".into(),
    }
}

fn note(org: Uuid, project: Uuid, kind: &str, subject: &str, gear: &str, value: &str) -> Note {
    Note {
        tenant_id: org,
        project_id: project,
        kind: kind.into(),
        subject: subject.into(),
        gear_id: gear.into(),
        value: value.into(),
        author: "a".into(),
        updated_at_ms: 1,
        match_id: None,
    }
}

const DAY: i64 = 86_400_000;

#[tokio::test]
async fn a_period_is_counted_per_project_from_the_gear_s_own_tables() {
    let store = store().await;
    let (org, a, b, quiet) = (
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    );
    let now = 100 * DAY;
    let since = now - 30 * DAY;
    let totals = r#"{"requirements":2,"covered":1,"partial":0,"gap":0,"clarification_needed":1,"not_assessed":0}"#;
    for m in [
        // Before the period: only its decision and report count.
        row(
            org,
            a,
            store::SUCCEEDED,
            since - DAY,
            Some(since - DAY + 60_000),
            Some(r#"{"calls":999,"input_tokens":999}"#),
            Some(totals),
            Some(report()),
        ),
        // In the period: a success of 10 minutes, a failure without usage,
        // one still running with `null` usage.
        row(
            org,
            a,
            store::SUCCEEDED,
            now - 2 * DAY,
            Some(now - 2 * DAY + 600_000),
            Some(r#"{"calls":127,"cache_hits":3,"input_tokens":651649,"output_tokens":51192}"#),
            Some(totals),
            Some(report()),
        ),
        row(
            org,
            a,
            store::FAILED,
            now - DAY,
            Some(now - DAY + 5_000),
            None,
            None,
            None,
        ),
        row(
            org,
            a,
            store::RUNNING,
            now - 1_000,
            None,
            Some("null"),
            None,
            None,
        ),
        // Another project: a partial of 2 minutes, and a cancelled one.
        row(
            org,
            b,
            store::PARTIAL,
            now - 3 * DAY,
            Some(now - 3 * DAY + 120_000),
            Some(r#"{"calls":5,"input_tokens":10,"output_tokens":2.0}"#),
            Some(totals),
            Some(report()),
        ),
        row(
            org,
            b,
            store::CANCELLED,
            now - 4 * DAY,
            Some(now - 4 * DAY + 1_000),
            None,
            None,
            None,
        ),
        // Another organization's row, in the same project ids: never counted.
        row(
            Uuid::new_v4(),
            a,
            store::SUCCEEDED,
            now - DAY,
            Some(now),
            Some(r#"{"calls":1000}"#),
            None,
            None,
        ),
    ] {
        store.insert(m).await.unwrap();
    }
    for n in [
        note(
            org,
            a,
            store::NOTE_DECISION,
            "cpt-x-fr-b",
            "gears-rust/x",
            "accepted",
        ),
        note(
            org,
            a,
            store::NOTE_DECISION,
            "cpt-x-fr-b",
            "gears-rust/y",
            "rejected",
        ),
        note(
            org,
            b,
            store::NOTE_DECISION,
            "cpt-x-fr-b",
            "gears-rust/x",
            "accepted",
        ),
        // `a` answered the requirement's question, not the report's own.
        note(
            org,
            a,
            store::NOTE_ANSWER,
            "cpt-x-fr-a",
            "",
            r#"{"text":"yes"}"#,
        ),
    ] {
        store.put_note(n).await.unwrap();
    }

    let usage = store.usage(org, &[a, b, quiet], since).await.unwrap();
    assert!(
        !usage.contains_key(&quiet),
        "a project without matches is absent"
    );

    let ua = &usage[&a];
    assert_eq!(ua.runs.get("succeeded"), Some(&1));
    assert_eq!(ua.runs.get("failed"), Some(&1));
    assert_eq!(ua.runs.get("running"), Some(&1));
    assert_eq!(ua.runs_total(), 3);
    assert_eq!(
        ua.usage,
        ModelUsage {
            calls: 127,
            cache_hits: 3,
            input_tokens: 651_649,
            output_tokens: 51_192
        }
    );
    let last = ua.last.as_ref().unwrap();
    assert_eq!(last.state, store::RUNNING);
    assert_eq!((ua.accepted, ua.rejected), (1, 1));
    // The last finished match asks two questions; one is answered.
    assert_eq!((ua.questions_open, ua.questions_answered), (1, 1));

    assert_eq!(ua.strategies["gears_matcher"].runs, 3);
    assert_eq!(ua.strategies["gears_matcher"].usage.calls, 127);
    let ub = &usage[&b];
    assert_eq!(ub.runs.get("partial"), Some(&1));
    assert_eq!(ub.runs.get("cancelled"), Some(&1));
    assert_eq!(ub.usage.calls, 5);
    assert_eq!(ub.usage.output_tokens, 2);
    assert_eq!(ub.last.as_ref().unwrap().state, store::PARTIAL);
    assert_eq!(
        ub.last
            .as_ref()
            .unwrap()
            .totals
            .as_ref()
            .map(|t| t.clarification_needed),
        Some(1)
    );
    assert_eq!((ub.questions_open, ub.questions_answered), (2, 0));
    assert_eq!((ub.accepted, ub.rejected), (1, 0));

    // A project not asked for is not read, even in the same organization.
    let only_b = store.usage(org, &[b], since).await.unwrap();
    assert_eq!(only_b.keys().copied().collect::<Vec<_>>(), vec![b]);

    // The median of the reports written in the period: 2 and 10 minutes.
    assert_eq!(
        store.median_run_ms(org, &[a, b], since).await.unwrap(),
        Some(360_000)
    );
    assert_eq!(
        store.median_run_ms(org, &[quiet], since).await.unwrap(),
        None
    );
    assert!(store.usage(org, &[], since).await.unwrap().is_empty());
}

#[test]
fn a_report_s_questions_are_the_match_view_s() {
    assert_eq!(question_ids(Some(&report())).len(), 2);
    assert!(question_ids(Some(&report())).contains(&"cpt-x-fr-a".to_owned()));
    assert!(question_ids(None).is_empty());
    assert!(question_ids(Some(r#"{"schema_version":"2.0.0"}"#)).is_empty());
    assert_eq!(counted_state(store::CANCELLING), "running");
    assert_eq!(counted_state(store::QUEUED), "running");
    assert_eq!(counted_state(store::PARTIAL), "partial");
}
