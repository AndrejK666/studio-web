//! Which service runs a strategy's gear matches (ADR-0074, amendment).
//!
//! A service strategy is a kit's `assembly_strategy` with `service: {contract:
//! "gears-matcher/v1"}`. Its service is the one the organization connected
//! for it: an `assembly-service` connection whose `strategy` option names the
//! strategy, holding the address and the secret (never the manifest). The
//! shipped `gears_matcher` is the first such strategy: a connection for it
//! wins, and without one the deployment's own `config.gears_matcher` serves
//! it, as before. Every other strategy without a connection is
//! `STRATEGY_NOT_CONNECTED`.

use std::sync::Arc;

use async_trait::async_trait;
use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::client::{HttpMatcher, Matcher};

/// The strategy Studio ships, run by the gears-matcher service.
pub const SHIPPED_STRATEGY: &str = "gears_matcher";

/// Why a strategy's service cannot be called: the deployment has none for the
/// shipped strategy.
pub const NOT_CONFIGURED: &str = "MATCHER_NOT_CONFIGURED";
/// Why a strategy's service cannot be called: the organization connected none.
pub const NOT_CONNECTED: &str = "STRATEGY_NOT_CONNECTED";

/// The services organizations connected for their strategies.
#[async_trait]
pub trait MatcherDirectory: Send + Sync + 'static {
    /// The service connected for `strategy` in organization `org`; `None`
    /// when there is none; an error when the connections could not be read.
    async fn connected(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        strategy: &str,
    ) -> Result<Option<Arc<dyn Matcher>>, String>;
}

/// [`MatcherDirectory`] over studio-connector's connections.
pub struct ConnectionDirectory {
    hub: Arc<ClientHub>,
    timeout_secs: u64,
}

impl ConnectionDirectory {
    pub fn new(hub: Arc<ClientHub>, timeout_secs: u64) -> Self {
        Self { hub, timeout_secs }
    }
}

#[async_trait]
impl MatcherDirectory for ConnectionDirectory {
    async fn connected(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        strategy: &str,
    ) -> Result<Option<Arc<dyn Matcher>>, String> {
        use crate::connectors::sdk::{
            ASSEMBLY_SERVICE_PROVIDER, ASSEMBLY_SERVICE_STRATEGY_OPTION, Connectors,
        };
        let Some(service) = Connectors::new(Arc::clone(&self.hub)).get() else {
            return Ok(None);
        };
        let list = service
            .list(ctx, org)
            .await
            .map_err(|e| format!("the organization's connections could not be read: {e:#}"))?;
        // An organization's or workspace's connection, never a person's own:
        // a match runs for everybody in the project.
        let Some(c) = list.into_iter().find(|c| {
            c.provider == ASSEMBLY_SERVICE_PROVIDER
                && c.scope != "personal"
                && c.options
                    .get(ASSEMBLY_SERVICE_STRATEGY_OPTION)
                    .map(String::as_str)
                    == Some(strategy)
        }) else {
            return Ok(None);
        };
        let (_, auth, _) = service
            .driver_and_auth(ctx, org, c.id)
            .await
            .map_err(|e| format!("the `{strategy}` service's secret could not be read: {e:#}"))?;
        Ok(Some(Arc::new(HttpMatcher::connected(
            &auth.base_url,
            auth.token,
            self.timeout_secs,
        ))))
    }
}

/// The identity a match reads the organization's connections with when no
/// person is asking (its run, a reconciliation).
pub fn service_context(org: Uuid) -> Option<SecurityContext> {
    SecurityContext::builder()
        .subject_id(crate::organizations::SERVICE_SUBJECT_ID)
        .subject_type("service")
        .subject_tenant_id(org)
        .token_scopes(vec!["*".to_owned()])
        .build()
        .ok()
}
