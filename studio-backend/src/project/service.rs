//! Project orchestration: our own storage plus the Resource Group that holds
//! the members.
//!
//! The split follows ADR-0002's own suggestion that "project membership can
//! stay on RG". We own the record — name, mode, stages, source, lifecycle — and
//! RG owns the member list, which it already does for user groups and which we
//! would otherwise reimplement (memberships, closure tables, authorization).

use std::sync::Arc;

use resource_group_sdk::api::ResourceGroupClient;
use resource_group_sdk::models::{CreateGroupRequest, CreateTypeRequest};
use toolkit_security::SecurityContext;
use tracing::{info, warn};
use uuid::Uuid;

use super::model::{NewProject, Project, Status, ValidationError};
use super::repo::{ProjectRepo, RepoError};

/// RG type backing project membership. Same code ADR-0002 chose and the portal
/// already knows (`studio-frontend/src/api.ts`, `PROJECT_RG_TYPE`).
pub const PROJECT_RG_TYPE: &str = "gts.cf.core.rg.type.v1~cf.studio.project.v1~";

/// AM's user member-handle, reused so project members are the same handles as
/// user-group members.
const USER_MEMBER_TYPE: &str = "gts.cf.core.rg.type.v1~cf.core.am.user.v1~";

/// What a handler needs to tell apart to pick a status code.
#[derive(Debug)]
pub enum ServiceError {
    /// The caller can fix it — 400.
    Invalid(ValidationError),
    /// Name already taken in this workspace — 409.
    Conflict(String),
    /// No such project in this tenant — 404.
    NotFound,
    /// Ours — 500.
    Storage(String),
}

