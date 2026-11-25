//! Constructor Studio kit registry.
//!
//! The first vertical slice deliberately keeps kit bytes in their canonical
//! Git repositories. This gear owns catalogue metadata and project-scoped
//! desired installations; `cfs` remains the only component that materializes
//! kit files into a checkout.

mod aliases;
mod archive;
mod bundles;
mod claims;
mod contents;
mod events;
mod gate;
mod gdl;
mod inbox;
pub(crate) mod installed;
mod kind;
pub(crate) mod kit_gdl; // a kit's passport, `kit.gdl`: the registry's, the catalogue reads it too
mod manifest;
mod mcp;
mod mna;
mod mna_mcp;
mod mna_rest;
mod models;
mod owners;
mod phase;
pub mod port;
mod project_types;
mod requires;
mod rest;
pub(crate) mod service;
mod shelf;
mod shelf_bundles;
mod sweep;

pub(crate) use installed::KITS_INSTALLED_METADATA_TYPE;
// This gear's MCP tools, collected by studio-mcp (ADR-0079).
// The kit library, and installing kits for everyone or one organization.
inventory::submit! {
    crate::mcp::sdk::ToolSet {
        gear: "studio-kits",
        order: 140,
        tools: mcp::tools,
    }
}

use std::sync::{Arc, OnceLock};

use account_management_sdk::AccountManagementClient;
use async_trait::async_trait;
use axum::Router;
use toolkit::api::OpenApiRegistry;
use toolkit::{Gear, GearCtx};

use installed::{AmInstalledStore, HubAuthority, KitInstaller};
use service::KitRegistryService;

#[toolkit::gear(
    name = "studio-kits",
    deps = [account_management],
    capabilities = [rest]
)]
#[derive(Default)]
pub struct StudioKitsGear {
    service: OnceLock<Arc<KitRegistryService>>,
    installer: OnceLock<Arc<KitInstaller>>,
    access: OnceLock<crate::org_scope::OrgAccess>,
    mna: OnceLock<Arc<mna::Mna>>,
}

#[async_trait]
impl Gear for StudioKitsGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let account_management = ctx.client_hub().get::<dyn AccountManagementClient>()?;
        let service = KitRegistryService::new(
            crate::model_metadata::client_for(
                ctx,
                account_management.clone(),
                service::MODEL_KINDS,
            ),
            ctx.client_hub(),
        )?;
        // Which kits apply to an organization (ADR-0069 §4): plain tenant
        // metadata, written as the gear after it has checked who asks.
        let installer = Arc::new(
            KitInstaller::new(
                service.catalogue(),
                Arc::new(AmInstalledStore::new(account_management.clone())),
                Arc::new(HubAuthority::new(ctx.client_hub())),
            )
            // An organization's own kits are read through its connections
            // (ADR-0068 phase 7).
            .with_reader(shelf::reader(ctx.client_hub()))
            // A kit's model overlay goes into the organization's model through
            // the domain model's port (ADR-0067 §6).
            .with_models(Arc::new(models::HubModels(ctx.client_hub())))
            // `kit.installed` / `kit.uninstalled`, so the shell reads the kits
            // again when somebody else changes them.
            .with_events(Arc::new(events::HubEvents(ctx.client_hub()))),
        );
        let service = Arc::new(service.with_ide_shelf(Arc::clone(&installer)));
        // An organization's own kits' screens, read from its repository at the
        // pinned commit (ADR-0068 phases 5 and 7).
        service
            .bundles()
            .add_source(Arc::new(shelf_bundles::ShelfBundles::new(
                Arc::clone(&installer) as Arc<dyn shelf_bundles::ShelfLookup>,
            )));
        // M&A due diligence's function (studio-web#1024): the deal on the
        // project's object, its findings, risks and open questions, and the
        // evidence read from what Studio already holds.
        let mna = Arc::new(mna::Mna::new(
            Arc::clone(&installer),
            Arc::new(mna::HubProjects::new(
                account_management.clone(),
                ctx.client_hub(),
            )),
        ));
        let access = crate::org_scope::OrgAccess(Arc::new(
            crate::studio_session::sdk::TenantMembership::new(account_management),
        ));
        // The kits a new project asked for, for its creation run
        // (studio-organizations, `organizations.project_create`).
        ctx.client_hub()
            .register::<dyn port::ProjectKitRequests>(Arc::new(port::KitRequests::new(
                Arc::clone(&service),
                Arc::clone(&installer),
            ))
                as Arc<dyn port::ProjectKitRequests>);
        // Whether a kit applies to an organization, for the gears that act
        // only where a kit is installed (studio-environments: Research).
        ctx.client_hub()
            .register::<dyn port::KitPresence>(Arc::new(port::InstalledKits::new(Arc::clone(
                &installer,
            ))) as Arc<dyn port::KitPresence>);
        // Every project's phase, for the rows of studio-organizations' rollups.
        ctx.client_hub()
            .register::<dyn port::ProjectPhases>(Arc::new(port::InstalledKits::new(Arc::clone(
                &installer,
            ))) as Arc<dyn port::ProjectPhases>);
        // The kit-rename sweep (ADR-0071 §8): every installation and every
        // organization's model moved off the retired slugs, once after start.
        crate::model_sweep::register(Arc::new(sweep::KitRenameSweep(Arc::clone(&installer))));
        self.service
            .set(service)
            .map_err(|_| anyhow::anyhow!("studio-kits already initialized"))?;
        self.installer
            .set(installer)
            .map_err(|_| anyhow::anyhow!("studio-kits already initialized"))?;
        self.access
            .set(access)
            .map_err(|_| anyhow::anyhow!("studio-kits already initialized"))?;
        self.mna
            .set(mna)
            .map_err(|_| anyhow::anyhow!("studio-kits already initialized"))?;
        Ok(())
    }
}

#[async_trait]
impl toolkit::contracts::RestApiCapability for StudioKitsGear {
    fn register_rest(
        &self,
        ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        let service = self
            .service
            .get()
            .ok_or_else(|| anyhow::anyhow!("studio-kits not initialized"))?
            .clone();
        let installer = self
            .installer
            .get()
            .ok_or_else(|| anyhow::anyhow!("studio-kits not initialized"))?
            .clone();
        let access = self
            .access
            .get()
            .ok_or_else(|| anyhow::anyhow!("studio-kits not initialized"))?
            .clone();
        let mna = self
            .mna
            .get()
            .ok_or_else(|| anyhow::anyhow!("studio-kits not initialized"))?
            .clone();
        let router = rest::register_routes(router, openapi, service, installer, access.clone());
        let router = mna_rest::register_routes(router, openapi, mna, access);
        // The write routes a kit claims answer KIT_NOT_INSTALLED without it
        // (ADR-0071 §4): Project lifecycle's `PUT /project-phase`, M&A due
        // diligence's deal, findings, risks and open questions.
        Ok(gate::with_claimed_routes(
            router,
            ctx.client_hub(),
            "studio-kits",
        ))
    }
}
