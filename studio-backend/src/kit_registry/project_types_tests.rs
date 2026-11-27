//! An organization's own kit becomes a project type (ADR-0073 Amendment 2,
//! studio-web#1119): from a test shelf, through the organization's install,
//! to a project created with it whose object in the model is the kit's
//! subtype of Project.

#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{Map, Value, json};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::*;
use crate::domain_model::port::DomainObjects;
use crate::kit_registry::installed::{
    InstalledDocument, InstalledKit, InstalledStore, KitAuthority, KitInstaller,
};
use crate::kit_registry::manifest::KIT_JSON;
use crate::kit_registry::models::FixedModels;
use crate::kit_registry::service::{builtin_catalogue, official_catalogue};
use crate::kit_registry::shelf::{Fetched, KitSourceReader, SourceInput};
use crate::organizations::project_create::{Plan, store_typed_project_object};

const ORG: Uuid = Uuid::from_u128(0xc31d);
const WORKSPACE: Uuid = Uuid::from_u128(0x3a5e);
const PROJECT: Uuid = Uuid::from_u128(0x9a0e);
const ADMIN: Uuid = Uuid::from_u128(0x0a);
const CONNECTION: Uuid = Uuid::from_u128(0xc0);
const C1: &str = "1111111111111111111111111111111111111111";
const C2: &str = "2222222222222222222222222222222222222222";
const DEALS_GTS: &str = "gts.cf.studio.domain.project.v1~cf.studio.kit_deals.project.v1~";

#[derive(Default)]
struct Memory {
    docs: Mutex<HashMap<Uuid, InstalledDocument>>,
}

#[async_trait]
impl InstalledStore for Memory {
    async fn read(&self, _: &SecurityContext, tenant: Uuid) -> anyhow::Result<InstalledDocument> {
        Ok(self
            .docs
            .lock()
            .unwrap()
            .get(&tenant)
            .cloned()
            .unwrap_or_default())
    }

    async fn update(
        &self,
        tenant: Uuid,
        change: &mut (
                 dyn for<'d> FnMut(
            &'d mut InstalledDocument,
        ) -> Result<Option<InstalledKit>, Refusal>
                     + Send
             ),
    ) -> Result<Option<InstalledKit>, Refusal> {
        let mut docs = self.docs.lock().unwrap();
        let mut doc = docs.get(&tenant).cloned().unwrap_or_default();
        let answer = change(&mut doc)?;
        docs.insert(tenant, doc);
        Ok(answer)
    }

    async fn organization_of(&self, _: &SecurityContext, tenant: Uuid) -> Uuid {
        if tenant == PROJECT { ORG } else { tenant }
    }

    async fn is_project(&self, _: &SecurityContext, tenant: Uuid) -> bool {
        tenant == PROJECT
    }
}

struct Admins;

#[async_trait]
impl KitAuthority for Admins {
    async fn is_platform_admin(&self, _: &SecurityContext) -> bool {
        false
    }
    async fn may_manage(&self, ctx: &SecurityContext, org: Uuid) -> bool {
        ctx.subject_id() == ADMIN && org == ORG
    }
}

/// A repository answering one manifest at whatever commit the test sets.
struct Repo {
    body: Mutex<String>,
    commit: Mutex<String>,
}

#[async_trait]
impl KitSourceReader for Repo {
    async fn fetch(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: &SourceInput,
    ) -> Result<Fetched, Refusal> {
        Ok(Fetched {
            provider: "github".into(),
            commit: self.commit.lock().unwrap().clone(),
            file: KIT_JSON,
            body: self.body.lock().unwrap().clone(),
            repository_url: "https://github.com/acme/kits".into(),
        })
    }
}

/// The organization's own Deals kit: a subtype of Project with its own
/// field, created with Studio's `prd` step, its next step one of the shell's
/// screens (or `route`, for the refusals).
fn deals(route: &str, steps: &[&str]) -> String {
    json!({
        "slug": "deals", "name": "Deals", "levels": ["organization", "project"],
        "model": {"types": [{"name": "project", "extends": "project", "label": "Deal",
            "fields": [{"name": "deal_size", "type": "number?"}]}]},
        "project_creation": {"steps": steps, "next_steps": [
            {"id": "sources", "label": "Connect the data room", "route": route}]},
    })
    .to_string()
}

