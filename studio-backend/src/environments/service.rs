//! What the routes do: who may, against what, and in which order.

use std::sync::Arc;

use base64::Engine;
use sha2::{Digest, Sha256};
use toolkit::client_hub::{ClientHub, ClientScope};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::deploy::{self, DeployPayload, Rollout};
use super::model::{
    self, Binding, BindingList, DeployImage, Deployment, DeploymentList, DeploymentState,
    Environment, EnvironmentInput, EnvironmentList, Invalid,
};
use super::store::{Store, service_context};
use super::{BINDINGS_METADATA_TYPE, DEPLOYMENTS_METADATA_TYPE, ENVIRONMENTS_METADATA_TYPE};
use crate::connectors::sdk as connectors;

/// The privilege that manages an organization's environments and decides
/// about deploys to its protected ones (ADR-0043 §1, §3).
pub const MANAGE_PRIVILEGE: &str = "environment.manage";

/// Why a request was not done. Each maps onto one HTTP answer.
#[derive(Debug)]
pub enum Refusal {
    /// 403: the caller may not; the reason code the problem carries.
    Forbidden(&'static str),
    /// 404: not there, or not for this caller: the id asked for, and why.
    NotFound(String, String),
    /// 400: the request as written cannot be done.
    Invalid(String),
    /// 400 failed_precondition: not now, in this state.
    Precondition(&'static str, String),
    /// 503: a gear this needs is missing.
    Unavailable(String),
    /// 500.
    Internal(String),
}

impl From<anyhow::Error> for Refusal {
    fn from(e: anyhow::Error) -> Self {
        Self::Internal(format!("{e:#}"))
    }
}

impl From<Invalid> for Refusal {
    fn from(e: Invalid) -> Self {
        Self::Invalid(e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Refusal>;

/// A person as a record names them.
#[derive(Debug, Clone)]
pub struct Person {
    pub id: String,
    pub name: Option<String>,
}

/// What a project sees: the environments it may deploy to, each with the
/// namespace it would get there, and its bindings.
#[derive(Debug, Clone)]
pub struct Targets {
    pub organization_id: Uuid,
    pub project_name: String,
    pub environments: Vec<(Environment, String)>,
    pub bindings: Vec<Binding>,
}

/// A deploy as asked for.
#[derive(Debug, Clone)]
pub struct DeployRequest {
    pub environment_id: Uuid,
    pub profile: String,
    pub product: String,
    pub commit: Option<String>,
    pub lock_hash: Option<String>,
    /// The build it came from, when the IDE deploys one it built.
    pub build: Option<String>,
    pub images: Vec<DeployImage>,
    /// The chart, a `.tgz`, base64.
    pub chart: String,
}

pub struct EnvironmentService {
    store: Store,
    hub: Arc<ClientHub>,
}

fn now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

/// A commit or a lock hash: hex, 7 to 64.
fn check_hash(field: &'static str, v: Option<String>) -> Result<Option<String>> {
    let Some(v) = v.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if (7..=64).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(Some(v))
    } else {
        Err(Refusal::Invalid(format!("{field} '{v}' is not a hex hash")))
    }
}

/// A build id as the IDE makes one: 8 to 64 letters, digits and hyphens.
fn check_build(v: Option<String>) -> Result<Option<String>> {
    let Some(v) = v.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if (8..=64).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        Ok(Some(v))
    } else {
        Err(Refusal::Invalid(format!("build '{v}' is not a build id")))
    }
}

impl EnvironmentService {
    pub fn new(store: Store, hub: Arc<ClientHub>) -> Self {
        Self { store, hub }
    }

    fn service(&self, tenant: Uuid) -> Result<SecurityContext> {
        service_context(tenant).map_err(Refusal::from)
    }

    /// May the caller administer `org`'s environments?
    pub async fn may_manage(&self, ctx: &SecurityContext, org: Uuid) -> bool {
        match self
            .hub
            .get_scoped::<dyn crate::user_profile::OrgAuthority>(&ClientScope::gts_id(
                crate::user_profile::IDENTITY_INSTANCE_ID,
            )) {
            Ok(authority) => authority.may_administer(ctx, org, MANAGE_PRIVILEGE).await,
            // Without studio-user nobody can be shown to hold it.
            Err(_) => false,
        }
    }

    async fn require_manage(&self, ctx: &SecurityContext, org: Uuid) -> Result<()> {
        if self.may_manage(ctx, org).await {
            Ok(())
        } else {
            // Only an organization administrator, or whoever holds
            // MANAGE_PRIVILEGE, manages environments and decides about
            // deploys to protected ones.
            Err(Refusal::Forbidden("ENVIRONMENT_ADMIN_REQUIRED"))
        }
    }

    /// The caller as a person, with the name their profile carries.
    pub async fn person(&self, ctx: &SecurityContext) -> Person {
        if let Ok(people) = self
            .hub
            .get_scoped::<dyn crate::user_profile::PersonResolver>(&ClientScope::gts_id(
                crate::user_profile::IDENTITY_INSTANCE_ID,
            ))
            && let Ok((id, name)) = people.resolve_caller_named(ctx).await
        {
            return Person { id, name };
        }
        Person {
            id: ctx.subject_id().to_string(),
            name: None,
        }
    }

    /// The organization a project is in, read as the caller: refused when the
    /// caller cannot see the project.
    pub async fn organization_of_project(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
    ) -> Result<Uuid> {
        crate::organizations::sdk::organization_of(self.store.am().as_ref(), ctx, project)
            .await
            .filter(|org| *org != project)
            .ok_or_else(|| {
                Refusal::NotFound(
                    project.to_string(),
                    format!("there is no project {project} for this caller"),
                )
            })
    }

    /* ── environments ── */

    pub async fn environments(&self, ctx: &SecurityContext, org: Uuid) -> Result<EnvironmentList> {
        Ok(self
            .store
            .read::<EnvironmentList>(ctx, org, ENVIRONMENTS_METADATA_TYPE)
            .await?
            .0)
    }

    async fn environment(&self, ctx: &SecurityContext, org: Uuid, id: Uuid) -> Result<Environment> {
        self.environments(ctx, org)
            .await?
            .items
            .into_iter()
            .find(|e| e.id == id)
            .ok_or_else(|| {
                Refusal::NotFound(
                    id.to_string(),
                    format!("the organization has no environment {id}"),
                )
            })
    }

    /// The connection an environment names must be a Kubernetes cluster the
    /// organization holds, shared with it: a deploy runs as the service, which
    /// cannot read somebody's personal token.
    async fn check_connection(&self, ctx: &SecurityContext, org: Uuid, id: Uuid) -> Result<()> {
        let am = self.store.am().as_ref();
        let (at, c) = connectors::connection_by_id(am, ctx, org, id)
            .await
            .ok_or_else(|| {
                Refusal::Invalid(format!("there is no connection {id} in the organization"))
            })?;
        if c.provider != "kubernetes" {
            return Err(Refusal::Invalid(format!(
                "connection '{}' is {}, not a Kubernetes cluster",
                c.label, c.provider
            )));
        }
        if c.scope == "personal" {
            return Err(Refusal::Invalid(format!(
                "connection '{}' is personal: an environment's cluster is the organization's, \
                 so connect it for the organization",
                c.label
            )));
        }
        let holder = connectors::holder_of_row(&c, at);
        connectors::check_owned(am, ctx, org, org, Some(holder))
            .await
            .map_err(|e| Refusal::Invalid(format!("{e}")))
    }

    pub async fn put_environment(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        id: Option<Uuid>,
        input: EnvironmentInput,
    ) -> Result<Environment> {
        self.require_manage(ctx, org).await?;
        self.check_connection(ctx, org, input.connection_id).await?;
        let by = self.person(ctx).await.id;
        let at = now();
        let svc = self.service(org)?;
        let written = self
            .store
            .update::<EnvironmentList, Environment, Refusal>(
                &svc,
                org,
                ENVIRONMENTS_METADATA_TYPE,
                |list| {
                    if let Some(id) = id
                        && !list.items.iter().any(|e| e.id == id)
                    {
                        return Err(Refusal::NotFound(
                            id.to_string(),
                            format!("the organization has no environment {id}"),
                        ));
                    }
                    let env = model::checked(list, id, input.clone(), by.clone(), at.clone())?;
                    match list.items.iter_mut().find(|e| e.id == env.id) {
                        Some(slot) => *slot = env.clone(),
                        None => list.items.push(env.clone()),
                    }
                    list.items.sort_by(|a, b| a.name.cmp(&b.name));
                    Ok(env)
                },
            )
            .await?;
        written.map(|(_, env)| env)
    }

    pub async fn delete_environment(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        id: Uuid,
    ) -> Result<()> {
        self.require_manage(ctx, org).await?;
        let svc = self.service(org)?;
        self.store
            .update::<EnvironmentList, (), Refusal>(&svc, org, ENVIRONMENTS_METADATA_TYPE, |list| {
                let before = list.items.len();
                list.items.retain(|e| e.id != id);
                if list.items.len() == before {
                    Err(Refusal::NotFound(
                        id.to_string(),
                        format!("the organization has no environment {id}"),
                    ))
                } else {
                    Ok(())
                }
            })
            .await?
            .map(|_| ())
    }

    /// Reach the environment's cluster with its connection and say what
    /// answered.
    pub async fn test_environment(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        id: Uuid,
    ) -> Result<String> {
        self.require_manage(ctx, org).await?;
        let env = self.environment(ctx, org, id).await?;
        let svc = self.service(org)?;
        let access = deploy::cluster_access(&self.hub, &svc, org, env.connection_id)
            .await
            .map_err(|e| Refusal::Precondition("ENVIRONMENT_CLUSTER_UNUSABLE", format!("{e:#}")))?;
        let client = access.client().await.map_err(|e| {
            Refusal::Precondition("ENVIRONMENT_CLUSTER_UNREACHABLE", format!("{e:#}"))
        })?;
        let version = client.apiserver_version().await.map_err(|e| {
            Refusal::Precondition(
                "ENVIRONMENT_CLUSTER_UNREACHABLE",
                format!("the cluster did not answer: {e}"),
            )
        })?;
        Ok(format!(
            "{} answers: Kubernetes {}",
            access.server, version.git_version
        ))
    }

    /* ── a project's bindings and targets ── */

    pub async fn targets(&self, ctx: &SecurityContext, project: Uuid) -> Result<Targets> {
        let org = self.organization_of_project(ctx, project).await?;
        let project_name = self.store.tenant_name(ctx, project).await;
        let environments = self
            .environments(ctx, org)
            .await?
            .items
            .into_iter()
            .filter(|e| e.admits(project))
            .map(|e| {
                let ns = model::namespace_for(&e.namespace_pattern, &project_name, &e.name)
                    .unwrap_or_default();
                (e, ns)
            })
            .collect();
        let bindings = self
            .store
            .read::<BindingList>(ctx, project, BINDINGS_METADATA_TYPE)
            .await?
            .0
            .items;
        Ok(Targets {
            organization_id: org,
            project_name,
            environments,
            bindings,
        })
    }

    pub async fn put_bindings(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        items: Vec<Binding>,
    ) -> Result<Vec<Binding>> {
        let org = self.organization_of_project(ctx, project).await?;
        let list = model::checked_bindings(items)?;
        let environments = self.environments(ctx, org).await?;
        for b in &list.items {
            let env = environments
                .items
                .iter()
                .find(|e| e.id == b.environment_id)
                .ok_or_else(|| {
                    Refusal::Invalid(format!(
                        "the organization has no environment {}",
                        b.environment_id
                    ))
                })?;
            if !env.admits(project) {
                return Err(Refusal::Invalid(format!(
                    "environment '{}' does not take this project's deploys",
                    env.name
                )));
            }
        }
        // The project's own setting, written as its member: a binding grants
        // nothing -- a deploy is still checked against the environment.
        self.store
            .update::<BindingList, (), Refusal>(ctx, project, BINDINGS_METADATA_TYPE, |row| {
                *row = list.clone();
                Ok(())
            })
            .await?
            .map(|(row, ())| row.items)
    }

    /* ── deployments ── */

    async fn enqueue(&self, org: Uuid, payload: &DeployPayload) -> Result<Uuid> {
        let queue = self
            .hub
            .get_scoped::<dyn crate::tasks::TaskQueue>(&ClientScope::gts_id(
                crate::tasks::TASK_QUEUE_INSTANCE_ID,
            ))
            .map_err(|_| {
                Refusal::Unavailable("background runs are not available in this deployment".into())
            })?;
        let svc = self.service(org)?;
        let partition = format!("{}:{}", payload.namespace, payload.release);
        queue
            .enqueue(
                &svc,
                crate::tasks::sdk::NewRun {
                    tenant: org,
                    task_type: deploy::TASK_TYPE,
                    payload: serde_json::to_value(payload).map_err(anyhow::Error::from)?,
                    // One release is installed by one run at a time.
                    partition_key: Some(&partition),
                    idempotency_key: Some(&payload.deployment_id.to_string()),
                    coalesce_queued: false,
                    notify_workspace_id: None,
                },
            )
            .await
            .map_err(|e| Refusal::Unavailable(format!("the deploy could not be queued: {e:#}")))
    }

    /// Queue the run, or record that it could not be queued: a record left
    /// `queued` with no run would say "deploying" for ever.
    async fn queue_or_fail(
        &self,
        org: Uuid,
        d: &mut Deployment,
        payload: DeployPayload,
    ) -> Result<Uuid> {
        match self.enqueue(org, &payload).await {
            Ok(run) => Ok(run),
            Err(refusal) => {
                d.state = DeploymentState::Failed;
                d.outcome = Some(match &refusal {
                    Refusal::Unavailable(why) | Refusal::Internal(why) => why.clone(),
                    _ => "the deploy could not be queued".to_owned(),
                });
                if let Err(e) = self.record(org, d.clone()).await {
                    tracing::warn!(error = ?e, "studio-environments: an unqueued deploy could not be recorded as failed");
                }
                Err(refusal)
            }
        }
    }

    fn payload(org: Uuid, env: &Environment, d: &Deployment, chart: String) -> DeployPayload {
        DeployPayload {
            deployment_id: d.id,
            organization_id: org,
            project_id: d.project_id,
            connection_id: env.connection_id,
            namespace: d.namespace.clone(),
            release: d.product.clone(),
            chart,
            values: model::image_values(env, &d.images),
        }
    }

    async fn record(&self, org: Uuid, d: Deployment) -> Result<()> {
        let svc = self.service(org)?;
        self.store
            .update::<DeploymentList, (), Refusal>(&svc, org, DEPLOYMENTS_METADATA_TYPE, |list| {
                list.record(d.clone());
                Ok(())
            })
            .await?
            .map(|_| ())
    }

    pub async fn request_deploy(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        req: DeployRequest,
    ) -> Result<Deployment> {
        let org = self.organization_of_project(ctx, project).await?;
        let env = self.environment(ctx, org, req.environment_id).await?;
        if !env.admits(project) {
            return Err(Refusal::Forbidden("ENVIRONMENT_NOT_FOR_THIS_PROJECT"));
        }
        let product = req.product.trim().to_owned();
        // A Helm release name: a DNS label of at most 53.
        if !model::is_dns_label(&product) || product.len() > 53 {
            return Err(Refusal::Invalid(format!(
                "'{product}' cannot be a release name"
            )));
        }
        model::check_images(&req.images)?;
        let chart = base64::engine::general_purpose::STANDARD
            .decode(req.chart.trim().as_bytes())
            .map_err(|_| Refusal::Invalid("the chart is not base64".into()))?;
        if chart.is_empty() || chart.len() > model::MAX_CHART_BYTES {
            return Err(Refusal::Invalid(format!(
                "the chart is {} bytes; a packaged chart is between 1 and {}",
                chart.len(),
                model::MAX_CHART_BYTES
            )));
        }
        // gzip magic: the chart is a packaged `.tgz`.
        if !chart.starts_with(&[0x1f, 0x8b]) {
            return Err(Refusal::Invalid("the chart is not a packaged .tgz".into()));
        }
        let project_name = self.store.tenant_name(ctx, project).await;
        let namespace = model::namespace_for(&env.namespace_pattern, &project_name, &env.name)?;
        let person = self.person(ctx).await;
        let mut d = Deployment {
            id: Uuid::new_v4(),
            project_id: project,
            project_name,
            environment_id: env.id,
            environment_name: env.name.clone(),
            profile: req.profile.trim().to_owned(),
            product,
            commit: check_hash("commit", req.commit)?,
            lock_hash: check_hash("lock_hash", req.lock_hash)?,
            build: check_build(req.build)?,
            images: req.images,
            namespace,
            chart_sha256: hex::encode(Sha256::digest(&chart)),
            state: DeploymentState::Queued,
            run_id: None,
            requested_by: person.id,
            requested_by_name: person.name.unwrap_or_default(),
            requested_at: now(),
            decided_by: None,
            decided_by_name: None,
            decided_at: None,
            reason: None,
            outcome: None,
            pending_chart: None,
        };
        let chart = req.chart.trim().to_owned();
        if env.protected {
            d.state = DeploymentState::AwaitingApproval;
            d.pending_chart = Some(chart);
            self.record(org, d.clone()).await?;
        } else {
            // Recorded before it is queued, so the run never finishes before
            // the record of it exists.
            self.record(org, d.clone()).await?;
            let payload = Self::payload(org, &env, &d, chart);
            let run = self.queue_or_fail(org, &mut d, payload).await?;
            d.run_id = Some(run);
            self.record(org, d.clone()).await?;
        }
        d.pending_chart = None;
        Ok(d)
    }

    /// Approve or decline a deploy waiting for one.
    pub async fn decide(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        id: Uuid,
        approve: bool,
        reason: Option<String>,
    ) -> Result<Deployment> {
        self.require_manage(ctx, org).await?;
        let reason = reason
            .map(|r| r.trim().to_owned())
            .filter(|r| !r.is_empty());
        if !approve && reason.is_none() {
            return Err(Refusal::Invalid(
                "a declined deploy says why: give a reason".into(),
            ));
        }
        let mut d = self.deployment(ctx, org, id).await?;
        if d.state != DeploymentState::AwaitingApproval {
            return Err(Refusal::Precondition(
                "DEPLOYMENT_NOT_AWAITING_APPROVAL",
                format!(
                    "the deploy is {}, not waiting for a decision",
                    d.state.as_str()
                ),
            ));
        }
        let person = self.person(ctx).await;
        d.decided_by = Some(person.id);
        d.decided_by_name = person.name;
        d.decided_at = Some(now());
        d.reason = reason;
        let chart = d.pending_chart.take();
        if approve {
            let env = self.environment(ctx, org, d.environment_id).await?;
            let chart = chart.ok_or_else(|| {
                Refusal::Precondition(
                    "DEPLOYMENT_CHART_GONE",
                    "the deploy no longer carries its chart: ask again".into(),
                )
            })?;
            d.state = DeploymentState::Queued;
            self.record(org, d.clone()).await?;
            let payload = Self::payload(org, &env, &d, chart);
            let run = self.queue_or_fail(org, &mut d, payload).await?;
            d.run_id = Some(run);
        } else {
            d.state = DeploymentState::Declined;
        }
        self.record(org, d.clone()).await?;
        Ok(d)
    }

    async fn deployment(&self, ctx: &SecurityContext, org: Uuid, id: Uuid) -> Result<Deployment> {
        self.store
            .read::<DeploymentList>(ctx, org, DEPLOYMENTS_METADATA_TYPE)
            .await?
            .0
            .items
            .into_iter()
            .find(|d| d.id == id)
            .ok_or_else(|| {
                Refusal::NotFound(
                    id.to_string(),
                    format!("the organization has no deployment {id}"),
                )
            })
    }

    /// An organization's deployments, newest first, each with where its run
    /// has got to. A run that ended since the last read is written back, so
    /// the record keeps its outcome after the run's history is swept.
    pub async fn deployments(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        project: Option<Uuid>,
        environment: Option<Uuid>,
    ) -> Result<Vec<Deployment>> {
        let (list, _) = self
            .store
            .read::<DeploymentList>(ctx, org, DEPLOYMENTS_METADATA_TYPE)
            .await?;
        let queue = self
            .hub
            .get_scoped::<dyn crate::tasks::TaskQueue>(&ClientScope::gts_id(
                crate::tasks::TASK_QUEUE_INSTANCE_ID,
            ))
            .ok();
        let mut ended = Vec::new();
        let mut items = Vec::new();
        for mut d in list.items {
            if project.is_some_and(|p| p != d.project_id)
                || environment.is_some_and(|e| e != d.environment_id)
            {
                continue;
            }
            if let (Some(queue), Some(run), DeploymentState::Queued | DeploymentState::Running) =
                (&queue, d.run_id, d.state)
                && let Ok(Some(view)) = queue.run(org, run).await
            {
                let state = match view.state {
                    crate::tasks::RunState::Queued => DeploymentState::Queued,
                    crate::tasks::RunState::Running => DeploymentState::Running,
                    crate::tasks::RunState::Succeeded => DeploymentState::Succeeded,
                    crate::tasks::RunState::Failed => DeploymentState::Failed,
                    crate::tasks::RunState::Cancelled => DeploymentState::Cancelled,
                };
                if state != d.state {
                    d.state = state;
                    d.outcome = view.last_error.clone().or_else(|| {
                        view.result
                            .as_ref()
                            .and_then(|r| r.get("output"))
                            .and_then(|o| o.as_str())
                            .map(|o| o.lines().last().unwrap_or_default().to_owned())
                    });
                    if view.state.is_terminal() {
                        ended.push(d.clone());
                    }
                }
            }
            d.pending_chart = None;
            items.push(d);
        }
        for d in ended {
            // Best effort: the answer above is right either way.
            if let Err(e) = self.record(org, d).await {
                tracing::warn!(error = ?e, "studio-environments: a finished deploy could not be written back");
            }
        }
        Ok(items)
    }

    /// The release's rollout as its cluster reports it now.
    pub async fn status(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        id: Uuid,
    ) -> Result<(Deployment, Rollout)> {
        let d = self.deployment(ctx, org, id).await?;
        let env = self.environment(ctx, org, d.environment_id).await?;
        // The member asked through a deployment they can see; the cluster is
        // read as the service, which can read the organization's connection.
        let svc = self.service(org)?;
        let access = deploy::cluster_access(&self.hub, &svc, org, env.connection_id)
            .await
            .map_err(|e| Refusal::Precondition("ENVIRONMENT_CLUSTER_UNUSABLE", format!("{e:#}")))?;
        let rollout = deploy::rollout(&access, &d.namespace, &d.product)
            .await
            .map_err(|e| {
                Refusal::Precondition("ENVIRONMENT_CLUSTER_UNREACHABLE", format!("{e:#}"))
            })?;
        let mut d = d;
        d.pending_chart = None;
        Ok((d, rollout))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hash_is_hex_of_a_sensible_length() {
        assert_eq!(check_hash("commit", None).unwrap(), None);
        assert_eq!(check_hash("commit", Some(" ".into())).unwrap(), None);
        assert_eq!(
            check_hash("commit", Some("ea964f9".into()))
                .unwrap()
                .as_deref(),
            Some("ea964f9")
        );
        assert!(check_hash("commit", Some("main".into())).is_err());
        assert!(check_hash("commit", Some("abc".into())).is_err());
    }
}
