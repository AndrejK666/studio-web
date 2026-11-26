//! The project status port (ADR-0079 §4): what a project's status and its
//! delivery path read from the kits, collected without naming them.
//!
//! A kit's gear registers its contributor in its own module:
//!
//! ```ignore
//! inventory::submit! {
//!     crate::organizations::port::StatusContributor {
//!         gear: "studio-documents",
//!         order: 10,
//!         source: &DocumentsStatus,
//!     }
//! }
//! ```
//!
//! Every contributor is asked side by side, as this gear's service identity
//! in the project's organization ([`super::status_read::service_ctx`]), and
//! answers the facts it owns in a [`StatusPart`]; a fact it does not own or
//! could not read stays `None`, which the status words as not known. Parts
//! are merged lowest `order` first, and the first contributor to say a fact
//! says it.

use async_trait::async_trait;
use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::status::{BuildFacts, Deploy, FindingFacts, ModelFacts, ProductFacts, Pull, SpecQueues};

/// A kit's contribution to a project's status, registered by its gear.
pub struct StatusContributor {
    /// The gear that reads it (`studio-documents`), for logs and readers.
    #[allow(dead_code, reason = "named for logs and readers of the registry")]
    pub gear: &'static str,
    /// Where its part stands when two say the same fact, lowest first.
    pub order: u16,
    pub source: &'static dyn StatusSource,
}

inventory::collect!(StatusContributor);

/// Every registered contributor, lowest `order` first, then by gear.
pub fn registered() -> Vec<&'static StatusContributor> {
    let mut out: Vec<&'static StatusContributor> =
        inventory::iter::<StatusContributor>.into_iter().collect();
    out.sort_by(|a, b| a.order.cmp(&b.order).then(a.gear.cmp(b.gear)));
    out
}

#[async_trait]
pub trait StatusSource: Send + Sync {
    /// The facts this kit owns about `project`, read as `ctx` through the
    /// kit's own clients in `hub`. A read that fails leaves its facts `None`.
    async fn read(&self, hub: &ClientHub, ctx: &SecurityContext, project: Uuid) -> StatusPart;
}

/// The facts a project's status reads, each `None` until a kit says it.
#[derive(Default)]
pub struct StatusPart {
    /// The Specs queues.
    pub specs: Option<SpecQueues>,
    /// The project domain model.
    pub model: Option<ModelFacts>,
    /// Findings nobody decided.
    pub findings: Option<FindingFacts>,
    /// The product record's facts.
    pub product: Option<ProductFacts>,
    /// The engine's last verdict kept on the product record.
    pub product_check: Option<crate::project_path::CheckFacts>,
    /// The saved description's revision; `Some(0)` for one in the
    /// repository only.
    pub product_revision: Option<i64>,
    /// The last build on the main branch.
    pub build: Option<BuildFacts>,
    /// The open pull requests, with whom each waits on by name.
    pub pulls: Option<Vec<Pull>>,
    /// The project's deployments.
    pub deployments: Option<Vec<Deploy>>,
    /// Stages 5-9 as the delivering kit decides them (`project_path.rs`).
    pub delivery: Option<Vec<crate::project_path::Stage>>,
}

impl StatusPart {
    /// `other`'s facts where this part has none.
    pub fn absorb(&mut self, other: StatusPart) {
        fn take<T>(into: &mut Option<T>, from: Option<T>) {
            if into.is_none() {
                *into = from;
            }
        }
        take(&mut self.specs, other.specs);
        take(&mut self.model, other.model);
        take(&mut self.findings, other.findings);
        take(&mut self.product, other.product);
        take(&mut self.product_check, other.product_check);
        take(&mut self.product_revision, other.product_revision);
        take(&mut self.build, other.build);
        take(&mut self.pulls, other.pulls);
        take(&mut self.deployments, other.deployments);
        take(&mut self.delivery, other.delivery);
    }
}

/// Every contributor's part, read side by side and merged in order.
pub async fn read_all(hub: &ClientHub, ctx: &SecurityContext, project: Uuid) -> StatusPart {
    let contributors = registered();
    let parts = futures_util::future::join_all(
        contributors
            .iter()
            .map(|c| c.source.read(hub, ctx, project)),
    )
    .await;
    let mut out = StatusPart::default();
    for part in parts {
        out.absorb(part);
    }
    out
}