fn setup(body: String) -> (KitInstaller, Arc<Repo>, Arc<dyn DomainObjects>) {
    let mut library = builtin_catalogue();
    library.extend(official_catalogue());
    let repo = Arc::new(Repo {
        body: Mutex::new(body),
        commit: Mutex::new(C1.into()),
    });
    let model = crate::domain_model::port::in_memory();
    let installer = KitInstaller::new(library, Arc::new(Memory::default()), Arc::new(Admins))
        .with_reader(repo.clone())
        .with_models(Arc::new(FixedModels(model.clone())));
    (installer, repo, model)
}

fn caller(subject: Uuid, home: Uuid) -> SecurityContext {
    SecurityContext::builder()
        .subject_id(subject)
        .subject_type("user")
        .subject_tenant_id(home)
        .token_scopes(vec!["studio".into()])
        .build()
        .unwrap()
}

/// The creation run's identity in the new project.
fn run_in_project() -> SecurityContext {
    SecurityContext::builder()
        .subject_id(crate::organizations::SERVICE_SUBJECT_ID)
        .subject_type("service")
        .subject_tenant_id(PROJECT)
        .token_scopes(vec!["*".into()])
        .build()
        .unwrap()
}

fn source() -> SourceInput {
    SourceInput {
        connection_id: CONNECTION,
        repository: "acme/kits".into(),
        path: "deals".into(),
        git_ref: Some("main".into()),
        slug: None,
    }
}

fn plan() -> Plan {
    let mut config = Map::new();
    config.insert("project_type_kit".into(), json!("deals"));
    config.insert("project_type_id".into(), json!(DEALS_GTS));
    Plan {
        asked_by: ADMIN,
        organization_id: ORG,
        workspace_id: WORKSPACE,
        project_id: PROJECT,
        name: "Acme acquisition".into(),
        config,
        sources: Vec::new(),
        repository: None,
        scaffold: None,
        prd: None,
        kits: Vec::new(),
    }
}

