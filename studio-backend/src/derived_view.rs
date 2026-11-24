//! A derived view: what a gear computes from a project's synced repositories,
//! computed when they move and kept, so a screen reads it in milliseconds.
//!
//! The Components tab read every source repository live from the provider on
//! every open (a tree, a GraphQL query for open pull requests, the history of
//! up to 25 directories): 17-18 s on the local stand, each time. Nothing in
//! that answer changes between two syncs of the repositories, so it is
//! computed once per change and stored:
//!
//! - **Inputs.** What a view is computed from is what a sync stored (files,
//!   pull requests and the links between them, in the model) and the
//!   server's own clone of the repository (its `git log`). Never the
//!   provider: fetching from the provider is the sync's job alone.
//! - **When.** Every repository sync that finishes tells
//!   `artifact_ingest::port::on_repository_synced`; [`RecomputeOnSync`] queues
//!   a `studio-tasks` run of each registered view for the project. A person
//!   can ask for one too (the screen's ↻), and a project nobody computed yet
//!   is queued by its first read. Runs of one view and project share a
//!   partition and a waiting run is joined, so a burst of syncs computes once.
//! - **Where.** The result is gear-held domain objects (ADR-0066 §8a): one
//!   item object per row ([`ViewSpec::item_entity`]) and one state object per
//!   project ([`ViewSpec::state_entity`]) saying what it was computed from
//!   (each source and its commit), when, and whether a computation is
//!   running or failed. A failed or running computation keeps the last
//!   result readable.
//!
//! The mechanism knows nothing of components. A gear declares a [`ViewSpec`],
//! implements [`Derive`], registers a [`DeriveTask`] and the spec with
//! [`RecomputeOnSync`], and reads with [`ViewSpec::read`]. Each gear has its
//! own state type: a type has exactly one holder (ADR-0037).

use std::collections::{BTreeSet, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use toolkit::client_hub::{ClientHub, ClientScope};
use toolkit_security::SecurityContext;
use tracing::{info, warn};
use uuid::Uuid;

use crate::domain_model::port::{DomainObjects, KeptByGear, OwnedObject, TypeNeed};
use crate::tasks::sdk::{TaskContext, TaskHandler, TaskOutcome};

/// A computation still `computing` after this long is taken for lost (its
/// process died): the next read queues it again.
const LOST_AFTER: time::Duration = time::Duration::minutes(15);

/// One derived view of a gear.
#[derive(Debug)]
pub struct ViewSpec {
    /// The gear that computes and holds it.
    pub gear: &'static str,
    /// The view's name, stored on its state: `project-components`.
    pub view: &'static str,
    /// The `studio-tasks` task type that computes it.
    pub task_type: &'static str,
    /// The model type of its rows.
    pub item_entity: &'static str,
    pub item_name: &'static str,
    pub item_description: &'static str,
    /// The rows' fields a query narrows by, `(name, type expression)`; the
    /// payload carries more.
    pub item_fields: &'static [(&'static str, &'static str)],
    /// The model type of its state, one object per project.
    pub state_entity: &'static str,
    pub state_name: &'static str,
}

/// One input a view was computed from: a source and where it stood.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ViewInput {
    /// `owner/repo`.
    pub source: String,
    /// The commit its files and history were read at, when known.
    pub commit: Option<String>,
    /// When the sync that stored its files finished, when known.
    pub synced_at: Option<String>,
    /// What part of the view could not be read from it, and why: the rows
    /// still show, without it.
    pub note: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ViewStatus {
    /// Queued or running; the rows are the last computation's.
    #[default]
    Computing,
    Ready,
    /// The last computation failed; the rows are the one before.
    Failed,
}

/// What a view was last computed from, when, and how that went.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ViewState {
    pub view: String,
    pub project_id: String,
    pub status: ViewStatus,
    pub inputs: Vec<ViewInput>,
    /// When the rows were computed (RFC 3339); `None` before the first.
    pub computed_at: Option<String>,
    /// When the computation now running was asked for.
    pub requested_at: Option<String>,
    pub error: Option<String>,
    pub items: u32,
    /// What the gear keeps beside the rows (its own shape).
    pub detail: Value,
}

impl ViewState {
    /// A computation asked for long ago that never finished: its run was lost.
    pub fn lost(&self, now: time::OffsetDateTime) -> bool {
        self.status == ViewStatus::Computing
            && self
                .requested_at
                .as_deref()
                .and_then(parse_time)
                .is_none_or(|at| now - at > LOST_AFTER)
    }
}

