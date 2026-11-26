//! What another gear may ask about an organization's tenant tree.
//!
//! `ProjectsOf` lists an organization's projects (ADR-0041 §1). The tree is
//! walked here and nowhere else -- `rollups::projects_of`, the same two levels
//! the portfolio walks -- so a gear that needs every project of an
//! organization (the components registry) asks rather than walking the tree
//! itself and growing its own idea of where projects sit.
//!
//! Published on the ClientHub at init, while account-management is the one
//! dependency it needs.

use std::sync::Arc;

use account_management_sdk::AccountManagementClient;
use async_trait::async_trait;
use toolkit_security::SecurityContext;
use uuid::Uuid;

pub use super::rollups::OrgProject;

#[async_trait]
pub trait ProjectsOf: Send + Sync {
    /// Every project tenant of the organization `org`, with its workspace, in
    /// tree order. An error when the tree could not be listed: "none" is an
    /// answer, "could not tell" is not one.
    async fn projects_of(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
    ) -> anyhow::Result<Vec<OrgProject>>;
}

/// The organizations gear's answer to [`ProjectsOf`].
pub struct TenantTreeProjects {
    am: Arc<dyn AccountManagementClient>,
}

impl TenantTreeProjects {
    pub fn new(am: Arc<dyn AccountManagementClient>) -> Self {
        Self { am }
    }
}

#[async_trait]
impl ProjectsOf for TenantTreeProjects {
    async fn projects_of(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
    ) -> anyhow::Result<Vec<OrgProject>> {
        super::rollups::projects_of(self.am.as_ref(), ctx, org).await
    }
}

/// The Overview port (ADR-0079 §4): what a kit's gear registers to put a
/// block on an organization's Overview, and what it is given to compute it.
pub use super::blocks::*;
/// The project creation port (ADR-0079 §4): the steps and configuration
/// fields a kit's gear registers for a new project.
pub use super::creation_port::{
    CreationField, CreationFieldSource, CreationStep, CreationStepRun, StepDone,
};
/// Which parts of a project's status and delivery path a kit owns (ADR-0079
/// §4): what a kit's gear registers so the core names no kit.
pub use super::kit_parts::{PathStage, ProjectKitParts, stage as path_stage};
/// The cost metering port (ADR-0079 §4): what a kit's gear registers to say
/// what an organization spent.
pub use super::metering_port::{CostMeter, MeterSource, Metered, MeteredItem};
/// The repository metrics port (ADR-0079 §4): what a kit's gear registers to
/// answer the metrics board's repository half.
pub use super::metrics::{
    Bucket as MetricsBucket, OrgMetricsCellDto, OrgMetricsInsightDto, OrgMetricsMeasureDto,
    OrgMetricsPointDto, OrgMetricsReviewsDto, Span as MetricsSpan,
};
pub use super::project_create::{
    MadeRepo, Plan, StepError, retry as creation_retry, service_ctx as creation_service_ctx,
};
pub use super::repository_metrics_port::{
    RepositoryMetrics, RepositoryMetricsSource, absent as absent_repository_metrics,
    unanswered as unanswered_repository_metrics,
};
/// The rollup counts port (ADR-0079 §4): what a kit's gear publishes on the
/// ClientHub to fill a project's row in the portfolio and the projects table.
pub use super::rollup_port::{
    ArtifactCounter, DocumentCounter, LastEvent, ProjectDocumentCounts, PullCounts,
    RowSignalSource, RowSignals, SpecSummary,
};
/// How many days a project's activity counts look back.
pub use super::rollups::ACTIVITY_DAYS;
/// The project status port (ADR-0079 §4): what a kit's gear registers to
/// say its facts about a project's status and delivery path.
pub use super::status::{BuildFacts, FindingFacts, ModelFacts, Pull};
pub use super::status_port::{StatusContributor, StatusPart, StatusSource};
pub use super::status_read::{build_facts, deploys, product_record_facts, spec_queues};
