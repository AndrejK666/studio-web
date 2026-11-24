//! A Research build's record against its run, and a deploy of the images a
//! build made without building them again.
//!
//! A build's record says `running` until its run records how it ended. A
//! run the queue gave up on, or one from before the queue told the handler
//! so, never did: the record is put right when it is read, from the run.

use toolkit::client_hub::ClientScope;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::{DeployRequest, EnvironmentService, Refusal, Result};
use crate::artifact_ingest::port::BuildRecord;
use crate::environments::model::{Deployment, DeploymentAction, EnvironmentKind};
use crate::environments::research;
use crate::environments::research_images::{self, ImageState, ImageStatus};

/// How long what Research said of a build's images is shown again before
/// it is asked again.
const IMAGES_FOR: std::time::Duration = std::time::Duration::from_secs(30);

type ImagesKey = (Uuid, Uuid, String);

/// What Research said of a build's images, by (person, project, build): each
/// person asks with their own sign-in.
fn images_cache() -> &'static crate::ttl_cache::TtlCache<ImagesKey, std::sync::Arc<Vec<ImageState>>>
{
    static CACHE: std::sync::OnceLock<
        crate::ttl_cache::TtlCache<ImagesKey, std::sync::Arc<Vec<ImageState>>>,
    > = std::sync::OnceLock::new();
    CACHE.get_or_init(|| crate::ttl_cache::TtlCache::new(IMAGES_FOR, 1024))
}
use crate::tasks::RunState;

/// What a record that says `running` becomes, given its run: `None` while
/// the run may still record the end itself (queued, running, or it
/// succeeded and recorded it).
pub(super) fn reconciled(
    record: &BuildRecord,
    run: &crate::tasks::KeyedRun,
) -> Option<crate::artifact_ingest::port::BuildOutcome> {
    if record.status != "running" || record.r#where.as_deref() != Some("research") {
        return None;
    }
    let cancelled = match run.view.state {
        RunState::Failed => false,
        RunState::Cancelled => true,
        RunState::Queued | RunState::Running | RunState::Succeeded => return None,
    };
    let p: research::ResearchBuildPayload = serde_json::from_value(run.payload.clone()).ok()?;
    let reason = run
        .view
        .last_error
        .clone()
        .unwrap_or_else(|| "its run ended without saying why".into());
    Some(research::ended_without_run(
        &p,
        run.view.result.as_ref(),
        cancelled,
        &reason,
    ))
}

impl EnvironmentService {
    /// `records` with every Research build whose record says `running`
    /// while its run has ended put right: recorded failed (or cancelled)
    /// with the run's reason, and answered so.
    pub(super) async fn reconcile_research_builds(
        &self,
        org: Uuid,
        mut records: Vec<BuildRecord>,
    ) -> Vec<BuildRecord> {
        if !records
            .iter()
            .any(|r| r.status == "running" && r.r#where.as_deref() == Some("research"))
        {
            return records;
        }
        let Ok(queue) = self
            .hub
            .get_scoped::<dyn crate::tasks::TaskQueue>(&ClientScope::gts_id(
                crate::tasks::TASK_QUEUE_INSTANCE_ID,
            ))
        else {
            return records;
        };
        let Ok(svc) = super::service_context(org) else {
            return records;
        };
        for record in &mut records {
            if record.status != "running" || record.r#where.as_deref() != Some("research") {
                continue;
            }
            let Ok(Some(run)) = queue.run_by_key(org, &record.build_id).await else {
                continue;
            };
            let Some(outcome) = reconciled(record, &run) else {
                continue;
            };
            let Ok(p) = serde_json::from_value::<research::ResearchBuildPayload>(run.payload)
            else {
                continue;
            };
            tracing::info!(build = %record.build_id, run = %run.id, status = %outcome.status, "studio-environments: a Research build's run had ended; its record now says so");
            record.status.clone_from(&outcome.status);
            record.failure.clone_from(&outcome.failure);
            record.failure_step.clone_from(&outcome.failure_step);
            if !outcome.images.is_empty() {
                record.images.clone_from(&outcome.images);
            }
            record.commit = outcome.commit.clone().or(record.commit.take());
            record.product = outcome.product.clone().or(record.product.take());
            research::record_research(&self.hub, &svc, &p, outcome).await;
        }
        records
    }

