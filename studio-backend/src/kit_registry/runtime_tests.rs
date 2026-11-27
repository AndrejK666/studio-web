//! The kit-runtime port and the registry under it, with Project lifecycle
//! (a built-in base kit that brings a model) as the kit: the Inbox sources a
//! kit brings, its model in and out of the organization's, what the port
//! answers a kit's function, and the claimed-route gate.

use std::sync::Arc;

use async_trait::async_trait;

use axum::Router;
use serde_json::json;
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OpenApiRegistryImpl, OperationBuilder};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::*;
use crate::kit_registry::installed::{KitInstaller, PLATFORM_TENANT, service_context};
use crate::kit_registry::models::FixedModels;
use crate::kit_registry::service::{builtin_catalogue, official_catalogue};
use crate::kit_registry::testing::{
    ADMIN, Admins, Memory, ORG, PLATFORM_ADMIN, PROJECT, caller, installer_over, runtime_of,
};

/// The kit the registry's tests read: built in, a base kit, with a model.
const SLUG: &str = "project-lifecycle";

fn setup() -> (
    Arc<KitInstaller>,
    Arc<dyn crate::domain_model::port::DomainObjects>,
) {
    let port = crate::domain_model::port::in_memory();
    (installer_over(port.clone()), port)
}

#[tokio::test]
async fn an_installed_kit_s_inbox_sources_apply_to_the_organization() {
    let (installer, _) = setup();
    let member = caller(Uuid::from_u128(0x3e), ORG);
    let sources = installer.inbox_sources(&member, ORG).await.unwrap();
    let ours: Vec<_> = sources.iter().filter(|s| s.kit_slug == SLUG).collect();
    assert_eq!(ours.len(), 1, "{sources:?}");
    assert_eq!(ours[0].kit_name, "Planning");
    assert_eq!(ours[0].source.id, "phase-waiting");
    // Every other source is Studio's own, turned on by its built-in kit, or an
    // `endpoint` source of a kit a project may have on its own (Constructor
    // Research): its route answers where it applies.
    assert!(
        sources
            .iter()
            .filter(|s| s.kit_slug != SLUG)
            .all(|s| matches!(s.source.kind(), "endpoint" | "studio")),
        "{sources:?}"
    );

    let platform = caller(PLATFORM_ADMIN, PLATFORM_TENANT);
    installer.uninstall_base(&platform, SLUG).await.unwrap();
    assert!(
        installer
            .inbox_sources(&member, ORG)
            .await
            .unwrap()
            .iter()
            .all(|s| s.kit_slug != SLUG)
    );

    // A query source of a kit installed nowhere is never listed; the
    // Constructor Research kit's endpoint sources are, before and after an
    // organization installs it, once each.
    let research = |sources: &[crate::kit_registry::inbox::KitInboxSource]| {
        let mut ids: Vec<String> = sources
            .iter()
            .filter(|s| s.kit_slug == "constructor-research")
            .map(|s| s.source.id.clone())
            .collect();
        ids.sort();
        ids
    };
    let before = installer.inbox_sources(&member, ORG).await.unwrap();
    assert_eq!(research(&before), ["deploy-failed", "sign-in-expires"]);
    installer
        .install_for_organization(&platform, ORG, "constructor-research", None)
        .await
        .unwrap();
    let after = installer.inbox_sources(&member, ORG).await.unwrap();
    assert_eq!(research(&after), ["deploy-failed", "sign-in-expires"]);
}

/// A platform administrator's home is the platform's tenant, where no kit's
/// overlay is applied: the lifecycle's query would be refused there, and the
/// Inbox said "not everything could be read" for it.
#[tokio::test]
async fn the_platform_tenant_lists_no_kit_query_sources() {
    let (installer, _) = setup();
    let platform = caller(PLATFORM_ADMIN, PLATFORM_TENANT);
    let sources = installer
        .inbox_sources(&platform, PLATFORM_TENANT)
        .await
        .unwrap();
    assert!(
        sources
            .iter()
            .all(|s| matches!(s.source.kind(), "endpoint" | "studio")),
        "{sources:?}"
    );
}

