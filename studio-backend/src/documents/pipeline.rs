//! A project's spec pipeline: after a repository sync, its documents go from
//! files to a product proposal without anybody pressing a button
//! (`docs/design/studio-documents.md` §4).
//!
//! The steps, each one only when the one before it is done:
//!
//! 1. **Specs.** The sync already classified the files and queued every Spec
//!    Quality detector on the typed documents that are new, changed or never
//!    analysed (`DocumentsService::classify_ingested`). A proposed type that
//!    scores at or over the project's threshold is confirmed there, marked
//!    as the pipeline's (`confirmed_by: auto`); here the proposals an older
//!    sync left below a threshold since lowered are swept the same way. A
//!    project with no bound document waits for a person.
//! 2. **Domain model.** When the bound documents or their text changed, a
//!    build of the project domain model starts on the organization's AI
//!    connection: the run's worker acting in the organization reaches no
//!    person's key. Without a usable connection the build stops at its first
//!    model call and the step says why. A build is long, so it runs spawned
//!    (`super::spec_model::build`) and, when it ends, asks for the pipeline
//!    again ([`after_build`]): that run records how it went and goes on.
//! 3. **Mapping.** What the bound documents need -- the capabilities they
//!    declare and the ones their requirements imply -- is what the spec→gear
//!    plan is read from (`studio-spec-mapping`, computed when read). Recorded
//!    here with its digest so the next step knows when it moved.
//! 4. **Product.** A gear match of the project's specifications
//!    (`product::port::ProductProposals`): which gears build the product.
//!    Nothing in the product changes; a member adds what is proposed.
//!
//! Every step is keyed by the digest of its input: a sync that changed
//! nothing the step reads repeats nothing (`unchanged`). A step that stopped
//! stays stopped for the same input until a person asks again
//! (`POST /spec-pipeline/runs`), so a missing key is not retried on every
//! sync.
//!
//! The mechanism is `crate::derived_view`: one run per project after each
//! repository sync ([`crate::derived_view::RecomputeOnSync`]), joined when
//! one is waiting, and the steps kept as the view's rows.

use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;
use tracing::warn;
use uuid::Uuid;

use super::model::BindingState;
use super::service::DocumentsService;
use super::spec_model::build::BuildState;
use crate::derived_view::{Derive, Derived, ViewSpec};

/// `confirmed_by` of a type the pipeline confirmed.
pub const CONFIRMED_BY_AUTO: &str = "auto";
/// `confirmed_by` of a type a person confirmed.
pub const CONFIRMED_BY_PERSON: &str = "person";
/// The settings' key in `project.config`.
pub const CONFIG_KEY: &str = "spec_pipeline";
/// A proposal at or over this confidence is confirmed by default.
pub const DEFAULT_THRESHOLD: f32 = 0.8;

/// The steps, in order.
pub const STEPS: [&str; 4] = ["specs", "domain_model", "mapping", "product"];

/// The view: one `spec-pipeline-step` per step, one `spec-pipeline-view`
/// per project.
pub(crate) static VIEW: ViewSpec = ViewSpec {
    gear: "studio-documents",
    view: "spec-pipeline",
    task_type: "documents.spec-pipeline",
    item_entity: "spec-pipeline-step",
    item_name: "Spec Pipeline Step",
    item_description: "One step of a project's automatic spec pipeline -- specs, domain \
                       model, mapping, product -- and how it last went: done, unchanged, \
                       running, waiting or stopped, with the reason.",
    item_fields: &[("step", "string"), ("state", "string")],
    state_entity: "spec-pipeline-view",
    state_name: "Spec Pipeline",
};

// ── settings ─────────────────────────────────────────────────────────────

/// A project's pipeline settings, `project.config` `spec_pipeline`:
/// `{ "enabled": true, "auto_confirm_threshold": 0.8 }`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PipelineSettings {
    /// The automatic pipeline, auto-confirmation included. On by default.
    pub enabled: bool,
    /// A proposed type scoring at or over it is confirmed without a person;
    /// `1.0` confirms nothing.
    pub auto_confirm_threshold: f32,
}

impl Default for PipelineSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            auto_confirm_threshold: DEFAULT_THRESHOLD,
        }
    }
}

/// A threshold a person may set: a number from 0 to 1.
pub fn valid_threshold(value: f32) -> bool {
    value.is_finite() && (0.0..=1.0).contains(&value)
}

