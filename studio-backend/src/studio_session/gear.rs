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
    deps = [credstore],
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
        if !cfg.enabled {
            info!("studio-session: disabled by config — session APIs will answer 503");
            return Ok(()); // service stays unset; REST mounts the disabled stub
        }
        info!(
            image = %cfg.image,
            ports = format!("{}-{}", cfg.port_range_start, cfg.port_range_end),
            "studio-session: initializing"
        );
        // No Docker daemon (k8s node, CI) must not fail the whole backend:
        // boot with sessions unavailable instead.
        let service = match SessionService::new(cfg) {
            Ok(s) => s,
            Err(e) => {
                warn!(
                    "studio-session: Docker unavailable ({e:#}) — sessions disabled for this run"
                );
                return Ok(());
            }
        };

        // credstore client: resolves repo PATs for private clones (optional —
        // sessions without tokens work regardless).
        match ctx
            .client_hub()
            .get::<dyn credstore_sdk::CredStoreClientV1>()
        {
            Ok(client) => service.set_credstore(client).await,
            Err(e) => warn!(
                "studio-session: credstore client unavailable ({e}); private repo tokens disabled"
            ),
        }

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
        // None = sessions disabled (config flag or no Docker): the routes
        // still mount and answer 503 with a clear message.
        let service = self.service.get().cloned();
        Ok(rest::register_routes(router, openapi, service))
    }
}

#[async_trait]
impl toolkit::contracts::RunnableCapability for StudioSessionGear {
    /// Background reaper: stops sessions past their maximum age.
    ///
    /// NB: `start()` must RETURN — the runtime awaits it before starting the
    /// next gear in topo order. The loop therefore runs in a spawned task
    /// tied to the runtime's cancellation token (same pattern as credstore's
    /// reaper tick).
    async fn start(&self, cancel: CancellationToken) -> anyhow::Result<()> {
        let Some(service) = self.service.get().cloned() else {
            return Ok(()); // sessions disabled — nothing to reap
        };
        // Background image keeper: boot pull + notify-driven refreshes, so
        // launch requests never pull inline (30s gateway deadline).
        tokio::spawn(SessionService::image_keeper(service.clone()));
        tokio::spawn(async move {
            info!("studio-session: reaper started (tick 60s)");
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
            info!("studio-session: reaper stopped");
        });
        Ok(())
    }

    async fn stop(&self, _deadline_token: CancellationToken) -> anyhow::Result<()> {
        // Sessions intentionally outlive the backend: adopt_existing()
        // re-attaches them on the next start.
        Ok(())
    }
}
