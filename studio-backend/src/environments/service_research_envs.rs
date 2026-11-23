//! The Research environments the deploy dialog forked before #1053, merged:
//! per project, per Research project, one environment stays and those with
//! nothing deployed or built are removed into it ([`research_envs::plan`]).
//! Run once at start by the model sweep, for every tenant; a project with
//! nothing to merge costs one read, a second run changes nothing.

use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::{EnvironmentService, Refusal, Result};
use crate::environments::model::{BindingList, DeploymentList};
use crate::environments::research_envs::{self, Merge};
use crate::environments::{BINDINGS_METADATA_TYPE, DEPLOYMENTS_METADATA_TYPE};

/// How many of a project's builds are read for the environments they went
/// to.
const BUILDS_READ: usize = 500;

impl EnvironmentService {
    /// Merge `project`'s duplicate Research environments, as this gear.
    /// `apply` false only says what would be merged.
    pub async fn merge_research_environments(
        &self,
        org: Uuid,
        project: Uuid,
        apply: bool,
    ) -> Result<Vec<Merge>> {
        let ctx = self.service(org)?;
        let (row, _) = self
            .store
            .read::<BindingList>(&ctx, project, BINDINGS_METADATA_TYPE)
            .await?;
        // Nothing to merge even if nothing had history: done, with one read.
        if research_envs::plan(&row.environments, &HashSet::new()).is_empty() {
            return Ok(Vec::new());
        }
        let Some(lived) = self.with_history(&ctx, org, project, &row).await? else {
            return Ok(Vec::new());
        };
        if !apply {
            return Ok(research_envs::plan(&row.environments, &lived));
        }
        let merges = self
            .store
            .update::<BindingList, Vec<Merge>, Refusal>(
                &ctx,
                project,
                BINDINGS_METADATA_TYPE,
                |row| {
                    // Planned again on the row as written now.
                    let merges = research_envs::plan(&row.environments, &lived);
                    research_envs::apply(row, &merges);
                    Ok(merges)
                },
            )
            .await?
            .map(|(_, m)| m)?;
        if let Some(records) = self.records() {
            for m in &merges {
                for removed in &m.remove {
                    if let Err(e) = records
                        .record_merge(org, project, *removed, m.keep, &m.research_project)
                        .await
                    {
                        tracing::warn!(%project, %removed, error = %e, "studio-environments: a merged Research environment could not be recorded");
                    }
                }
            }
        }
        Ok(merges)
    }

    /// The project's environments a person can see something happened in: a
    /// deployment, a build, a configuration secret or a namespace. `None`
    /// when that cannot be known now -- a build read failed, or a Research
    /// build is running that does not say its environment -- and nothing is
    /// merged.
    async fn with_history(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        project: Uuid,
        row: &BindingList,
    ) -> Result<Option<HashSet<Uuid>>> {
        let mut lived: HashSet<Uuid> = row.secrets.iter().map(|s| s.environment_id).collect();
        let (deployments, _) = self
            .store
            .read::<DeploymentList>(ctx, org, DEPLOYMENTS_METADATA_TYPE)
            .await?;
        lived.extend(
            deployments
                .items
                .iter()
                .filter(|d| d.project_id == project)
                .map(|d| d.environment_id),
        );
        if let Ok(builds) = self
            .hub
            .get::<dyn crate::artifact_ingest::port::BuildRecords>()
        {
            let Ok(builds) = builds.builds(ctx, &project.to_string(), BUILDS_READ).await else {
                return Ok(None);
            };
            for b in &builds {
                match b.place.environment_id.as_deref().map(Uuid::parse_str) {
                    Some(Ok(env)) => {
                        lived.insert(env);
                    }
                    // A Research build from before builds said their
                    // environment, still running: its deploy goes to an
                    // environment nothing here can tell.
                    _ if b.status == "running" && b.r#where.as_deref() == Some("research") => {
                        return Ok(None);
                    }
                    _ => {}
                }
            }
        }
        if let Some(records) = self.records() {
            let Ok(assigned) = records.assignments(org).await else {
                return Ok(None);
            };
            lived.extend(
                assigned
                    .iter()
                    .filter(|a| a.project_id == project)
                    .map(|a| a.environment_id),
            );
        }
        Ok(Some(lived))
    }
}

/// The merge as a step of the start-up sweep.
pub struct ResearchMerges {
    service: Arc<EnvironmentService>,
}

impl ResearchMerges {
    pub fn new(service: Arc<EnvironmentService>) -> Self {
        Self { service }
    }
}

#[async_trait]
impl crate::model_sweep::TenantMover for ResearchMerges {
    fn name(&self) -> &str {
        "studio-environments research merges"
    }

    async fn prepare(&self, ctx: &SecurityContext, tenant: Uuid) -> anyhow::Result<()> {
        let org = ctx.subject_tenant_id();
        if tenant == org {
            return Ok(());
        }
        let merges = self
            .service
            .merge_research_environments(org, tenant, true)
            .await
            .map_err(|e| anyhow::anyhow!("{e:?}"))?;
        for m in merges {
            tracing::info!(
                project = %tenant,
                research_project = %m.research_project,
                kept = %m.keep,
                removed = ?m.remove,
                kept_with_history = ?m.kept_with_history,
                "studio-environments: duplicate Research environments merged"
            );
        }
        Ok(())
    }
}