impl PipelineSettings {
    /// Read from a project's config; what is missing or out of range is the
    /// default.
    pub fn from_config(config: &Value) -> Self {
        let d = Self::default();
        let Some(p) = config.get(CONFIG_KEY) else {
            return d;
        };
        #[allow(clippy::cast_possible_truncation)]
        let threshold = p
            .get("auto_confirm_threshold")
            .and_then(Value::as_f64)
            .map(|v| v as f32)
            .filter(|v| valid_threshold(*v));
        Self {
            enabled: p
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(d.enabled),
            auto_confirm_threshold: threshold.unwrap_or(d.auto_confirm_threshold),
        }
    }

    /// Write the given settings into a project's config, leaving the rest of
    /// it alone; whether anything changed.
    pub fn write(config: &mut Value, enabled: Option<bool>, threshold: Option<f32>) -> bool {
        let before = config.clone();
        if !config.is_object() {
            *config = json!({});
        }
        let current = Self::from_config(config);
        let next = Self {
            enabled: enabled.unwrap_or(current.enabled),
            auto_confirm_threshold: threshold
                .filter(|t| valid_threshold(*t))
                .unwrap_or(current.auto_confirm_threshold),
        };
        config[CONFIG_KEY] = json!({
            "enabled": next.enabled,
            "auto_confirm_threshold": next.auto_confirm_threshold,
        });
        *config != before
    }

    /// Whether a proposal scoring `confidence` is confirmed without a person.
    pub fn auto_confirms(&self, confidence: Option<f32>) -> bool {
        self.enabled
            && self.auto_confirm_threshold < 1.0
            && confidence.is_some_and(|c| c >= self.auto_confirm_threshold)
    }
}

/// A binding's state after the pipeline's rule: a proposal the project
/// trusts enough is `confirmed`, by `auto`. Anything else is left as it is,
/// with no `confirmed_by`. `settings` is `None` where nothing applies (a
/// workspace-level scan).
pub fn auto_settle(
    state: BindingState,
    confidence: Option<f32>,
    settings: Option<&PipelineSettings>,
) -> (BindingState, Option<String>) {
    if state == BindingState::Detected && settings.is_some_and(|s| s.auto_confirms(confidence)) {
        (BindingState::Confirmed, Some(CONFIRMED_BY_AUTO.to_owned()))
    } else {
        (state, None)
    }
}

/// One digest of a set of inputs, in any order.
pub fn digest(parts: impl IntoIterator<Item = String>) -> String {
    let mut parts: Vec<String> = parts.into_iter().collect();
    parts.sort();
    Uuid::new_v5(&Uuid::NAMESPACE_OID, parts.join("\n").as_bytes())
        .simple()
        .to_string()
}

// ── steps ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepState {
    /// Ran on this input.
    Done,
    /// Its input is what it last ran on: nothing repeated.
    Unchanged,
    /// Going on now; the pipeline goes on when it ends.
    Running,
    /// Waits for the step before it, or for a person.
    #[default]
    Waiting,
    /// Could not go on; `reason` says why. Stays so for the same input.
    Stopped,
    /// The project's automatic pipeline is off.
    Off,
}

impl StepState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Done => "done",
            Self::Unchanged => "unchanged",
            Self::Running => "running",
            Self::Waiting => "waiting",
            Self::Stopped => "stopped",
            Self::Off => "off",
        }
    }

    /// Whether the next step may go on.
    pub fn passed(self) -> bool {
        matches!(self, Self::Done | Self::Unchanged)
    }
}

/// One step as the view keeps it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Step {
    /// One of [`STEPS`].
    pub step: String,
    pub state: StepState,
    /// One line for a person: what it did.
    pub summary: Option<String>,
    /// Why it waits or stopped.
    pub reason: Option<String>,
    /// The digest of the input it last ran on.
    pub input: Option<String>,
    /// When it last ran (RFC 3339).
    pub at: Option<String>,
    /// What it made, when it made something to open: a gear match's id.
    pub link: Option<String>,
}

impl Step {
    fn new(step: &str, state: StepState) -> Self {
        Self {
            step: step.to_owned(),
            state,
            at: Some(crate::derived_view::now_rfc3339()),
            ..Self::default()
        }
    }

    fn summary(mut self, s: impl Into<String>) -> Self {
        self.summary = Some(s.into());
        self
    }

    fn reason(mut self, s: impl Into<String>) -> Self {
        self.reason = Some(s.into());
        self
    }

    fn input(mut self, digest: Option<String>) -> Self {
        self.input = digest;
        self
    }
}

