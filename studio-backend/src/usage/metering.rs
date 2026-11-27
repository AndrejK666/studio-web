//! The org-costs kit's meter (the core's cost metering port, ADR-0079 §4):
//! what an organization's tree used, priced, with what people paid with their
//! own keys left out.

use async_trait::async_trait;
use time::OffsetDateTime;
use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::port::Payer;
use super::reader::{OrganizationUsage, PricedUsage};
use crate::organizations::port::{CostMeter, MeterSource, Metered, MeteredItem};

inventory::submit! {
    CostMeter {
        gear: "studio-usage",
        order: 10,
        source: &UsageMeter,
    }
}

struct UsageMeter;

#[async_trait]
impl MeterSource for UsageMeter {
    async fn may_view(&self, hub: &ClientHub, ctx: &SecurityContext, org: Uuid) -> bool {
        match hub.get::<dyn OrganizationUsage>() {
            Ok(usage) => usage.may_view(ctx, org).await,
            Err(_) => false,
        }
    }

    async fn spent(
        &self,
        hub: &ClientHub,
        ctx: &SecurityContext,
        org: Uuid,
        from: OffsetDateTime,
        to: OffsetDateTime,
    ) -> anyhow::Result<Metered> {
        let usage = hub
            .get::<dyn OrganizationUsage>()
            .map_err(|_| anyhow::anyhow!("studio-usage is not in this deployment"))?;
        Ok(metered(&usage.usage(ctx, org, from, to).await?))
    }
}

/// The organization's own money in `usage`: every fact but those paid with
/// a person's own key, priced, named `provider/item`.
pub fn metered(usage: &PricedUsage) -> Metered {
    Metered {
        currency: usage.currency.clone(),
        items: usage
            .facts
            .iter()
            .filter(|f| f.payer != Some(Payer::Personal))
            .map(|f| MeteredItem {
                tenant: f.tenant,
                cost: usage.cost_of(f),
                item: format!("{}/{}", f.provider, f.item),
            })
            .collect(),
    }
}

#[cfg(test)]
#[path = "metering_tests.rs"]
mod tests;
