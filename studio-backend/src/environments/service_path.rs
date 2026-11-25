//! A project's path to running (#1050) read in one go, and the caller's own
//! Constructor Research projects and hardware for the one deploy dialog
//! (#1053).

use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::{EnvironmentService, RESEARCH_SIGN_IN_WARN_DAYS, Refusal, Result, sign_in_due};
use crate::connectors::sdk as connectors;
use crate::environments::model::EnvironmentKind;
use crate::environments::path::{self, PathEnvironment, PathFacts, ProjectPath, SignInState};

/// How many builds the path reads: the newest, and the newest that passed
/// among them.
const PATH_BUILDS: usize = 50;

/// The caller's own Constructor Research sign-in, as the deploy dialog shows
/// it (#1053).
#[derive(Debug, Clone)]
pub struct ResearchSignIn {
    /// The caller's own `research` connection, when they signed in.
    pub connection_id: Option<Uuid>,
    pub state: SignInState,
}

/// The path, and what it was decided about.
#[derive(Debug, Clone)]
pub struct PathView {
    pub organization_id: Uuid,
    pub path: ProjectPath,
    /// Whether the Constructor Research kit applies to the project: without
    /// it, no Research target is offered.
    pub research_kit: bool,
    /// The caller's sign-in; `None` where the kit does not apply.
    pub research: Option<ResearchSignIn>,
    /// The targets and the project's deploys the path was decided from:
    /// what `/targets` and `/deployments` answer, so the Releases tab need
    /// not ask for them again (`?include=`).
    pub targets: super::Targets,
    pub deployments: Vec<crate::environments::model::Deployment>,
    /// The path's stages 5-9, Product to Deploy (`project_path.rs`): what
    /// every tab draws.
    pub stages: Vec<crate::project_path::Stage>,
}

/// What a project's status reads its stages 5-9 through (`port.rs`).
pub struct DeliveryStagesPort(pub std::sync::Arc<EnvironmentService>);

#[async_trait::async_trait]
impl crate::environments::port::ProjectDeliveryStages for DeliveryStagesPort {
    async fn delivery_stages(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
    ) -> anyhow::Result<Vec<crate::project_path::Stage>> {
        self.0
            .project_path(ctx, project)
            .await
            .map(|v| v.stages)
            .map_err(|e| anyhow::anyhow!("{e:?}"))
    }
}

impl EnvironmentService {
    /// The caller's own Research sign-in, looked for as a build or deploy
    /// would look for it (the project, then the organization, then their own
    /// tenant), and whether it runs out.
    async fn research_sign_in(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        project: Uuid,
    ) -> ResearchSignIn {
        let am = self.store.am().as_ref();
        let from = [project, org, ctx.subject_tenant_id()];
        let Some((_, c)) =
            connectors::own_connection(am, ctx, &from, connectors::RESEARCH_PROVIDER).await
        else {
            return ResearchSignIn {
                connection_id: None,
                state: SignInState::None,
            };
        };
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        let state = match sign_in_due(
            c.id,
            c.created_at_epoch_secs,
            now,
            connectors::RESEARCH_KEY_LIFETIME_DAYS,
            RESEARCH_SIGN_IN_WARN_DAYS,
        ) {
            None => SignInState::SignedIn,
            Some(due) if due.days_left == 0 => SignInState::Expired,
            Some(due) => SignInState::RunsOut(due.days_left),
        };
        ResearchSignIn {
            connection_id: Some(c.id),
            state,
        }
    }

