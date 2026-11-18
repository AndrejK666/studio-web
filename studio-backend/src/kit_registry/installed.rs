//! Which kits apply to an organization, and who installs them (ADR-0068 §4–5
//! as amended by ADR-0069 §4).
//!
//! Two kinds of installation:
//!
//! * **Base kits**, installed by a platform administrator for every
//!   organization. One document on the platform's root tenant. The built-in
//!   kits are base kits by default: a built-in kit with no record is installed,
//!   and removing one records it in `removed_builtin` so it stays removed. The
//!   opt-in built-in kits ([`super::service::OPT_IN_BUILTIN`]) are not: they
//!   are base kits only once a platform administrator installs one.
//! * **Organization kits**, installed by an organization administrator (or a
//!   platform administrator) for that organization only. One document on the
//!   organization's tenant.
//!
//! * **Project kits**, installed for one project only by whoever may install
//!   kits for the project's organization (its owner, a role with
//!   [`MANAGE_PRIVILEGE`], or a platform administrator): a project has no
//!   access config of its own, so the organization's answers for it. One
//!   document on the project's tenant. Only a kit whose `levels` name
//!   `project` may be.
//!
//! An organization cannot uninstall a base kit, and a project neither a base
//! kit nor an organization kit. A kit installed on more than one level is one
//! installation where they meet, at the newest of the versions ([`effective`]).
//!
//! Both documents are account-management tenant metadata of
//! [`KITS_INSTALLED_METADATA_TYPE`], written by this gear as the service after
//! it has checked who may change them (`studio_authz_plugin::GEAR_HELD_METADATA`
//! refuses anybody else's write). The base document is read as the service
//! too: a member of an organization is not a member of the root, and what
//! Studio is for everyone is not a secret.

use std::cmp::Ordering;
use std::sync::Arc;

use account_management_sdk::{AccountManagementClient, UpsertMetadataRequest};
use anyhow::anyhow;
use async_trait::async_trait;
use gts::GtsTypeId;
use serde::{Deserialize, Serialize};
use toolkit::client_hub::{ClientHub, ClientScope};
use toolkit_canonical_errors::CanonicalError;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::service::{
    KitDescriptor, SHELF_BUILTIN, SHELF_ORGANIZATION, is_opt_in_builtin, normalize_slug,
    normalize_version, now_rfc3339,
};

/// The installed kits of one tenant: the base kits on the platform root, an
/// organization's own kits on the organization.
pub const KITS_INSTALLED_METADATA_TYPE: &str =
    "gts.cf.core.am.tenant_metadata.v1~cf.studio.kits.installed.v1~";

/// The platform's root tenant, where the base kits are kept. The same
/// constant studio-user and the components catalogue name the root by.
pub const PLATFORM_TENANT: Uuid = Uuid::from_u128(1);

/// The privilege that lets an organization's role install kits for it
/// (`access_config::PRIVILEGES`). Its owner and a platform administrator may
/// without it.
pub const MANAGE_PRIVILEGE: &str = "kit.manage";

/// The subject this gear writes the installed-kit documents as. Fixed, so an
/// audit of account-management says which gear changed a row.
pub const SERVICE_SUBJECT_ID: Uuid = Uuid::from_u128(0x5e7d_0e4b_9a21_4c6e_8f03_0000_0000_c175);

/// How many times a write re-reads and tries again when somebody else wrote
/// the same document in between.
const WRITE_ATTEMPTS: usize = 4;

/// A base kit (installed by the platform).
pub const KIND_BASE: &str = "base";
/// An organization kit (installed by the organization for itself).
pub const KIND_ORGANIZATION: &str = "organization";
/// A project kit (installed for that project only).
pub const KIND_PROJECT: &str = "project";
/// The level a kit's `levels` must name to be installed in a project.
pub const LEVEL_PROJECT: &str = "project";

/// The stored document, on the root (base kits) or an organization.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstalledDocument {
    #[serde(default)]
    pub kits: Vec<InstalledRecord>,
    /// Built-in kits a platform administrator removed. Only the root's
    /// document has any: without the list a built-in kit would come back as a
    /// default the moment its record was gone.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub removed_builtin: Vec<String>,
    /// The organization's own kits (ADR-0068 phase 7, [`super::shelf`]).
    /// Only an organization's document has any.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shelf: Vec<super::shelf::ShelfKit>,
    /// Pinned manifests still used by installations after the shelf moves on.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shelf_versions: Vec<super::shelf::ShelfKit>,
    /// What resolving retired kit slugs did to this document (ADR-0071 §8),
    /// for its administrators: set by the migration that wrote it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub renamed: Option<super::aliases::KitRenameReport>,
}

/// One installation as stored.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstalledRecord {
    pub kit_slug: String,
    pub version: String,
    pub shelf: String,
    pub installed_by: String,
    /// RFC 3339, UTC.
    pub installed_at: String,
}

/// One installation as a caller sees it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstalledKit {
    pub kit_slug: String,
    pub version: String,
    pub shelf: String,
    /// [`KIND_BASE`], [`KIND_ORGANIZATION`] or [`KIND_PROJECT`].
    pub kind: &'static str,
    /// `None` for a built-in kit installed by default: nobody installed it.
    pub installed_by: Option<String>,
    pub installed_at: Option<String>,
    pub by_default: bool,
    /// A retired slug listed for an old client during the alias release
    /// (ADR-0071 §8): everything it resolves to applies. Never stored.
    pub retired: bool,
}

/// What applies to one organization, or to one project of it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Installed {
    pub organization_id: Uuid,
    /// The project asked about; `None` for an organization.
    pub project_id: Option<Uuid>,
    pub base: Vec<InstalledKit>,
    pub organization: Vec<InstalledKit>,
    /// The project's own kits; empty for an organization.
    pub project: Vec<InstalledKit>,
    pub effective: Vec<InstalledKit>,
}