#[tokio::test]
async fn studio_s_own_inbox_sources_come_and_go_with_their_kits() {
    let (installer, _) = setup();
    let member = caller(Uuid::from_u128(0x3e), ORG);
    let studio = |sources: Vec<crate::kit_registry::inbox::KitInboxSource>| {
        let mut ids: Vec<(String, String)> = sources
            .into_iter()
            .filter(|s| s.source.kind() == "studio")
            .map(|s| (s.kit_slug, s.source.id))
            .collect();
        ids.sort();
        ids
    };
    let pair = |kit: &str, id: &str| (kit.to_owned(), id.to_owned());
    // Both kits are base kits: every organization has both sources.
    assert_eq!(
        studio(installer.inbox_sources(&member, ORG).await.unwrap()),
        [
            pair("project-git", "pull-requests"),
            pair("project-specs", "review-requests")
        ]
    );
    // Without project-specs there are no review requests; the pull requests
    // stay, and nothing is restarted for it.
    // (Project model, Product and Tests require Specs, ADR-0071 §5: they go
    // first.)
    let platform = caller(PLATFORM_ADMIN, PLATFORM_TENANT);
    for kit in ["project-domain-model", "project-product", "project-tests"] {
        installer.uninstall_base(&platform, kit).await.unwrap();
    }
    installer
        .uninstall_base(&platform, "project-specs")
        .await
        .unwrap();
    assert_eq!(
        studio(installer.inbox_sources(&member, ORG).await.unwrap()),
        [pair("project-git", "pull-requests")]
    );
    // Without project-git either, none of Studio's own (Delivery requires
    // it: it goes first).
    installer
        .uninstall_base(&platform, "delivery")
        .await
        .unwrap();
    installer
        .uninstall_base(&platform, "project-git")
        .await
        .unwrap();
    assert!(studio(installer.inbox_sources(&member, ORG).await.unwrap()).is_empty());
    // project-git brings a model, which is the organization's: a project
    // cannot take it while the organization's model does not carry it, so
    // nothing turns its source on behind the organization's back.
    let admin = caller(ADMIN, ORG);
    assert!(matches!(
        installer
            .install_for_project(&admin, PROJECT, "project-git", None)
            .await,
        Err(Refusal::ModelKitNotForProject(slug)) if slug == "project-git"
    ));
    assert!(studio(installer.inbox_sources(&member, ORG).await.unwrap()).is_empty());
    // The organization installs it for itself: its source is back, and goes
    // again when the organization removes it.
    installer
        .install_for_organization(&admin, ORG, "project-git", None)
        .await
        .unwrap();
    assert_eq!(
        studio(installer.inbox_sources(&member, ORG).await.unwrap()),
        [pair("project-git", "pull-requests")]
    );
    installer
        .uninstall_for_organization(&admin, ORG, "project-git")
        .await
        .unwrap();
    assert!(studio(installer.inbox_sources(&member, ORG).await.unwrap()).is_empty());
}

