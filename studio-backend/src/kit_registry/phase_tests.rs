use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;

use super::*;
use crate::kit_registry::installed::{
    InstalledDocument, InstalledKit, InstalledStore, KitAuthority, PLATFORM_TENANT, service_context,
};
use crate::kit_registry::models::FixedModels;
use crate::kit_registry::service::{builtin_catalogue, official_catalogue};

const ORG: Uuid = Uuid::from_u128(0xc31d);
const PROJECT: Uuid = Uuid::from_u128(0x9a0e);
const ADMIN: Uuid = Uuid::from_u128(0x0a);
const PLATFORM_ADMIN: Uuid = Uuid::from_u128(0xad);

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
    async fn is_platform_admin(&self, ctx: &SecurityContext) -> bool {
        ctx.subject_id() == PLATFORM_ADMIN
    }
    async fn may_manage(&self, ctx: &SecurityContext, _: Uuid) -> bool {
        ctx.subject_id() == ADMIN || ctx.subject_id() == PLATFORM_ADMIN
    }
}

fn caller(subject: Uuid, home: Uuid) -> SecurityContext {
    SecurityContext::builder()
        .subject_id(subject)
        .subject_type("user")
        .subject_tenant_id(home)
        .token_scopes(vec!["*".into()])
        .build()
        .unwrap()
}

fn setup() -> (
    KitInstaller,
    Arc<dyn crate::domain_model::port::DomainObjects>,
) {
    let mut library = builtin_catalogue();
    library.extend(official_catalogue());
    let port = crate::domain_model::port::in_memory();
    let installer = KitInstaller::new(library, Arc::new(Memory::default()), Arc::new(Admins))
        .with_models(Arc::new(FixedModels(port.clone())));
    (installer, port)
}

#[tokio::test]
async fn an_installed_kit_s_inbox_sources_apply_to_the_organization() {
    let (installer, _) = setup();
    let member = caller(Uuid::from_u128(0x3e), ORG);
    let sources = installer.inbox_sources(&member, ORG).await.unwrap();
    let ours: Vec<_> = sources.iter().filter(|s| s.kit_slug == SLUG).collect();
    assert_eq!(ours.len(), 1, "{sources:?}");
    assert_eq!(ours[0].kit_name, "Project lifecycle");
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
    let platform = caller(PLATFORM_ADMIN, PLATFORM_TENANT);
    installer
        .uninstall_base(&platform, "project-specs")
        .await
        .unwrap();
    assert_eq!(
        studio(installer.inbox_sources(&member, ORG).await.unwrap()),
        [pair("project-git", "pull-requests")]
    );
    // Without project-git either, none of Studio's own.
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

#[test]
fn the_phase_lifecycle_is_the_kit_s() {
    let l = lifecycle();
    assert_eq!(l.states, ["idea", "discovery", "build", "run"]);
    assert_eq!(l.initial.as_deref(), Some("idea"));
    // No phase yet: any starts it.
    assert!(l.allows(None, "build"));
    assert!(l.allows(Some("idea"), "discovery"));
    assert!(l.allows(Some("build"), "build"), "staying is not a move");
    assert!(l.allows(Some("build"), "idea"));
    assert!(!l.allows(Some("idea"), "run"));
    assert!(!l.allows(Some("idea"), "nowhere"));
    assert_eq!(
        l.next(Some("discovery")),
        [
            ("build".to_owned(), "build".to_owned()),
            ("rethink".to_owned(), "idea".to_owned())
        ]
    );
}

#[tokio::test]
async fn project_lifecycle_brings_its_model_and_takes_it_away() {
    let (installer, port) = setup();
    let org = service_context(ORG).unwrap();

    // A built-in kit is a base kit by default: the organization's model gets
    // its overlay when the organization is read.
    assert!(installer.reconcile_models(ORG).await.unwrap().is_empty());
    let carried = port.kit_models(&org).await.unwrap();
    assert!(carried.contains_key(SLUG), "{carried:?}");

    // Its phase moves along the lifecycle only.
    let admin = caller(ADMIN, ORG);
    let none = installer.project_phase(&admin, PROJECT).await.unwrap();
    assert!(none.installed);
    assert_eq!(none.phase, None);
    let set = installer
        .set_project_phase(&admin, PROJECT, "idea", None)
        .await
        .unwrap();
    assert_eq!(set.phase.as_deref(), Some("idea"));
    assert_eq!(set.owner, Some(ADMIN.to_string()), "the caller owns it");
    assert!(set.since.is_some());
    assert!(matches!(
        installer
            .set_project_phase(&admin, PROJECT, "run", None)
            .await,
        Err(Refusal::NoSuchTransition(_))
    ));
    let moved = installer
        .set_project_phase(&admin, PROJECT, "discovery", Some("someone"))
        .await
        .unwrap();
    assert_eq!(moved.owner.as_deref(), Some("someone"));
    let (applies, rows) = installer.project_phases(&admin, ORG).await.unwrap();
    assert!(applies);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0, PROJECT.to_string());
    assert_eq!(rows[0].1, "discovery");

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

    // The platform takes the base kit away: the model loses the fields.
    let platform = caller(PLATFORM_ADMIN, PLATFORM_TENANT);
    installer.uninstall_base(&platform, SLUG).await.unwrap();
    installer.reconcile_models(ORG).await.unwrap();
    assert!(!port.kit_models(&org).await.unwrap().contains_key(SLUG));
    let gone = installer.project_phase(&admin, PROJECT).await.unwrap();
    assert!(!gone.installed);
    assert!(matches!(
        installer
            .set_project_phase(&admin, PROJECT, "build", None)
            .await,
        Err(Refusal::KitNotInstalled(_))
    ));

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
    let installer = KitInstaller::new(library, Arc::new(Memory::default()), Arc::new(Admins))
        .with_models(Arc::new(FixedModels(counting.clone())));
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
    installer.project_phase(&admin, PROJECT).await.unwrap();
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
