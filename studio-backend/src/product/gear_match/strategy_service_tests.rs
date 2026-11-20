//! An organization's own kit provides an assembly strategy run by a plug-in
//! service (ADR-0074, amendment), end to end: the kit's manifest declares
//! `acme_matcher` with `service: {contract: "gears-matcher/v1"}`; the strategy
//! is offered and chosen; a fake service speaking the contract over HTTP
//! (`/v1/info`, submit, run, report, cancel, a bearer) is the one the
//! organization connected; a match of that strategy runs through the
//! gear-match pipeline against PostgreSQL ([`crate::test_pg`]) and its
//! proposals are read back. Without a connection the strategy falls back with
//! `STRATEGY_NOT_CONNECTED`.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use axum::extract::Path;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{Value, json};
use tokio::sync::OnceCell;
use toolkit_db::migration_runner::run_migrations_for_testing;
use toolkit_db::sea_orm_migration::MigratorTrait;
use toolkit_db::{ConnectOpts, DBProvider, connect_db};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::client::{HttpMatcher, Matcher};
use super::config::MatcherConfig;
use super::services::{MatcherDirectory, NOT_CONNECTED};
use super::store::{self, Match, MatchStore};
use super::task::{GearMatchTask, Payload};
use super::{GearMatches, report};
use crate::product::assembly::{self, Available, Strategy};
use crate::product::migrations::Migrator;
use crate::tasks::sdk::{TaskContext, TaskHandler, TaskOutcome};

const SECRET: &str = "acme-shared-secret";

/// The organization's own kit, as its repository holds it.
const ACME_KIT: &str = r#"{
  "slug": "acme-matcher",
  "name": "Acme matcher",
  "levels": ["organization", "project"],
  "requires": ["gears-matcher"],
  "assembly_strategy": {
    "id": "acme_matcher",
    "name": "Acme matcher",
    "description": "Acme's own reading of the specifications.",
    "service": {"contract": "gears-matcher/v1"}
  }
}"#;

static DSN: OnceCell<String> = OnceCell::const_new();

