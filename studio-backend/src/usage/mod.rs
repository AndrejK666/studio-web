//! studio-usage — what Studio's model calls and IDE sessions use, and what it
//! costs an organization (issue #781).
//!
//! **Recording** is not this gear's code path: studio-llm-proxy records every
//! model call and studio-session every running session, through [`sdk::Usage`],
//! into the platform's `usage-collector` gear, whose storage is
//! `plugins/postgres-usage-collector-plugin`. This module holds the shape of a
//! use ([`port`]) and the usage types it becomes ([`types`]).
//!
//! **Costs** are this gear's: an organization's price list (one
//! account-management metadata row on the organization, [`PRICES_METADATA_TYPE`])
//! and a report of its usage over a period, priced with that list and grouped
//! (`rest.rs`, `service.rs`). Records stay quantities; money is derived when
//! the report is read.
//!
//! No database of its own: the records are the collector's and the price list
//! is bounded.

mod costs;
mod prices;
mod rest;
mod service;

pub mod port;
pub mod sdk;
pub mod types;

use std::sync::Arc;

use async_trait::async_trait;
use axum::Router;
use toolkit::api::OpenApiRegistry;
use toolkit::contracts::RestApiCapability;
use toolkit::{Gear, GearCtx};

/// An organization's price list.
pub const PRICES_METADATA_TYPE: &str =
    "gts.cf.core.am.tenant_metadata.v1~cf.studio.usage.prices.v1~";

#[toolkit::gear(
    name = "studio-usage",
    deps = [account_management],
    capabilities = [rest]
)]
#[derive(Default)]
pub struct StudioUsageGear;

#[async_trait]
impl Gear for StudioUsageGear {
    async fn init(&self, _ctx: &GearCtx) -> anyhow::Result<()> {
        Ok(())
    }
}

#[async_trait]
impl RestApiCapability for StudioUsageGear {
    fn register_rest(
        &self,
        ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        let am = ctx
            .client_hub()
            .get::<dyn account_management_sdk::AccountManagementClient>()?;
        let access = crate::org_scope::OrgAccess(Arc::new(
            crate::studio_session::sdk::TenantMembership::new(Arc::clone(&am)),
        ));
        let service = Arc::new(service::UsageService::new(am, ctx.client_hub()));
        let router = rest::register_routes(router, openapi, service);
        // `?organization_id=` resolves through it.
        Ok(router.layer(axum::Extension(access)))
    }
}
