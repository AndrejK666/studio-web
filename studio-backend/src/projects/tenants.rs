//! Making a project's tenant and writing its configuration.
//!
//! The one write in the sequence that cannot be taken back from here: a
//! duplicate tenant is not an error anybody sees, it is a second project with
//! the same name, and nothing downstream can tell which one was meant.
//!
//! So [`Tenants::find_project`] is not an optimisation. It is what makes a
//! retry heal a half-finished project instead of building another beside it.

use std::sync::Arc;

use account_management_sdk::{AccountManagementClient, CreateTenantRequest, UpsertMetadataRequest};
use gts::GtsTypeId;
use toolkit_odata::ODataQuery;
use toolkit_security::SecurityContext;
use uuid::Uuid;

/// The tenant type a project is.
const PROJECT_TENANT_TYPE: &str = "gts.cf.core.am.tenant_type.v1~cf.studio.tenant.project.v1~";

/// The metadata type a project's configuration is stored under.
const PROJECT_CONFIG_TYPE: &str = "gts.cf.core.am.tenant_metadata.v1~cf.studio.project.config.v1~";

pub struct Tenants {
    am: Arc<dyn AccountManagementClient>,
    /// The caller's, because a provisioning run acts as the person who asked
    /// for it — see `steps::Gears`.
    security: SecurityContext,
}

impl Tenants {
    pub fn new(am: Arc<dyn AccountManagementClient>, security: SecurityContext) -> Self {
        Self { am, security }
    }
}

#[async_trait::async_trait]
impl super::steps::TenantWriter for Tenants {
    async fn find_project(&self, workspace_id: Uuid, name: &str) -> anyhow::Result<Option<Uuid>> {
        let page = self
            .am
            .list_children(&self.security, workspace_id, &ODataQuery::default())
            .await?;
        Ok(page
            .items
            .into_iter()
            .find(|t| t.tenant_type.as_deref() == Some(PROJECT_TENANT_TYPE) && t.name == name)
            .map(|t| t.id.0))
    }

    async fn create_project(&self, workspace_id: Uuid, name: &str) -> anyhow::Result<Uuid> {
        let id = Uuid::new_v4();
        self.am
            .create_tenant(
                &self.security,
                CreateTenantRequest::new(
                    id,
                    workspace_id,
                    name.to_owned(),
                    GtsTypeId::new(PROJECT_TENANT_TYPE),
                ),
            )
            .await?;
        Ok(id)
    }

    async fn write_config(
        &self,
        project_id: Uuid,
        config: serde_json::Value,
    ) -> anyhow::Result<()> {
        // The RAW value, not `{"value": …}`: the wrapped form answers 200 and
        // silently stores a document missing every field, which then reads
        // back as defaults. Learned the hard way; the shape is the contract.
        self.am
            .upsert_metadata(
                &self.security,
                project_id,
                UpsertMetadataRequest::new(GtsTypeId::new(PROJECT_CONFIG_TYPE), config),
            )
            .await?;
        Ok(())
    }
}
