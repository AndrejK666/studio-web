//! Connector driver plugins.
//!
//! One gear per provider, mirroring the IdP / authn / authz plugin families:
//! each registers a `PluginV1` instance under the connector contract and
//! publishes its [`ConnectorDriver`] as a scoped ClientHub client keyed by the
//! same GTS instance id. The connector gear resolves drivers by that id, so a
//! provider is present exactly when its plugin gear is linked into the
//! assembly — no registry of hardcoded constructors.
//!
//! ## Why one module per gear
//!
//! `#[toolkit::gear(deps = [...])]` expands to a module-scope `use <dep> as
//! _gear_dep_<dep>;` alias for every declared dependency. Two gears in the
//! same module that both depend on `types_registry` therefore emit the same
//! alias twice and fail to compile (E0252). Each gear gets its own child
//! module; the shared config type and helpers stay here and are reachable as
//! `super::*` because private items are visible to descendant modules.

use std::sync::Arc;

use serde::Deserialize;
use toolkit::client_hub::ClientScope;
use toolkit::context::GearCtx;
use tracing::{info, warn};
use types_registry_sdk::{RegisterResult, TypesRegistryClient};

use super::driver::ConnectorDriver;
use super::gts::plugin_registration;

#[derive(Debug, Clone, Deserialize)]
pub struct ConnectorPluginConfig {
    #[serde(default = "default_vendor")]
    pub vendor: String,
    #[serde(default = "default_priority")]
    pub priority: i16,
}

impl Default for ConnectorPluginConfig {
    fn default() -> Self {
        Self {
            vendor: default_vendor(),
            priority: default_priority(),
        }
    }
}

fn default_vendor() -> String {
    "constructorfabric".into()
}
fn default_priority() -> i16 {
    100
}

/// Shared registration path: publish the instance document, then expose the
/// driver under the same GTS id.
async fn register_driver(
    ctx: &GearCtx,
    instance_id: &str,
    cfg: &ConnectorPluginConfig,
    driver: Arc<dyn ConnectorDriver>,
) -> anyhow::Result<()> {
    let registry = ctx.client_hub().get::<dyn TypesRegistryClient>()?;
    let doc = plugin_registration(instance_id, &cfg.vendor, cfg.priority);
    // A profile that does not declare the connector contract (older config,
    // trimmed deployment) must not fail the boot over an optional feature:
    // skip the scoped registration instead, and studio-connector reports the
    // provider as unavailable.
    match registry.register(vec![doc]).await {
        Ok(results) => {
            if let Err(e) = RegisterResult::ensure_all_ok(&results) {
                warn!(
                    instance_id = %instance_id,
                    "connector driver not registered ({e}) — is \
                     cf.studio.connector.plugin.v1~ declared in this profile?"
                );
                return Ok(());
            }
        }
        Err(e) => {
            warn!(instance_id = %instance_id, "connector driver registration failed: {e}");
            return Ok(());
        }
    }
    ctx.client_hub()
        .register_scoped::<dyn ConnectorDriver>(ClientScope::gts_id(instance_id), driver);
    info!(instance_id = %instance_id, vendor = %cfg.vendor, priority = cfg.priority,
          "connector driver registered");
    Ok(())
}

/// Reused by every plugin: a plain HTTPS client. Source hosts and model
/// providers are public endpoints with ordinary certificates; a self-hosted
/// installation behind a private CA is a follow-up (same shape as
/// keycloak-idp-plugin's `custom_ca_certificate_paths`).
fn http_client() -> anyhow::Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent("constructor-studio")
        .build()?)
}

mod gitlab_plugin {
    use std::sync::Arc;

    use async_trait::async_trait;
    use toolkit::Gear;
    use toolkit::context::GearCtx;

    use super::super::driver::ConnectorDriver;
    use super::super::gitlab::GitLabDriver;
    use super::super::gts::GITLAB_INSTANCE_ID;
    use super::{ConnectorPluginConfig, http_client, register_driver};

    #[toolkit::gear(name = "gitlab-connector-plugin", deps = [types_registry])]
    #[derive(Default)]
    pub struct GitLabConnectorPlugin {}