#[tokio::test]
async fn a_kit_s_model_comes_and_goes_with_the_kit() {
    let (installer, port) = setup();
    let runtime = runtime_of(&installer);
    let org = service_context(ORG).unwrap();
    let admin = caller(ADMIN, ORG);

    // A built-in kit is a base kit by default: the organization's model gets
    // its overlay when the organization is read.
    assert!(installer.reconcile_models(ORG).await.unwrap().is_empty());
    let carried = port.kit_models(&org).await.unwrap();
    assert!(carried.contains_key(SLUG), "{carried:?}");
    assert!(
        runtime
            .applies_to_project(&admin, PROJECT, SLUG)
            .await
            .unwrap()
    );
    assert!(
        runtime
            .applies_to_organization(&admin, ORG, SLUG)
            .await
            .unwrap()
    );

    // A kit that brings a model is the organization's: the organization's
    // model already carries this one, so a project may take its screens,
    // and the model stays as it was.
    let before = port.kit_models(&org).await.unwrap();
    installer
        .install_for_project(&admin, PROJECT, SLUG, None)
        .await
        .expect("the organization's model carries the kit");
    assert_eq!(port.kit_models(&org).await.unwrap(), before);
    installer
        .uninstall_for_project(&admin, PROJECT, SLUG)
        .await
        .unwrap();
    assert_eq!(port.kit_models(&org).await.unwrap(), before);

    // The platform takes the base kit away: the model loses the fields, and
    // the kit applies nowhere.
    let platform = caller(PLATFORM_ADMIN, PLATFORM_TENANT);
    installer.uninstall_base(&platform, SLUG).await.unwrap();
    installer.reconcile_models(ORG).await.unwrap();
    assert!(!port.kit_models(&org).await.unwrap().contains_key(SLUG));
    assert!(
        !runtime
            .applies_to_project(&admin, PROJECT, SLUG)
            .await
            .unwrap()
    );
    assert!(
        !runtime
            .applies_to_organization(&admin, ORG, SLUG)
            .await
            .unwrap()
    );

    // The organization installs it for itself: back, at once.
    installer
        .install_for_organization(&admin, ORG, SLUG, None)
        .await
        .unwrap();
    assert!(port.kit_models(&org).await.unwrap().contains_key(SLUG));
    // And uninstalls it: gone again, at once.
    installer
        .uninstall_for_organization(&admin, ORG, SLUG)
        .await
        .unwrap();
    assert!(!port.kit_models(&org).await.unwrap().contains_key(SLUG));
}

/// The model port, counting what the kits ask of it.
struct Counting {
    inner: Arc<dyn crate::domain_model::port::DomainObjects>,
    syncs: std::sync::atomic::AtomicUsize,
    model_reads: std::sync::atomic::AtomicUsize,
}

#[async_trait]
impl crate::domain_model::port::DomainObjects for Counting {
    async fn upsert(
        &self,
        ctx: &SecurityContext,
        entity: &str,
        key: &str,
        payload: serde_json::Value,
    ) -> anyhow::Result<String> {
        self.inner.upsert(ctx, entity, key, payload).await
    }
    async fn list(
        &self,
        ctx: &SecurityContext,
        entity: &str,
    ) -> anyhow::Result<Vec<crate::domain_model::port::StoredObject>> {
        self.inner.list(ctx, entity).await
    }
    async fn query(
        &self,
        ctx: &SecurityContext,
        body: serde_json::Value,
    ) -> anyhow::Result<(Vec<crate::domain_model::port::StoredObject>, usize)> {
        self.inner.query(ctx, body).await
    }
    async fn sync_kit_model(
        &self,
        ctx: &SecurityContext,
        slug: &str,
        version: &str,
        overlay: Option<&crate::domain_model::port::KitOverlay>,
    ) -> anyhow::Result<crate::domain_model::port::KitModelChange> {
        self.syncs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.inner.sync_kit_model(ctx, slug, version, overlay).await
    }
    async fn kit_models(
        &self,
        ctx: &SecurityContext,
    ) -> anyhow::Result<std::collections::BTreeMap<String, String>> {
        self.model_reads
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.inner.kit_models(ctx).await
    }
}

