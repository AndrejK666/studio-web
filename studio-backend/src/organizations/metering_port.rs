//! The cost metering port (ADR-0079 §4): what an organization spent, as the
//! kits that meter it say, for the metrics board's money half.
//!
//! A kit's gear registers its meter in its own module:
//!
//! ```ignore
//! inventory::submit! {
//!     crate::organizations::port::CostMeter {
//!         gear: "studio-usage",
//!         order: 10,
//!         source: &UsageMeter,
//!     }
//! }
//! ```
//!
//! A meter says whether the caller may see the organization's costs, and
//! what was spent over a window: each metered item's tenant, its cost (`None`
//! when it has no price) and its name. Only the organization's own money is
//! metered here: what people pay with their own keys is the meter's to leave
//! out.

use async_trait::async_trait;
use time::OffsetDateTime;
use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;
use uuid::Uuid;

/// A meter of an organization's spend, registered by the kit gear that
/// keeps it.
pub struct CostMeter {
    /// The gear that meters (`studio-usage`), for logs and readers.
    pub gear: &'static str,
    /// Where it stands among the meters, lowest first: the first one's
    /// currency is the board's.
    pub order: u16,
    pub source: &'static dyn MeterSource,
}

inventory::collect!(CostMeter);

/// Every registered meter, lowest `order` first, then by gear.
pub fn registered() -> Vec<&'static CostMeter> {
    let mut out: Vec<&'static CostMeter> = inventory::iter::<CostMeter>
        .into_iter()
        .filter(|m| crate::composition::contributes(m.gear))
        .collect();
    out.sort_by(|a, b| a.order.cmp(&b.order).then(a.gear.cmp(b.gear)));
    out
}

#[async_trait]
pub trait MeterSource: Send + Sync {
    /// Whether `ctx` may see `org`'s costs through this meter; `false` too
    /// when the meter's gear is not in this assembly.
    async fn may_view(&self, hub: &ClientHub, ctx: &SecurityContext, org: Uuid) -> bool;

    /// What `org` spent over `[from, to)`, its own money only.
    async fn spent(
        &self,
        hub: &ClientHub,
        ctx: &SecurityContext,
        org: Uuid,
        from: OffsetDateTime,
        to: OffsetDateTime,
    ) -> anyhow::Result<Metered>;
}

/// One window's spend, as a meter says it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Metered {
    pub currency: String,
    pub items: Vec<MeteredItem>,
}

/// One metered item.
#[derive(Clone, Debug, PartialEq)]
pub struct MeteredItem {
    /// The tenant it was spent in: the organization, a workspace or a project.
    pub tenant: Uuid,
    /// What it cost; `None` when it has no price.
    pub cost: Option<f64>,
    /// What it was (`provider/model`), named when it has no price.
    pub item: String,
}

/// The meters through which `ctx` may see `org`'s costs, in order; none when
/// the costs are not the caller's to see.
pub async fn viewable(
    hub: &ClientHub,
    ctx: &SecurityContext,
    org: Uuid,
) -> Vec<&'static CostMeter> {
    let meters = registered();
    let may =
        futures_util::future::join_all(meters.iter().map(|m| m.source.may_view(hub, ctx, org)))
            .await;
    meters
        .into_iter()
        .zip(may)
        .filter_map(|(m, may)| may.then_some(m))
        .collect()
}

/// What `meters` say was spent over `[from, to)`, together: the first
/// meter's currency, every meter's items. A meter that cannot say makes the
/// whole window unreadable.
pub async fn spent(
    meters: &[&'static CostMeter],
    hub: &ClientHub,
    ctx: &SecurityContext,
    org: Uuid,
    from: OffsetDateTime,
    to: OffsetDateTime,
) -> anyhow::Result<Metered> {
    let parts = futures_util::future::join_all(
        meters
            .iter()
            .map(|m| m.source.spent(hub, ctx, org, from, to)),
    )
    .await;
    let mut out: Option<Metered> = None;
    for part in parts {
        let part = part?;
        match out.as_mut() {
            None => out = Some(part),
            Some(all) => all.items.extend(part.items),
        }
    }
    Ok(out.unwrap_or_default())
}
