//! What another gear asks studio-environments for directly.
//!
//! - [`record`] / [`Published`]: a pipeline's published images become the
//!   project's image records (ADR-0062 §4); studio-artifact-ingest hands
//!   them over when it reads a build's report.
//! - [`ProjectDeployments`]: a project's deployments for its status.

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