impl core::fmt::Display for ServiceError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Invalid(e) => write!(f, "{e}"),
            Self::Conflict(m) => write!(f, "{m}"),
            Self::NotFound => write!(f, "project not found"),
            Self::Storage(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for ServiceError {}

impl From<ValidationError> for ServiceError {
    fn from(e: ValidationError) -> Self {
        Self::Invalid(e)
    }
}

impl From<RepoError> for ServiceError {
    fn from(e: RepoError) -> Self {
        match e {
            RepoError::DuplicateName => Self::Conflict(e.to_string()),
            RepoError::Db(m) => Self::Storage(m),
        }
    }
}

pub struct ProjectService {
    repo: Arc<ProjectRepo>,
    /// `None` when resource-group is not in the assembly: projects still work,
    /// they just have no member list.
    rg: Option<Arc<dyn ResourceGroupClient>>,
}

impl ProjectService {
    #[must_use]
    pub fn new(repo: Arc<ProjectRepo>, rg: Option<Arc<dyn ResourceGroupClient>>) -> Self {
        Self { repo, rg }
    }

    /// Register the project RG type if it is not there yet.
    ///
    /// Runs in `start`, not `init`, and never propagates a failure: this
    /// replaces the manual `demo/setup-projects.sh` step, and a deployment
    /// where RG rejects the call should come up with projects that have no
    /// member groups rather than not come up at all. The next boot retries.
    pub async fn ensure_rg_type(&self, ctx: &SecurityContext) {
        let Some(rg) = &self.rg else {
            warn!("studio-project: resource-group unavailable — project member groups are off");
            return;
        };
        let request = CreateTypeRequest {
            code: PROJECT_RG_TYPE.to_owned(),
            can_be_root: true,
            allowed_parent_types: Vec::new(),
            allowed_membership_types: vec![USER_MEMBER_TYPE.to_owned()],
            metadata_schema: None,
        };
        match rg.create_type(ctx, request).await {
            Ok(_) => info!(code = PROJECT_RG_TYPE, "studio-project: RG project type registered"),
            // Almost always "already exists", which is the steady state. The
            // message is logged rather than matched: RG's canonical error codes
            // are richer than this call needs, and a wrong guess here would
            // turn a healthy boot into a scary line.
            Err(e) => info!(
                code = PROJECT_RG_TYPE,
                "studio-project: RG project type not created ({e}) — expected when it already exists"
            ),
        }
    }

    /// Create a project, then give it a members group.
    ///
    /// The two writes are deliberately not atomic and deliberately ordered this
    /// way. There is no transaction spanning our database and RG, so one of them
    /// has to be able to fail alone; a project without a member group is
    /// recoverable (the group can be created later, and the DTO says it is
    /// missing), while an RG group without a project would be an orphan nobody
    /// ever looks at again.
    ///
    /// # Errors
    /// [`ServiceError::Conflict`] on a duplicate name, [`ServiceError::Storage`]
    /// for anything else.
    pub async fn create(
        &self,
        ctx: &SecurityContext,
        new: NewProject,
    ) -> Result<Project, ServiceError> {
        let mut project = self.repo.insert(&new).await?;

        if let Some(rg) = &self.rg {
            let request = CreateGroupRequest {
                id: None,
                code: PROJECT_RG_TYPE.to_owned(),
                name: project.name.clone(),
                parent_id: None,
                metadata: Some(serde_json::json!({
                    "workspace_id": project.tenant_id,
                    "project_id": project.id,
                })),
            };
            match rg.create_group(ctx, request).await {
                Ok(group) => {
                    if let Err(e) = self.repo.set_rg_group(project.tenant_id, project.id, group.id).await
                    {
                        // The group exists but we failed to remember it. Say so
                        // loudly with both ids: this is the one state a human
                        // has to reconcile by hand.
                        warn!(
                            project_id = %project.id,
                            group_id = %group.id,
                            "studio-project: created the RG member group but could not record it ({e})"
                        );
                    } else {
                        project.rg_group_id = Some(group.id);
                    }
                }
                Err(e) => warn!(
                    project_id = %project.id,
                    "studio-project: RG member group not created ({e}) — project has no members yet"
                ),
            }
        }

        info!(
            project_id = %project.id,
            tenant_id = %project.tenant_id,
            mode = project.mode().as_str(),
            stages = project.stages.len(),
            "studio-project: project created"
        );
        Ok(project)
    }

    /// # Errors
    /// Propagates storage failures.
    pub async fn list(&self, tenant_id: Uuid) -> Result<Vec<Project>, ServiceError> {
        Ok(self.repo.list(tenant_id).await?)
    }

    /// # Errors
    /// [`ServiceError::NotFound`] when the tenant has no such project.
    pub async fn get(&self, tenant_id: Uuid, id: Uuid) -> Result<Project, ServiceError> {
        self.repo.find(tenant_id, id).await?.ok_or(ServiceError::NotFound)
    }

    /// Apply a patch. Every field is optional; the status is checked against
    /// the ladder in [`Status::can_transition_to`].
    ///
    /// # Errors
    /// [`ServiceError::Invalid`] on a rejected transition or bad field,
    /// [`ServiceError::NotFound`], [`ServiceError::Conflict`] on a rename clash.
    pub async fn update(
        &self,
        tenant_id: Uuid,
        id: Uuid,
        name: Option<&str>,
        stages: Option<&[String]>,
        status: Option<Status>,
    ) -> Result<Project, ServiceError> {
        let current = self.get(tenant_id, id).await?;

        let name = name.map(super::model::normalize_name).transpose()?;
        let stages = stages.map(super::model::normalize_stages).transpose()?;

        if let Some(next) = status
            && !current.status.can_transition_to(next)
        {
            return Err(ServiceError::Invalid(ValidationError::IllegalTransition {
                from: current.status,
                to: next,
            }));
        }

        let updated = self
            .repo
            .update(tenant_id, id, name.as_deref(), stages.as_deref(), status)
            .await?
            .ok_or(ServiceError::NotFound)?;
        Ok(updated)
    }

    /// Delete a project and, best effort, its members group.
    ///
    /// # Errors
    /// [`ServiceError::NotFound`] when there was nothing to delete.
    pub async fn delete(
        &self,
        ctx: &SecurityContext,
        tenant_id: Uuid,
        id: Uuid,
    ) -> Result<(), ServiceError> {
        let project = self.get(tenant_id, id).await?;

        // RG first: a leftover group with no project is invisible junk, whereas
        // a project whose group failed to delete is still consistent from the
        // API's point of view and retries on the next attempt.
        if let (Some(rg), Some(group_id)) = (&self.rg, project.rg_group_id) {
            // Cascade: the group has memberships, and the non-cascade delete
            // fails with FailedPrecondition when it does.
            if let Err(e) = rg.delete_group_cascade(ctx, group_id).await {
                warn!(
                    project_id = %id,
                    group_id = %group_id,
                    "studio-project: RG member group not deleted ({e}) — deleting the project anyway"
                );
            }
        }

        if self.repo.delete(tenant_id, id).await? {
            info!(project_id = %id, tenant_id = %tenant_id, "studio-project: project deleted");
            Ok(())
        } else {
            Err(ServiceError::NotFound)
        }
    }
}
