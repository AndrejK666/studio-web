//! The repository metrics port (ADR-0079 §4): the git, CI and task half of
//! the metrics board, said by the kit that analyses repositories.
//!
//! A kit's gear registers its source in its own module:
//!
//! ```ignore
//! inventory::submit! {
//!     crate::organizations::port::RepositoryMetricsSource {
//!         gear: "studio-insight",
//!         source: &InsightBoard,
//!     }
//! }
//! ```
//!
//! The core reads which repositories the scope's projects are made of
//! (`project.config` `sources[]`); the source says which of them it can be
//! asked about, by what key, and answers the board's half for them over the
//! board's windows. With no source in the assembly the half is `absent`.

use async_trait::async_trait;
use toolkit::client_hub::ClientHub;

use super::metrics::{OrgMetricsInsightDto, Span};

/// The source of the board's repository half, registered by its kit gear.
pub struct RepositoryMetricsSource {
    /// The gear that answers it (`studio-insight`), for logs and readers.
    pub gear: &'static str,
    pub source: &'static dyn RepositoryMetrics,
}

inventory::collect!(RepositoryMetricsSource);

/// The registered source; the first by gear name when several are.
pub fn registered() -> Option<&'static RepositoryMetricsSource> {
    inventory::iter::<RepositoryMetricsSource>
        .into_iter()
        .min_by(|a, b| a.gear.cmp(b.gear))
}

#[async_trait]
pub trait RepositoryMetrics: Send + Sync {
    /// The key the source is asked about a repository by (`owner/name`,
    /// lower case), from one of a project's source URLs; `None` for one it
    /// cannot be asked about.
    fn repository_key(&self, url: &str) -> Option<String>;

    /// The board's repository half for `repositories` (keys, distinct and
    /// sorted) over `span`'s windows. Never an error: a source that could
    /// not answer says why in the answer's `state`.
    async fn board(
        &self,
        hub: &ClientHub,
        repositories: &[String],
        span: &Span,
    ) -> OrgMetricsInsightDto;
}

/// The half when the assembly has no source for it.
pub fn absent() -> OrgMetricsInsightDto {
    unanswered(
        "absent",
        Some("no kit in this deployment measures repositories".into()),
    )
}

/// A half with no figures: `state` and why.
pub fn unanswered(state: &str, detail: Option<String>) -> OrgMetricsInsightDto {
    OrgMetricsInsightDto {
        state: state.to_owned(),
        detail,
        truncated: false,
        measures: Vec::new(),
        reviews: Vec::new(),
        ai_rows: None,
    }
}
