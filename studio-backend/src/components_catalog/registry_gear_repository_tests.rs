//! The organization's gear repository over REST (ADR-0042 §2): who may
//! change it, what a refusal says, and "Create a gear" into it.

use std::sync::Mutex;

use axum::response::IntoResponse;

use super::*;
use crate::catalog_graph::MemorySink;
use crate::components_catalog::registry::gear_repository_scope_refusal;
use crate::product::port::{
    DeclarationFile, GearScaffolds, NewGear, RepositoryTarget, ScaffoldFailure, ScaffoldOutcome,
};

const ORG: Uuid = Uuid::from_u128(0x0a6);
const ADMIN: u128 = 7;
const MEMBER: u128 = 8;

/// A fake studio-user: grants the registry privilege to one subject.
struct Authority(Uuid);

#[async_trait::async_trait]
impl crate::user_profile::OrgAuthority for Authority {
    async fn may_administer(&self, ctx: &SecurityContext, _org: Uuid, privilege: &str) -> bool {
        privilege == REGISTRY_PRIVILEGE && ctx.subject_id() == self.0
    }
    async fn may_dispose(&self, _ctx: &SecurityContext, _org: Uuid) -> bool {
        false
    }
}

/// A fake studio-product: records where it was asked to write.
#[derive(Default)]
struct Scaffolds {
    asked: Mutex<Vec<(Uuid, RepositoryTarget, NewGear)>>,
}

#[async_trait::async_trait]
impl GearScaffolds for Scaffolds {
    async fn scaffold_into(
        &self,
        ctx: &SecurityContext,
        target: &RepositoryTarget,
        gear: &NewGear,
    ) -> Result<ScaffoldOutcome, ScaffoldFailure> {
        self.asked
            .lock()
            .unwrap()
            .push((ctx.subject_tenant_id(), target.clone(), gear.clone()));
        Ok(ScaffoldOutcome {
            branch: format!("scaffold/{}", gear.slug),
            commit_sha: if gear.dry_run {
                String::new()
            } else {
                "c0ffee".into()
            },
            pr_url: (!gear.dry_run && gear.open_pr).then(|| "https://example/pr/1".to_owned()),
            files: vec![DeclarationFile {
                path: format!("gears/{}/gear.toml", gear.slug),
                content: "[gear]".into(),
            }],
        })
    }
}

struct Rig {
    catalog: Catalog,
    scaffolds: Arc<Scaffolds>,
}

fn rig() -> Rig {
    let hub = Arc::new(ClientHub::new());
    hub.register_scoped::<dyn crate::user_profile::OrgAuthority>(
        ClientScope::gts_id(crate::user_profile::IDENTITY_INSTANCE_ID),
        Arc::new(Authority(Uuid::from_u128(ADMIN))),
    );
    let scaffolds = Arc::new(Scaffolds::default());
    hub.register::<dyn GearScaffolds>(scaffolds.clone());
    let service = Arc::new(CatalogService::new(
        Arc::new(MemorySink::default()),
        "k".to_string(),
        None,
    ));
    Rig {
        catalog: Catalog::new(service, hub, None),
        scaffolds,
    }
}

fn caller(id: u128) -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(id))
        .subject_tenant_id(ORG)
        .build()
        .unwrap()
}

fn status(e: CanonicalError) -> StatusCode {
    e.into_response().status()
}

fn stored() -> GearRepository {
    GearRepository {
        tenant: ORG,
        connection_id: Uuid::from_u128(0xc0),
        repo: "acme/gears".into(),
        branch: "trunk".into(),
        connection_label: Some("Acme GitHub".into()),
        set_by: Some("u7".into()),
        set_at: Some("2026-10-09T10:00:00Z".into()),
    }
}

fn scaffold_body(dry_run: Option<bool>) -> RegistryScaffoldRequest {
    RegistryScaffoldRequest {
        slug: "billing".into(),
        problem: Some("Bill the customers.".into()),
        capabilities: Some(vec!["billing".into()]),
        gear_kind: None,
        plugin_host: None,
        plugin_spec: None,
        parent_dir: None,
        app_title: None,
        open_pr: None,
        dry_run,
    }
}

#[tokio::test]
async fn every_member_reads_the_setting_and_only_an_administrator_may_manage_it() {
    let r = rig();
    let Json(none) = get_gear_repository(OrgCtx(caller(MEMBER)), Extension(r.catalog.clone()))
        .await
        .unwrap();
    assert!(none.gear_repository.is_none());
    assert!(!none.may_manage, "a member may not");

    r.catalog
        .service
        .store_gear_repository(&caller(ADMIN), Some(stored()))
        .await
        .unwrap();
    let Json(set) = get_gear_repository(OrgCtx(caller(ADMIN)), Extension(r.catalog.clone()))
        .await
        .unwrap();
    let repo = set.gear_repository.expect("set");
    assert_eq!(repo.repo, "acme/gears");
    assert_eq!(repo.branch, "trunk");
    assert_eq!(repo.connection_label.as_deref(), Some("Acme GitHub"));
    assert!(set.may_manage, "the administrator may");

    // A member is refused every change, and nothing changes.
    let put = set_gear_repository(
        OrgCtx(caller(MEMBER)),
        Extension(r.catalog.clone()),
        Json(SetGearRepositoryRequest {
            connection_id: Uuid::from_u128(1),
            repo: "acme/other".into(),
            branch: None,
        }),
    )
    .await
    .unwrap_err();
    assert_eq!(status(put), StatusCode::FORBIDDEN);
    let del = delete_gear_repository(OrgCtx(caller(MEMBER)), Extension(r.catalog.clone()))
        .await
        .unwrap_err();
    assert_eq!(status(del), StatusCode::FORBIDDEN);
    let create = create_gear_repository(
        OrgCtx(caller(MEMBER)),
        Extension(r.catalog.clone()),
        Json(CreateGearRepositoryRequest {
            connection_id: Uuid::from_u128(1),
            name: "gears".into(),
            owner: None,
            is_org: None,
            private: None,
        }),
    )
    .await
    .unwrap_err();
    assert_eq!(status(create), StatusCode::FORBIDDEN);
    assert_eq!(
        r.catalog
            .service
            .gear_repository(&caller(MEMBER))
            .await
            .unwrap(),
        Some(stored())
    );

    // The administrator removes it; the setting reads back empty.
    let Json(removed) = delete_gear_repository(OrgCtx(caller(ADMIN)), Extension(r.catalog.clone()))
        .await
        .unwrap();
    assert!(removed.gear_repository.is_none());
    assert_eq!(
        r.catalog
            .service
            .gear_repository(&caller(ADMIN))
            .await
            .unwrap(),
        None
    );
}

