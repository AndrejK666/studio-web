//! The one shared `KIT_NOT_INSTALLED` (ADR-0071 §4): a claimed write route
//! and a claimed MCP tool answer it without their kit, reads still answer,
//! and an opted-in sync skips without the kit and resumes after an install.

#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

use async_trait::async_trait;
use axum::Router;
use axum::http::StatusCode;
use axum::routing::{get, put};
use serde_json::json;

use super::super::manifest::read_kit_json;
use super::*;

const ORG: Uuid = Uuid::from_u128(0x0a);
const PROJECT: Uuid = Uuid::from_u128(0x0b);
const ELSEWHERE: Uuid = Uuid::from_u128(0x0c);

fn caller() -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(1))
        .subject_tenant_id(ORG)
        .token_scopes(vec!["*".to_string()])
        .build()
        .unwrap()
}

/// The kits that apply, per tenant; `broken` answers an error.
#[derive(Default)]
struct Kits {
    applies: Mutex<BTreeMap<Uuid, BTreeSet<String>>>,
    broken: bool,
}

impl Kits {
    fn with(self, tenant: Uuid, kit: &str) -> Self {
        self.install(tenant, kit);
        self
    }
    fn install(&self, tenant: Uuid, kit: &str) {
        self.applies
            .lock()
            .unwrap()
            .entry(tenant)
            .or_default()
            .insert(kit.to_owned());
    }
}

#[async_trait]
impl KitPresence for Kits {
    async fn applies(&self, _: &SecurityContext, tenant: Uuid, kit: &str) -> anyhow::Result<bool> {
        anyhow::ensure!(!self.broken, "the kits could not be read");
        Ok(self
            .applies
            .lock()
            .unwrap()
            .get(&tenant)
            .is_some_and(|k| k.contains(kit)))
    }
    async fn effective(&self, _: &SecurityContext, tenant: Uuid) -> anyhow::Result<Vec<String>> {
        Ok(self
            .applies
            .lock()
            .unwrap()
            .get(&tenant)
            .map(|k| k.iter().cloned().collect())
            .unwrap_or_default())
    }
}

/// Who reaches which tenant.
struct Reach(Vec<Uuid>);

#[async_trait]
impl WorkspaceAccess for Reach {
    async fn may_reach(&self, _: &SecurityContext, id: Uuid) -> bool {
        self.0.contains(&id)
    }
}

