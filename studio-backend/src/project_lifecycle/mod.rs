//! Project lifecycle's function (the built-in kit `project-lifecycle`,
//! ADR-0068 §7): a project's phase, moved only along the lifecycle the kit
//! declares.
//!
//! A kit gear in process (ADR-0079 §7): it joins studio-kits through the
//! core's kit-runtime port ([`crate::kit_registry::runtime`]) and its MCP
//! port, and studio-kits names it nowhere. Its routes are mounted on
//! studio-kits' router, held to what `project-lifecycle.kit.json` claims; its
//! function also answers the rollups' [`ProjectPhases`] port.

mod mcp;
pub(crate) mod phase;
mod rest;

use std::sync::Arc;

use axum::Router;
use toolkit::api::OpenApiRegistry;

use crate::kit_registry::port::ProjectPhases;
use crate::kit_registry::runtime::{KitFunction, KitHost, KitRoutes};
use crate::org_scope::OrgAccess;

use phase::{ProjectLifecycle, SLUG};

inventory::submit! {
    KitFunction {
        kit: SLUG,
        order: 10,
        start,
    }
}

// Its tools, right after the kit library's (`tools/list` keeps its order).
inventory::submit! {
    crate::mcp::sdk::ToolSet {
        gear: crate::kit_registry::runtime::GEAR,
        order: 141,
        tools: mcp::tools,
    }
}

fn start(host: &KitHost) -> anyhow::Result<Arc<dyn KitRoutes>> {
    let lifecycle = Arc::new(ProjectLifecycle::new(Arc::clone(&host.runtime)));
    // Every project's phase, for the rows of studio-organizations' rollups.
    host.hub
        .register::<dyn ProjectPhases>(Arc::clone(&lifecycle) as Arc<dyn ProjectPhases>);
    Ok(Arc::new(Routes {
        lifecycle,
        access: host.access.clone(),
    }))
}

struct Routes {
    lifecycle: Arc<ProjectLifecycle>,
    access: OrgAccess,
}

impl KitRoutes for Routes {
    fn register_rest(&self, router: Router, openapi: &dyn OpenApiRegistry) -> Router {
        rest::register_routes(
            router,
            openapi,
            Arc::clone(&self.lifecycle),
            self.access.clone(),
        )
    }
}