    /// Deploy the images build `build_id` made to Research environment
    /// `environment`, building nothing: what continues a build that failed
    /// after its images were asked for (once Research has built them all),
    /// and what redeploys -- or rolls back to -- an earlier build. Each image
    /// must be built and still in Research, read with the caller's sign-in.
    pub async fn deploy_built_images(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        build_id: &str,
        environment: Uuid,
    ) -> Result<Deployment> {
        let org = self.organization_of_project(ctx, project).await?;
        let env = self
            .project_environment(ctx, org, project, environment)
            .await?;
        if env.kind != EnvironmentKind::Research {
            return Err(Refusal::Precondition(
                "ENVIRONMENT_NOT_RESEARCH",
                format!(
                    "'{}' is not a Constructor Research environment: deploy the build there as \
                     usual",
                    env.name
                ),
            ));
        }
        let records =
            crate::environments::build_records::OrgBuilds::of(&self.hub, org).map_err(|_| {
                Refusal::Unavailable("builds are not available in this deployment".into())
            })?;
        let record = records
            .build(ctx, &project.to_string(), build_id)
            .await
            .map_err(|e| Refusal::Internal(format!("{e:#}")))?
            .ok_or_else(|| {
                Refusal::NotFound(
                    build_id.to_owned(),
                    format!("project {project} has no build {build_id}"),
                )
            })?;
        let record = self
            .reconcile_research_builds(org, vec![record])
            .await
            .into_iter()
            .next()
            .ok_or_else(|| Refusal::Internal("the build record went missing".into()))?;
        if record.r#where.as_deref() != Some("research") {
            return Err(Refusal::Precondition(
                "BUILD_NOT_MADE_IN_RESEARCH",
                format!(
                    "build {build_id} was not made in Constructor Research, which runs only images \
                     it built"
                ),
            ));
        }
        if record.status == "running" {
            return Err(Refusal::Precondition(
                "BUILD_STILL_RUNNING",
                format!("build {build_id} is still running: it deploys when it ends"),
            ));
        }
        if record.images.is_empty() {
            return Err(Refusal::Precondition(
                "BUILD_HAS_NO_IMAGES",
                format!(
                    "build {build_id} ended before it asked Constructor Research for any image: \
                     build again"
                ),
            ));
        }
        let api = self.own_research_api(ctx, org, Some(project)).await?;
        let missing: Vec<String> = research_images::image_states(&api, &record.images)
            .await
            .iter()
            .filter(|s| s.status != research_images::ImageStatus::Built)
            .map(research_images::ImageState::line)
            .collect();
        if !missing.is_empty() {
            return Err(Refusal::Precondition(
                "RESEARCH_IMAGES_NOT_READY",
                format!(
                    "Constructor Research has not built every image of build {build_id}: {}. \
                     Wait for it, or build again",
                    missing.join("; ")
                ),
            ));
        }
        let req = DeployRequest {
            environment_id: env.id,
            profile: String::new(),
            product: String::new(),
            commit: None,
            lock_hash: None,
            build: Some(build_id.to_owned()),
            images: Vec::new(),
            chart: None,
            chart_ref: None,
            chart_version: None,
            action: DeploymentAction::Install,
            redeploy_of: None,
            preview: None,
        };
        self.research_deploy_of(ctx, org, project, &env, req, true)
            .await
    }

    /// What Constructor Research says now of each image Research build
    /// `build_id` asked for, read with the caller's own sign-in and kept
    /// [`IMAGES_FOR`]; every image `unknown`, with why, when Research cannot
    /// be asked. An answer with an unknown image is not kept.
    pub async fn research_images(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        build_id: &str,
    ) -> Result<std::sync::Arc<Vec<ImageState>>> {
        let org = self.organization_of_project(ctx, project).await?;
        let records =
            crate::environments::build_records::OrgBuilds::of(&self.hub, org).map_err(|_| {
                Refusal::Unavailable("builds are not available in this deployment".into())
            })?;
        let record = records
            .build(ctx, &project.to_string(), build_id)
            .await
            .map_err(|e| Refusal::Internal(format!("{e:#}")))?
            .ok_or_else(|| {
                Refusal::NotFound(
                    build_id.to_owned(),
                    format!("project {project} has no build {build_id}"),
                )
            })?;
        if record.r#where.as_deref() != Some("research") {
            return Err(Refusal::Precondition(
                "BUILD_NOT_MADE_IN_RESEARCH",
                format!(
                    "build {build_id} was not made in Constructor Research: its images are in \
                     the registry it pushed them to"
                ),
            ));
        }
        let key = (ctx.subject_id(), project, build_id.to_owned());
        let images = record.images;
        let read = || async {
            let states = match self.own_research_api(ctx, org, Some(project)).await {
                Ok(api) => research_images::image_states(&api, &images).await,
                Err(r) => {
                    let why = r.line();
                    images
                        .iter()
                        .map(|(app, reference)| ImageState::unknown(app, reference, &why))
                        .collect()
                }
            };
            std::sync::Arc::new(states)
        };
        Ok(images_cache()
            .get_or_compute(key, 0, read, |v| {
                v.iter().all(|s| s.status != ImageStatus::Unknown)
            })
            .await)
    }

    /// The deploy "Build and run in Research" asked for, started by the
    /// build's run once Research has built every image: as this gear's
    /// service in the organization, with what the member's request kept
    /// (`basis`), so it happens whether or not anyone still watches.
    pub(crate) async fn deploy_after_build(
        &self,
        p: &research::ResearchBuildPayload,
        basis: &research::DeployBasis,
    ) -> Result<Deployment> {
        let org = p.organization_id;
        let svc = self.service(org)?;
        let env = self
            .project_environment(&svc, org, p.project_id, basis.environment_id)
            .await?;
        if env.kind != EnvironmentKind::Research {
            return Err(Refusal::Precondition(
                "ENVIRONMENT_NOT_RESEARCH",
                format!(
                    "'{}' is not a Constructor Research environment any more",
                    env.name
                ),
            ));
        }
        let req = DeployRequest {
            environment_id: env.id,
            profile: p.profile.clone(),
            product: String::new(),
            commit: None,
            lock_hash: None,
            build: Some(p.build_id.clone()),
            images: Vec::new(),
            chart: None,
            chart_ref: None,
            chart_version: None,
            action: DeploymentAction::Install,
            redeploy_of: None,
            preview: None,
        };
        // The description the build took (ADR-0053 §2), not a later one.
        let description = p.description_revision.zip(p.description_text.clone());
        self.research_deploy_with(
            &svc,
            org,
            p.project_id,
            &env,
            req,
            false,
            basis.clone(),
            description,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::sdk::research::{Building, DeskBuild};
    use crate::environments::research_app;
    use crate::tasks::{KeyedRun, RunView};

    fn payload() -> serde_json::Value {
        serde_json::json!({
            "build_id": "research-faa4fdf8107a",
            "organization_id": Uuid::nil(),
            "project_id": Uuid::nil(),
            "connection_id": Uuid::nil(),
            "research_project": "hyp3099-git-pull-test",
            "profile": "dev",
            "product_file": "product.gdl",
            "repo": { "tenant": Uuid::nil(), "connection_id": Uuid::nil(), "repo": "acme/shop", "branch": "main" },
        })
    }

    fn running() -> BuildRecord {
        BuildRecord {
            build_id: "research-faa4fdf8107a".into(),
            r#where: Some("research".into()),
            status: "running".into(),
            ..BuildRecord::default()
        }
    }

    fn run(state: RunState, result: Option<serde_json::Value>) -> KeyedRun {
        KeyedRun {
            id: Uuid::nil(),
            payload: payload(),
            view: RunView {
                state,
                result,
                last_error: Some(
                    "gave up after 1 deliveries, the last of which never reported back — the \
                     work is most likely longer than this queue's 900s lease"
                        .into(),
                ),
            },
        }
    }

    #[test]
    fn a_running_record_whose_run_was_given_up_on_is_recorded_failed_with_why() {
        // research-faa4fdf8107a, as the stand left it on 2026-11-23: a run
        // from before builds were resumable, so nothing under `resume`.
        let out = reconciled(&running(), &run(RunState::Failed, None)).expect("put right");
        assert_eq!(out.status, "failed");
        let failure = out.failure.unwrap();
        assert!(failure.contains("Studio stopped following"), "{failure}");
        assert!(failure.contains("gave up after 1 deliveries"), "{failure}");
        assert_eq!(out.failure_step.as_deref(), Some("images"));
        assert!(out.images.is_empty());

        let cancelled = reconciled(&running(), &run(RunState::Cancelled, None)).unwrap();
        assert_eq!(cancelled.status, "cancelled");
    }

    #[test]
    fn a_run_that_may_still_record_its_end_is_left_alone() {
        for state in [RunState::Queued, RunState::Running, RunState::Succeeded] {
            assert!(reconciled(&running(), &run(state, None)).is_none());
        }
        let ended = BuildRecord {
            status: "failed".into(),
            ..running()
        };
        assert!(reconciled(&ended, &run(RunState::Failed, None)).is_none());
        let cluster = BuildRecord {
            r#where: None,
            ..running()
        };
        assert!(reconciled(&cluster, &run(RunState::Failed, None)).is_none());
    }

    #[test]
    fn a_failed_build_keeps_the_images_it_had_asked_for() {
        let resume = research::Resume {
            made: Some(research::Made {
                product: "shop".into(),
                commit: "0123456789abcdef0123456789abcdef01234567".into(),
                bakes: [("api".to_owned(), "b1".to_owned())].into(),
                ..research::Made::default()
            }),
            desk: DeskBuild {
                submitted: true,
                images: vec![Building {
                    key: "api".into(),
                    name: "gbx-api".into(),
                    id: "img-1".into(),
                    dockerfile: "studio-api.dockerfile".into(),
                    first_name: None,
                    erred: false,
                    done: false,
                    reused: false,
                }],
                ..DeskBuild::default()
            },
        };
        let recorded = serde_json::json!({ "resume": resume });
        let out = reconciled(&running(), &run(RunState::Failed, Some(recorded))).unwrap();
        assert_eq!(
            out.images,
            vec![(
                "api".to_owned(),
                research_app::image_reference("b1", "gbx-api", "img-1")
            )]
        );
        assert_eq!(out.product.as_deref(), Some("shop"));
    }
}