/// Why a request was not done.
#[derive(Debug)]
pub enum Refusal {
    /// 403 with this reason.
    Forbidden(&'static str),
    /// 400 `invalid_argument`.
    Invalid(String),
    /// 404: the slug names no kit of the library, or nothing installed.
    NotFound(String, String),
    /// 400 `failed_precondition`: the kit is a base kit, which an
    /// organization or a project cannot uninstall.
    BaseKit(String),
    /// 400 `failed_precondition`: the kit is the organization's, which a
    /// project cannot uninstall.
    OrganizationKit(String),
    /// 400 `failed_precondition`: the kit's `levels` do not name `project`,
    /// so it cannot be installed in one.
    NotAProjectKit(String),
    /// 400 `failed_precondition`: an organization's kit would shadow a
    /// built-in or official kit of the same slug.
    SlugTaken(String),
    /// 400 `failed_precondition`: the organization has the kit installed, so
    /// it stays on its shelf.
    KitInstalled(String),
    /// 400 `failed_precondition`: the organization's model already has
    /// part of what the kit's overlay brings, from somebody else.
    ModelConflict(String),
    /// 400 `failed_precondition`: the kit brings a model, which is the
    /// organization's, so it is not installed for one project.
    ModelKitNotForProject(String),
    /// 400 `failed_precondition`: the kit a function belongs to does not
    /// apply where it was asked.
    KitNotInstalled(String),
    /// 400 `failed_precondition`: a lifecycle does not declare the move.
    NoSuchTransition(String),
    /// 400 `failed_precondition`: the kit requires kits that would not apply
    /// where it is installed (ADR-0071 §5): `kit`, and what is `missing`.
    RequiresKits {
        kit: String,
        missing: Vec<String>,
    },
    /// 400 `failed_precondition`: kits that would still apply require the
    /// kit being uninstalled (ADR-0071 §5): `kit`, and the kits that need it.
    RequiredBy {
        kit: String,
        by: Vec<String>,
    },
    Internal(anyhow::Error),
}

impl From<anyhow::Error> for Refusal {
    fn from(error: anyhow::Error) -> Self {
        Self::Internal(error)
    }
}

/// The 403 reasons.
pub const PLATFORM_ADMIN_REQUIRED: &str = "PLATFORM_ADMIN_REQUIRED";
pub const KIT_ADMIN_REQUIRED: &str = "KIT_ADMIN_REQUIRED";
/// The `failed_precondition` kind for removing a base kit.
pub const BASE_KIT: &str = "BASE_KIT";
/// The `failed_precondition` kind for a project removing its organization's kit.
pub const ORGANIZATION_KIT: &str = "ORGANIZATION_KIT";
/// The `failed_precondition` kind for installing in a project a kit whose
/// `levels` do not name `project`.
pub const NOT_A_PROJECT_KIT: &str = "NOT_A_PROJECT_KIT";
/// The `failed_precondition` kind for installing a kit where a kit it
/// requires does not apply (ADR-0071 §5).
pub const KIT_REQUIRES_KIT: &str = "KIT_REQUIRES_KIT";
/// The `failed_precondition` kind for uninstalling a kit another kit that
/// still applies requires (ADR-0071 §5).
pub const KIT_REQUIRED_BY: &str = "KIT_REQUIRED_BY";

/// Where the documents are kept.
#[async_trait]
pub trait InstalledStore: Send + Sync {
    /// The document on `tenant`, read as `ctx`; empty when there is none.
    async fn read(&self, ctx: &SecurityContext, tenant: Uuid) -> anyhow::Result<InstalledDocument>;

    /// Read, change and write back the document on `tenant` as the service,
    /// version-checked. `change` may refuse; nothing is written then.
    async fn update(
        &self,
        tenant: Uuid,
        change: &mut (
                 dyn for<'d> FnMut(
            &'d mut InstalledDocument,
        ) -> Result<Option<InstalledKit>, Refusal>
                     + Send
             ),
    ) -> Result<Option<InstalledKit>, Refusal>;

    /// The organization `tenant` belongs to (itself for an organization).
    async fn organization_of(&self, ctx: &SecurityContext, tenant: Uuid) -> Uuid;

    /// Is `tenant` a project (account-management's tenant type), read as `ctx`?
    async fn is_project(&self, ctx: &SecurityContext, tenant: Uuid) -> bool;
}

/// Who may change installations.
#[async_trait]
pub trait KitAuthority: Send + Sync {
    async fn is_platform_admin(&self, ctx: &SecurityContext) -> bool;
    /// May the caller install kits for `org`? Its owner, a role carrying
    /// [`MANAGE_PRIVILEGE`], or a platform administrator.
    async fn may_manage(&self, ctx: &SecurityContext, org: Uuid) -> bool;
}

pub struct KitInstaller {
    catalogue: Vec<KitDescriptor>,
    /// The documents read and written through the alias table (ADR-0071 §8,
    /// [`MigratingStore`]).
    store: Arc<dyn InstalledStore>,
    /// The same documents as stored: what the kit-rename sweep reads to see
    /// whether one still names a retired slug.
    raw: Arc<dyn InstalledStore>,
    authority: Arc<dyn KitAuthority>,
    reader: Arc<dyn super::shelf::KitSourceReader>,
    models: Option<Arc<dyn super::models::ModelPort>>,
    events: Option<Arc<dyn crate::studio_events::StudioEventPublisher>>,
    /// Which kits each organization's model was last brought in step with
    /// ([`super::models::InStep`]): a read that finds the same set writes
    /// nothing.
    in_step: super::models::InStep,
}

impl KitInstaller {
    pub fn new(
        catalogue: Vec<KitDescriptor>,
        store: Arc<dyn InstalledStore>,
        authority: Arc<dyn KitAuthority>,
    ) -> Self {
        let builtin = catalogue
            .iter()
            .filter(|k| k.shelf == SHELF_BUILTIN)
            .map(|k| k.slug.clone())
            .collect();
        Self {
            catalogue,
            store: Arc::new(MigratingStore {
                inner: store.clone(),
                builtin,
            }),
            raw: store,
            authority,
            reader: Arc::new(super::shelf::NoReader),
            models: None,
            events: None,
            in_step: super::models::InStep::default(),
        }
    }

    pub(super) fn in_step(&self) -> &super::models::InStep {
        &self.in_step
    }

    /// Publish `kit.installed` / `kit.uninstalled` through `events`
    /// ([`super::events`]).
    pub fn with_events(
        mut self,
        events: Arc<dyn crate::studio_events::StudioEventPublisher>,
    ) -> Self {
        self.events = Some(events);
        self
    }