/// What the domain model step does with an input whose digest is `digest`,
/// given how it last went and the project's build as this process knows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DomainAction {
    /// The documents are what it last built from: nothing to do.
    Unchanged,
    /// It stopped on this input; it stays stopped with this reason.
    Held(String),
    /// A build is going on: wait for it.
    Running,
    /// The build it started ended: with the reason it stopped, if it did.
    Finished(Option<String>),
    /// Start a build.
    Start,
}

pub fn domain_action(prior: Option<&Step>, digest: &str, build: &BuildState) -> DomainAction {
    let same = prior.and_then(|p| p.input.as_deref()) == Some(digest);
    match prior.map(|p| p.state) {
        Some(StepState::Running) => {
            if build.running {
                DomainAction::Running
            } else if build.finished_at.is_some() {
                DomainAction::Finished(build.error.clone())
            } else {
                // Lost with the process that ran it: what it kept is kept,
                // and a new build starts where it stopped.
                DomainAction::Start
            }
        }
        Some(StepState::Done | StepState::Unchanged) if same => DomainAction::Unchanged,
        Some(StepState::Stopped) if same => DomainAction::Held(
            prior
                .and_then(|p| p.reason.clone())
                .unwrap_or_else(|| "stopped".to_owned()),
        ),
        _ if build.running => DomainAction::Running,
        _ => DomainAction::Start,
    }
}

/// Whether a step that runs once per input runs for `digest`: not when it
/// already did, or stopped on it.
pub fn due(prior: Option<&Step>, digest: &str) -> bool {
    !prior.is_some_and(|p| {
        matches!(
            p.state,
            StepState::Done | StepState::Unchanged | StepState::Stopped
        ) && p.input.as_deref() == Some(digest)
    })
}

/// What a stopped build says to a person: the reason, and where a key for
/// the organization is set.
pub fn stopped_reason(error: &str) -> String {
    format!(
        "{error}. The pipeline reads on the organization's AI connection: check it in the \
         organization's settings (AI connections), then run the pipeline again."
    )
}

/// The steps from `from` on, waiting for `why`.
fn waiting_from(from: usize, why: &str) -> Vec<Step> {
    STEPS[from..]
        .iter()
        .map(|s| Step::new(s, StepState::Waiting).reason(why))
        .collect()
}

// ── the run ──────────────────────────────────────────────────────────────

/// Computes the pipeline of a project: the view's [`Derive`].
pub struct SpecPipeline {
    hub: Arc<ClientHub>,
    service: Arc<DocumentsService>,
}

impl SpecPipeline {
    pub fn new(hub: Arc<ClientHub>, service: Arc<DocumentsService>) -> Self {
        Self { hub, service }
    }

    /// How each step last went, by step.
    async fn prior(&self, org: &SecurityContext, project: Uuid) -> BTreeMap<String, Step> {
        let Some(port) = crate::derived_view::port(&self.hub) else {
            return BTreeMap::new();
        };
        match VIEW.read(port.as_ref(), org, project).await {
            Ok((_, rows)) => steps_of(rows),
            Err(e) => {
                warn!(%project, error = %format!("{e:#}"), "spec pipeline: the last run could not be read; every step runs");
                BTreeMap::new()
            }
        }
    }

