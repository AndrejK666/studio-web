//! The `kit-rename` sweep (ADR-0071 §8, the `model_sweep` pattern): once
//! after start, every tenant's installed-kits document is stored with its
//! retired slugs resolved ([`super::aliases`]), and every organization's
//! model is reconciled, which moves its kit marks to the kits that bring the
//! pieces now first (`DomainObjects::rename_kit_marks`, one model version
//! `op = "kit-rename"` with no inverse). Both are idempotent: a second visit
//! finds nothing to do. A request that arrives first reads the same answer
//! through the alias table, and its own reconciliation renames the marks.

use std::sync::Arc;

use async_trait::async_trait;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::installed::{KitInstaller, PLATFORM_TENANT};

pub struct KitRenameSweep(pub Arc<KitInstaller>);

#[async_trait]
impl crate::model_sweep::TenantMover for KitRenameSweep {
    fn name(&self) -> &str {
        "studio-kits kit-rename"
    }

    async fn prepare(&self, ctx: &SecurityContext, tenant: Uuid) -> anyhow::Result<()> {
        if self
            .0
            .rename_installations(tenant)
            .await
            .map_err(|r| anyhow::anyhow!("kit-rename of {tenant}'s installations: {r:?}"))?
        {
            tracing::info!(%tenant, "studio-kits: installations renamed to the current kits");
        }
        // The model is the organization's: once per organization.
        if tenant != PLATFORM_TENANT && ctx.subject_tenant_id() == tenant {
            let problems = self
                .0
                .reconcile_models(tenant)
                .await
                .map_err(|r| anyhow::anyhow!("kit-rename of {tenant}'s model: {r:?}"))?;
            if !problems.is_empty() {
                anyhow::bail!("{}", problems.join("; "));
            }
        }
        Ok(())
    }
}