    /// Where `project` stands on its way from a product to running.
    pub async fn project_path(&self, ctx: &SecurityContext, project: Uuid) -> Result<PathView> {
        let targets = self.targets(ctx, project).await?;
        let org = targets.organization_id;
        // Everything below needs only the organization: read side by side
        // (seven reads in turn were 7.7 s on Dev). A refusal is said in the
        // order they used to be read in.
        // A gear reading as itself (the project's status) has no Research
        // sign-in of its own: whoever deploys brings theirs.
        let as_gear = ctx.subject_type() == Some("service");
        let research = async {
            let research_kit = self.research_kit_applies(ctx, project).await?;
            let research = if research_kit && !as_gear {
                Some(self.research_sign_in(ctx, org, project).await)
            } else {
                None
            };
            Ok::<_, Refusal>((research_kit, research))
        };
        let builds = async {
            match crate::environments::build_records::OrgBuilds::of(&self.hub, org) {
                Ok(records) => records
                    .builds(ctx, &project.to_string(), PATH_BUILDS)
                    .await
                    .map_err(|e| Refusal::Internal(format!("the builds could not be read: {e:#}"))),
                Err(_) => Ok(Vec::new()),
            }
        };
        let product_revision = async {
            match self.hub.get::<dyn crate::product::port::ProjectProducts>() {
                Ok(products) => {
                    let latest = products
                        .latest_description(ctx, project)
                        .await
                        .map_err(|e| {
                            Refusal::Internal(format!(
                                "the product description could not be read: {e:#}"
                            ))
                        })?;
                    Ok::<_, Refusal>(match latest {
                        Some(d) => Some(d.revision.max(1)),
                        None => products
                            .saved_description(ctx, &project.to_string())
                            .await
                            .ok()
                            .flatten()
                            .map(|_| 0),
                    })
                }
                Err(_) => Ok(None),
            }
        };
        let deployments = self.deployments(ctx, org, Some(project), None);
        // The product record and the CI runs, for the Product and Build
        // stages (`project_path.rs`): read as the project's status reads them.
        let record = async {
            let products = self
                .hub
                .get::<dyn crate::product::port::ProjectProducts>()
                .ok()?;
            let record = products
                .product_record(ctx, &project.to_string())
                .await
                .ok()?;
            Some(crate::organizations::product_record_facts(record.as_ref()))
        };
        let ci = async {
            let evidence = self
                .hub
                .get::<dyn crate::artifact_ingest::port::DeliveryEvidence>()
                .ok()?;
            let runs = evidence.ci_runs(ctx, &project.to_string()).await.ok()?;
            Some(crate::organizations::last_build(runs))
        };
        let (research, builds, product_revision, deployments, record, ci) =
            tokio::join!(research, builds, product_revision, deployments, record, ci);
        let (research_kit, research) = research?;
        let builds = self.reconcile_research_builds(org, project, builds?).await;
        let product_revision: Option<i64> = product_revision?;
        let deployments = deployments?;
        // A product built before Studio kept its description is one.
        let product_revision = product_revision.or((!builds.is_empty()).then_some(0));

        let mut environments: Vec<PathEnvironment> = targets
            .environments
            .iter()
            .filter(|(e, _)| research_kit || e.kind != EnvironmentKind::Research)
            .map(|(env, _namespace)| PathEnvironment {
                bound: targets.bindings.iter().any(|b| b.environment_id == env.id),
                env: env.clone(),
                missing_secrets: Vec::new(),
            })
            .collect();
        // The secrets are read for the environment the path is about only:
        // each read reads the description.
        if let Some(target) = path::target_environment(&environments, &deployments)
            && let Ok(keys) = self.secret_keys(ctx, project, target).await
            && let Some(e) = environments.iter_mut().find(|e| e.env.id == target)
        {
            e.missing_secrets = keys
                .needed
                .iter()
                .filter(|n| n.missing())
                .map(|n| n.key.clone())
                .collect();
        }
        let facts = PathFacts {
            product_revision,
            builds,
            environments,
            deployments,
            research_kit,
            sign_in: match &research {
                Some(r) => r.state,
                None if as_gear => SignInState::NotAsked,
                None => SignInState::None,
            },
        };
        let delivery = path::project_path(&facts);
        let (product, check) = match &record {
            Some((product, check)) => (Some(product), check.as_ref()),
            None => (None, None),
        };
        let steps: Vec<crate::project_path::DeliveryStep> =
            delivery.steps.iter().map(Into::into).collect();
        let stages = crate::project_path::delivery_stages(&crate::project_path::DeliveryFacts {
            product,
            revision: facts.product_revision,
            check,
            ci: ci.as_ref(),
            path: Some(&steps),
        });
        Ok(PathView {
            organization_id: org,
            path: delivery,
            research_kit,
            research,
            targets,
            deployments: facts.deployments,
            stages,
        })
    }

    /// The Research projects the caller's own sign-in may run `project`'s
    /// product in: what the deploy dialog offers as Research targets (#1053).
    /// Refused without the kit, and without a sign-in.
    pub async fn my_research_projects(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
    ) -> Result<(Uuid, Vec<connectors::research::Project>)> {
        let org = self.organization_of_project(ctx, project).await?;
        self.require_research_kit(ctx, project).await?;
        let sign_in = self.own_research(ctx, org, Some(project)).await?;
        let mut projects = self
            .research_api(ctx, sign_in.tenant, sign_in.connection_id)
            .await?
            .projects()
            .await
            .map_err(|e| {
                Refusal::Precondition("ENVIRONMENT_RESEARCH_UNREACHABLE", format!("{e:#}"))
            })?;
        // Where a build can go first: a project whose Deployment is off
        // refuses to build images, and the picker shows it last, disabled.
        projects.sort_by_key(|p| p.deployment_enabled == Some(false));
        Ok((sign_in.connection_id, projects))
    }

    /// The hardware of one of the caller's Research projects.
    pub async fn my_research_hardware(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        research_project: &str,
    ) -> Result<Vec<connectors::research::Hardware>> {
        let org = self.organization_of_project(ctx, project).await?;
        self.require_research_kit(ctx, project).await?;
        self.own_research_api(ctx, org, Some(project))
            .await?
            .hardware(research_project)
            .await
            .map_err(|e| {
                Refusal::Precondition("ENVIRONMENT_RESEARCH_UNREACHABLE", format!("{e:#}"))
            })
    }

    /// Where the portal opens one of `project`'s deploys: Project › Releases
    /// with the deploy named (the shell keeps the foreign `deployment`
    /// parameter for the screen). The project's workspace is its parent.
    pub async fn deployment_link(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        project: Uuid,
        deployment: Uuid,
    ) -> String {
        let am = self.store.am().as_ref();
        let workspace = am
            .get_tenant(ctx, project)
            .await
            .ok()
            .and_then(|t| t.parent_id.map(|p| p.0))
            .filter(|w| *w != org);
        let workspace = workspace
            .map(|w| format!(";workspace={w}"))
            .unwrap_or_default();
        format!("/?screen=releases;org={org}{workspace};project={project}&deployment={deployment}")
    }
}