    async fn steps(
        &self,
        org: &SecurityContext,
        project: Uuid,
        prior: &BTreeMap<String, Step>,
        settings: &PipelineSettings,
    ) -> anyhow::Result<Vec<Step>> {
        if !settings.enabled {
            return Ok(STEPS
                .iter()
                .map(|s| {
                    Step::new(s, StepState::Off)
                        .reason("the automatic pipeline is off for this project")
                })
                .collect());
        }
        let workspace = self
            .service
            .parent_of(org, project)
            .await?
            .ok_or_else(|| anyhow::anyhow!("the project hangs from no workspace"))?;
        let mut out = Vec::with_capacity(STEPS.len());

        // 1. Specs.
        let swept = self
            .service
            .auto_confirm_proposals(org, workspace, Some(project), settings)
            .await?;
        let bindings = self
            .service
            .all_bindings(org, workspace, Some(project))
            .await?;
        let bound: Vec<_> = bindings.iter().filter(|b| b.state.is_typed()).collect();
        let auto = bindings.iter().filter(|b| b.auto_confirmed).count();
        let proposed = bindings
            .iter()
            .filter(|b| b.state == BindingState::Detected)
            .count();
        let mut summary = format!(
            "{} bound ({auto} confirmed automatically{}), {proposed} proposed below {:.0}% wait for a person",
            bound.len(),
            if swept > 0 {
                format!(", {swept} now")
            } else {
                String::new()
            },
            settings.auto_confirm_threshold * 100.0
        );
        summary.push_str(if crate::spec_quality::is_configured() {
            "; every Spec Quality detector runs on the typed documents a sync changed"
        } else {
            "; Spec Quality is not set up on this server, so nothing is checked"
        });
        if bound.is_empty() {
            out.push(
                Step::new("specs", StepState::Waiting)
                    .summary(summary)
                    .reason(
                        "no document has a settled type yet: confirm the proposed types in Specs",
                    ),
            );
            out.extend(waiting_from(1, "waits for bound documents"));
            return Ok(out);
        }
        out.push(Step::new("specs", StepState::Done).summary(summary));

        // 2. Domain model.
        let quality = super::rest::quality_of(Arc::clone(&self.hub));
        let plan = match super::rest::plan_spec_model_build(
            &self.service,
            &quality,
            org,
            workspace,
            project,
        )
        .await
        {
            Ok(plan) => plan,
            Err(why) => {
                out.push(Step::new("domain_model", StepState::Stopped).reason(why));
                out.extend(waiting_from(2, "waits for the project domain model"));
                return Ok(out);
            }
        };
        let last = prior.get("domain_model");
        let model_digest = plan.digest.clone();
        let build_state = super::spec_model::build::state(project);
        let domain = match domain_action(last, &model_digest, &build_state) {
            DomainAction::Unchanged => {
                let mut s = Step::new("domain_model", StepState::Unchanged)
                    .summary(format!(
                        "nothing new to read in {} documents",
                        plan.documents
                    ))
                    .input(Some(model_digest.clone()));
                s.at = last.and_then(|l| l.at.clone()).or(s.at);
                s
            }
            DomainAction::Held(reason) => Step::new("domain_model", StepState::Stopped)
                .reason(reason)
                .input(Some(model_digest.clone())),
            DomainAction::Running => Step::new("domain_model", StepState::Running)
                .summary("a build of the model is reading the documents")
                .input(Some(model_digest.clone())),
            DomainAction::Finished(Some(error)) => Step::new("domain_model", StepState::Stopped)
                .reason(stopped_reason(&error))
                .input(last.and_then(|l| l.input.clone())),
            DomainAction::Finished(None) => Step::new("domain_model", StepState::Done)
                .summary(format!("read {} documents into the model", plan.documents))
                .input(last.and_then(|l| l.input.clone())),
            DomainAction::Start => {
                let pending = plan.pending.len();
                if super::spec_model::build::begin(project, pending) {
                    tokio::spawn(super::rest::run_spec_model_build(
                        Arc::clone(&self.service),
                        quality,
                        org.clone(),
                        workspace,
                        project,
                        plan.pending,
                        plan.sources,
                    ));
                }
                Step::new("domain_model", StepState::Running)
                    .summary(format!(
                        "reading {pending} of {} documents on the organization's AI connection",
                        plan.documents
                    ))
                    .input(Some(model_digest.clone()))
            }
        };
        let passed = domain.state.passed();
        out.push(domain);
        if !passed {
            out.extend(waiting_from(2, "waits for the project domain model"));
            return Ok(out);
        }

        // 3. Mapping: what the bound documents need.
        let mut needs = std::collections::BTreeSet::new();
        for b in &bound {
            needs.extend(b.capabilities.iter().cloned());
            needs.extend(b.inferred_capabilities.iter().map(|c| c.key.clone()));
        }
        let mapping_digest = digest_of_needs(&needs);
        let mut mapping = Step::new(
            "mapping",
            if due(prior.get("mapping"), &mapping_digest) {
                StepState::Done
            } else {
                StepState::Unchanged
            },
        )
        .summary(format!(
            "{} capabilities needed by {} bound documents; the gear plan is read from them",
            needs.len(),
            bound.len()
        ))
        .input(Some(mapping_digest.clone()));
        if mapping.state == StepState::Unchanged {
            mapping.at = prior
                .get("mapping")
                .and_then(|m| m.at.clone())
                .or(mapping.at);
        }
        out.push(mapping);

        // 4. Product.
        let product_digest = digest([model_digest, mapping_digest]);
        out.push(
            self.product(org, project, prior.get("product"), product_digest)
                .await,
        );
        Ok(out)
    }

