use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;

use super::*;
use crate::kit_registry::testing::{ADMIN, ORG, PROJECT, installer_over, runtime_of};

/// The project's owner: the deal lead.
const LEAD: Uuid = Uuid::from_u128(0x1ead);
const ANALYST: Uuid = Uuid::from_u128(0xa7a1);

/// The project's config and each source's contributors.
#[derive(Default)]
struct Projects {
    config: Option<Value>,
    /// By `full_path`; absent is a provider that refuses.
    contributors: HashMap<String, Vec<(String, u64)>>,
}

#[async_trait]
impl DealProjects for Projects {
    async fn config(&self, _: &SecurityContext, _: Uuid) -> Result<Option<Value>, String> {
        Ok(self.config.clone())
    }

    async fn contributors(
        &self,
        _: &SecurityContext,
        _: Uuid,
        source: &ProjectSource,
    ) -> Result<Vec<(String, u64)>, String> {
        self.contributors
            .get(&source.full_path)
            .cloned()
            .ok_or_else(|| "the connection was refused".to_owned())
    }
}

/// The other gears' answers, by path; absent is a failed read.
#[derive(Default)]
struct Reads(HashMap<&'static str, Value>);

#[async_trait]
impl GearReads for Reads {
    async fn get(&self, path: &str, _: &[(String, String)]) -> Result<Value, String> {
        self.0
            .get(path)
            .cloned()
            .ok_or_else(|| format!("{path} answered 503"))
    }
}

fn caller(subject: Uuid) -> SecurityContext {
    SecurityContext::builder()
        .subject_id(subject)
        .subject_type("user")
        .subject_tenant_id(ORG)
        .token_scopes(vec!["*".into()])
        .build()
        .unwrap()
}

fn config() -> Value {
    json!({
        "owner_id": LEAD.to_string(),
        "project_type_kit": "mna",
        "sources": [
            { "connection_id": Uuid::from_u128(7).to_string(), "full_path": "target/api",
              "clone_url": "https://github.com/target/api.git", "branch": "main" },
            { "connection_id": Uuid::from_u128(7).to_string(), "full_path": "target/web",
              "clone_url": "https://github.com/target/web.git" }
        ]
    })
}

async fn setup(projects: Projects, install: bool) -> Mna {
    let installer = installer_over(crate::domain_model::port::in_memory());
    if install {
        installer
            .install_for_project(&caller(ADMIN), PROJECT, SLUG, None)
            .await
            .expect("a project type installs for one project");
    }
    Mna::new(runtime_of(&installer), Arc::new(projects))
}

fn with_config() -> Projects {
    Projects {
        config: Some(config()),
        ..Projects::default()
    }
}

#[test]
fn the_vocabulary_is_the_overlay_s() {
    assert_eq!(
        vocabulary(SUBTYPE, "deal_phase"),
        ["screening", "confirmatory_dd", "signing", "integration"]
    );
    assert_eq!(
        vocabulary(SUBTYPE, "recommendation"),
        ["proceed", "proceed_with_conditions", "stop"]
    );
    assert_eq!(
        vocabulary("finding", "severity"),
        ["critical", "high", "medium", "low", "info"]
    );
    assert_eq!(vocabulary("risk", "likelihood"), ["low", "medium", "high"]);
    assert_eq!(
        vocabulary("open-question", "status"),
        ["open", "answered", "closed"]
    );
}

#[test]
fn the_truck_factor_is_the_fewest_people_with_more_than_half_the_commits() {
    assert_eq!(truck_factor(&[]), None);
    assert_eq!(truck_factor(&[0, 0]), None);
    assert_eq!(truck_factor(&[90, 5, 5]), Some(1));
    assert_eq!(truck_factor(&[50, 50]), Some(2), "exactly half is not more");
    assert_eq!(truck_factor(&[10, 40, 30, 20]), Some(2));
    assert_eq!(truck_factor(&[1, 1, 1, 1, 1]), Some(3));
}

#[test]
fn an_item_is_checked_before_it_is_stored() {
    let f = clean_item(
        Kind::Finding,
        &json!({"title": " No tests ", "severity": "high"}),
        &[],
    )
    .unwrap();
    assert_eq!(f["title"], "No tests");
    assert_eq!(f["origin"], "manual");
    assert_eq!(f["status"], "open");
    assert!(matches!(
        clean_item(
            Kind::Finding,
            &json!({"title": "x", "severity": "dire"}),
            &[]
        ),
        Err(Refusal::Invalid(_))
    ));
    assert!(matches!(
        clean_item(Kind::Finding, &json!({"severity": "low"}), &[]),
        Err(Refusal::Invalid(_))
    ));
    assert!(matches!(
        clean_item(
            Kind::Finding,
            &json!({"title": "x", "severity": "low", "origin": "Not A Word"}),
            &[]
        ),
        Err(Refusal::Invalid(_))
    ));
    // A risk names one of the deal's findings, or none.
    let risk = json!({"title": "Key person", "likelihood": "high", "impact": "critical",
        "finding_id": "f-1"});
    assert!(matches!(
        clean_item(Kind::Risk, &risk, &[]),
        Err(Refusal::Invalid(_))
    ));
    assert_eq!(
        clean_item(Kind::Risk, &risk, &["f-1".into()]).unwrap()["finding_id"],
        "f-1"
    );
    // An answer given says the question is answered, unless it says otherwise.
    let q = clean_item(
        Kind::Question,
        &json!({"what": "Who owns the build?", "answer": "Ops"}),
        &[],
    )
    .unwrap();
    assert_eq!(q["status"], "answered");
    assert!(date_ok("2026-12-01"));
    assert!(!date_ok("2026-02-30"));
    assert!(!date_ok("next week"));
}

#[tokio::test]
async fn where_the_kit_does_not_apply_there_is_no_deal_and_nothing_is_written() {
    let mna = setup(with_config(), false).await;
    let deal = mna.deal(&caller(LEAD), PROJECT).await.unwrap();
    assert!(!deal.installed);
    assert_eq!(deal.phases.len(), 4, "the vocabulary is still said");
    assert!(
        mna.items(&caller(LEAD), PROJECT, Kind::Finding)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(matches!(
        mna.update_deal(
            &caller(LEAD),
            PROJECT,
            DealPatch {
                thesis: Some("x".into()),
                ..DealPatch::default()
            }
        )
        .await,
        Err(Refusal::KitNotInstalled(k)) if k == SLUG
    ));
    assert!(matches!(
        mna.save_item(&caller(LEAD), PROJECT, Kind::Finding, None, &json!({}))
            .await,
        Err(Refusal::KitNotInstalled(_))
    ));
    assert!(matches!(
        mna.evidence(&caller(LEAD), PROJECT, &Reads::default())
            .await,
        Err(Refusal::KitNotInstalled(_))
    ));
}

#[tokio::test]
async fn a_deal_is_the_project_s_fields_and_only_its_lead_signs_it_off() {
    let mna = setup(with_config(), true).await;
    let lead = caller(LEAD);
    let analyst = caller(ANALYST);

    let deal = mna.deal(&analyst, PROJECT).await.unwrap();
    assert!(deal.installed);
    assert_eq!(
        deal.deal_lead,
        Some(LEAD.to_string()),
        "the project's owner"
    );
    assert!(!deal.may_sign_off);
    assert!(mna.deal(&lead, PROJECT).await.unwrap().may_sign_off);

    // Anybody who may edit the project's object fills the deal in.
    let deal = mna
        .update_deal(
            &analyst,
            PROJECT,
            DealPatch {
                target: Some("Acme Robotics".into()),
                thesis: Some("Their planner is ten years ahead of ours.".into()),
                deal_phase: Some("confirmatory_dd".into()),
                ic_date: Some("2026-12-15".into()),
                ..DealPatch::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(deal.target.as_deref(), Some("Acme Robotics"));
    assert_eq!(deal.deal_phase.as_deref(), Some("confirmatory_dd"));
    assert_eq!(deal.ic_date.as_deref(), Some("2026-12-15"));
    for bad in [
        DealPatch {
            deal_phase: Some("closing".into()),
            ..DealPatch::default()
        },
        DealPatch {
            ic_date: Some("15.12.2026".into()),
            ..DealPatch::default()
        },
        DealPatch {
            recommendation: Some("maybe".into()),
            ..DealPatch::default()
        },
    ] {
        assert!(matches!(
            mna.update_deal(&analyst, PROJECT, bad).await,
            Err(Refusal::Invalid(_))
        ));
    }

    // Nothing to sign off yet.
    assert!(matches!(
        mna.sign_off(&lead, PROJECT).await,
        Err(Refusal::Precondition(
            "recommendation",
            _,
            NO_RECOMMENDATION
        ))
    ));
    let deal = mna
        .update_deal(
            &analyst,
            PROJECT,
            DealPatch {
                recommendation: Some("proceed_with_conditions".into()),
                conditions: Some(vec![
                    "Escrow the planner's source".into(),
                    " ".into(),
                    "Retain the two core engineers".into(),
                ]),
                ..DealPatch::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(deal.conditions.len(), 2, "an empty condition is dropped");

    // Only the deal lead signs off.
    assert!(matches!(
        mna.sign_off(&analyst, PROJECT).await,
        Err(Refusal::Forbidden(DEAL_LEAD_REQUIRED))
    ));
    let signed = mna.sign_off(&lead, PROJECT).await.unwrap();
    assert_eq!(signed.signed_off_by, Some(LEAD.to_string()));
    assert!(signed.signed_off_at.is_some());

    // The thesis changes nothing signed; the conditions take it back.
    let deal = mna
        .update_deal(
            &analyst,
            PROJECT,
            DealPatch {
                thesis: Some("Sharper thesis".into()),
                ..DealPatch::default()
            },
        )
        .await
        .unwrap();
    assert!(deal.signed_off_by.is_some());
    let deal = mna
        .update_deal(
            &analyst,
            PROJECT,
            DealPatch {
                conditions: Some(vec!["Escrow the planner's source".into()]),
                ..DealPatch::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(deal.signed_off_by, None);
    assert_eq!(deal.signed_off_at, None);
    assert_eq!(
        deal.target.as_deref(),
        Some("Acme Robotics"),
        "the rest stays"
    );

    // An empty string clears.
    let deal = mna
        .update_deal(
            &analyst,
            PROJECT,
            DealPatch {
                ic_date: Some(String::new()),
                ..DealPatch::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(deal.ic_date, None);
}

#[tokio::test]
async fn a_project_without_an_owner_has_no_deal_lead() {
    let mna = setup(
        Projects {
            config: Some(json!({"sources": []})),
            ..Projects::default()
        },
        true,
    )
    .await;
    let deal = mna.deal(&caller(LEAD), PROJECT).await.unwrap();
    assert_eq!(deal.deal_lead, None);
    assert!(!deal.may_sign_off);
}

#[tokio::test]
async fn findings_risks_and_questions_are_the_deal_s_objects() {
    let mna = setup(with_config(), true).await;
    let who = caller(ANALYST);

    let finding = mna
        .save_item(
            &who,
            PROJECT,
            Kind::Finding,
            None,
            &json!({"title": "No tests on the planner", "severity": "high",
                "source": "target/api", "evidence": "0 test files", "origin": "spec_check"}),
        )
        .await
        .unwrap();
    assert_eq!(finding.text("created_by"), Some(ANALYST.to_string()));
    let risk = mna
        .save_item(
            &who,
            PROJECT,
            Kind::Risk,
            None,
            &json!({"title": "Regressions after integration", "likelihood": "high",
                "impact": "high", "finding_id": finding.id}),
        )
        .await
        .unwrap();
    assert_eq!(
        risk.text("finding_id").as_deref(),
        Some(finding.id.as_str())
    );
    assert!(matches!(
        mna.save_item(
            &who,
            PROJECT,
            Kind::Risk,
            None,
            &json!({"title": "x", "likelihood": "low", "impact": "low", "finding_id": "nope"})
        )
        .await,
        Err(Refusal::Invalid(_))
    ));
    mna.save_item(
        &who,
        PROJECT,
        Kind::Question,
        None,
        &json!({"what": "Who can release?", "who": "CTO"}),
    )
    .await
    .unwrap();

    let findings = mna.items(&who, PROJECT, Kind::Finding).await.unwrap();
    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].text("origin").as_deref(), Some("spec_check"));
    assert_eq!(mna.items(&who, PROJECT, Kind::Risk).await.unwrap().len(), 1);
    assert_eq!(
        mna.items(&who, PROJECT, Kind::Question).await.unwrap()[0]
            .text("status")
            .as_deref(),
        Some("open")
    );

    // A replace keeps who recorded it and when.
    let other = caller(LEAD);
    let resolved = mna
        .save_item(
            &other,
            PROJECT,
            Kind::Finding,
            Some(&finding.id),
            &json!({"title": "No tests on the planner", "severity": "medium",
                "status": "resolved"}),
        )
        .await
        .unwrap();
    assert_eq!(resolved.id, finding.id);
    assert_eq!(resolved.text("created_by"), Some(ANALYST.to_string()));
    assert_eq!(resolved.text("severity").as_deref(), Some("medium"));
    assert_eq!(
        mna.items(&who, PROJECT, Kind::Finding).await.unwrap().len(),
        1,
        "replaced, not added"
    );
    assert!(matches!(
        mna.save_item(
            &who,
            PROJECT,
            Kind::Finding,
            Some("missing"),
            &json!({"title": "x", "severity": "low"})
        )
        .await,
        Err(Refusal::NotFound(..))
    ));

    mna.delete_item(&who, PROJECT, Kind::Risk, &risk.id)
        .await
        .unwrap();
    assert!(
        mna.items(&who, PROJECT, Kind::Risk)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(matches!(
        mna.delete_item(&who, PROJECT, Kind::Risk, &risk.id).await,
        Err(Refusal::NotFound(..))
    ));
}

fn fact<'a>(e: &'a Evidence, key: &str) -> &'a Fact {
    e.facts
        .iter()
        .find(|f| f.key == key)
        .unwrap_or_else(|| panic!("no fact {key}: {:?}", e.facts))
}

#[tokio::test]
async fn the_evidence_says_where_each_number_came_from_and_never_invents_one() {
    let mut projects = with_config();
    // One repository's contributors are read, the other's connection refuses.
    projects.contributors.insert(
        "target/api".into(),
        vec![
            ("ann".into(), 70),
            ("bob".into(), 20),
            ("dependabot[bot]".into(), 400),
            ("cy".into(), 10),
        ],
    );
    let mna = setup(projects, true).await;
    let who = caller(ANALYST);
    mna.save_item(
        &who,
        PROJECT,
        Kind::Risk,
        None,
        &json!({"title": "Key person", "likelihood": "high", "impact": "high"}),
    )
    .await
    .unwrap();
    mna.save_item(
        &who,
        PROJECT,
        Kind::Risk,
        None,
        &json!({"title": "Old", "likelihood": "low", "impact": "low", "status": "closed"}),
    )
    .await
    .unwrap();

    let mut reads = Reads::default();
    reads.0.insert(
        "/studio-artifact-ingest/v1/nodes",
        json!({"nodes": [{"value": {"full_path": "Target/API", "synced_at": "2026-11-18T10:00:00Z"}}],
            "total": 1}),
    );
    reads.0.insert(
        "/studio-organizations/v1/metrics",
        json!({"insight": {"state": "unconfigured",
            "detail": "Insight is not configured here"}}),
    );
    reads.0.insert(
        "/studio-artifact-ingest/v1/runs",
        json!({"items": [
            {"id": "r3", "status": "completed", "conclusion": "failure"},
            {"id": "r2", "status": "completed", "conclusion": "success"},
            {"id": "r1", "status": "completed", "conclusion": "success"},
            {"id": "r0", "status": "completed", "conclusion": "cancelled"},
            {"id": "rq", "status": "in_progress", "conclusion": null}],
            "total": 5, "latest_completed": "r3"}),
    );
    // The rollup could not be read at all.
    let e = mna.evidence(&who, PROJECT, &reads).await.unwrap();

    assert_eq!(e.repositories.len(), 2);
    let api = &e.repositories[0];
    assert_eq!(api.full_path, "target/api");
    assert_eq!(api.synced_at.as_deref(), Some("2026-11-18T10:00:00Z"));
    assert_eq!(api.contributors, Some(3), "the bot is not a person");
    assert_eq!(api.truck_factor, Some(1));
    assert_eq!(e.repositories[1].contributors, None, "not asked, not zero");

    assert_eq!(fact(&e, "repositories").value, Some(2.0));
    assert_eq!(fact(&e, "repositories_synced").value, Some(1.0));
    assert_eq!(fact(&e, "repositories_synced").total, Some(2.0));
    let c = fact(&e, "contributors");
    assert_eq!(c.value, Some(3.0));
    assert!(
        c.detail.as_deref().unwrap().contains("target/web"),
        "the repository that could not be asked is named"
    );
    assert_eq!(fact(&e, "truck_factor").value, Some(1.0));

    let active = fact(&e, "active_contributors");
    assert!(!active.available);
    assert_eq!(active.value, None);
    assert!(active.source.contains("Insight"));

    let rate = fact(&e, "ci_pass_rate");
    assert_eq!(
        rate.total,
        Some(3.0),
        "cancelled and running runs do not count"
    );
    assert!((rate.value.unwrap() - 2.0 / 3.0).abs() < 1e-9);
    let build = fact(&e, "mainline_build");
    assert_eq!(build.value, Some(0.0));
    assert_eq!(build.detail.as_deref(), Some("failed"));

    for key in ["specs_checked", "specs_failing", "spec_findings_open"] {
        let f = fact(&e, key);
        assert!(!f.available, "{key}");
        assert_eq!(f.value, None, "{key}");
        assert!(f.detail.as_deref().unwrap().contains("503"), "{key}");
    }

    let risks = fact(&e, "risks_open");
    assert_eq!((risks.value, risks.total), (Some(1.0), Some(2.0)));
    assert_eq!(fact(&e, "findings_open").value, Some(0.0));
    assert!(e.facts.iter().all(|f| !f.source.is_empty()));
    assert!(
        e.facts.iter().all(|f| f.available == f.value.is_some()),
        "a fact without a number is not available, and the other way round"
    );
}

#[tokio::test]
async fn evidence_without_repositories_says_so() {
    let mna = setup(
        Projects {
            config: Some(json!({"owner_id": LEAD.to_string()})),
            ..Projects::default()
        },
        true,
    )
    .await;
    let mut reads = Reads::default();
    reads.0.insert(
        "/studio-organizations/v1/rollups",
        json!({"items": [{"specs_checked": 4, "specs_failing": 1, "open_findings": null}]}),
    );
    let e = mna.evidence(&caller(LEAD), PROJECT, &reads).await.unwrap();
    assert!(e.repositories.is_empty());
    assert_eq!(fact(&e, "repositories").value, Some(0.0));
    assert!(!fact(&e, "truck_factor").available);
    assert_eq!(fact(&e, "specs_checked").value, Some(4.0));
    assert_eq!(fact(&e, "specs_failing").value, Some(1.0));
    assert!(!fact(&e, "spec_findings_open").available, "null is unknown");
}

/// Every route the kit's function serves is one its kit.json claims: the
/// claimed-route gate studio-kits mounts it through lets it in.
#[tokio::test]
async fn the_kit_s_routes_pass_the_claimed_route_gate() {
    let routes = super::super::Routes {
        mna: Arc::new(setup(Projects::default(), false).await),
        access: crate::kit_registry::testing::anyone(),
    };
    let openapi = toolkit::api::OpenApiRegistryImpl::new();
    let _mounted: axum::Router =
        crate::kit_registry::runtime::mount(SLUG, &routes, axum::Router::new(), &openapi)
            .expect("every route of M&A due diligence is claimed");
}
