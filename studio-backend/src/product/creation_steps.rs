//! The product kit's steps of a project's creation (the core's project
//! creation port, ADR-0079 §4): the repository the project's gears go to,
//! made or attached, and a starter gear written into it.

use async_trait::async_trait;
use toolkit::client_hub::ClientHub;

use super::port::{GearScaffolds, NewGear, ProjectRepositories, RepositoryTarget, ScaffoldFailure};
use crate::organizations::port::{
    CreationStep, CreationStepRun, MadeRepo, Plan, StepDone, StepError, creation_retry as retry,
    creation_service_ctx as service_ctx,
};

inventory::submit! {
    CreationStep {
        gear: "studio-product",
        key: "repository",
        step: &RepositoryStep,
    }
}

inventory::submit! {
    CreationStep {
        gear: "studio-product",
        key: "scaffold",
        step: &ScaffoldStep,
    }
}

struct RepositoryStep;

#[async_trait]
impl CreationStepRun for RepositoryStep {
    async fn run(
        &self,
        hub: &ClientHub,
        plan: &Plan,
        _repo: Option<&MadeRepo>,
    ) -> Result<StepDone, StepError> {
        let Some(r) = plan.repository.as_ref() else {
            return Err(StepError::Fail("the plan names no repository".to_string()));
        };
        let repos = hub
            .get::<dyn ProjectRepositories>()
            .map_err(|_| StepError::Fail("studio-product is not in this deployment".to_string()))?;
        // The organization's connection, as the service in the organization.
        let ctx = service_ctx(plan.organization_id)?;
        let made_from = |t: RepositoryTarget, clone_url: Option<String>| MadeRepo {
            clone_url: clone_url.unwrap_or_else(|| format!("https://github.com/{}", t.repo)),
            full_name: t.repo,
            default_branch: t.base_branch,
            connection_id: r.connection_id,
            holder: r.holder,
        };
        // A repository an earlier attempt recorded is the one.
        if let Some(t) = repos
            .gear_repository(&ctx, plan.project_id)
            .await
            .map_err(|e| retry("the project's repository cannot be read", e))?
        {
            return Ok(StepDone::Repository(made_from(t, None)));
        }
        if r.mode == "existing" {
            let full_path = r.full_path.clone().unwrap_or_default();
            let target = RepositoryTarget {
                tenant: r.holder,
                connection_id: Some(r.connection_id),
                repo: full_path,
                base_branch: r
                    .default_branch
                    .clone()
                    .unwrap_or_else(|| "main".to_string()),
            };
            repos
                .attach(&ctx, plan.project_id, &target)
                .await
                .map_err(|e| retry("the repository could not be attached", e))?;
            return Ok(StepDone::Repository(made_from(target, r.clone_url.clone())));
        }
        let name = r.name.clone().unwrap_or_default();
        let made = repos
            .create(
                &ctx,
                plan.project_id,
                r.holder,
                Some(r.connection_id),
                r.owner.as_deref(),
                r.is_org,
                &name,
                r.private,
            )
            .await
            .map_err(|e| retry("the repository could not be created", e))?;
        Ok(StepDone::Repository(MadeRepo {
            full_name: made.full_name,
            clone_url: made.clone_url,
            default_branch: made.default_branch,
            connection_id: r.connection_id,
            holder: r.holder,
        }))
    }
}

struct ScaffoldStep;

#[async_trait]
impl CreationStepRun for ScaffoldStep {
    async fn run(
        &self,
        hub: &ClientHub,
        plan: &Plan,
        repo: Option<&MadeRepo>,
    ) -> Result<StepDone, StepError> {
        let Some(s) = plan.scaffold.as_ref() else {
            return Err(StepError::Fail(
                "the plan names no starter gear".to_string(),
            ));
        };
        let Some(repo) = repo else {
            return Err(StepError::Fail(
                "a starter gear needs the repository step before it".to_string(),
            ));
        };
        let scaffolds = hub
            .get::<dyn GearScaffolds>()
            .map_err(|_| StepError::Fail("studio-product is not in this deployment".to_string()))?;
        let ctx = service_ctx(plan.organization_id)?;
        let target = RepositoryTarget {
            tenant: repo.holder,
            connection_id: Some(repo.connection_id),
            repo: repo.full_name.clone(),
            base_branch: repo.default_branch.clone(),
        };
        let gear = NewGear {
            slug: s.slug.clone(),
            app_title: s.app_title.clone().or_else(|| Some(plan.name.clone())),
            problem: s.problem.clone(),
            origin: Some("Scaffolded when the project was created.".to_string()),
            parent_dir: s.parent_dir.clone(),
            gear_kind: s.gear_kind.clone(),
            plugin_host: s.plugin_host.clone(),
            plugin_spec: s.plugin_spec.clone(),
            open_pr: s.open_pr,
            ..NewGear::default()
        };
        match scaffolds.scaffold_into(&ctx, &target, &gear).await {
            Ok(o) => Ok(StepDone::Line(match o.pr_url {
                Some(pr) => format!("on {} ({pr})", o.branch),
                None => format!("on {}", o.branch),
            })),
            Err(ScaffoldFailure::Invalid(why)) => Err(StepError::Fail(why)),
            Err(ScaffoldFailure::Failed(e)) => {
                Err(retry("the starter gear could not be written", e))
            }
        }
    }
}
