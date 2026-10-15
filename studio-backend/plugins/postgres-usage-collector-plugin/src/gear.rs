use std::sync::Arc;

use async_trait::async_trait;
use toolkit::Gear;
use toolkit::client_hub::ClientScope;
use toolkit::context::GearCtx;
use toolkit::gts::PluginV1;
use tracing::info;
use types_registry_sdk::{RegisterResult, TypesRegistryClient};
use usage_collector_sdk::{UsageCollectorPluginSpecV1, UsageCollectorPluginV1};

use crate::config::TimescaleDbPluginConfig;
use crate::domain::adapter::StorageAdapter;
use crate::domain::ports::{CatalogStore, RecordStore};
use crate::infra::metrics::Metrics;
use crate::infra::storage::catalog_store::PgCatalogStore;
use crate::infra::storage::pool::{
    MIGRATOR, apply_post_migration_setup, apply_retention_policy, build_pool,
};

/// How often the retention window is applied after start. A day: the window
/// is a year, so a record outlives it by a day at most.
const RETENTION_EVERY: std::time::Duration = std::time::Duration::from_secs(86_400);
use crate::infra::storage::record_store::PgRecordStore;

/// Usage Collector storage backend on plain `PostgreSQL`.
///
/// Conforms to the storage Plugin SPI: connects + migrates a `PostgreSQL`
/// database, performs the full GTS registration handshake, then registers
/// the scoped `StorageAdapter` client so the plugin host resolves it on
/// first dispatch.
#[toolkit::gear(
    name = "postgres-usage-collector-plugin",
    deps = [types_registry]
)]
#[derive(Default)]
pub struct PostgresUsageCollectorPlugin;

#[async_trait]
impl Gear for PostgresUsageCollectorPlugin {
    // @cpt-flow:cpt-cf-usage-collector-flow-foundation-plugin-host-binding:p1
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let cfg: TimescaleDbPluginConfig = ctx.config_expanded_or_default()?;
        // Studio links this plugin into every build, and a profile that gives
        // it no database (a developer's `dev.yaml`) must still boot: the
        // plugin stands down, and the usage-collector has no storage to bind,
        // so nothing is recorded. Not in the published plugin, which fails
        // init instead.
        if cfg.database_url.expose().trim().is_empty() {
            tracing::warn!(
                "postgres-usage-collector-plugin: no database_url configured — standing down; \
                 usage is not recorded in this deployment"
            );
            return Ok(());
        }
        cfg.validate()
            .map_err(|e| anyhow::anyhow!("invalid postgres usage-collector plugin config: {e}"))?;

        // Connect, migrate, and install the config-driven retention policy.
        // Race the startup-I/O sequence against the gear's cancellation token so
        // a shutdown mid-startup aborts promptly instead of blocking on each
        // call's own timeout. `Metrics::new` and the migration-failure counter
        // stay inside the raced block (the metric needs the pool; the counter
        // must still fire on a migration error), so the block yields the
        // `(pool, metrics)` it built. The `ready` gauge is deliberately left
        // unset (0) here: it is flipped to 1 only once the full init sequence —
        // including GTS registration — has succeeded (see below), so the gauge
        // means "fully initialized", not merely "migrated".
        let cancel = ctx.cancellation_token().clone();
        let (pool, metrics) = toolkit::tokio::select! {
            biased;
            () = cancel.cancelled() => {
                return Err(anyhow::anyhow!("init cancelled during shutdown"));
            }
            res = async {
                let pool = build_pool(&cfg).await?;
                let metrics = Arc::new(Metrics::new(pool.clone()));
                if let Err(e) = MIGRATOR.run(&pool).await {
                    metrics.inc_migration_failure();
                    return Err::<_, anyhow::Error>(e.into());
                }
                apply_post_migration_setup(&pool, cfg.retention_period_secs).await?;
                Ok((pool, metrics))
            } => res?,
        };

        // Build registration payload and instance id for this plugin.
        let (instance_id, instance_json) =
            PluginV1::<UsageCollectorPluginSpecV1>::build_registration(
                "cf.studio._.postgres_usage_collector.v1",
                cfg.vendor.clone(),
                cfg.priority,
            )?;

        // Publish to types-registry.
        let registry = ctx.client_hub().get::<dyn TypesRegistryClient>()?;
        let results = registry.register(vec![instance_json]).await?;
        RegisterResult::ensure_all_ok(&results)?;

        // The full init sequence — pool, migration, retention, and GTS
        // registration — has now succeeded, so mark the plugin ready. The Gear
        // trait exposes no shutdown hook (only `init`), so the cancellation
        // token is the only shutdown signal: a detached watcher flips `ready`
        // back to 0 when the gear is cancelled, so the gauge tracks live
        // readiness rather than "ready at last init". The watcher is spawned
        // AFTER `set_ready(true)` so a cancellation that already fired (a
        // shutdown racing the registration above) is still observed —
        // `cancelled()` resolves immediately on an already-cancelled token — and
        // clears the gauge rather than leaving it stuck at 1. Best-effort: if
        // the meter provider is already gone the record is a harmless no-op.
        metrics.set_ready(true);
        let ready_metrics = metrics.clone();
        toolkit::tokio::spawn(async move {
            cancel.cancelled().await;
            ready_metrics.set_ready(false);
        });

        // A plain table has no retention policy to run it (see
        // `apply_retention_policy`): the window is applied here, once a day,
        // until the gear is cancelled.
        {
            let pool = pool.clone();
            let cancel = ctx.cancellation_token().clone();
            let secs = cfg.retention_period_secs;
            toolkit::tokio::spawn(async move {
                loop {
                    toolkit::tokio::select! {
                        () = cancel.cancelled() => return,
                        () = toolkit::tokio::time::sleep(RETENTION_EVERY) => {}
                    }
                    if let Err(e) = apply_retention_policy(&pool, secs).await {
                        tracing::warn!(error = %e, "usage records past retention could not be deleted; next try in a day");
                    }
                }
            });
        }

        // Wire the storage stack: record + catalog stores behind the adapter.
        // Both stores share the one metric inventory via `Arc<Metrics>`.
        let record: Arc<dyn RecordStore> = Arc::new(PgRecordStore::new(
            pool.clone(),
            metrics.clone(),
            ctx.cancellation_token().clone(),
        ));
        let catalog: Arc<dyn CatalogStore> = Arc::new(PgCatalogStore::new(
            pool.clone(),
            metrics,
            ctx.cancellation_token().clone(),
        ));
        let adapter = StorageAdapter::new(record, catalog);

        // Register the scoped backend client in ClientHub under the GTS
        // instance scope so the plugin host resolves it on first dispatch.
        ctx.client_hub()
            .register_scoped::<dyn UsageCollectorPluginV1>(
                ClientScope::gts_id(&instance_id),
                Arc::new(adapter) as Arc<dyn UsageCollectorPluginV1>,
            );

        info!(
            instance_id = %instance_id,
            vendor = %cfg.vendor,
            priority = cfg.priority,
            "Registered PostgreSQL usage-collector plugin instance"
        );
        Ok(())
    }
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "gear_tests.rs"]
mod gear_tests;
