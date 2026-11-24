//! What another gear asks studio-environments for directly.
//!
//! - [`record`] / [`Published`]: a pipeline's published images become the
//!   project's image records (ADR-0062 §4); studio-artifact-ingest hands
//!   them over when it reads a build's report.
//! - [`ProjectDeployments`]: a project's deployments for its status.
//! - [`ProjectDeliveryStages`]: a project's stages from its product to
//!   running, for its status's whole path.

pub(crate) use super::images_sink::{Published, record};

/// A project's deployments, as `GET /deployments?project=` answers them
/// (the same JSON page), read in process as whoever asks: what a project's
/// status (studio-organizations) reads when it computes it as itself.
#[async_trait::async_trait]
pub trait ProjectDeployments: Send + Sync + 'static {
    async fn deployments_page(
        &self,
        ctx: &toolkit_security::SecurityContext,
        project: uuid::Uuid,
    ) -> anyhow::Result<serde_json::Value>;
}

pub(crate) use super::rest::DeploymentsPort;

/// A project's stages from its product to running (`project_path.rs`,
/// stages 5-9), as `GET /project-path` answers them in `stages`, read in
/// process as whoever asks: what a project's status (studio-organizations)
/// draws its whole path with, so Overview and Releases say the same.
#[async_trait::async_trait]
pub trait ProjectDeliveryStages: Send + Sync + 'static {
    async fn delivery_stages(
        &self,
        ctx: &toolkit_security::SecurityContext,
        project: uuid::Uuid,
    ) -> anyhow::Result<Vec<crate::project_path::Stage>>;
}

pub(crate) use super::service::DeliveryStagesPort;