    fn announce(&self, kind: &str, level: super::events::Level, slug: &str, version: Option<&str>) {
        if let Some(events) = &self.events {
            events.publish(super::events::event(kind, level, slug, version));
        }
    }

    /// Import kits' model overlays through `models` (ADR-0067 §6). Without
    /// it, installing records the kit and leaves the model alone.
    pub fn with_models(mut self, models: Arc<dyn super::models::ModelPort>) -> Self {
        self.models = Some(models);
        self
    }

    pub(super) fn models(&self) -> Option<Arc<dyn crate::domain_model::port::DomainObjects>> {
        self.models.as_ref().and_then(|m| m.get())
    }

    /// Read organizations' kit sources with `reader`.
    pub fn with_reader(mut self, reader: Arc<dyn super::shelf::KitSourceReader>) -> Self {
        self.reader = reader;
        self
    }

    pub(super) fn store(&self) -> &dyn InstalledStore {
        self.store.as_ref()
    }

    pub(super) fn reader(&self) -> &dyn super::shelf::KitSourceReader {
        self.reader.as_ref()
    }

    /// The library every organization shares: built-in and official kits.
    pub(super) fn library(&self) -> &[KitDescriptor] {
        &self.catalogue
    }

    pub(super) async fn require_org_admin_pub(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
    ) -> Result<Uuid, Refusal> {
        self.require_org_admin(ctx, tenant).await
    }

    /// Kit `slug` of the library as `org` sees it: the shared library, then
    /// the organization's own shelf.
    pub(super) async fn kit_for(&self, org: Uuid, slug: &str) -> Result<KitDescriptor, Refusal> {
        if let Ok(kit) = self.kit(slug) {
            return Ok(kit);
        }
        if org != PLATFORM_TENANT
            && let Some(own) = self
                .store
                .read(&service_context(org)?, org)
                .await?
                .shelf
                .into_iter()
                .find(|k| k.kit.slug == slug)
        {
            return Ok(own.kit);
        }
        self.kit(slug)
    }

    /// What applies to the organization `tenant` belongs to. The caller has
    /// already been shown to reach `tenant` (`org_scope::OrgCtx`).
    pub async fn installed(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
    ) -> Result<Installed, Refusal> {
        let org = self.store.organization_of(ctx, tenant).await;
        let root = self
            .store
            .read(&service_context(PLATFORM_TENANT)?, PLATFORM_TENANT)
            .await?;
        let base = base_kits(&root, &self.catalogue);
        // Read as the service: the caller's reach was checked by `OrgCtx`,
        // and a platform administrator acting in an organization is not a
        // member of it.
        let organization = if org == PLATFORM_TENANT {
            Vec::new()
        } else {
            organization_kits(
                &self.store.read(&service_context(org)?, org).await?,
                &self.catalogue,
            )
        };
        let effective = effective(&base, &organization);
        Ok(Installed {
            organization_id: org,
            project_id: None,
            base,
            organization,
            project: Vec::new(),
            effective,
        })
    }

    /// What applies to `project`: its organization's kits and its own. The
    /// caller has already been shown to reach `project`.
    pub async fn installed_in_project(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
    ) -> Result<Installed, Refusal> {
        self.require_project(ctx, project).await?;
        let mut installed = self.installed(ctx, project).await?;
        // Read as the service, as the organization's document is.
        let own = project_kits(
            &self.store.read(&service_context(project)?, project).await?,
            &self.catalogue,
        );
        installed.effective = effective(&installed.effective, &own);
        installed.project_id = Some(project);
        installed.project = own;
        Ok(installed)
    }

    /// Install `slug` for `project` only, at `version` or the kit's default.
    /// The kit's `levels` must name `project`.
    async fn install_for_project_one(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        slug: &str,
        version: Option<&str>,
    ) -> Result<InstalledKit, Refusal> {
        let slug = normalize_slug(slug).map_err(|e| Refusal::Invalid(e.to_string()))?;
        let org = self.require_project_admin(ctx, project).await?;
        self.install_project_kit(ctx, ctx, project, org, slug, version)
            .await
    }

    pub(super) async fn install_for_created_project(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        organization: Uuid,
        slug: &str,
    ) -> Result<InstalledKit, Refusal> {
        if ctx.subject_id() != crate::organizations::SERVICE_SUBJECT_ID
            || ctx.subject_tenant_id() != project
        {
            return Err(Refusal::Forbidden(KIT_ADMIN_REQUIRED));
        }
        if super::manifest::project_type_kit(slug).is_none() {
            return Err(Refusal::Invalid(format!(
                "`{slug}` does not define a project type"
            )));
        }
        // The run's context reaches the new project and nothing above it, so
        // the project's organization (its workspace's parent) is read as this
        // gear in the organization the plan names, then checked against it.
        let reader = service_context(organization).map_err(Refusal::Internal)?;
        let installed = self.installed_in_project(&reader, project).await?;
        let org = installed.organization_id;
        if org != organization || org == project {
            return Err(Refusal::Forbidden(KIT_ADMIN_REQUIRED));
        }
        if let Some(kit) = installed
            .project
            .into_iter()
            .find(|kit| kit.kit_slug == slug)
        {
            return Ok(kit);
        }
        self.install_project_kit(ctx, &reader, project, org, slug.to_owned(), None)
            .await
    }

