use std::sync::{Arc, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use axum::Router;
use tokio_util::sync::CancellationToken;
use toolkit::api::OpenApiRegistry;
use toolkit::{Gear, GearCtx};
use tracing::{info, warn};

use super::config::StudioSessionConfig;
use super::rest;
use super::service::SessionService;

/// Studio's first own gear: launches per-workspace Theia IDE containers.
///
/// MVP scope (ADR-0003): docker-compose/local Docker via bollard, loopback
/// port publishing, tenant-scoped in-memory session registry, age-based
/// reaper. The k8s successor replaces the Docker driver with per-session
/// Pods (theia-cloud model) behind the same REST contract.
#[toolkit::gear(
    name = "studio-session",
    capabilities = [rest, stateful]
)]
pub struct StudioSessionGear {
    service: OnceLock<Arc<SessionService>>,
}

impl Default for StudioSessionGear {
    fn default() -> Self {
        Self {
            service: OnceLock::new(),
        }
    }
}

#[async_trait]
impl Gear for StudioSessionGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let cfg: StudioSessionConfig = ctx.config_or_default()?;
        info!(
            image = %cfg.image,
            ports = format!("{}-{}", cfg.port_range_start, cfg.port_range_end),
            "studio-session: initializing"
        );
        let service = SessionService::new(cfg)?;

        // Re-attach sessions that survived a backend restart.
        match service.adopt_existing().await {
            Ok(n) if n > 0 => info!("studio-session: adopted {n} existing session container(s)"),
            Ok(_) => {}
            Err(e) => warn!("studio-session: could not list existing containers: {e:#}"),
        }

        self.service
            .set(service)
            .map_err(|_| anyhow::anyhow!("studio-session gear already initialized"))?;
        Ok(())
    }
}

#[async_trait]
impl toolkit::contracts::RestApiCapability for StudioSessionGear {
    fn register_rest(
        &self,
        _ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        let service = self
            .service
            .get()
            .ok_or_else(|| anyhow::anyhow!("studio-session service not initialized"))?
            .clone();
        Ok(rest::register_routes(router, openapi, service))
    }
}

#[async_trait]
impl toolkit::contracts::RunnableCapability for StudioSessionGear {
    /// Background reaper: stops sessions past their maximum age.
    async fn start(&self, cancel: CancellationToken) -> anyhow::Result<()> {
        let service = self
            .service
            .get()
            .ok_or_else(|| anyhow::anyhow!("studio-session service not initialized"))?
            .clone();
        loop {
            tokio::select! {
                () = cancel.cancelled() => break,
                () = tokio::time::sleep(Duration::from_secs(60)) => {
                    let reaped = service.reap_expired().await;
                    if reaped > 0 {
                        info!("studio-session: reaped {reaped} expired session(s)");
                    }
                }
            }
        }
        Ok(())
    }

    async fn stop(&self, _deadline_token: CancellationToken) -> anyhow::Result<()> {
        // Sessions intentionally outlive the backend: adopt_existing()
        // re-attaches them on the next start.
        Ok(())
    }
}
