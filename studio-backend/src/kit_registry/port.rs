//! What another gear asks studio-kits for, through the ClientHub.
//!
//! - [`ProjectKitRequests`]: the kits a project asked for, and a request for
//!   one more -- what a project's creation run (studio-organizations,
//!   `organizations.project_create`) records for the kits picked when it was
//!   created. The same desired-state write `POST
//!   /studio-kits/v1/projects/{project_id}/installations` makes; materializing
//!   stays `cfs`'s job.

use std::sync::Arc;

use async_trait::async_trait;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::service::KitRegistryService;

#[async_trait]
pub trait ProjectKitRequests: Send + Sync + 'static {
    /// The slugs of the kits the project asked for.
    async fn requested(
        &self,
        ctx: &SecurityContext,
        project_id: Uuid,
    ) -> anyhow::Result<Vec<String>>;

    /// Ask for `kit_slug` at `version` (its catalogue default when `None`),
    /// copied into all of the project's repositories. A kit the catalogue does
    /// not offer is refused.
    async fn request(
        &self,
        ctx: &SecurityContext,
        project_id: Uuid,
        kit_slug: &str,
        version: Option<&str>,
    ) -> anyhow::Result<()>;
}

/// studio-kits' [`ProjectKitRequests`].
pub struct KitRequests {
    service: Arc<KitRegistryService>,
}

impl KitRequests {
    pub(super) fn new(service: Arc<KitRegistryService>) -> Self {
        Self { service }
    }
}

#[async_trait]
impl ProjectKitRequests for KitRequests {
    async fn requested(
        &self,
        ctx: &SecurityContext,
        project_id: Uuid,
    ) -> anyhow::Result<Vec<String>> {
        Ok(self
            .service
            .list_installations(ctx, project_id)
            .await?
            .into_iter()
            .map(|i| i.kit_slug)
            .collect())
    }

    async fn request(
        &self,
        ctx: &SecurityContext,
        project_id: Uuid,
        kit_slug: &str,
        version: Option<&str>,
    ) -> anyhow::Result<()> {
        let default = self
            .service
            .installable()
            .into_iter()
            .find(|k| k.slug == kit_slug)
            .map(|k| k.default_version)
            .ok_or_else(|| anyhow::anyhow!("the catalogue offers no kit `{kit_slug}`"))?;
        self.service
            .request_installation(
                ctx,
                project_id,
                kit_slug,
                version.unwrap_or(&default),
                "copy",
                "all-repositories",
            )
            .await
            .map(|_| ())
    }
}