    /// Install `slug` in `project` of `org` as `ctx`, reading what applies
    /// above the project as `reader`.
    async fn install_project_kit(
        &self,
        ctx: &SecurityContext,
        reader: &SecurityContext,
        project: Uuid,
        org: Uuid,
        slug: String,
        version: Option<&str>,
    ) -> Result<InstalledKit, Refusal> {
        let kit = self.kit_for(org, &slug).await?;
        if !kit.levels.iter().any(|level| level == LEVEL_PROJECT) {
            return Err(Refusal::NotAProjectKit(slug));
        }
        let record = record_for(&kit, version, ctx, now_rfc3339()?)?;
        // The model is the organization's (ADR-0067 §6, ADR-0068 §5): a kit
        // that brings one is installed for the organization, never for one
        // project, unless the organization's model already carries it (a
        // base kit, or the organization's own): the project then adds the
        // kit's screens and nothing of the model changes (ADR-0070 phase 5
        // moved every project tab's types into such kits).
        if let super::models::KitModel::Overlay(_) =
            self.model_of(org, &kit, &record.version).await?
        {
            let carried = match self.models() {
                Some(port) => port
                    .kit_models(&service_context(org).map_err(Refusal::Internal)?)
                    .await
                    .map_err(Refusal::Internal)?
                    .contains_key(&slug),
                None => false,
            };
            if !carried {
                return Err(Refusal::ModelKitNotForProject(slug));
            }
        }
        // What it requires must apply to the project once it is installed
        // (ADR-0071 §5).
        let above = self.installed(reader, project).await?;
        let mut doc = self.store.read(&service_context(project)?, project).await?;
        install_project(&mut doc, record.clone());
        let after = effective(&above.effective, &project_kits(&doc, &self.catalogue));
        self.check_requires(org, &slug, &record.version, &after)
            .await?;
        let installed = self
            .store
            .update(project, &mut |doc| {
                Ok(Some(install_project(doc, record.clone())))
            })
            .await?;
        let installed = installed
            .ok_or_else(|| Refusal::Internal(anyhow!("the project kit was not recorded")))?;
        self.announce(
            super::events::INSTALLED,
            super::events::Level::Project { org, project },
            &installed.kit_slug,
            Some(&installed.version),
        );
        Ok(installed)
    }

    /// Stop `project` having `slug` as its own. Refused for a kit it has only
    /// from its organization or the platform.
    async fn uninstall_for_project_one(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        slug: &str,
    ) -> Result<(), Refusal> {
        let slug = normalize_slug(slug).map_err(|e| Refusal::Invalid(e.to_string()))?;
        let org = self.require_project_admin(ctx, project).await?;
        let above = self.installed(ctx, project).await?;
        let mut doc = self.store.read(&service_context(project)?, project).await?;
        if uninstall_project(&mut doc, &slug, &above.base, &above.organization).is_ok() {
            let after = effective(&above.effective, &project_kits(&doc, &self.catalogue));
            self.check_required_by(org, &slug, &after).await?;
        }
        self.store
            .update(project, &mut |doc| {
                uninstall_project(doc, &slug, &above.base, &above.organization).map(|()| None)
            })
            .await?;
        self.announce(
            super::events::UNINSTALLED,
            super::events::Level::Project { org, project },
            &slug,
            None,
        );
        Ok(())
    }

    /// `project` is a project, or the request is not one this answers.
    async fn require_project(&self, ctx: &SecurityContext, project: Uuid) -> Result<(), Refusal> {
        if self.store.is_project(ctx, project).await {
            Ok(())
        } else {
            Err(Refusal::Invalid(format!(
                "{project} is not a project: name an organization with `organization_id`"
            )))
        }
    }

    /// The organization `project` belongs to, when the caller may install
    /// kits for the project: whoever may for that organization.
    async fn require_project_admin(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
    ) -> Result<Uuid, Refusal> {
        self.require_project(ctx, project).await?;
        let org = self.store.organization_of(ctx, project).await;
        if org != project && self.authority.may_manage(ctx, org).await {
            Ok(org)
        } else {
            Err(Refusal::Forbidden(KIT_ADMIN_REQUIRED))
        }
    }

    /// Install `slug` as a base kit, at `version` or the kit's default.
    async fn install_base_one(
        &self,
        ctx: &SecurityContext,
        slug: &str,
        version: Option<&str>,
    ) -> Result<InstalledKit, Refusal> {
        let slug = normalize_slug(slug).map_err(|e| Refusal::Invalid(e.to_string()))?;
        self.require_platform_admin(ctx).await?;
        let kit = self.kit(&slug)?;
        if kit.shelf == SHELF_ORGANIZATION {
            return Err(Refusal::Invalid(format!(
                "`{slug}` is an organization's own kit: it is installed for that organization, not as a base kit"
            )));
        }
        let record = record_for(&kit, version, ctx, now_rfc3339()?)?;
        // A base kit applies to every organization: what it requires must be
        // a base kit too (ADR-0071 §5).
        let mut root = self
            .store
            .read(&service_context(PLATFORM_TENANT)?, PLATFORM_TENANT)
            .await?;
        install_base(&mut root, record.clone());
        let after = base_kits(&root, &self.catalogue);
        self.check_requires(PLATFORM_TENANT, &slug, &record.version, &after)
            .await?;
        let installed = self
            .store
            .update(PLATFORM_TENANT, &mut |doc| {
                Ok(Some(install_base(doc, record.clone())))
            })
            .await?;
        let installed =
            installed.ok_or_else(|| Refusal::Internal(anyhow!("the base kit was not recorded")))?;
        self.announce(
            super::events::INSTALLED,
            super::events::Level::Base,
            &installed.kit_slug,
            Some(&installed.version),
        );
        Ok(installed)
    }

    /// Stop `slug` being a base kit. A built-in kit stays removed until it is
    /// installed again.
    async fn uninstall_base_one(&self, ctx: &SecurityContext, slug: &str) -> Result<(), Refusal> {
        let slug = normalize_slug(slug).map_err(|e| Refusal::Invalid(e.to_string()))?;
        self.require_platform_admin(ctx).await?;
        let catalogue = &self.catalogue;
        let mut root = self
            .store
            .read(&service_context(PLATFORM_TENANT)?, PLATFORM_TENANT)
            .await?;
        if uninstall_base(&mut root, &slug, catalogue).is_ok() {
            let after = base_kits(&root, catalogue);
            self.check_required_by(PLATFORM_TENANT, &slug, &after)
                .await?;
        }
        self.store
            .update(PLATFORM_TENANT, &mut |doc| {
                uninstall_base(doc, &slug, catalogue).map(|()| None)
            })
            .await?;
        self.announce(
            super::events::UNINSTALLED,
            super::events::Level::Base,
            &slug,
            None,
        );
        Ok(())
    }