#[tokio::test]
async fn the_setting_round_trips_beside_the_other_registry_settings() {
    let r = rig();
    let svc = &r.catalog.service;
    let ctx = caller(ADMIN);
    svc.set_excluded_projects(&ctx, vec![Uuid::from_u128(3)])
        .await
        .unwrap();
    svc.store_gear_repository(&ctx, Some(stored()))
        .await
        .unwrap();
    assert_eq!(svc.gear_repository(&ctx).await.unwrap(), Some(stored()));
    assert_eq!(
        svc.excluded_projects(&ctx).await.unwrap(),
        vec![Uuid::from_u128(3)],
        "setting the gear repository keeps the excluded projects"
    );
    svc.set_excluded_projects(&ctx, Vec::new()).await.unwrap();
    assert_eq!(
        svc.gear_repository(&ctx).await.unwrap(),
        Some(stored()),
        "and the other way round"
    );
    svc.store_gear_repository(&ctx, None).await.unwrap();
    assert_eq!(svc.gear_repository(&ctx).await.unwrap(), None);
}

#[tokio::test]
async fn a_scaffold_into_the_organizations_repository_is_an_administrators_and_needs_one() {
    let r = rig();
    let refused = scaffold_organization_gear(
        OrgCtx(caller(MEMBER)),
        Extension(r.catalog.clone()),
        Json(scaffold_body(None)),
    )
    .await
    .unwrap_err();
    assert_eq!(status(refused), StatusCode::FORBIDDEN);

    let none = scaffold_organization_gear(
        OrgCtx(caller(ADMIN)),
        Extension(r.catalog.clone()),
        Json(scaffold_body(None)),
    )
    .await
    .unwrap_err();
    assert_eq!(
        status(none),
        StatusCode::BAD_REQUEST,
        "no gear repository is a failed precondition"
    );
    assert!(r.scaffolds.asked.lock().unwrap().is_empty());

    r.catalog
        .service
        .store_gear_repository(&caller(ADMIN), Some(stored()))
        .await
        .unwrap();
    let Json(done) = scaffold_organization_gear(
        OrgCtx(caller(ADMIN)),
        Extension(r.catalog.clone()),
        Json(scaffold_body(None)),
    )
    .await
    .unwrap();
    assert_eq!(done.repo, "acme/gears");
    assert_eq!(done.branch, "scaffold/billing");
    assert_eq!(done.pr_url.as_deref(), Some("https://example/pr/1"));
    assert!(!done.dry_run);
    assert_eq!(done.files[0].path, "gears/billing/gear.toml");
    let asked = r.scaffolds.asked.lock().unwrap();
    let (tenant, target, gear) = &asked[0];
    assert_eq!(*tenant, ORG, "written as the organization");
    assert_eq!(target.repo, "acme/gears");
    assert_eq!(target.base_branch, "trunk");
    assert_eq!(target.connection_id, Some(Uuid::from_u128(0xc0)));
    assert!(gear.open_pr, "a pull request by default");
    assert_eq!(gear.capabilities, ["billing"]);
    assert_eq!(gear.problem.as_deref(), Some("Bill the customers."));
}

#[tokio::test]
async fn a_dry_run_answers_the_files_and_says_so() {
    let r = rig();
    r.catalog
        .service
        .store_gear_repository(&caller(ADMIN), Some(stored()))
        .await
        .unwrap();
    let Json(done) = scaffold_organization_gear(
        OrgCtx(caller(ADMIN)),
        Extension(r.catalog.clone()),
        Json(scaffold_body(Some(true))),
    )
    .await
    .unwrap();
    assert!(done.dry_run);
    assert!(done.commit_sha.is_empty());
    assert!(done.pr_url.is_none());
}

#[test]
fn a_refused_gear_repository_names_the_field_and_why() {
    let shared = GearRepositoryError::NotShared {
        scope: "personal".into(),
        hint: gear_repository_scope_refusal("personal").unwrap(),
    };
    let text = shared.to_string();
    assert!(text.contains("personal-scoped"), "{text}");
    assert!(text.contains("background read cannot use"), "{text}");
    assert_eq!(
        status(gear_repository_problem(&shared)),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        status(gear_repository_problem(&GearRepositoryError::InvalidRepo(
            "x".into()
        ))),
        StatusCode::BAD_REQUEST
    );
}