/// What a computation produced.
#[derive(Debug, Clone, Default)]
pub struct Derived {
    pub inputs: Vec<ViewInput>,
    /// `(key, payload)` of each row; the key is unique within the project.
    pub items: Vec<(String, Value)>,
    pub detail: Value,
}

fn parse_time(s: &str) -> Option<time::OffsetDateTime> {
    time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339).ok()
}

pub fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

/// The payload's `project_id`, the one field every row and state carries.
const PROJECT_FIELD: &str = "project_id";

impl ViewSpec {
    /// The two types the view needs in the model, both held by its gear.
    pub fn needs(&self) -> Vec<TypeNeed> {
        let need = |id: &str, name: &str, description: &str, fields: &[(&str, &str)]| TypeNeed {
            declared_by: self.gear.to_owned(),
            held_by: Some(self.gear.to_owned()),
            id: id.to_owned(),
            name: name.to_owned(),
            description: description.to_owned(),
            extends: Some("record".to_owned()),
            bucket: Some("content".to_owned()),
            fields: fields
                .iter()
                .map(|(n, t)| ((*n).to_owned(), (*t).to_owned(), String::new()))
                .collect(),
            relations: Vec::new(),
            searchable: false,
        };
        let mut item_fields: Vec<(&str, &str)> = vec![(PROJECT_FIELD, "string")];
        item_fields.extend(self.item_fields.iter().copied());
        vec![
            need(
                self.item_entity,
                self.item_name,
                self.item_description,
                &item_fields,
            ),
            need(
                self.state_entity,
                self.state_name,
                "What a derived view of a project was last computed from (each source and its \
                 commit), when, and whether a computation is running or failed.",
                &[
                    (PROJECT_FIELD, "string"),
                    ("status", "string"),
                    ("computed_at", "timestamp?"),
                ],
            ),
        ]
    }

    fn state_id(&self, project: Uuid) -> String {
        format!("{}:{project}", self.state_entity)
    }

    fn item_id(&self, project: Uuid, key: &str) -> String {
        format!("{}:{project}:{key}", self.item_entity)
    }

    /// The state and the rows of `project`, as stored: `None` before the
    /// first computation was asked for.
    pub async fn read(
        &self,
        port: &dyn DomainObjects,
        ctx: &SecurityContext,
        project: Uuid,
    ) -> anyhow::Result<(Option<ViewState>, Vec<Value>)> {
        let scope = project.to_string();
        let state = self.read_state(port, ctx, project).await?;
        if state.is_none() {
            return Ok((None, Vec::new()));
        }
        let rows = port
            .list_in(ctx, self.item_entity, &scope)
            .await?
            .into_iter()
            .map(|o| o.payload)
            .collect();
        Ok((state, rows))
    }

    async fn read_state(
        &self,
        port: &dyn DomainObjects,
        ctx: &SecurityContext,
        project: Uuid,
    ) -> anyhow::Result<Option<ViewState>> {
        let id = self.state_id(project);
        Ok(port
            .list_in(ctx, self.state_entity, &project.to_string())
            .await?
            .into_iter()
            .find(|o| o.instance_id == id || o.instance_id.ends_with(&format!(":{id}")))
            .and_then(|o| serde_json::from_value(o.payload).ok()))
    }

    async fn write_state(
        &self,
        port: &dyn DomainObjects,
        ctx: &SecurityContext,
        project: Uuid,
        state: &ViewState,
    ) -> anyhow::Result<()> {
        let mut payload = serde_json::to_value(state)?;
        payload[PROJECT_FIELD] = json!(project.to_string());
        port.put_objects(
            ctx,
            self.state_entity,
            vec![OwnedObject {
                id: self.state_id(project),
                scope: project.to_string(),
                payload,
            }],
        )
        .await?;
        Ok(())
    }

    /// Say a computation was asked for, keeping the last rows readable.
    pub async fn mark_computing(
        &self,
        port: &dyn DomainObjects,
        ctx: &SecurityContext,
        project: Uuid,
    ) -> anyhow::Result<ViewState> {
        let mut state = self
            .read_state(port, ctx, project)
            .await?
            .unwrap_or_else(|| ViewState {
                view: self.view.to_owned(),
                project_id: project.to_string(),
                ..ViewState::default()
            });
        state.status = ViewStatus::Computing;
        state.requested_at = Some(now_rfc3339());
        self.write_state(port, ctx, project, &state).await?;
        Ok(state)
    }