    /// Install `slug` for the organization `tenant`, at `version` or the
    /// kit's default.
    async fn install_for_organization_one(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        slug: &str,
        version: Option<&str>,
    ) -> Result<InstalledKit, Refusal> {
        let slug = normalize_slug(slug).map_err(|e| Refusal::Invalid(e.to_string()))?;
        let org = self.require_org_admin(ctx, tenant).await?;
        let kit = self.kit_for(org, &slug).await?;
        let record = record_for(&kit, version, ctx, now_rfc3339()?)?;
        // What it requires must apply to the organization once it is
        // installed (ADR-0071 §5), before anything changes.
        let root = self
            .store
            .read(&service_context(PLATFORM_TENANT)?, PLATFORM_TENANT)
            .await?;
        let mut doc = self.store.read(&service_context(org)?, org).await?;
        install_organization(&mut doc, record.clone());
        let after = effective(
            &base_kits(&root, &self.catalogue),
            &organization_kits(&doc, &self.catalogue),
        );
        self.check_requires(org, &slug, &record.version, &after)
            .await?;
        // The model first: a conflict refuses the install, and nothing is
        // recorded (ADR-0067 §6).
        self.apply_model(org, &kit, &record.version).await?;
        let installed = self
            .store
            .update(org, &mut |doc| {
                Ok(Some(install_organization(doc, record.clone())))
            })
            .await?;
        let installed = installed
            .ok_or_else(|| Refusal::Internal(anyhow!("the organization kit was not recorded")))?;
        self.announce(
            super::events::INSTALLED,
            super::events::Level::Organization(org),
            &installed.kit_slug,
            Some(&installed.version),
        );
        Ok(installed)
    }

    /// Stop the organization `tenant` having `slug`. Refused for a kit it
    /// has only as a base kit.
    async fn uninstall_for_organization_one(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        slug: &str,
    ) -> Result<(), Refusal> {
        let slug = normalize_slug(slug).map_err(|e| Refusal::Invalid(e.to_string()))?;
        let org = self.require_org_admin(ctx, tenant).await?;
        let root = self
            .store
            .read(&service_context(PLATFORM_TENANT)?, PLATFORM_TENANT)
            .await?;
        let base = base_kits(&root, &self.catalogue);
        let mut doc = self.store.read(&service_context(org)?, org).await?;
        if uninstall_organization(&mut doc, &slug, &base).is_ok() {
            let after = effective(&base, &organization_kits(&doc, &self.catalogue));
            self.check_required_by(org, &slug, &after).await?;
        }
        self.store
            .update(org, &mut |doc| {
                uninstall_organization(doc, &slug, &base).map(|()| None)
            })
            .await?;
        // Heard before the model is reconciled: the kit no longer applies,
        // whatever the model's answer.
        self.announce(
            super::events::UNINSTALLED,
            super::events::Level::Organization(org),
            &slug,
            None,
        );
        // What the kit brought into the model goes, unless it still applies
        // (a base kit too); a type with objects stays, marked left by it.
        self.reconcile_models(org).await?;
        Ok(())
    }

    fn kit(&self, slug: &str) -> Result<KitDescriptor, Refusal> {
        self.catalogue
            .iter()
            .find(|kit| kit.slug == slug)
            .cloned()
            .ok_or_else(|| {
                Refusal::NotFound(slug.to_owned(), "the kit library has no such kit".into())
            })
    }

    async fn require_platform_admin(&self, ctx: &SecurityContext) -> Result<(), Refusal> {
        if self.authority.is_platform_admin(ctx).await {
            Ok(())
        } else {
            Err(Refusal::Forbidden(PLATFORM_ADMIN_REQUIRED))
        }
    }

    /// The organization `tenant` is, when the caller may install kits for it.
    async fn require_org_admin(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
    ) -> Result<Uuid, Refusal> {
        if tenant == PLATFORM_TENANT {
            return Err(Refusal::Invalid(
                "name the organization (`organization_id`): the platform's kits are base kits"
                    .into(),
            ));
        }
        let org = self.store.organization_of(ctx, tenant).await;
        if org != tenant {
            return Err(Refusal::Invalid(format!(
                "{tenant} is not an organization: kits are installed for the organization {org}"
            )));
        }
        if self.authority.may_manage(ctx, org).await {
            Ok(org)
        } else {
            Err(Refusal::Forbidden(KIT_ADMIN_REQUIRED))
        }
    }
}

/// A request naming a retired slug (ADR-0071 §8) acts on every kit it
/// resolves to; one naming a slug that went to the shell is refused.
fn requested(slug: &str) -> Result<Vec<String>, Refusal> {
    let slug = normalize_slug(slug).map_err(|e| Refusal::Invalid(e.to_string()))?;
    match super::aliases::resolve(&slug) {
        None => Ok(vec![slug]),
        Some([]) => Err(Refusal::Invalid(format!(
            "`{slug}` was retired: what it brought is part of Studio itself now (ADR-0071 §6)"
        ))),
        Some(to) => Ok(to.iter().map(|s| (*s).to_owned()).collect()),
    }
}

impl KitInstaller {
    /// Install `slug` for `project` only, at `version` or the kit's default.
    /// The kit's `levels` must name `project`.
    pub async fn install_for_project(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        slug: &str,
        version: Option<&str>,
    ) -> Result<InstalledKit, Refusal> {
        let mut last = None;
        for s in requested(slug)? {
            last = Some(
                self.install_for_project_one(ctx, project, &s, version)
                    .await?,
            );
        }
        last.ok_or_else(|| Refusal::Internal(anyhow!("nothing to install")))
    }

    /// Stop `project` having `slug` as its own.
    pub async fn uninstall_for_project(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        slug: &str,
    ) -> Result<(), Refusal> {
        for s in requested(slug)? {
            self.uninstall_for_project_one(ctx, project, &s).await?;
        }
        Ok(())
    }

    /// Install `slug` as a base kit, at `version` or the kit's default.
    pub async fn install_base(
        &self,
        ctx: &SecurityContext,
        slug: &str,
        version: Option<&str>,
    ) -> Result<InstalledKit, Refusal> {
        let mut last = None;
        for s in requested(slug)? {
            last = Some(self.install_base_one(ctx, &s, version).await?);
        }
        last.ok_or_else(|| Refusal::Internal(anyhow!("nothing to install")))
    }

    /// Stop `slug` being a base kit.
    pub async fn uninstall_base(&self, ctx: &SecurityContext, slug: &str) -> Result<(), Refusal> {
        for s in requested(slug)? {
            self.uninstall_base_one(ctx, &s).await?;
        }
        Ok(())
    }

