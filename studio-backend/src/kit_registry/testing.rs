//! An installer over memory, for the tests of the registry and of a kit's
//! function (the kit-runtime port): one organization with one project, an
//! organization administrator and a platform administrator.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::installed::{
    InstalledDocument, InstalledKit, InstalledStore, KitAuthority, KitInstaller, Refusal,
};
use super::models::FixedModels;
use super::runtime::{InstallerRuntime, KitRuntime};
use super::service::{builtin_catalogue, official_catalogue};
use crate::domain_model::port::DomainObjects;

pub(crate) const ORG: Uuid = Uuid::from_u128(0xc31d);
pub(crate) const PROJECT: Uuid = Uuid::from_u128(0x9a0e);
/// The organization's administrator.
pub(crate) const ADMIN: Uuid = Uuid::from_u128(0x0a);
pub(crate) const PLATFORM_ADMIN: Uuid = Uuid::from_u128(0xad);

/// The installations, in memory. [`PROJECT`] is [`ORG`]'s.
#[derive(Default)]
pub(crate) struct Memory {
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

/// [`ADMIN`] manages [`ORG`]'s kits; [`PLATFORM_ADMIN`] everybody's.
pub(crate) struct Admins;

#[async_trait]
impl KitAuthority for Admins {
    async fn is_platform_admin(&self, ctx: &SecurityContext) -> bool {
        ctx.subject_id() == PLATFORM_ADMIN
    }
    async fn may_manage(&self, ctx: &SecurityContext, _: Uuid) -> bool {
        ctx.subject_id() == ADMIN || ctx.subject_id() == PLATFORM_ADMIN
    }
}

/// `subject`, at home in `home`.
pub(crate) fn caller(subject: Uuid, home: Uuid) -> SecurityContext {
    SecurityContext::builder()
        .subject_id(subject)
        .subject_type("user")
        .subject_tenant_id(home)
        .token_scopes(vec!["*".into()])
        .build()
        .unwrap()
}

/// The installer over [`Memory`] with every built-in and official kit, its
/// model `port`.
pub(crate) fn installer_over(port: Arc<dyn DomainObjects>) -> Arc<KitInstaller> {
    let mut library = builtin_catalogue();
    library.extend(official_catalogue());
    Arc::new(
        KitInstaller::new(library, Arc::new(Memory::default()), Arc::new(Admins))
            .with_models(Arc::new(FixedModels(port))),
    )
}

/// The kit-runtime port over `installer`, as studio-kits lends it.
pub(crate) fn runtime_of(installer: &Arc<KitInstaller>) -> Arc<dyn KitRuntime> {
    Arc::new(InstallerRuntime(Arc::clone(installer)))
}

/// Everybody reaches every tenant: the access a kit function's routes are
/// mounted with in a test that only looks at what they register.
struct Anyone;

#[async_trait]
impl crate::studio_session::sdk::WorkspaceAccess for Anyone {
    async fn may_reach(&self, _: &SecurityContext, _: Uuid) -> bool {
        true
    }
}

pub(crate) fn anyone() -> crate::org_scope::OrgAccess {
    crate::org_scope::OrgAccess(Arc::new(Anyone))
}