/// What Dev showed (#1077): every read of the kits synced every kit's model
/// (a model read, a type listing per kit, a warning per conflict). A read
/// that finds the kits the model was last brought in step with touches the
/// model not at all; a base kit's change still reaches it on the next read.
#[tokio::test]
async fn reading_the_kits_twice_with_nothing_changed_writes_nothing() {
    use crate::domain_model::port::DomainObjects;
    use std::sync::atomic::Ordering;

    let mut library = builtin_catalogue();
    library.extend(official_catalogue());
    let counting = Arc::new(Counting {
        inner: crate::domain_model::port::in_memory(),
        syncs: Default::default(),
        model_reads: Default::default(),
    });
    let installer = Arc::new(
        KitInstaller::new(library, Arc::new(Memory::default()), Arc::new(Admins))
            .with_models(Arc::new(FixedModels(counting.clone()))),
    );
    let runtime = runtime_of(&installer);
    let org = service_context(ORG).unwrap();
    let member = caller(Uuid::from_u128(0x3e), ORG);
    let admin = caller(ADMIN, ORG);

    // The first read brings the base kits' models in.
    installer.inbox_sources(&member, ORG).await.unwrap();
    assert!(counting.syncs.load(Ordering::SeqCst) > 0);
    assert!(counting.kit_models(&org).await.unwrap().contains_key(SLUG));

    // Every read after it, of whatever kind, leaves the model alone.
    counting.syncs.store(0, Ordering::SeqCst);
    counting.model_reads.store(0, Ordering::SeqCst);
    installer.models_in_step(ORG).await.unwrap();
    installer.inbox_sources(&member, ORG).await.unwrap();
    // What a kit's function reads (a project's phase), through the port.
    assert!(
        runtime
            .applies_to_project(&admin, PROJECT, SLUG)
            .await
            .unwrap()
    );
    let (_, at) = runtime.org_ctx(&admin, PROJECT).await.unwrap();
    runtime.models_in_step(ORG).await.unwrap();
    runtime.project_object(&at, PROJECT).await.unwrap();
    assert_eq!(
        counting.syncs.load(Ordering::SeqCst),
        0,
        "nothing was written"
    );
    assert_eq!(
        counting.model_reads.load(Ordering::SeqCst),
        0,
        "the model was not even read"
    );

    // The platform takes a base kit away: the next read takes its model out
    // of the organization's (ADR-0070), and the one after leaves it again.
    let platform = caller(PLATFORM_ADMIN, PLATFORM_TENANT);
    installer.uninstall_base(&platform, SLUG).await.unwrap();
    installer.models_in_step(ORG).await.unwrap();
    assert!(counting.syncs.load(Ordering::SeqCst) > 0);
    assert!(!counting.kit_models(&org).await.unwrap().contains_key(SLUG));
    counting.syncs.store(0, Ordering::SeqCst);
    installer.models_in_step(ORG).await.unwrap();
    assert_eq!(counting.syncs.load(Ordering::SeqCst), 0);

    // Concurrent first reads of another organization reconcile once.
    let other = Uuid::from_u128(0x0e2);
    let before = counting.model_reads.load(Ordering::SeqCst);
    let reads = (0..6).map(|_| installer.models_in_step(other));
    for r in futures_util::future::join_all(reads).await {
        r.unwrap();
    }
    assert_eq!(
        counting.model_reads.load(Ordering::SeqCst) - before,
        1,
        "one reconciliation, not one per read"
    );
}

#[tokio::test]
async fn the_port_reads_and_writes_the_project_s_own_object() {
    let (installer, _) = setup();
    let runtime = runtime_of(&installer);
    let admin = caller(ADMIN, ORG);
    installer.reconcile_models(ORG).await.unwrap();

    let (org, at) = runtime.org_ctx(&admin, PROJECT).await.unwrap();
    assert_eq!(org, ORG, "a project's model is its organization's");
    assert!(runtime.models().is_some());
    assert_eq!(runtime.project_object(&at, PROJECT).await.unwrap(), None);

    runtime
        .put_project_object(
            &at,
            PROJECT,
            json!({ "tenant_id": PROJECT.to_string(), "phase": "idea" }),
        )
        .await
        .unwrap();
    let (_, payload) = runtime
        .project_object(&at, PROJECT)
        .await
        .unwrap()
        .expect("written");
    assert_eq!(payload["phase"], "idea");
    assert_eq!(payload["tenant_id"], PROJECT.to_string());
}