    /// Install `slug` for the organization `tenant`.
    pub async fn install_for_organization(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        slug: &str,
        version: Option<&str>,
    ) -> Result<InstalledKit, Refusal> {
        let mut last = None;
        for s in requested(slug)? {
            last = Some(
                self.install_for_organization_one(ctx, tenant, &s, version)
                    .await?,
            );
        }
        last.ok_or_else(|| Refusal::Internal(anyhow!("nothing to install")))
    }

    /// Stop the organization `tenant` having `slug`.
    pub async fn uninstall_for_organization(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        slug: &str,
    ) -> Result<(), Refusal> {
        for s in requested(slug)? {
            self.uninstall_for_organization_one(ctx, tenant, &s).await?;
        }
        Ok(())
    }
}

/// Every installed-kits document read through the slug alias table
/// (ADR-0071 §8, [`super::aliases::migrate`]): a retired slug reads as the
/// kits it resolves to, and the first write of a document stores it so.
pub struct MigratingStore {
    inner: Arc<dyn InstalledStore>,
    /// The built-in kits' slugs.
    builtin: Vec<String>,
}

#[async_trait]
impl InstalledStore for MigratingStore {
    async fn read(&self, ctx: &SecurityContext, tenant: Uuid) -> anyhow::Result<InstalledDocument> {
        let mut doc = self.inner.read(ctx, tenant).await?;
        super::aliases::migrate(&mut doc, &self.builtin);
        Ok(doc)
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
        let builtin = &self.builtin;
        self.inner
            .update(tenant, &mut |doc| {
                super::aliases::migrate(doc, builtin);
                change(doc)
            })
            .await
    }

    async fn organization_of(&self, ctx: &SecurityContext, tenant: Uuid) -> Uuid {
        self.inner.organization_of(ctx, tenant).await
    }

    async fn is_project(&self, ctx: &SecurityContext, tenant: Uuid) -> bool {
        self.inner.is_project(ctx, tenant).await
    }
}

impl KitInstaller {
    /// The kit-rename sweep's part for `tenant` (ADR-0071 §8): store its
    /// installed-kits document with every retired slug resolved, when it
    /// still names one. Answers whether it wrote.
    pub async fn rename_installations(&self, tenant: Uuid) -> Result<bool, Refusal> {
        let doc = self.raw.read(&service_context(tenant)?, tenant).await?;
        if !super::aliases::needs_migration(&doc) {
            return Ok(false);
        }
        self.store.update(tenant, &mut |_| Ok(None)).await?;
        Ok(true)
    }

    /// What resolving retired slugs reported on the documents that make
    /// `tenant`'s kits: the root's, its organization's, and its own.
    pub async fn rename_reports(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
    ) -> Vec<super::aliases::KitRenameReport> {
        let org = self.store.organization_of(ctx, tenant).await;
        let mut tenants = vec![PLATFORM_TENANT, org, tenant];
        tenants.dedup();
        let mut out = Vec::new();
        for t in tenants {
            let Ok(sctx) = service_context(t) else {
                continue;
            };
            if let Ok(doc) = self.store.read(&sctx, t).await
                && let Some(report) = doc.renamed
            {
                out.push(report);
            }
        }
        out
    }
}

/// The identity this gear writes its documents with, in `tenant`.
pub fn service_context(tenant: Uuid) -> anyhow::Result<SecurityContext> {
    SecurityContext::builder()
        .subject_id(SERVICE_SUBJECT_ID)
        .subject_type("service")
        .subject_tenant_id(tenant)
        .token_scopes(vec!["*".to_owned()])
        .build()
        .map_err(|e| anyhow!("studio-kits: cannot build a service context: {e}"))
}

/// The record installing `kit` writes. A built-in kit has one version,
/// Studio's: asking for another is refused rather than recorded and ignored.
fn record_for(
    kit: &KitDescriptor,
    version: Option<&str>,
    ctx: &SecurityContext,
    at: String,
) -> Result<InstalledRecord, Refusal> {
    let version = match version.map(str::trim).filter(|v| !v.is_empty()) {
        None => kit.default_version.clone(),
        Some(v) if kit.shelf == SHELF_BUILTIN && v != kit.default_version => {
            return Err(Refusal::Invalid(format!(
                "`{}` is built into Studio and comes at Studio's version {}, not {v}",
                kit.slug, kit.default_version
            )));
        }
        Some(v) if kit.shelf == SHELF_ORGANIZATION && v != kit.default_version => {
            return Err(Refusal::Invalid(format!(
                "`{}` is on the organization's shelf at commit {}, not {v}: refresh the shelf \
                 kit to move it",
                kit.slug, kit.default_version
            )));
        }
        Some(v) => normalize_version(v).map_err(|e| Refusal::Invalid(e.to_string()))?,
    };
    Ok(InstalledRecord {
        kit_slug: kit.slug.clone(),
        version,
        shelf: kit.shelf.clone(),
        installed_by: ctx.subject_id().to_string(),
        installed_at: at,
    })
}

fn view(record: &InstalledRecord, kind: &'static str, catalogue: &[KitDescriptor]) -> InstalledKit {
    // A built-in kit is whatever this image ships, whichever release
    // recorded it.
    let version = match catalogue.iter().find(|k| k.slug == record.kit_slug) {
        Some(kit) if kit.shelf == SHELF_BUILTIN => kit.default_version.clone(),
        _ => record.version.clone(),
    };
    InstalledKit {
        kit_slug: record.kit_slug.clone(),
        version,
        shelf: record.shelf.clone(),
        kind,
        installed_by: Some(record.installed_by.clone()),
        installed_at: Some(record.installed_at.clone()),
        by_default: false,
        retired: false,
    }
}

/// A built-in kit recorded by an earlier image and no longer in this one
/// cannot apply: there is nothing to show.
fn applies(record: &InstalledRecord, catalogue: &[KitDescriptor]) -> bool {
    record.shelf != SHELF_BUILTIN || catalogue.iter().any(|k| k.slug == record.kit_slug)
}

/// Is `kit` a base kit when the root has no record of it: built in, and not
/// one of the kits an organization asks for ([`super::service::OPT_IN_BUILTIN`]).
fn base_by_default(kit: &KitDescriptor) -> bool {
    kit.shelf == SHELF_BUILTIN && !is_opt_in_builtin(&kit.slug)
}

