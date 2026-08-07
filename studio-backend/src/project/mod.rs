//! studio-project — projects as a first-class record.
//!
//! ## Why this is a gear and not Resource Group metadata
//!
//! ADR-0002 put Projects on RG groups and called a dedicated gear "Step 3, only
//! if logic outgrows CRUD". It has. A project now has two mutually exclusive
//! shapes (start from an idea vs. start from existing code), a journey-stage
//! selection with a mandatory member, a status ladder that only moves forward,
//! and a name that has to be unique inside its workspace. RG's
//! `metadata_schema` can express the first two — it is a JSON Schema and RG
//! really does validate group metadata against it — but not the last two: there
//! is no unique index over group metadata and no transition hook.
//!
//! ## What stayed on Resource Group
//!
//! Membership. ADR-0002 explicitly allows it ("Project membership can stay on
//! RG"), and RG already carries memberships, closure tables and their
//! authorization; reimplementing that here would be the expensive half. Each
//! project gets an RG group of type `cf.studio.project.v1~` and remembers its
//! id. The gear also registers that RG type at start, which retires the manual
//! `demo/setup-projects.sh` step.
//!
//! ## What stayed on file-storage
//!
//! Bytes. An uploaded codebase goes to the file-storage gear over REST and only
//! its file id lands here — the same split as connector tokens, where credstore
//! holds the value and the connection row holds the reference. This is not just
//! taste: `FileStorageClientV1` is still a stub with one `module_name()`
//! method, so there is no in-process path to storage to take even if we wanted
//! one. When the P1 operations land upstream, nothing here has to change.

mod entity;
mod migrations;
mod model;
mod repo;
mod rest;
mod service;

use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use axum::Router;
use resource_group_sdk::api::ResourceGroupClient;
use tokio_util::sync::CancellationToken;
use toolkit::api::OpenApiRegistry;
use toolkit::contracts::{DatabaseCapability, RestApiCapability, RunnableCapability};
use toolkit::context::GearCtx;
use toolkit_db::DBProvider;
use toolkit_security::SecurityContext;
use tracing::{info, warn};
use uuid::Uuid;

use repo::ProjectRepo;
use service::ProjectService;

/// Platform root tenant — where the synthetic start-up context lives, mirroring
/// `studio-secrets-bootstrap`.
const ROOT_TENANT: Uuid = Uuid::from_u128(0x0000_0000_0000_0000_0000_0000_0000_0001);
/// Stable synthetic subject for the start-up RG type registration, so the call
/// is attributable in an audit log.
const BOOTSTRAP_ACTOR: Uuid = Uuid::from_u128(0x0000_0000_0000_0000_0000_0000_0000_b008);

/// Projects gear.
#[toolkit::gear(
    name = "studio-project",
    deps = [resource_group],
    capabilities = [db, rest, stateful]
)]
#[derive(Default)]
pub struct StudioProjectGear {
    service: OnceLock<Arc<ProjectService>>,
}

#[async_trait]
impl toolkit::Gear for StudioProjectGear {
    #[tracing::instrument(skip_all, fields(module = "studio-project"))]
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let db_raw = ctx.db_required().map_err(|e| {
            anyhow::anyhow!(
                "studio-project needs its own database — add a `database:` section \
                 (server + dbname) to the studio-project gear config: {e}"
            )
        })?;
        let db = Arc::new(DBProvider::<repo::RepoError>::new(db_raw.db()));
        let repo = Arc::new(ProjectRepo::new(db));

        // Resource-group is a declared dependency, so it initialised first. Still
        // treated as optional: a trimmed deployment without it should serve
        // projects that simply have no member list, which the DTO reports, rather
        // than refuse to boot over the members half of the feature.
        let rg = match ctx.client_hub().get::<dyn ResourceGroupClient>() {
            Ok(client) => Some(client),
            Err(e) => {
                warn!(
                    "studio-project: resource-group client unavailable ({e}) — projects will \
                     have no member groups"
                );
                None
            }
        };

        let service = Arc::new(ProjectService::new(repo, rg));
        self.service
            .set(service)
            .map_err(|_| anyhow::anyhow!("{} gear already initialized", Self::MODULE_NAME))?;

        info!("studio-project: initialized");
        Ok(())
    }
}

#[async_trait]
impl RunnableCapability for StudioProjectGear {
    /// Register the project RG type once everything is up.
    ///
    /// In `start` rather than `init` and in a spawned task, for the same reason
    /// `studio-secrets-bootstrap` does it that way: the call goes through
    /// resource-group's authorization, and a deployment where it is denied
    /// should come up with the members half switched off, not fail the boot.
    async fn start(&self, _cancel: CancellationToken) -> anyhow::Result<()> {
        let Some(service) = self.service.get().cloned() else {
            return Ok(());
        };
        tokio::spawn(async move {
            let ctx = match SecurityContext::builder()
                .subject_id(BOOTSTRAP_ACTOR)
                .subject_type("service")
                .subject_tenant_id(ROOT_TENANT)
                .build()
            {
                Ok(c) => c,
                Err(e) => {
                    warn!("studio-project: cannot build the start-up security context: {e}");
                    return;
                }
            };
            service.ensure_rg_type(&ctx).await;
        });
        Ok(())
    }

    async fn stop(&self, _deadline: CancellationToken) -> anyhow::Result<()> {
        Ok(())
    }
}

impl DatabaseCapability for StudioProjectGear {
    fn migrations(&self) -> Vec<Box<dyn toolkit_db::sea_orm_migration::MigrationTrait>> {
        use toolkit_db::sea_orm_migration::MigratorTrait;
        migrations::Migrator::migrations()
    }
}

impl RestApiCapability for StudioProjectGear {
    fn register_rest(
        &self,
        _ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        Ok(rest::register_routes(
            router,
            openapi,
            self.service.get().cloned(),
        ))
    }
}