    /// Keep a computation's rows and say what they were computed from. Rows
    /// the last one had and this one has not are removed.
    pub async fn store(
        &self,
        port: &dyn DomainObjects,
        ctx: &SecurityContext,
        project: Uuid,
        derived: Derived,
    ) -> anyhow::Result<ViewState> {
        let scope = project.to_string();
        let objects: Vec<OwnedObject> = derived
            .items
            .into_iter()
            .map(|(key, mut payload)| {
                payload[PROJECT_FIELD] = json!(scope);
                OwnedObject {
                    id: self.item_id(project, &key),
                    scope: scope.clone(),
                    payload,
                }
            })
            .collect();
        let kept: BTreeSet<String> = objects.iter().map(|o| o.id.clone()).collect();
        let count = objects.len();
        if !objects.is_empty() {
            port.put_objects(ctx, self.item_entity, objects).await?;
        }
        let gone: Vec<String> = port
            .list_in(ctx, self.item_entity, &scope)
            .await?
            .into_iter()
            .map(|o| o.instance_id)
            .filter(|id| {
                !kept
                    .iter()
                    .any(|k| id == k || id.ends_with(&format!(":{k}")))
            })
            .collect();
        if !gone.is_empty() {
            port.remove_objects(ctx, self.item_entity, gone).await?;
        }
        let state = ViewState {
            view: self.view.to_owned(),
            project_id: scope,
            status: ViewStatus::Ready,
            inputs: derived.inputs,
            computed_at: Some(now_rfc3339()),
            requested_at: None,
            error: None,
            items: u32::try_from(count).unwrap_or(u32::MAX),
            detail: derived.detail,
        };
        self.write_state(port, ctx, project, &state).await?;
        Ok(state)
    }

    /// Say the computation failed, keeping the last rows.
    pub async fn fail(
        &self,
        port: &dyn DomainObjects,
        ctx: &SecurityContext,
        project: Uuid,
        error: String,
    ) -> anyhow::Result<()> {
        let mut state = self
            .read_state(port, ctx, project)
            .await?
            .unwrap_or_else(|| ViewState {
                view: self.view.to_owned(),
                project_id: project.to_string(),
                ..ViewState::default()
            });
        state.status = ViewStatus::Failed;
        state.error = Some(error);
        self.write_state(port, ctx, project, &state).await
    }
}

/// The model's port, reached as the gear (`KeptByGear`): the view's records
/// are the gear's, and its routes decide who reads them.
pub fn port(hub: &ClientHub) -> Option<Arc<dyn DomainObjects>> {
    hub.get::<dyn DomainObjects>().ok().map(KeptByGear::wrap)
}

/// `ctx` acting in the organization `project` belongs to: where the view's
/// records live in the model.
pub async fn in_org_of(hub: &ClientHub, ctx: &SecurityContext, project: Uuid) -> SecurityContext {
    match hub.get::<dyn account_management_sdk::AccountManagementClient>() {
        Ok(am) => crate::org_scope::in_org_of(am.as_ref(), ctx, project).await,
        Err(_) => ctx.clone(),
    }
}

/// Make sure `ctx`'s model has the view's types, once per organization in
/// this process.
pub async fn ensure_types(
    port: &dyn DomainObjects,
    ctx: &SecurityContext,
    spec: &'static ViewSpec,
) -> anyhow::Result<()> {
    static TYPED: OnceLock<Mutex<HashSet<(Uuid, &'static str)>>> = OnceLock::new();
    let typed = TYPED.get_or_init(Mutex::default);
    let key = (ctx.subject_tenant_id(), spec.state_entity);
    if typed.lock().is_ok_and(|t| t.contains(&key)) {
        return Ok(());
    }
    for need in spec.needs() {
        port.ensure_type(ctx, &need).await?;
    }
    if let Ok(mut t) = typed.lock() {
        t.insert(key);
    }
    Ok(())
}

/// The payload of a view's run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DerivePayload {
    pub project_id: String,
}

/// Queue a computation of `spec` for `project` in `tenant`'s queue: joined
/// to one already waiting, behind one running.
pub async fn request(
    hub: &ClientHub,
    ctx: &SecurityContext,
    tenant: Uuid,
    spec: &'static ViewSpec,
    project: Uuid,
) -> anyhow::Result<Uuid> {
    let queue = hub
        .get_scoped::<dyn crate::tasks::TaskQueue>(&ClientScope::gts_id(
            crate::tasks::TASK_QUEUE_INSTANCE_ID,
        ))
        .map_err(|_| anyhow::anyhow!("studio-tasks is not available in this deployment"))?;
    let partition = format!("{}:{project}", spec.view);
    queue
        .enqueue(
            ctx,
            crate::tasks::sdk::NewRun {
                tenant,
                task_type: spec.task_type,
                payload: serde_json::to_value(DerivePayload {
                    project_id: project.to_string(),
                })?,
                partition_key: Some(&partition),
                idempotency_key: None,
                coalesce_queued: true,
                notify_workspace_id: None,
            },
        )
        .await
}