#[test]
fn the_refusal_names_the_kit_for_a_screen_and_for_an_agent() {
    let refusal = KitRefusal::NotInstalled {
        kit: "org-costs".into(),
    };
    assert!(refusal.detail().contains("the Costs kit (`org-costs`)"));
    assert!(
        refusal
            .tool_text()
            .starts_with("KIT_NOT_INSTALLED (kit org-costs): ")
    );
    let response = refusal.problem().into_response();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let unavailable = KitRefusal::Unavailable("down".into())
        .problem()
        .into_response();
    assert_eq!(unavailable.status(), StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn a_claimed_call_is_checked_where_it_acts() {
    let kits = Kits::default().with(ORG, "org-costs");
    let reach = Reach(vec![PROJECT]);
    let check = |named: Named, kit: &'static str| {
        let (kits, reach) = (&kits, &reach);
        async move { claimed_call(Some(kits), Some(reach), &caller(), kit, &named).await }
    };
    // The caller's own organization.
    assert_eq!(check(Named::default(), "org-costs").await, Ok(()));
    assert_eq!(
        check(Named::default(), "delivery").await,
        Err(KitRefusal::NotInstalled {
            kit: "delivery".into()
        })
    );
    // A project the call names, and the caller reaches: its kits decide.
    let in_project = Named {
        project: Some(PROJECT),
        organization: Some(ORG),
        ..Named::default()
    };
    assert!(check(in_project.clone(), "org-costs").await.is_err());
    kits.install(PROJECT, "org-costs");
    assert_eq!(check(in_project, "org-costs").await, Ok(()));
    // A tenant the caller cannot reach is the handler's to answer.
    let elsewhere = Named {
        project: Some(ELSEWHERE),
        ..Named::default()
    };
    assert_eq!(check(elsewhere, "delivery").await, Ok(()));
    // No studio-kits in the assembly: nothing to install, nothing held back.
    assert_eq!(
        claimed_call(None, None, &caller(), "anything", &Named::default()).await,
        Ok(())
    );
    // The kits unreadable: 503, not a guess.
    let broken = Kits {
        broken: true,
        ..Kits::default()
    };
    assert!(matches!(
        claimed_call(
            Some(&broken),
            None,
            &caller(),
            "org-costs",
            &Named::default()
        )
        .await,
        Err(KitRefusal::Unavailable(_))
    ));
}

#[test]
fn a_call_names_its_tenant_by_project_workspace_or_organization() {
    let mut named = Named::default();
    named.take_object(
        json!({"organization_id": ORG.to_string(), "project_id": PROJECT.to_string(),
               "name": "x", "workspace_id": "not-a-uuid"})
        .as_object()
        .unwrap(),
    );
    assert_eq!(named.most_specific(), Some(PROJECT));
    named.project = None;
    assert_eq!(named.most_specific(), Some(ORG));
    let mut by_path = Named::default();
    by_path.take("org_id", &ELSEWHERE.to_string());
    assert_eq!(by_path.most_specific(), Some(ELSEWHERE));
    assert!(Named::default().is_empty());
}

/// A claimed write (`PUT /studio-usage/v1/budgets`, org-costs'), its read,
/// and another gear's claimed write, behind studio-usage's layer, with the
/// caller signed in as the gateway would.
async fn serve(kits: Arc<Kits>) -> String {
    let hub = Arc::new(ClientHub::new());
    hub.register::<dyn KitPresence>(kits as Arc<dyn KitPresence>);
    let app = Router::new()
        .route(
            "/studio-usage/v1/budgets",
            put(|| async { "written" }).get(|| async { "read" }),
        )
        .route(
            "/studio-environments/v1/open-clusters",
            put(|| async { "not usage's" }),
        )
        .route("/studio-usage/v1/costs", get(|| async { "costs" }));
    let app = with_claimed_routes(app, hub, "studio-usage").layer(axum::Extension(caller()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    origin
}

#[tokio::test]
async fn a_claimed_write_route_answers_kit_not_installed_and_reads_still_answer() {
    let kits = Arc::new(Kits::default());
    let origin = serve(Arc::clone(&kits)).await;
    let http = reqwest::Client::new();
    let refused = http
        .put(format!("{origin}/studio-usage/v1/budgets"))
        .json(&json!({"budgets": []}))
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), 400);
    let body: Value = refused.json().await.unwrap();
    let violation = &body["context"]["violations"][0];
    let kind = violation.get("type_").or_else(|| violation.get("type"));
    assert_eq!(kind, Some(&json!(KIT_NOT_INSTALLED)), "{body}");
    assert_eq!(violation["subject"], "org-costs", "{body}");
    // Reads are not claimed.
    let read = http
        .get(format!("{origin}/studio-usage/v1/budgets"))
        .send()
        .await
        .unwrap();
    assert_eq!(read.text().await.unwrap(), "read");
    // Another gear's claim is that gear's layer's to check.
    let other = http
        .put(format!("{origin}/studio-environments/v1/open-clusters"))
        .send()
        .await
        .unwrap();
    assert_eq!(other.text().await.unwrap(), "not usage's");
    // Installed: written, and the body arrives whole.
    kits.install(ORG, "org-costs");
    let written = http
        .put(format!("{origin}/studio-usage/v1/budgets"))
        .json(&json!({"budgets": []}))
        .send()
        .await
        .unwrap();
    assert_eq!(written.text().await.unwrap(), "written");
}

#[tokio::test]
async fn a_claimed_tool_answers_kit_not_installed() {
    let hub = ClientHub::new();
    let kits = Arc::new(Kits::default());
    hub.register::<dyn KitPresence>(Arc::clone(&kits) as Arc<dyn KitPresence>);
    let args = Map::new();
    let refused = tool_refusal(&hub, &caller(), "deploy_request", &args)
        .await
        .expect("refused");
    assert_eq!(
        refused,
        KitRefusal::NotInstalled {
            kit: "delivery".into()
        }
    );
    // The shell's tools always answer.
    assert_eq!(
        tool_refusal(&hub, &caller(), "kits_catalog", &args).await,
        None
    );
    kits.install(ORG, "delivery");
    assert_eq!(
        tool_refusal(&hub, &caller(), "deploy_request", &args).await,
        None
    );
}

#[tokio::test]
async fn an_opted_in_sync_skips_without_its_kit_and_resumes_after_an_install() {
    let kit = |flag: bool| {
        read_kit_json(
            &json!({"slug": "tests", "name": "Tests",
                "gears": [{"gear": "studio-artifact-ingest", "types": ["ci-run"],
                           "sync_only_with_kit": flag}]})
            .to_string(),
        )
        .unwrap()
    };
    let opted = Claims::of(&[kit(true)]).unwrap();
    let plain = Claims::of(&[kit(false)]).unwrap();
    let kits = Kits::default();
    async fn wanted(claims: &Claims, kits: Option<&Kits>, type_id: &str) -> bool {
        sync_wanted(
            claims,
            kits.map(|k| k as &dyn KitPresence),
            &caller(),
            PROJECT,
            "studio-artifact-ingest",
            type_id,
        )
        .await
    }
    assert!(!wanted(&opted, Some(&kits), "ci-run").await, "skipped");
    assert!(
        wanted(&plain, Some(&kits), "ci-run").await,
        "writes as before"
    );
    assert!(wanted(&opted, Some(&kits), "release").await, "not claimed");
    assert!(wanted(&opted, None, "ci-run").await, "no studio-kits");
    let broken = Kits {
        broken: true,
        ..Kits::default()
    };
    assert!(wanted(&opted, Some(&broken), "ci-run").await, "unreadable");
    kits.install(PROJECT, "tests");
    assert!(wanted(&opted, Some(&kits), "ci-run").await, "resumed");
    // The built-in claims leave it off: every gear writes as before.
    assert_eq!(
        Claims::builtin().sync_kit("studio-artifact-ingest", "ci-run"),
        None
    );
}
