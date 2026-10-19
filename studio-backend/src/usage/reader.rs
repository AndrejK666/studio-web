//! An organization's usage, priced, for another gear: the organization's
//! overview compares periods and attributes spend to its members, which the
//! Costs report alone does not answer.
//!
//! The same reads and the same gate as `GET /studio-usage/v1/costs`: the
//! caller has to hold `cost.view` in the organization, and every tenant in its
//! tree is asked with the caller acting in it. What comes back are the facts
//! and the price list, so a consumer folds them as often as it likes —
//! by project and by person, with and without people's own keys — from one
//! read of the collector per period.

use std::sync::Arc;

use account_management_sdk::AccountManagementClient;
use async_trait::async_trait;
use futures_util::{StreamExt, stream};
use time::OffsetDateTime;
use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;
use usage_collector_sdk::UsageCollectorClientV1;
use uuid::Uuid;

pub use super::costs::{Fact, FactKind, GroupBy, Report};
use super::prices::PriceList;
use super::service::{Refusal, UsageService, VIEW_PRIVILEGE, facts_of};

/// How many tenants are asked at once, as the Costs report does.
const PARALLEL_TENANTS: usize = 8;

/// One period of an organization's usage and the prices it is read with.
pub struct PricedUsage {
    pub facts: Vec<Fact>,
    pub currency: String,
    prices: PriceList,
}

impl PricedUsage {
    /// The Costs report's own fold of these facts.
    pub fn report(&self, group: GroupBy, include_personal: bool) -> Report {
        super::costs::report(&self.facts, &self.prices, group, include_personal)
    }

    /// Facts and a price list in its stored JSON shape, for a consumer's tests.
    #[cfg(test)]
    pub fn from_parts(facts: Vec<Fact>, prices: serde_json::Value) -> anyhow::Result<Self> {
        let prices: PriceList = serde_json::from_value(prices)?;
        Ok(Self {
            facts,
            currency: prices.currency().to_owned(),
            prices,
        })
    }

    /// What each fact cost; `None` where it has no price.
    pub fn cost_of(&self, fact: &Fact) -> Option<f64> {
        match fact.kind {
            FactKind::Llm => self
                .prices
                .tokens_cost(&fact.provider, &fact.item, fact.tokens),
            FactKind::Session => self
                .prices
                .session_cost(fact.cpu_millicore_seconds, fact.memory_mib_seconds),
        }
    }
}

/// What studio-usage offers another gear about an organization's spend.
#[async_trait]
pub trait OrganizationUsage: Send + Sync + 'static {
    /// May the caller see the organization's costs (`cost.view`)?
    async fn may_view(&self, ctx: &SecurityContext, org: Uuid) -> bool;

    /// Everything the organization's tree used over `[from, to)`. Refused
    /// unless [`Self::may_view`].
    async fn usage(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        from: OffsetDateTime,
        to: OffsetDateTime,
    ) -> anyhow::Result<PricedUsage>;
}

/// The reader, over the gear's own service.
pub struct UsageReader {
    service: UsageService,
    hub: Arc<ClientHub>,
}

impl UsageReader {
    pub fn new(am: Arc<dyn AccountManagementClient>, hub: Arc<ClientHub>) -> Self {
        Self {
            service: UsageService::new(am, Arc::clone(&hub)),
            hub,
        }
    }
}

fn refused(r: Refusal) -> anyhow::Error {
    match r {
        Refusal::Forbidden(code) => anyhow::anyhow!("refused: {code}"),
        Refusal::Invalid(m) | Refusal::Unavailable(m) | Refusal::Internal(m) => {
            anyhow::anyhow!(m)
        }
    }
}

#[async_trait]
impl OrganizationUsage for UsageReader {
    async fn may_view(&self, ctx: &SecurityContext, org: Uuid) -> bool {
        self.service.may(ctx, org, VIEW_PRIVILEGE).await
    }

    async fn usage(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        from: OffsetDateTime,
        to: OffsetDateTime,
    ) -> anyhow::Result<PricedUsage> {
        if !self.may_view(ctx, org).await {
            anyhow::bail!("refused: COST_ADMIN_REQUIRED");
        }
        let (prices, _) = self.service.prices(ctx, org).await.map_err(refused)?;
        let collector = self
            .hub
            .get::<dyn UsageCollectorClientV1>()
            .map_err(|_| anyhow::anyhow!("usage is not recorded in this deployment"))?;
        let places = self.service.places(ctx, org).await.map_err(refused)?;
        let lookups = places.into_iter().map(|place| {
            let collector = Arc::clone(&collector);
            async move {
                let acting = crate::org_scope::acting_in(ctx, place.id)?;
                facts_of(collector.as_ref(), &acting, place.id, from, to)
                    .await
                    .map_err(|e| anyhow::anyhow!("usage of {} cannot be read: {e}", place.label))
            }
        });
        let mut facts = Vec::new();
        let mut answers = stream::iter(lookups).buffer_unordered(PARALLEL_TENANTS);
        while let Some(answer) = answers.next().await {
            facts.extend(answer?);
        }
        Ok(PricedUsage {
            facts,
            currency: prices.currency().to_owned(),
            prices,
        })
    }
}
