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
    assert_eq!(sources.len(), 1, "{sources:?}");
    assert_eq!(sources[0].kit_slug, SLUG);
    assert_eq!(sources[0].kit_name, "Project lifecycle");
    assert_eq!(sources[0].source.id, "phase-waiting");

    let platform = caller(PLATFORM_ADMIN, PLATFORM_TENANT);
    installer.uninstall_base(&platform, SLUG).await.unwrap();
    assert!(
        installer
            .inbox_sources(&member, ORG)
            .await
            .unwrap()
            .is_empty()
    );
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

    // A kit that brings a model is the organization's, never one project's.
    assert!(matches!(
        installer
            .install_for_project(&admin, PROJECT, SLUG, None)
            .await,
        Err(Refusal::ModelKitNotForProject(_))
    ));

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
