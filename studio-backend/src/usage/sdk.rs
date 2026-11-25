//! Where Studio's usage records go: this gear's [`UsageRecorder`] for the
//! core's metering port (`crate::metering`), registered in the ClientHub at
//! init, so a gear's [`Usage`] handle reaches it without naming this gear.
//!
//! Records go to the platform's `usage-collector` gear
//! ([`UsageCollectorClientV1`] on the ClientHub), resolved when a record is
//! made: Studio gears share one crate, so the toolkit's `deps` cannot order a
//! recording gear after the collector. An assembly without the collector
//! records nothing, and says so once.
//!
//! The usage types ([`super::types`]) are put in the collector's catalogue
//! the first time anything is recorded, and again after a failure — the
//! collector rejects a record whose type it does not know.

use std::sync::Arc;

use async_trait::async_trait;
use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;
use usage_collector_sdk::{UsageCollectorClientV1, UsageCollectorError};

pub use super::port::{Payer, Runtime, SESSION_ITEM, Source, TokenCounts, UsageRecord};
use super::types;
pub use crate::metering::{Usage, UsageRecorder};

/// The recorder this gear registers for the metering port.
pub fn recorder(hub: Arc<ClientHub>) -> Arc<dyn UsageRecorder> {
    Arc::new(Collector {
        hub,
        catalogued: tokio::sync::OnceCell::new(),
    })
}

struct Collector {
    hub: Arc<ClientHub>,
    /// Set once the types are in the catalogue; left unset by a failure, so
    /// the next record tries again.
    catalogued: tokio::sync::OnceCell<()>,
}

/// Put every Studio usage type in the catalogue. One already there is fine:
/// the catalogue is the platform's and outlives a restart.
async fn catalogue(
    client: &dyn UsageCollectorClientV1,
    ctx: &SecurityContext,
) -> anyhow::Result<()> {
    for usage_type in types::catalogue()? {
        match client.get_usage_type(ctx, usage_type.gts_id.clone()).await {
            Ok(_) => continue,
            Err(UsageCollectorError::NotFound { .. }) => {}
            Err(e) => anyhow::bail!("usage type {:?}: {e}", usage_type.gts_id),
        }
        match client.create_usage_type(ctx, usage_type).await {
            Ok(_) | Err(UsageCollectorError::AlreadyExists { .. }) => {}
            Err(e) => anyhow::bail!("cannot catalogue a usage type: {e}"),
        }
    }
    Ok(())
}

#[async_trait]
impl UsageRecorder for Collector {
    async fn record(&self, ctx: &SecurityContext, records: Vec<UsageRecord>) -> anyhow::Result<()> {
        let Ok(client) = self.hub.get::<dyn UsageCollectorClientV1>() else {
            tracing::debug!("no usage-collector in this assembly: usage is not recorded");
            return Ok(());
        };
        self.catalogued
            .get_or_try_init(|| catalogue(client.as_ref(), ctx))
            .await?;
        let mut batch = Vec::new();
        for record in &records {
            batch.extend(types::collector_records(record)?);
        }
        if batch.is_empty() {
            return Ok(());
        }
        let outcomes = client
            .create_usage_records(ctx, batch)
            .await
            .map_err(|e| anyhow::anyhow!("usage-collector refused the batch: {e}"))?;
        let refused: Vec<String> = outcomes
            .into_iter()
            .filter_map(Result::err)
            .map(|e| e.to_string())
            .collect();
        if !refused.is_empty() {
            anyhow::bail!(
                "usage-collector refused {} record(s): {}",
                refused.len(),
                refused.join("; ")
            );
        }
        Ok(())
    }
}