    #[async_trait]
    impl Gear for GitLabConnectorPlugin {
        async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
            let cfg: ConnectorPluginConfig = ctx.config_or_default()?;
            let driver: Arc<dyn ConnectorDriver> = Arc::new(GitLabDriver::new(http_client()?));
            register_driver(ctx, GITLAB_INSTANCE_ID, &cfg, driver).await
        }
    }
}

mod github_plugin {
    use std::sync::Arc;

    use async_trait::async_trait;
    use toolkit::Gear;
    use toolkit::context::GearCtx;

    use super::super::driver::ConnectorDriver;
    use super::super::github::GitHubDriver;
    use super::super::gts::GITHUB_INSTANCE_ID;
    use super::{ConnectorPluginConfig, http_client, register_driver};

    #[toolkit::gear(name = "github-connector-plugin", deps = [types_registry])]
    #[derive(Default)]
    pub struct GitHubConnectorPlugin {}

    #[async_trait]
    impl Gear for GitHubConnectorPlugin {
        async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
            let cfg: ConnectorPluginConfig = ctx.config_or_default()?;
            let driver: Arc<dyn ConnectorDriver> = Arc::new(GitHubDriver::new(http_client()?));
            register_driver(ctx, GITHUB_INSTANCE_ID, &cfg, driver).await
        }
    }
}

mod bitbucket_plugin {
    use std::sync::Arc;

    use async_trait::async_trait;
    use toolkit::Gear;
    use toolkit::context::GearCtx;

    use super::super::bitbucket::BitbucketDriver;
    use super::super::driver::ConnectorDriver;
    use super::super::gts::BITBUCKET_INSTANCE_ID;
    use super::{ConnectorPluginConfig, http_client, register_driver};

    #[toolkit::gear(name = "bitbucket-connector-plugin", deps = [types_registry])]
    #[derive(Default)]
    pub struct BitbucketConnectorPlugin {}

    #[async_trait]
    impl Gear for BitbucketConnectorPlugin {
        async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
            let cfg: ConnectorPluginConfig = ctx.config_or_default()?;
            let driver: Arc<dyn ConnectorDriver> = Arc::new(BitbucketDriver::new(http_client()?));
            register_driver(ctx, BITBUCKET_INSTANCE_ID, &cfg, driver).await
        }
    }
}

/// Anthropic — the credential `@theia/ai-claude-code` authenticates with.
mod anthropic_plugin {
    use std::sync::Arc;

    use async_trait::async_trait;
    use toolkit::Gear;
    use toolkit::context::GearCtx;

    use super::super::ai_providers::AnthropicDriver;
    use super::super::driver::ConnectorDriver;
    use super::super::gts::ANTHROPIC_INSTANCE_ID;
    use super::{ConnectorPluginConfig, http_client, register_driver};

    #[toolkit::gear(name = "anthropic-connector-plugin", deps = [types_registry])]
    #[derive(Default)]
    pub struct AnthropicConnectorPlugin {}

    #[async_trait]
    impl Gear for AnthropicConnectorPlugin {
        async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
            let cfg: ConnectorPluginConfig = ctx.config_or_default()?;
            let driver: Arc<dyn ConnectorDriver> = Arc::new(AnthropicDriver::new(http_client()?));
            register_driver(ctx, ANTHROPIC_INSTANCE_ID, &cfg, driver).await
        }
    }
}

/// OpenAI — what `@theia/ai-codex` uses, and any OpenAI-compatible endpoint.
mod openai_plugin {
    use std::sync::Arc;

    use async_trait::async_trait;
    use toolkit::Gear;
    use toolkit::context::GearCtx;

    use super::super::ai_providers::OpenAiDriver;
    use super::super::driver::ConnectorDriver;
    use super::super::gts::OPENAI_INSTANCE_ID;
    use super::{ConnectorPluginConfig, http_client, register_driver};

    #[toolkit::gear(name = "openai-connector-plugin", deps = [types_registry])]
    #[derive(Default)]
    pub struct OpenAiConnectorPlugin {}

    #[async_trait]
    impl Gear for OpenAiConnectorPlugin {
        async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
            let cfg: ConnectorPluginConfig = ctx.config_or_default()?;
            let driver: Arc<dyn ConnectorDriver> = Arc::new(OpenAiDriver::new(http_client()?));
            register_driver(ctx, OPENAI_INSTANCE_ID, &cfg, driver).await
        }
    }
}