async fn store() -> Arc<MatchStore> {
    let dsn = DSN
        .get_or_init(|| async {
            let dsn = crate::test_pg::fresh_database("product_gear_match_strategy").await;
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

/// What the fake service saw.
#[derive(Default)]
struct Seen {
    calls: Vec<String>,
    unauthorized: u32,
}

/// A service speaking `gears-matcher/v1` on a local port: one run that has
/// finished by the first poll, with one requirement covered by a gear.
async fn fake_service() -> (String, Arc<Mutex<Seen>>) {
    let seen = Arc::new(Mutex::new(Seen::default()));
    let authorized = |headers: &HeaderMap, seen: &Arc<Mutex<Seen>>| {
        let ok = headers.get("authorization").and_then(|v| v.to_str().ok())
            == Some(&format!("Bearer {SECRET}"));
        if !ok {
            seen.lock().unwrap().unauthorized += 1;
        }
        ok
    };
    let app = Router::new()
        .route(
            "/v1/info",
            get({
                let seen = Arc::clone(&seen);
                move |h: HeaderMap| async move {
                    if !authorized(&h, &seen) {
                        return Err(StatusCode::UNAUTHORIZED);
                    }
                    seen.lock().unwrap().calls.push("info".into());
                    Ok(Json(json!({
                        "service_version": "9.1.0",
                        "catalogue": {"source": "acme", "gear_gdl_commit": "abcdef0123"},
                        "limits": {"max_documents": 20}
                    })))
                }
            }),
        )
        .route(
            "/v1/runs",
            post({
                let seen = Arc::clone(&seen);
                move |h: HeaderMap, Json(body): Json<Value>| async move {
                    if !authorized(&h, &seen) {
                        return Err(StatusCode::UNAUTHORIZED);
                    }
                    let key = h
                        .get("idempotency-key")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or_default()
                        .to_owned();
                    let docs = body["documents"].as_array().map_or(0, Vec::len);
                    seen.lock()
                        .unwrap()
                        .calls
                        .push(format!("submit {key} {docs}"));
                    Ok((
                        StatusCode::ACCEPTED,
                        Json(json!({"id": "acme-run-1", "state": "queued"})),
                    ))
                }
            }),
        )
        .route(
            "/v1/runs/{id}",
            get({
                let seen = Arc::clone(&seen);
                move |h: HeaderMap, Path(id): Path<String>| async move {
                    if !authorized(&h, &seen) {
                        return Err(StatusCode::UNAUTHORIZED);
                    }
                    seen.lock().unwrap().calls.push(format!("run {id}"));
                    Ok(Json(json!({
                        "id": id, "state": "succeeded",
                        "progress": {"requirements_done": 1, "requirements_total": 1},
                        "usage": {"calls": 4, "cache_hits": 1, "input_tokens": 900, "output_tokens": 80}
                    })))
                }
            }),
        )
        .route(
            "/v1/runs/{id}/report",
            get({
                let seen = Arc::clone(&seen);
                move |h: HeaderMap, Path(id): Path<String>| async move {
                    if !authorized(&h, &seen) {
                        return Err(StatusCode::UNAUTHORIZED);
                    }
                    seen.lock().unwrap().calls.push(format!("report {id}"));
                    Ok(Json(json!({
                        "schema_version": "1.2.0",
                        "provenance": {"gear_gdl_commit": "abcdef0123"},
                        "recommended_gears": [
                            {"gear_id": "acme-gears/acme-auth", "name": "Acme Auth", "confidence": 0.9,
                             "in_code": true, "requirement_ids": ["cpt-shop-fr-sign-in"]}
                        ],
                        "requirements": [
                            {"requirement_id": "cpt-shop-fr-sign-in", "kind": "fr", "coverage": "covered",
                             "confidence": 0.9, "reason": "", "gears": [
                                {"gear_id": "acme-gears/acme-auth", "verdict": "covered", "confidence": 0.9,
                                 "evidence": "signs people in", "covers": "sign-in", "missing": "",
                                 "rationale": "", "role": "chosen"}]}
                        ],
                        "totals": {"requirements": 1,
                            "fr": {"covered": 1, "partial": 0, "gap": 0, "clarification_needed": 0, "not_assessed": 0},
                            "nfr": {}}
                    })))
                }
            }),
        )
        .route(
            "/v1/runs/{id}/cancel",
            post(|Path(id): Path<String>| async move {
                Json(json!({"id": id, "state": "cancelling"}))
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{addr}"), seen)
}

/// The organization's connections, as a test gives them: strategy → the
/// service's address and secret.
struct Connected(BTreeMap<String, (String, String)>);

#[async_trait]
impl MatcherDirectory for Connected {
    async fn connected(
        &self,
        _ctx: &SecurityContext,
        _org: Uuid,
        strategy: &str,
    ) -> Result<Option<Arc<dyn Matcher>>, String> {
        Ok(self.0.get(strategy).map(|(url, secret)| {
            Arc::new(HttpMatcher::connected(url, secret.clone(), 10)) as Arc<dyn Matcher>
        }))
    }
}

/// No gears-matcher in this deployment: only connected services run.
fn unconfigured() -> MatcherConfig {
    MatcherConfig {
        base_url_env: "STUDIO_TEST_GM_STRATEGY_URL_NONE".into(),
        secret_env: "STUDIO_TEST_GM_STRATEGY_SECRET_NONE".into(),
        ..MatcherConfig::default()
    }
}

fn matches(store: Arc<MatchStore>, connected: Connected) -> Arc<GearMatches> {
    let config = unconfigured();
    let matcher = Arc::new(HttpMatcher::from_config(&config));
    Arc::new(
        GearMatches::new(
            config,
            matcher,
            Some(store),
            Arc::new(toolkit::client_hub::ClientHub::new()),
        )
        .with_directory(Arc::new(connected)),
    )
}

fn ctx(org: Uuid) -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(9))
        .subject_tenant_id(org)
        .build()
        .unwrap()
}

/// A match of `strategy` as `start` keeps it, its documents prepared.
fn queued(org: Uuid, project: Uuid, strategy: &str) -> Match {
    let id = Uuid::new_v4();
    Match {
        tenant_id: org,
        project_id: project,
        id,
        run_id: None,
        state: store::QUEUED.into(),
        requested_by: "person-1".into(),
        created_at_ms: store::now_ms(),
        updated_at_ms: store::now_ms(),
        finished_at_ms: None,
        idempotency_key: format!("studio-{id}"),
        product: "shop".into(),
        documents: "[]".into(),
        request: json!({"product": "shop", "documents": [
            {"path": "prd.md", "sha256": "x", "content": "#### Sign In\n`cpt-shop-fr-sign-in`"}
        ]})
        .to_string(),
        matcher_run_id: None,
        info: None,
        progress: None,
        report: None,
        totals: None,
        usage: None,
        error: None,
        cancel_requested: false,
        strategy: strategy.into(),
    }
}

#[tokio::test]
async fn an_organization_kit_s_service_strategy_runs_a_match_and_proposes_gears() {
    // 1. The kit, read and checked as the shelf reads it.
    let provided = crate::kit_registry::port::strategy_of_kit_json(ACME_KIT)
        .unwrap()
        .expect("the kit provides a strategy");
    assert_eq!(provided.id, "acme_matcher");
    assert_eq!(provided.service.as_deref(), Some("gears-matcher/v1"));
    let gm = crate::kit_registry::port::assembly_strategies(&["gears-matcher".into()]);

    // 2. Offered where the kit applies, and the organization's default.
    let mut available = Available {
        kits: Some(assembly::offers(&[gm[0].clone(), provided.clone()])),
        services: BTreeMap::new(),
    };
    let acme = Strategy::parse("acme_matcher").unwrap();
    assert!(available.installed("acme_matcher").unwrap());
    let e = assembly::resolve(None, Some(acme.clone()), available.clone());
    assert_eq!(e.strategy.as_ref(), Some(&acme));

    // 3. Not connected yet: the strategy falls back, and says why.
    let org = Uuid::new_v4();
    let project = Uuid::new_v4();
    let store = store().await;
    let bare = matches(Arc::clone(&store), Connected(BTreeMap::new()));
    let why = bare
        .service_refusal(&ctx(org), org, "acme_matcher")
        .await
        .expect("no service is connected");
    assert_eq!(why.0, NOT_CONNECTED);
    available.services.insert("acme_matcher".into(), why);
    let shipped = super::services::SHIPPED_STRATEGY;
    let refusal = bare
        .service_refusal(&ctx(org), org, shipped)
        .await
        .expect("the shipped matcher is not configured");
    available.services.insert(shipped.into(), refusal);
    let e = assembly::resolve(None, Some(acme.clone()), available);
    assert_eq!(
        e.fallback.as_ref().map(|f| f.0),
        Some("STRATEGY_NOT_CONNECTED")
    );
    assert_eq!(
        e.strategy, None,
        "the shipped matcher is not configured either"
    );

    // 4. Connected: the fake service answers the contract.
    let (url, seen) = fake_service().await;
    let connected = matches(
        Arc::clone(&store),
        Connected(BTreeMap::from([(
            "acme_matcher".to_owned(),
            (url, SECRET.to_owned()),
        )])),
    );
    assert_eq!(
        connected
            .service_refusal(&ctx(org), org, "acme_matcher")
            .await,
        None
    );
    let live = connected
        .live_info(&ctx(org), org, "acme_matcher")
        .await
        .expect("asked");
    assert_eq!(live.answer.unwrap()["service_version"], "9.1.0");

    // 5. A match of the strategy runs through the gear-match pipeline.
    let row = queued(org, project, "acme_matcher");
    let id = row.id;
    store.insert(row.clone()).await.unwrap();
    let task = GearMatchTask::new(Arc::clone(&connected));
    let outcome = task
        .run(&TaskContext::for_tests(
            json!(Payload {
                match_id: id,
                project_id: project
            }),
            ctx(org),
        ))
        .await;
    assert!(matches!(outcome, TaskOutcome::Done { .. }), "{outcome:?}");
    let calls = seen.lock().unwrap().calls.clone();
    assert_eq!(
        calls,
        vec![
            "info".to_owned(),
            format!("submit studio-{id} 1"),
            "run acme-run-1".to_owned(),
            "report acme-run-1".to_owned(),
        ]
    );
    assert_eq!(
        seen.lock().unwrap().unauthorized,
        0,
        "every call carried the bearer"
    );

    // 6. Kept under its strategy, and its proposals read back.
    let kept = connected
        .latest(org, project, "acme_matcher")
        .await
        .unwrap()
        .expect("the match");
    assert_eq!(kept.id, id);
    assert_eq!(kept.state, store::SUCCEEDED);
    assert_eq!(kept.strategy, "acme_matcher");
    assert!(
        connected
            .latest(org, project, "gears_matcher")
            .await
            .unwrap()
            .is_none(),
        "another strategy's history is apart"
    );
    let report: Value = serde_json::from_str(kept.report.as_deref().unwrap()).unwrap();
    let reqs = report::requirements(&report, &[]);
    let proposed: Vec<&str> = reqs
        .iter()
        .flat_map(|r| r.candidates.iter())
        .filter(|c| c.proposed)
        .map(|c| c.pick.as_str())
        .collect();
    assert_eq!(proposed, ["acme-auth"]);
    let usage = store.usage(org, &[project], 0).await.unwrap();
    assert_eq!(usage[&project].strategies["acme_matcher"].usage.calls, 4);
}