    async fn product(
        &self,
        org: &SecurityContext,
        project: Uuid,
        last: Option<&Step>,
        digest: String,
    ) -> Step {
        if !due(last, &digest) {
            let mut kept = last.cloned().unwrap_or_default();
            kept.step = "product".to_owned();
            if kept.state == StepState::Done {
                kept.state = StepState::Unchanged;
            }
            return kept;
        }
        let Ok(proposals) = self.hub.get::<dyn crate::product::port::ProductProposals>() else {
            return Step::new("product", StepState::Stopped)
                .reason("gear matches are not part of this deployment (studio-product)")
                .input(Some(digest));
        };
        // A key the matcher accepts: letters, digits and `:`.
        let key = format!("pipeline:{}", &digest[..digest.len().min(32)]);
        match proposals
            .propose(org, org.subject_tenant_id(), project, &key)
            .await
        {
            Ok(m) => {
                let mut s = Step::new("product", StepState::Done)
                    .summary(format!("gear match {}", m.state))
                    .input(Some(digest));
                s.link = Some(m.match_id.to_string());
                s
            }
            Err(why) => Step::new("product", StepState::Stopped)
                .reason(why)
                .input(Some(digest)),
        }
    }
}

fn digest_of_needs(needs: &std::collections::BTreeSet<String>) -> String {
    digest(needs.iter().cloned())
}

/// The view's rows as steps, by step.
pub fn steps_of(rows: Vec<Value>) -> BTreeMap<String, Step> {
    rows.into_iter()
        .filter_map(|v| serde_json::from_value::<Step>(v).ok())
        .filter(|s| !s.step.is_empty())
        .map(|s| (s.step.clone(), s))
        .collect()
}

#[async_trait]
impl Derive for SpecPipeline {
    fn spec(&self) -> &'static ViewSpec {
        &VIEW
    }

    async fn derive(
        &self,
        _ctx: &SecurityContext,
        org: &SecurityContext,
        project: Uuid,
    ) -> anyhow::Result<Derived> {
        // `org` is the worker acting in the project's organization: what the
        // documents are read as, and whose AI connection a build reads on.
        let prior = self.prior(org, project).await;
        let settings = self.service.pipeline_settings(org, project).await;
        let steps = self.steps(org, project, &prior, &settings).await?;
        Ok(Derived {
            inputs: Vec::new(),
            items: steps
                .into_iter()
                .map(|s| {
                    let key = s.step.clone();
                    (key, serde_json::to_value(&s).unwrap_or(Value::Null))
                })
                .collect(),
            detail: json!({ "settings": settings }),
        })
    }
}

/// Ask for the project's pipeline: after a build of its model ended, and
/// when a person presses Run. Joined to a run already waiting.
pub async fn request(
    hub: &ClientHub,
    ctx: &SecurityContext,
    project: Uuid,
) -> anyhow::Result<Uuid> {
    crate::derived_view::request(hub, ctx, ctx.subject_tenant_id(), &VIEW, project).await
}

/// Hand the pipeline its next turn once a build of the model ended. Never
/// fails the build: the next sync asks again.
pub async fn after_build(hub: &ClientHub, ctx: &SecurityContext, project: Uuid) {
    if let Err(e) = request(hub, ctx, project).await {
        warn!(%project, error = %format!("{e:#}"), "spec pipeline: could not go on after a build of the model");
    }
}

/// A person asks the pipeline to run again: the steps that stopped forget
/// the input they stopped on, so they run for it once more, and a run is
/// queued.
pub async fn run_again(
    hub: &ClientHub,
    ctx: &SecurityContext,
    project: Uuid,
) -> anyhow::Result<Uuid> {
    if let Some(port) = crate::derived_view::port(hub) {
        let org = crate::derived_view::in_org_of(hub, ctx, project).await;
        if let Ok((Some(state), rows)) = VIEW.read(port.as_ref(), &org, project).await {
            let mut steps = steps_of(rows);
            let mut changed = false;
            for s in steps.values_mut() {
                if s.state == StepState::Stopped {
                    s.input = None;
                    changed = true;
                }
            }
            if changed {
                let items = steps
                    .into_values()
                    .map(|s| {
                        let key = s.step.clone();
                        (key, serde_json::to_value(&s).unwrap_or(Value::Null))
                    })
                    .collect();
                VIEW.store(
                    port.as_ref(),
                    &org,
                    project,
                    Derived {
                        inputs: state.inputs,
                        items,
                        detail: state.detail,
                    },
                )
                .await?;
            }
        }
    }
    request(hub, ctx, project).await
}

#[cfg(test)]
#[path = "pipeline_tests.rs"]
mod tests;
