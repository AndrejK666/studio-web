//! studio-spec-graph: a project's documents as a typed graph, checked by
//! deterministic rules and judged by models, through the external spec-graph
//! service (the neurosymbolic stand's `specq.server`).
//!
//! The gear is a thin, authenticated proxy, as `studio-spec-quality` and the
//! Gears matcher's client are:
//! - [`config`]: where the service is, its key, and how the service reaches
//!   this backend's Git proxy;
//! - `client`: the service's REST API (its contract: `GET /v1/openapi.json`);
//! - `rest`: the routes under `/studio-spec-graph/v1`, each for one project;
//! - `mcp`: the same as MCP tools.
//!
//! The service keeps the project's graph in the project's own graph-storage
//! tenant, runs the long jobs itself (index, contradiction search, judges),
//! and keeps labels and dismissals per project; decisions are Project model's.
//! The Spec graph kit (`kit_registry/builtin/spec-graph.kit.json`) claims the
//! tools and the write routes, so where it is not installed they answer
//! `KIT_NOT_INSTALLED` (ADR-0071). The integration's design is the neurosymbolic
//! repository's `docs/studio-web-integration.md`.

mod client;
pub mod config;
mod mcp;
// This gear's MCP tools, collected by studio-mcp (ADR-0079).
inventory::submit! {
    crate::mcp::sdk::ToolSet {
        gear: "studio-spec-graph",
        order: 40,
        tools: mcp::tools,
    }
}
mod rest;

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use axum::Router;
use toolkit::api::OpenApiRegistry;
use toolkit::contracts::RestApiCapability;
use toolkit::{Gear, GearCtx};
use tracing::{info, warn};

use config::SpecGraphConfig;

#[toolkit::gear(name = "studio-spec-graph", capabilities = [rest])]
#[derive(Default)]
pub struct SpecGraphGear {
    config: OnceLock<SpecGraphConfig>,
}

#[async_trait]
impl Gear for SpecGraphGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let cfg: SpecGraphConfig = ctx.config_or_default()?;
        let (url, secret, git) = (
            cfg.resolve_base_url(),
            cfg.resolve_secret(),
            cfg.resolve_git_url(),
        );
        if url.is_empty() || secret.is_none() || git.is_empty() {
            warn!(
                url_set = !url.is_empty(),
                secret_set = secret.is_some(),
                git_url_set = !git.is_empty(),
                "studio-spec-graph: not (fully) configured; its routes answer 503. Set \
                 STUDIO_SPEC_GRAPH_URL, STUDIO_SPEC_GRAPH_SECRET and STUDIO_SPEC_GRAPH_GIT_URL"
            );
        } else {
            info!(url = %url, "studio-spec-graph: configured");
        }
        self.config
            .set(cfg)
            .map_err(|_| anyhow::anyhow!("studio-spec-graph gear already initialized"))?;
        Ok(())
    }
}

#[async_trait]
impl RestApiCapability for SpecGraphGear {
    fn register_rest(
        &self,
        ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        let cfg = self.config.get().cloned().unwrap_or_default();
        // A check or a review answers in seconds; a run is submitted and
        // followed, and a wait is at most 25 s, so 60 s bounds every call.
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .build()?;
        let state = Arc::new(rest::State {
            client: client::Client::new(http, cfg.resolve_base_url(), cfg.resolve_secret()),
            git_url: cfg.resolve_git_url(),
            hub: ctx.client_hub(),
        });
        let router = rest::register_routes(router, openapi, state);
        // The write routes the Spec graph kit claims answer KIT_NOT_INSTALLED
        // without it (ADR-0071 §4): studio-kits' one shared check.
        Ok(crate::kit_registry::port::with_claimed_routes(
            router,
            ctx.client_hub(),
            "studio-spec-graph",
        ))
    }
}