#[tokio::test]
async fn an_organizations_kit_from_its_shelf_becomes_a_project_type_and_types_the_project() {
    let (installer, repo, model) = setup(deals("/projects/sources", &["prd"]));
    let admin = caller(ADMIN, ORG);
    installer
        .add_shelf_kit(&admin, ORG, source())
        .await
        .unwrap();

    // On the shelf only, it is no type yet: installing it is the decision.
    let slugs = |types: &[OrgProjectType]| -> Vec<String> {
        types.iter().map(|t| t.manifest.slug.clone()).collect()
    };
    assert!(!slugs(&installer.project_types(ORG).await.unwrap()).contains(&"deals".to_owned()));
    installer
        .install_for_organization(&admin, ORG, "deals", None)
        .await
        .unwrap();
    let types = installer.project_types(ORG).await.unwrap();
    assert_eq!(
        slugs(&types),
        ["gears-project", "constructor-research", "mna", "deals"],
        "the built-in types, then the organization's own"
    );
    let own = types.iter().find(|t| t.manifest.slug == "deals").unwrap();
    assert_eq!(own.version.as_deref(), Some(C1));
    assert_eq!(own.shelf, "organization");
    assert_eq!(
        own.manifest.project_subtype().map(|s| s.gts).as_deref(),
        Some(DEALS_GTS)
    );
    // Another organization does not have it.
    assert!(
        !slugs(
            &installer
                .project_types(Uuid::from_u128(0xdead))
                .await
                .unwrap()
        )
        .contains(&"deals".to_owned())
    );

    // The shelf moves on; the organization keeps what it installed, and so
    // does a project created now.
    *repo.commit.lock().unwrap() = C2.into();
    installer
        .refresh_shelf_kit(&admin, ORG, "deals")
        .await
        .unwrap();
    let installed = installer
        .install_for_created_project(&run_in_project(), PROJECT, ORG, "deals")
        .await
        .unwrap();
    assert_eq!(
        installed.version, C1,
        "the organization's pin, not the shelf's latest"
    );

    // The creation's `model` step: the project's object is the subtype.
    let org_ctx = crate::kit_registry::installed::service_context(ORG).unwrap();
    let wrote = store_typed_project_object(model.as_ref(), &org_ctx, &plan(), DEALS_GTS)
        .await
        .unwrap();
    assert!(wrote);
    let scope = PROJECT.to_string();
    let (as_subtype, _) = model
        .query(
            &org_ctx,
            json!({"type": "deals-project", "project_id": scope}),
        )
        .await
        .unwrap();
    assert_eq!(as_subtype.len(), 1, "stored as the kit's subtype");
    assert_eq!(as_subtype[0].payload["project_type_id"], DEALS_GTS);
    assert_eq!(as_subtype[0].payload["project_type"], "deals-project");
    let (as_project, total) = model
        .query(&org_ctx, json!({"type": "project", "project_id": scope}))
        .await
        .unwrap();
    assert_eq!((as_project.len(), total), (1, 1), "and a Project, once");
    // Again: nothing to do.
    assert!(
        !store_typed_project_object(model.as_ref(), &org_ctx, &plan(), DEALS_GTS)
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn a_next_step_to_no_screen_refuses_the_install() {
    let (installer, ..) = setup(deals("/nowhere", &["prd"]));
    let admin = caller(ADMIN, ORG);
    installer
        .add_shelf_kit(&admin, ORG, source())
        .await
        .unwrap();
    match installer
        .install_for_organization(&admin, ORG, "deals", None)
        .await
    {
        Err(Refusal::Invalid(why)) => {
            assert!(why.contains("`/nowhere`"), "{why}");
            assert!(
                why.contains("/projects/sources"),
                "it names the screens: {why}"
            );
        }
        other => panic!("installed: {other:?}"),
    }
    assert!(
        installer
            .project_types(ORG)
            .await
            .unwrap()
            .iter()
            .all(|t| t.manifest.slug != "deals")
    );
}

#[tokio::test]
async fn a_creation_step_outside_studios_is_refused_when_the_kit_is_read() {
    let (installer, ..) = setup(deals("/projects/sources", &["deploy"]));
    let admin = caller(ADMIN, ORG);
    match installer.add_shelf_kit(&admin, ORG, source()).await {
        Err(Refusal::Invalid(why)) => assert!(why.contains("deploy"), "{why}"),
        other => panic!("read: {other:?}"),
    }
}

#[test]
fn the_built_in_project_types_pass_and_their_routes_are_known() {
    for kit in project_type_kits() {
        check_project_type(&kit).unwrap_or_else(|e| panic!("{e}"));
    }
}

/// The shell's routes are the shell's: each is a route some
/// micro-frontend of the portal (`studio-frontend`) declares.
#[test]
fn the_shells_routes_are_routes_the_portal_declares() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../studio-frontend/src-app/mfe_packages");
    let Ok(dirs) = std::fs::read_dir(&root) else {
        // A checkout without the frontend (a crate-only build) has nothing to
        // hold the list to.
        return;
    };
    let mut declared: Vec<String> = Vec::new();
    for dir in dirs.flatten() {
        let Ok(body) = std::fs::read_to_string(dir.path().join("mfe.json")) else {
            continue;
        };
        let doc: Value = serde_json::from_str(&body).unwrap();
        collect_routes(&doc, &mut declared);
    }
    for route in SHELL_ROUTES {
        assert!(
            declared.iter().any(|d| d == route),
            "`{route}` is in SHELL_ROUTES but no mfe.json declares it"
        );
    }
}

fn collect_routes(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::Object(m) => {
            for (k, v) in m {
                match (k.as_str(), v) {
                    ("route", Value::String(r)) => out.push(r.clone()),
                    _ => collect_routes(v, out),
                }
            }
        }
        Value::Array(a) => a.iter().for_each(|v| collect_routes(v, out)),
        _ => {}
    }
}