#[test]
fn a_kit_serves_its_claimed_writes_and_its_listed_reads_only() {
    // Project lifecycle claims `PUT /project-phase` on studio-kits and lists
    // its two reads.
    assert!(super::super::claims::kit_serves(
        SLUG,
        GEAR,
        "PUT",
        "/studio-kits/v1/project-phase"
    ));
    assert!(super::super::claims::kit_serves(
        SLUG,
        GEAR,
        "GET",
        "/studio-kits/v1/project-phases"
    ));
    // Not on another gear, not another kit's, not a route nobody claims.
    assert!(!super::super::claims::kit_serves(
        SLUG,
        "studio-organizations",
        "PUT",
        "/studio-kits/v1/project-phase"
    ));
    assert!(!super::super::claims::kit_serves(
        SLUG,
        GEAR,
        "PATCH",
        "/studio-kits/v1/mna/deal"
    ));
    assert!(!super::super::claims::kit_serves(
        SLUG,
        GEAR,
        "DELETE",
        "/studio-kits/v1/project-phase"
    ));
    assert!(!super::super::claims::kit_serves(
        "no-such-kit",
        GEAR,
        "GET",
        "/studio-kits/v1/project-phase"
    ));
}

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

async fn nothing() -> StatusCode {
    StatusCode::NO_CONTENT
}

/// A kit function that serves `routes`, `(METHOD, path)`.
struct Serves(&'static [(&'static str, &'static str)]);

impl KitRoutes for Serves {
    fn register_rest(&self, mut router: Router, openapi: &dyn OpenApiRegistry) -> Router {
        for (i, (method, path)) in self.0.iter().enumerate() {
            let builder = match *method {
                "GET" => OperationBuilder::get(*path),
                "PUT" => OperationBuilder::put(*path),
                "POST" => OperationBuilder::post(*path),
                _ => OperationBuilder::delete(*path),
            };
            router = builder
                .operation_id(format!("studio_kits.test_{i}"))
                .summary("A test route")
                .tag("StudioKits")
                .authenticated()
                .require_license_features::<License>([])
                .handler(nothing)
                .no_content_response(StatusCode::NO_CONTENT, "Done")
                .register(router, openapi);
        }
        router
    }
}

#[test]
fn the_gate_mounts_a_kit_s_claimed_routes() {
    let openapi = OpenApiRegistryImpl::new();
    let routes = Serves(&[
        ("GET", "/studio-kits/v1/project-phase"),
        ("PUT", "/studio-kits/v1/project-phase"),
        ("GET", "/studio-kits/v1/project-phases"),
    ]);
    let _mounted: axum::Router =
        mount(SLUG, &routes, Router::new(), &openapi).expect("every route is claimed");
}

#[test]
fn the_gate_refuses_a_kit_s_unclaimed_route() {
    let openapi = OpenApiRegistryImpl::new();
    // A write the kit does not claim, and another kit's write.
    let routes = Serves(&[
        ("GET", "/studio-kits/v1/project-phase"),
        ("POST", "/studio-kits/v1/project-phase/undo"),
        ("PUT", "/studio-kits/v1/mna/findings/{finding_id}"),
    ]);
    let err = mount(SLUG, &routes, Router::new(), &openapi)
        .expect_err("an unclaimed route stops the gear")
        .to_string();
    assert!(
        err.contains("POST /studio-kits/v1/project-phase/undo")
            && err.contains("PUT /studio-kits/v1/mna/findings/{finding_id}")
            && !err.contains("GET /studio-kits/v1/project-phase,"),
        "{err}"
    );
}

#[test]
fn no_two_kit_functions_share_a_kit_or_an_order() {
    let mut kits = std::collections::BTreeSet::new();
    let mut orders = std::collections::BTreeSet::new();
    for f in functions() {
        assert!(kits.insert(f.kit), "two functions for the kit {}", f.kit);
        assert!(orders.insert(f.order), "{} takes order {}", f.kit, f.order);
        assert!(
            super::super::manifest::builtin_manifest(f.kit).is_some(),
            "{} is not a built-in kit",
            f.kit
        );
    }
}
