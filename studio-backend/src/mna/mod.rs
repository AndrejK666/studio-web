//! M&A due diligence's function (the built-in kit `mna`, studio-web#1024,
//! `docs/design/mna-kit.md`): a deal on the project's object, its findings,
//! risks and open questions, and the evidence read from what Studio already
//! holds.
//!
//! A kit gear in process (ADR-0079 §7): it joins studio-kits through the
//! core's kit-runtime port ([`crate::kit_registry::runtime`]) and its MCP
//! port, and studio-kits names it nowhere. Its routes are mounted on
//! studio-kits' router, held to what `mna.kit.json` claims.

mod deal;
mod mcp;
mod rest;

use std::sync::Arc;

use account_management_sdk::AccountManagementClient;
use axum::Router;
use toolkit::api::OpenApiRegistry;

use crate::kit_registry::runtime::{KitFunction, KitHost, KitRoutes};
use crate::org_scope::OrgAccess;

use deal::{HubProjects, Mna, SLUG};

inventory::submit! {
    KitFunction {
        kit: SLUG,
        order: 20,
        start,
    }
}

// Its tools, after Project lifecycle's (`tools/list` keeps its order).
inventory::submit! {
    crate::mcp::sdk::ToolSet {
        gear: crate::kit_registry::runtime::GEAR,
        order: 142,
        tools: mcp::tools,
    }
}

fn start(host: &KitHost) -> anyhow::Result<Arc<dyn KitRoutes>> {
    let account_management = host.hub.get::<dyn AccountManagementClient>()?;
    let mna = Arc::new(Mna::new(
        Arc::clone(&host.runtime),
        Arc::new(HubProjects::new(account_management, Arc::clone(&host.hub))),
    ));
    Ok(Arc::new(Routes {
        mna,
        access: host.access.clone(),
    }))
}

struct Routes {
    mna: Arc<Mna>,
    access: OrgAccess,
}

impl KitRoutes for Routes {
    fn register_rest(&self, router: Router, openapi: &dyn OpenApiRegistry) -> Router {
        rest::register_routes(router, openapi, Arc::clone(&self.mna), self.access.clone())
    }
}