/// What a gear computes a view with.
#[async_trait]
pub trait Derive: Send + Sync + 'static {
    fn spec(&self) -> &'static ViewSpec;
    /// Compute the view of `project` from what its syncs stored. `ctx` is
    /// the run's worker identity; `org` the same acting in the project's
    /// organization.
    async fn derive(
        &self,
        ctx: &SecurityContext,
        org: &SecurityContext,
        project: Uuid,
    ) -> anyhow::Result<Derived>;
}

/// The `studio-tasks` handler of one view: mark, compute, keep.
pub struct DeriveTask {
    derive: Arc<dyn Derive>,
    hub: Arc<ClientHub>,
}

impl DeriveTask {
    pub fn new(derive: Arc<dyn Derive>, hub: Arc<ClientHub>) -> Self {
        Self { derive, hub }
    }
}

#[async_trait]
impl TaskHandler for DeriveTask {
    fn task_type(&self) -> &'static str {
        self.derive.spec().task_type
    }

    async fn run(&self, ctx: &TaskContext) -> TaskOutcome {
        let spec = self.derive.spec();
        let payload: DerivePayload = match serde_json::from_value(ctx.payload.clone()) {
            Ok(p) => p,
            Err(e) => {
                return TaskOutcome::Failed(format!(
                    "{}: this run's payload names no project ({e})",
                    spec.view
                ));
            }
        };
        let Ok(project) = Uuid::parse_str(payload.project_id.trim()) else {
            return TaskOutcome::Failed(format!("{}: the project is not a UUID", spec.view));
        };
        let Some(port) = port(&self.hub) else {
            return TaskOutcome::Failed(format!(
                "{}: the domain model is not available",
                spec.view
            ));
        };
        let org = in_org_of(&self.hub, &ctx.security, project).await;
        if let Err(e) = ensure_types(port.as_ref(), &org, spec).await {
            return TaskOutcome::Retry(format!("{}: {e:#}", spec.view));
        }
        if let Err(e) = spec.mark_computing(port.as_ref(), &org, project).await {
            return TaskOutcome::Retry(format!("{}: {e:#}", spec.view));
        }
        ctx.progress("computing").await;
        let started = std::time::Instant::now();
        match self.derive.derive(&ctx.security, &org, project).await {
            Ok(derived) => match spec.store(port.as_ref(), &org, project, derived).await {
                Ok(state) => {
                    info!(
                        view = spec.view,
                        %project,
                        items = state.items,
                        elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
                        "derived view computed"
                    );
                    TaskOutcome::done(format!(
                        "{}: {}",
                        spec.view,
                        crate::plural::plural(state.items, "row", "rows")
                    ))
                }
                Err(e) => TaskOutcome::Retry(format!("{}: {e:#}", spec.view)),
            },
            Err(e) => {
                let error = format!("{e:#}");
                warn!(view = spec.view, %project, error, "derived view failed");
                if let Err(e) = spec.fail(port.as_ref(), &org, project, error.clone()).await {
                    warn!(view = spec.view, %project, error = %format!("{e:#}"), "derived view: the failure could not be recorded");
                }
                TaskOutcome::Failed(format!("{}: {error}", spec.view))
            }
        }
    }
}

/// Queues every registered view of a project when one of its repositories
/// has been synced.
pub struct RecomputeOnSync {
    hub: Arc<ClientHub>,
    spec: &'static ViewSpec,
}

impl RecomputeOnSync {
    /// Register `spec` to follow every repository sync.
    pub fn register(hub: Arc<ClientHub>, spec: &'static ViewSpec) {
        crate::artifact_ingest::port::on_repository_synced(Arc::new(Self { hub, spec }));
    }
}

#[async_trait]
impl crate::artifact_ingest::port::RepositorySynced for RecomputeOnSync {
    async fn synced(
        &self,
        ctx: &SecurityContext,
        repo: &crate::artifact_ingest::port::SyncedRepository,
    ) {
        let Some(project) = repo
            .project_id
            .as_deref()
            .and_then(|p| Uuid::parse_str(p.trim()).ok())
        else {
            return;
        };
        if let Err(e) = request(&self.hub, ctx, repo.run_tenant, self.spec, project).await {
            warn!(view = self.spec.view, %project, error = %format!("{e:#}"), "derived view: could not queue the recomputation after a sync");
        }
    }
}

#[cfg(test)]
#[path = "derived_view_tests.rs"]
mod tests;
