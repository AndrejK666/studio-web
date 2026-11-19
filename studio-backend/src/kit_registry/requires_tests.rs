use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::super::installed::{
    InstalledDocument, InstalledStore, KitAuthority, PLATFORM_TENANT, Refusal,
};
use super::*;
use crate::kit_registry::claims::builtin_manifests;
use crate::kit_registry::manifest::needs_id_ok;
use crate::kit_registry::service::{builtin_catalogue, official_catalogue};

const ORG: Uuid = Uuid::from_u128(0x7e01);
const PROJECT: Uuid = Uuid::from_u128(0x7e02);
const PLATFORM_ADMIN: Uuid = Uuid::from_u128(0xad);
const ORG_ADMIN: Uuid = Uuid::from_u128(0x0a);
const RESEARCH: &str = "constructor-research";
/// What Constructor Research requires (ADR-0071 §5): the delivery kit.
const DELIVERY: &str = "delivery";

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

struct Roles;

#[async_trait]
impl KitAuthority for Roles {
    async fn is_platform_admin(&self, ctx: &SecurityContext) -> bool {
        ctx.subject_id() == PLATFORM_ADMIN
    }
    async fn may_manage(&self, ctx: &SecurityContext, org: Uuid) -> bool {
        ctx.subject_id() == PLATFORM_ADMIN || (ctx.subject_id() == ORG_ADMIN && org == ORG)
    }
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

fn installer() -> KitInstaller {
    let mut catalogue = builtin_catalogue();
    catalogue.extend(official_catalogue());
    KitInstaller::new(catalogue, Arc::new(Memory::default()), Arc::new(Roles))
}

#[test]
fn the_built_in_kits_declare_the_adr_s_two_requirements() {
    let requires: Vec<(String, Vec<String>)> = builtin_manifests()
        .into_iter()
        .filter(|m| !m.requires.is_empty())
        .map(|m| (m.slug, m.requires))
        .collect();
    assert_eq!(
        requires,
        [
            (
                "project-domain-model".to_owned(),
                vec!["project-specs".to_owned()]
            ),
            // A Gears project composes a product and ships it.
            (
                "gears-project".to_owned(),
                vec!["project-product".to_owned(), DELIVERY.to_owned()]
            ),
            (RESEARCH.to_owned(), vec![DELIVERY.to_owned()]),
            // ADR-0072: the matcher's proposals go into the product.
            (
                "gears-matcher".to_owned(),
                vec!["project-product".to_owned()]
            ),
        ]
    );
    // Every required kit is one of the library's built-in kits.
    let slugs: Vec<String> = builtin_catalogue().into_iter().map(|k| k.slug).collect();
    for (_, r) in &requires {
        assert!(r.iter().all(|s| slugs.contains(s)), "{r:?}");
    }
}

#[test]
fn no_screen_needs_a_bare_type_id() {
    for kit in builtin_catalogue() {
        let detail = crate::kit_registry::contents::describe(kit);
        for s in &detail.contents.screens {
            for n in &s.needs {
                assert!(needs_id_ok(n), "{}: `{n}` is not a GTS id", detail.kit.slug);
            }
        }
    }
    assert!(needs_id_ok("gts.cf.studio.domain.pull_request.v1~"));
    assert!(needs_id_ok("gts.cf.studio.kit.project_lifecycle.phase.v1~"));
    for bare in [
        "milestone",
        "pull-request",
        "gts.cf.studio.domain.pull-request.v1~",
        "gts.cf.studio.domain.milestone.v1",
        "gts.cf.studio.other.milestone.v1~",
    ] {
        assert!(!needs_id_ok(bare), "{bare}");
    }
}

#[tokio::test]
async fn installing_a_kit_whose_required_kit_does_not_apply_is_refused_naming_it() {
    let installer = installer();
    let platform = caller(PLATFORM_ADMIN, PLATFORM_TENANT);
    let admin = caller(ORG_ADMIN, ORG);
    // Without the delivery kit anywhere.
    installer.uninstall_base(&platform, DELIVERY).await.unwrap();
    match installer
        .install_for_organization(&admin, ORG, RESEARCH, None)
        .await
    {
        Err(Refusal::RequiresKits { kit, missing }) => {
            assert_eq!(kit, RESEARCH);
            assert_eq!(missing, [DELIVERY]);
        }
        other => panic!("{other:?}"),
    }
    // Nor for one project, nor as a base kit.
    assert!(matches!(
        installer
            .install_for_project(&admin, PROJECT, RESEARCH, None)
            .await,
        Err(Refusal::RequiresKits { .. })
    ));
    assert!(matches!(
        installer.install_base(&platform, RESEARCH, None).await,
        Err(Refusal::RequiresKits { .. })
    ));
    // Nothing was recorded.
    let installed = installer.installed(&admin, ORG).await.unwrap();
    assert!(installed.effective.iter().all(|k| k.kit_slug != RESEARCH));
    // With the delivery kit, it installs.
    installer
        .install_for_organization(&admin, ORG, DELIVERY, None)
        .await
        .unwrap();
    installer
        .install_for_organization(&admin, ORG, RESEARCH, None)
        .await
        .unwrap();
}

#[tokio::test]
async fn uninstalling_a_kit_another_still_needs_is_refused_naming_it() {
    let installer = installer();
    let platform = caller(PLATFORM_ADMIN, PLATFORM_TENANT);
    let admin = caller(ORG_ADMIN, ORG);
    // A base kit another base kit requires.
    match installer.uninstall_base(&platform, "project-specs").await {
        Err(Refusal::RequiredBy { kit, by }) => {
            assert_eq!(kit, "project-specs");
            assert_eq!(by, ["project-domain-model"]);
        }
        other => panic!("{other:?}"),
    }
    // Both, the requiring one first, go.
    installer
        .uninstall_base(&platform, "project-domain-model")
        .await
        .unwrap();
    installer
        .uninstall_base(&platform, "project-specs")
        .await
        .unwrap();

    // An organization's own kit the organization's research kit requires.
    installer.uninstall_base(&platform, DELIVERY).await.unwrap();
    installer
        .install_for_organization(&admin, ORG, DELIVERY, None)
        .await
        .unwrap();
    installer
        .install_for_organization(&admin, ORG, RESEARCH, None)
        .await
        .unwrap();
    assert!(matches!(
        installer
            .uninstall_for_organization(&admin, ORG, DELIVERY)
            .await,
        Err(Refusal::RequiredBy { ref by, .. }) if by == &[RESEARCH]
    ));
    // A project's own: the same rule on its level.
    installer
        .uninstall_for_organization(&admin, ORG, RESEARCH)
        .await
        .unwrap();
    installer
        .install_for_project(&admin, PROJECT, RESEARCH, None)
        .await
        .unwrap();
    assert!(matches!(
        installer
            .uninstall_for_organization(&admin, ORG, DELIVERY)
            .await,
        Ok(())
    ));
    // The organization's level does not see the project's kit; the project
    // now reads the research kit without what it requires, as any kit whose
    // requirement went away. Installing it again for the project is refused.
    installer
        .uninstall_for_project(&admin, PROJECT, RESEARCH)
        .await
        .unwrap();
    assert!(matches!(
        installer
            .install_for_project(&admin, PROJECT, RESEARCH, None)
            .await,
        Err(Refusal::RequiresKits { .. })
    ));
}
