use std::sync::{Arc, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use axum::Router;
use toolkit::api::OpenApiRegistry;
use toolkit::{Gear, GearCtx};
use tracing::{info, warn};

use super::config::LlmProxyConfig;
use super::rest::{self, ProxyState};

/// OpenAI-compatible LLM proxy for Theia AI inside IDE sessions.
///
/// See the module docs (`super`) for the why; the how is deliberately dumb:
/// authenticated passthrough with a server-held upstream key. No request
/// rewriting, no model policy — that stays the mini-chat/oagw chain's job.
#[toolkit::gear(name = "studio-llm-proxy", capabilities = [rest])]
pub struct LlmProxyGear {
    state: OnceLock<Arc<ProxyState>>,
}

impl Default for LlmProxyGear {
    fn default() -> Self {
        Self {
            state: OnceLock::new(),
        }
    }
}

#[async_trait]
impl Gear for LlmProxyGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let cfg: LlmProxyConfig = ctx.config_or_default()?;
        let api_key = cfg.resolve_api_key();
        if api_key.is_none() {
            warn!(
                env = %cfg.api_key_env,
                "studio-llm-proxy: no upstream API key (env unset and no literal in config) — \
                 /studio-llm requests will fail until it is provided"
            );
        }
        info!(
            base_url = %cfg.base_url,
            key_present = api_key.is_some(),
            "studio-llm-proxy: configured"
        );

        // Long timeout: chat completions stream for minutes. connect_timeout
        // still keeps dead upstreams from hanging the handler.
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(600))
            .build()?;

        let state = Arc::new(ProxyState {
            client,
            base_url: cfg.base_url.trim_end_matches('/').to_string(),
            api_key,
        });
        self.state
            .set(state)
            .map_err(|_| anyhow::anyhow!("studio-llm-proxy gear already initialized"))?;
        Ok(())
    }
}

#[async_trait]
impl toolkit::contracts::RestApiCapability for LlmProxyGear {
    fn register_rest(
        &self,
        _ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        let state = self
            .state
            .get()
            .ok_or_else(|| anyhow::anyhow!("studio-llm-proxy not initialized"))?
            .clone();
        Ok(rest::register_routes(router, openapi, state))
    }
}