/// The base kits: what the root records, and every built-in kit nobody
/// removed, except the opt-in ones. Sorted by slug.
pub fn base_kits(root: &InstalledDocument, catalogue: &[KitDescriptor]) -> Vec<InstalledKit> {
    let mut kits: Vec<InstalledKit> = root
        .kits
        .iter()
        .filter(|record| applies(record, catalogue))
        .map(|record| view(record, KIND_BASE, catalogue))
        .collect();
    for kit in catalogue.iter().filter(|k| base_by_default(k)) {
        if root.removed_builtin.contains(&kit.slug) || kits.iter().any(|k| k.kit_slug == kit.slug) {
            continue;
        }
        kits.push(InstalledKit {
            kit_slug: kit.slug.clone(),
            version: kit.default_version.clone(),
            shelf: kit.shelf.clone(),
            kind: KIND_BASE,
            installed_by: None,
            installed_at: None,
            by_default: true,
            retired: false,
        });
    }
    kits.sort_by(|a, b| a.kit_slug.cmp(&b.kit_slug));
    kits
}

/// An organization's own kits, sorted by slug.
pub fn organization_kits(
    doc: &InstalledDocument,
    catalogue: &[KitDescriptor],
) -> Vec<InstalledKit> {
    let mut kits: Vec<InstalledKit> = doc
        .kits
        .iter()
        .filter(|record| applies(record, catalogue))
        .map(|record| view(record, KIND_ORGANIZATION, catalogue))
        .collect();
    kits.sort_by(|a, b| a.kit_slug.cmp(&b.kit_slug));
    kits
}

/// A project's own kits, sorted by slug.
pub fn project_kits(doc: &InstalledDocument, catalogue: &[KitDescriptor]) -> Vec<InstalledKit> {
    let mut kits: Vec<InstalledKit> = doc
        .kits
        .iter()
        .filter(|record| applies(record, catalogue))
        .map(|record| view(record, KIND_PROJECT, catalogue))
        .collect();
    kits.sort_by(|a, b| a.kit_slug.cmp(&b.kit_slug));
    kits
}

/// What applies: the kits of the levels above (`base`) with a level's own
/// (`organization`), one entry per slug, the newer version winning
/// (ADR-0069 §4). For a project it is folded once more:
/// (base ∪ organization) ∪ project. Sorted by slug.
pub fn effective(base: &[InstalledKit], organization: &[InstalledKit]) -> Vec<InstalledKit> {
    let mut all: Vec<InstalledKit> = base.to_vec();
    for org in organization {
        match all.iter_mut().find(|k| k.kit_slug == org.kit_slug) {
            Some(existing) => {
                if newer(existing, org) == Ordering::Less {
                    *existing = org.clone();
                }
            }
            None => all.push(org.clone()),
        }
    }
    all.sort_by(|a, b| a.kit_slug.cmp(&b.kit_slug));
    all
}

/// How `base` compares with `org` for the same kit: `Less` when the
/// organization's is the newer.
///
/// Versions that both read as dotted numbers (`1.2.0`, `v2.0`) compare as
/// numbers. Anything else (a commit, a branch) has no order of its own, so
/// the one installed later is the newer; a built-in kit installed by default
/// was installed by nobody, earliest of all. A tie keeps the base kit: the
/// organization's adds nothing to it.
pub fn newer(base: &InstalledKit, org: &InstalledKit) -> Ordering {
    if base.version == org.version {
        return Ordering::Greater;
    }
    if let (Some(a), Some(b)) = (numeric(&base.version), numeric(&org.version)) {
        let len = a.len().max(b.len());
        let pad = |v: &[u64]| {
            let mut v = v.to_vec();
            v.resize(len, 0);
            v
        };
        return match pad(&a).cmp(&pad(&b)) {
            Ordering::Equal => Ordering::Greater,
            other => other,
        };
    }
    match base.installed_at.cmp(&org.installed_at) {
        Ordering::Equal => Ordering::Greater,
        other => other,
    }
}

fn numeric(version: &str) -> Option<Vec<u64>> {
    let v = version.strip_prefix('v').unwrap_or(version);
    v.split('.').map(|part| part.parse::<u64>().ok()).collect()
}

/// Record `record` in the root's document: a re-install replaces the old
/// record, and a removed built-in kit is no longer removed.
pub fn install_base(doc: &mut InstalledDocument, record: InstalledRecord) -> InstalledKit {
    doc.removed_builtin.retain(|slug| *slug != record.kit_slug);
    upsert(doc, record.clone());
    InstalledKit {
        kind: KIND_BASE,
        ..view_plain(record)
    }
}

pub fn install_organization(doc: &mut InstalledDocument, record: InstalledRecord) -> InstalledKit {
    upsert(doc, record.clone());
    InstalledKit {
        kind: KIND_ORGANIZATION,
        ..view_plain(record)
    }
}

pub fn install_project(doc: &mut InstalledDocument, record: InstalledRecord) -> InstalledKit {
    upsert(doc, record.clone());
    InstalledKit {
        kind: KIND_PROJECT,
        ..view_plain(record)
    }
}

fn view_plain(record: InstalledRecord) -> InstalledKit {
    InstalledKit {
        kit_slug: record.kit_slug,
        version: record.version,
        shelf: record.shelf,
        kind: KIND_BASE,
        installed_by: Some(record.installed_by),
        installed_at: Some(record.installed_at),
        by_default: false,
        retired: false,
    }
}

fn upsert(doc: &mut InstalledDocument, record: InstalledRecord) {
    doc.kits.retain(|k| k.kit_slug != record.kit_slug);
    doc.kits.push(record);
    doc.kits.sort_by(|a, b| a.kit_slug.cmp(&b.kit_slug));
}

/// Take `slug` out of the base kits. 404 when it is not one.
pub fn uninstall_base(
    doc: &mut InstalledDocument,
    slug: &str,
    catalogue: &[KitDescriptor],
) -> Result<(), Refusal> {
    // An opt-in built-in kit is a base kit only by its record: removing the
    // record is all there is, and nothing has to stay removed.
    let builtin = catalogue
        .iter()
        .any(|k| k.slug == slug && base_by_default(k));
    let before = doc.kits.len();
    doc.kits.retain(|k| k.kit_slug != slug);
    let had_record = doc.kits.len() != before;
    let was_default = builtin && !doc.removed_builtin.iter().any(|s| s == slug);
    if !had_record && !was_default {
        return Err(Refusal::NotFound(
            slug.to_owned(),
            "this kit is not a base kit".into(),
        ));
    }
    if builtin && !doc.removed_builtin.iter().any(|s| s == slug) {
        doc.removed_builtin.push(slug.to_owned());
        doc.removed_builtin.sort();
    }
    Ok(())
}

/// Take `slug` out of an organization's own kits. A kit the organization has
/// only as a base kit is refused: it is the platform's to remove.
pub fn uninstall_organization(
    doc: &mut InstalledDocument,
    slug: &str,
    base: &[InstalledKit],
) -> Result<(), Refusal> {
    let before = doc.kits.len();
    doc.kits.retain(|k| k.kit_slug != slug);
    if doc.kits.len() != before {
        return Ok(());
    }
    if base.iter().any(|k| k.kit_slug == slug) {
        return Err(Refusal::BaseKit(slug.to_owned()));
    }
    Err(Refusal::NotFound(
        slug.to_owned(),
        "the organization has not installed this kit".into(),
    ))
}

/// Take `slug` out of a project's own kits. A kit the project has only from
/// its organization or the platform is refused: it is theirs to remove.
pub fn uninstall_project(
    doc: &mut InstalledDocument,
    slug: &str,
    base: &[InstalledKit],
    organization: &[InstalledKit],
) -> Result<(), Refusal> {
    let before = doc.kits.len();
    doc.kits.retain(|k| k.kit_slug != slug);
    if doc.kits.len() != before {
        return Ok(());
    }
    if organization.iter().any(|k| k.kit_slug == slug) {
        return Err(Refusal::OrganizationKit(slug.to_owned()));
    }
    if base.iter().any(|k| k.kit_slug == slug) {
        return Err(Refusal::BaseKit(slug.to_owned()));
    }
    Err(Refusal::NotFound(
        slug.to_owned(),
        "the project has not installed this kit".into(),
    ))
}

/// The documents in account-management.
pub struct AmInstalledStore {
    am: Arc<dyn AccountManagementClient>,
}

impl AmInstalledStore {
    pub fn new(am: Arc<dyn AccountManagementClient>) -> Self {
        Self { am }
    }

    async fn read_versioned(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
    ) -> anyhow::Result<(InstalledDocument, i64)> {
        match self
            .am
            .get_metadata(ctx, tenant, GtsTypeId::new(KITS_INSTALLED_METADATA_TYPE))
            .await
        {
            Ok(entry) => {
                let doc = serde_json::from_value(entry.value)
                    .map_err(|e| anyhow!("the installed kits of {tenant} are unreadable: {e}"))?;
                Ok((doc, entry.version))
            }
            Err(CanonicalError::NotFound { .. }) => Ok((InstalledDocument::default(), 0)),
            // Treating any other failure as "none installed" and writing
            // would wipe the document.
            Err(e) => Err(anyhow!("cannot read the installed kits of {tenant}: {e}")),
        }
    }
}

#[async_trait]
impl InstalledStore for AmInstalledStore {
    async fn read(&self, ctx: &SecurityContext, tenant: Uuid) -> anyhow::Result<InstalledDocument> {
        Ok(self.read_versioned(ctx, tenant).await?.0)
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
        let ctx = service_context(tenant)?;
        let mut last = None;
        for _ in 0..WRITE_ATTEMPTS {
            let (mut doc, version) = self.read_versioned(&ctx, tenant).await?;
            let answer = change(&mut doc)?;
            let value = serde_json::to_value(&doc).map_err(|e| Refusal::Internal(e.into()))?;
            let mut request =
                UpsertMetadataRequest::new(GtsTypeId::new(KITS_INSTALLED_METADATA_TYPE), value);
            if version > 0 {
                request = request.with_expected_version(version);
            }
            match self.am.upsert_metadata(&ctx, tenant, request).await {
                Ok(_) => return Ok(answer),
                Err(e) => last = Some(e),
            }
        }
        Err(Refusal::Internal(anyhow!(
            "cannot write the installed kits of {tenant}: {}",
            last.map(|e| e.to_string()).unwrap_or_default()
        )))
    }

    async fn organization_of(&self, ctx: &SecurityContext, tenant: Uuid) -> Uuid {
        crate::org_scope::org_of(self.am.as_ref(), ctx, tenant).await
    }

    async fn is_project(&self, ctx: &SecurityContext, tenant: Uuid) -> bool {
        self.am.get_tenant(ctx, tenant).await.is_ok_and(|t| {
            t.tenant_type.as_deref() == Some(crate::organizations::sdk::PROJECT_TENANT_TYPE)
        })
    }
}

/// studio-user's answers, looked up when asked: it publishes them in its
/// `init`, and without it nobody can be shown to hold the authority.
pub struct HubAuthority {
    hub: Arc<ClientHub>,
}

impl HubAuthority {
    pub fn new(hub: Arc<ClientHub>) -> Self {
        Self { hub }
    }
}

#[async_trait]
impl KitAuthority for HubAuthority {
    async fn is_platform_admin(&self, ctx: &SecurityContext) -> bool {
        match self
            .hub
            .get_scoped::<dyn crate::user_profile::OrganizationReader>(&ClientScope::gts_id(
                crate::user_profile::IDENTITY_INSTANCE_ID,
            )) {
            Ok(reader) => reader
                .is_platform_admin(&ctx.subject_id().to_string())
                .await
                .unwrap_or(false),
            Err(_) => false,
        }
    }

    async fn may_manage(&self, ctx: &SecurityContext, org: Uuid) -> bool {
        match self
            .hub
            .get_scoped::<dyn crate::user_profile::OrgAuthority>(&ClientScope::gts_id(
                crate::user_profile::IDENTITY_INSTANCE_ID,
            )) {
            Ok(authority) => authority.may_administer(ctx, org, MANAGE_PRIVILEGE).await,
            Err(_) => false,
        }
    }
}

#[cfg(test)]
#[path = "installed_tests.rs"]
mod tests;
