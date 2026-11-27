//! M&A due diligence's function (studio-web#1024, `docs/design/mna-kit.md`).
//!
//! A deal is a project of the kit's type (ADR-0073): its attributes —
//! target, thesis, phase, IC date, recommendation, conditions and the
//! sign-off — are fields of the kit's subtype of Project, written on the
//! project's own object in the organization's model (`project`, keyed
//! `self`, as Project lifecycle writes its phase). Findings, risks and open
//! questions are the kit's own types (`mna-finding`, `mna-risk`,
//! `mna-open-question`), objects in the project's scope. Every write is the
//! domain model's, made as the caller, so the PDP's `domain.edit` decides as
//! for any object; the project's tenant is the deal's confidentiality.
//!
//! **Who signs off.** A project carries no roles of its own (its access is
//! its organization's), so the deal lead is the project's owner,
//! `project.config` `owner_id`, set when the project is created. Only that
//! person signs the recommendation off; changing the recommendation or its
//! conditions afterwards takes the sign-off back.
//!
//! **Evidence** is computed here from what Studio already holds, read as the
//! caller: the project's sources (`project.config`), the repositories' sync
//! state, contributors and the truck factor from the server's checkout of
//! each source (its history, never the provider), active contributors from
//! Insight, CI runs, spec
//! checks and the kit's own objects. Each fact names where it came from, and
//! one whose source could not be asked is `available: false` with the
//! reason: never a number made up.
//!
//! Until kit functions run in Studio's function runtime (ADR-0068 §9), this
//! built-in kit's function is compiled in, as Project lifecycle's is, and joins
//! studio-kits through the kit-runtime port (`crate::kit_registry::runtime`).

use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Map, Value, json};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use crate::domain_model::port::is_refusal;
use crate::kit_registry::runtime::{KitRuntime, Refusal, builtin_overlay, now_rfc3339};
use crate::project_sources::ProjectSource;

/// The kit this is the function of.
pub const SLUG: &str = "mna";
/// The `permission_denied` reason when somebody else than the deal lead
/// signs off.
pub const DEAL_LEAD_REQUIRED: &str = "DEAL_LEAD_REQUIRED";
/// The `failed_precondition` kind for a sign-off with no recommendation.
pub const NO_RECOMMENDATION: &str = "NO_RECOMMENDATION";
/// The `permission_denied` reason when the PDP refuses the write.
pub const DOMAIN_EDIT_REQUIRED: &str = "DOMAIN_EDIT_REQUIRED";

/// The kit's project subtype, by its name in the overlay.
const SUBTYPE: &str = "project";
/// Where an item keeps its own id: the store's `id` is the instance's.
const ITEM_ID: &str = "item_id";

const MAX_TITLE: usize = 200;
const MAX_TEXT: usize = 8000;
const MAX_CONDITIONS: usize = 30;
/// Contributors read per repository for the truck factor.
const CONTRIBUTORS: u32 = 100;

/// One of the kit's own item types.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Finding,
    Risk,
    Question,
}

impl Kind {
    /// Its name in the overlay.
    pub fn name(self) -> &'static str {
        match self {
            Self::Finding => "finding",
            Self::Risk => "risk",
            Self::Question => "open-question",
        }
    }

    /// Its entity in the model.
    pub fn entity(self) -> String {
        crate::domain_model::port::kit_entity_id(SLUG, self.name())
    }

    /// How a person calls one.
    pub fn noun(self) -> &'static str {
        match self {
            Self::Finding => "finding",
            Self::Risk => "risk",
            Self::Question => "open question",
        }
    }

    /// The statuses that count as still open.
    fn open(self) -> &'static [&'static str] {
        match self {
            Self::Finding => &["open"],
            Self::Risk => &["open", "mitigating"],
            Self::Question => &["open"],
        }
    }
}

/// The values the kit's overlay allows for `field` of its type `type_name`
/// (`a | b | c`): the one place the vocabulary is written.
pub fn vocabulary(type_name: &str, field: &str) -> Vec<String> {
    let overlay = builtin_overlay(SLUG).expect("mna brings a model");
    overlay
        .types
        .iter()
        .find(|t| t.name == type_name)
        .and_then(|t| t.fields.iter().find(|f| f.name == field))
        .map(|f| {
            f.type_name
                .trim_end_matches('?')
                .split('|')
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// The deal: the M&A subtype's fields on the project's object.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Deal {
    /// The kit applies to the project; everything else is empty when not.
    pub installed: bool,
    pub target: Option<String>,
    pub thesis: Option<String>,
    pub deal_phase: Option<String>,
    /// `YYYY-MM-DD`.
    pub ic_date: Option<String>,
    pub recommendation: Option<String>,
    pub conditions: Vec<String>,
    pub signed_off_by: Option<String>,
    pub signed_off_at: Option<String>,
    /// The project's owner: who signs off.
    pub deal_lead: Option<String>,
    /// The caller is the deal lead.
    pub may_sign_off: bool,
    pub phases: Vec<String>,
    pub recommendations: Vec<String>,
}

/// A change to a deal: a field present replaces, an empty string clears.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DealPatch {
    pub target: Option<String>,
    pub thesis: Option<String>,
    pub deal_phase: Option<String>,
    pub ic_date: Option<String>,
    pub recommendation: Option<String>,
    pub conditions: Option<Vec<String>>,
}

/// One item, as stored: its id and its fields.
#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    pub id: String,
    pub fields: Map<String, Value>,
}

impl Item {
    pub fn text(&self, key: &str) -> Option<String> {
        text(&Value::Object(self.fields.clone()), key)
    }
}

/// One fact of the evidence summary.
#[derive(Clone, Debug, PartialEq)]
pub struct Fact {
    pub key: &'static str,
    pub value: Option<f64>,
    /// What `value` is out of, where that says something (a pass rate's
    /// runs).
    pub total: Option<f64>,
    pub available: bool,
    /// Where it came from, in words.
    pub source: String,
    /// What it means, or why it is not available.
    pub detail: Option<String>,
}

impl Fact {
    fn known(key: &'static str, value: f64, source: &str) -> Self {
        Self {
            key,
            value: Some(value),
            total: None,
            available: true,
            source: source.to_owned(),
            detail: None,
        }
    }

    fn missing(key: &'static str, source: &str, why: impl Into<String>) -> Self {
        Self {
            key,
            value: None,
            total: None,
            available: false,
            source: source.to_owned(),
            detail: Some(why.into()),
        }
    }

    fn with_total(mut self, total: f64) -> Self {
        self.total = Some(total);
        self
    }

    fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

/// One of the target's repositories in the evidence.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EvidenceRepository {
    pub full_path: String,
    pub branch: Option<String>,
    /// When its last sync finished; `None` when it never did.
    pub synced_at: Option<String>,
    /// Commit authors in the server's checkout (up to [`CONTRIBUTORS`]); `None` when
    /// it could not be asked.
    pub contributors: Option<u32>,
    pub truck_factor: Option<u32>,
}

/// The evidence summary.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Evidence {
    pub repositories: Vec<EvidenceRepository>,
    pub facts: Vec<Fact>,
    pub read_at: String,
}

/// What the function reads of a project besides the model.
#[async_trait]
pub trait DealProjects: Send + Sync {
    /// The project's `project.config`, read as the caller; `Err` with the
    /// reason when it could not be read, `Ok(None)` when there is none.
    async fn config(&self, ctx: &SecurityContext, project: Uuid) -> Result<Option<Value>, String>;

    /// A source's contributors, `(author, commits)`, from the history of the
    /// server's checkout of it (`ProjectCheckout`) -- never the provider. An
    /// author is the commit's name, not a host login.
    async fn contributors(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        source: &ProjectSource,
    ) -> Result<Vec<(String, u64)>, String>;
}

/// The other gears' routes the evidence reads, as the caller.
#[async_trait]
pub trait GearReads: Send + Sync {
    async fn get(&self, path: &str, query: &[(String, String)]) -> Result<Value, String>;
}

#[async_trait]
impl GearReads for crate::mcp::sdk::Api {
    async fn get(&self, path: &str, query: &[(String, String)]) -> Result<Value, String> {
        crate::mcp::sdk::Api::get(self, path, query)
            .await
            .map_err(|e| e.0)
    }
}

/// The real [`DealProjects`]: account-management for the configuration,
/// the project's checkouts for the contributors.
pub struct HubProjects {
    am: Arc<dyn account_management_sdk::AccountManagementClient>,
    hub: Arc<toolkit::client_hub::ClientHub>,
}

impl HubProjects {
    pub fn new(
        am: Arc<dyn account_management_sdk::AccountManagementClient>,
        hub: Arc<toolkit::client_hub::ClientHub>,
    ) -> Self {
        Self { am, hub }
    }
}

#[async_trait]
impl DealProjects for HubProjects {
    async fn config(&self, ctx: &SecurityContext, project: Uuid) -> Result<Option<Value>, String> {
        match self
            .am
            .get_metadata(
                ctx,
                project,
                gts::GtsTypeId::new(crate::project_sources::PROJECT_CONFIG_TYPE),
            )
            .await
        {
            Ok(entry) => Ok(Some(entry.value)),
            Err(toolkit_canonical_errors::CanonicalError::NotFound { .. }) => Ok(None),
            Err(e) => Err(format!("the project's config could not be read: {e}")),
        }
    }

    async fn contributors(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        source: &ProjectSource,
    ) -> Result<Vec<(String, u64)>, String> {
        let checkouts = self
            .hub
            .get::<dyn crate::project_checkout::ProjectCheckout>()
            .map_err(|_| "the project checkouts are not kept on this server".to_owned())?;
        let checkout = checkouts
            .checkout_of(ctx, project, &source.full_path)
            .await
            .ok_or_else(|| {
                format!(
                    "{} has not been synced to the server yet: Re-sync the project",
                    source.full_path
                )
            })?;
        let mut people = checkout
            .authors(HISTORY_COMMITS)
            .await
            .map_err(|e| format!("{e:#}"))?;
        people.truncate(CONTRIBUTORS as usize);
        Ok(people)
    }
}

/// How many of a source's newest commits its contributors are counted over.
const HISTORY_COMMITS: usize = 5_000;

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn texts(v: &Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

/// The smallest number of people who made more than half of the commits:
/// the repository is at risk when that many leave. `None` for no commits.
pub fn truck_factor(commits: &[u64]) -> Option<u32> {
    let total: u64 = commits.iter().sum();
    if total == 0 {
        return None;
    }
    let mut sorted = commits.to_vec();
    sorted.sort_unstable_by(|a, b| b.cmp(a));
    let mut covered = 0u64;
    for (i, c) in sorted.iter().enumerate() {
        covered += c;
        if covered * 2 > total {
            return Some(u32::try_from(i + 1).unwrap_or(u32::MAX));
        }
    }
    Some(u32::try_from(sorted.len()).unwrap_or(u32::MAX))
}

/// A bot account the provider lists among the contributors.
fn is_bot(login: &str) -> bool {
    let l = login.to_ascii_lowercase();
    l.ends_with("[bot]") || l.ends_with("-bot") || l == "dependabot" || l == "renovate"
}

/// Checks `value` is one of `allowed`.
fn one_of(field: &str, value: &str, allowed: &[String]) -> Result<String, Refusal> {
    if allowed.iter().any(|a| a == value) {
        Ok(value.to_owned())
    } else {
        Err(Refusal::Invalid(format!(
            "`{field}` is one of {}, not `{value}`",
            allowed.join(", ")
        )))
    }
}

fn bounded(field: &str, value: &str, max: usize) -> Result<String, Refusal> {
    let value = value.trim();
    if value.chars().count() > max {
        return Err(Refusal::Invalid(format!(
            "`{field}` is at most {max} characters"
        )));
    }
    Ok(value.to_owned())
}

/// `YYYY-MM-DD`, a real day.
fn date_ok(s: &str) -> bool {
    let mut parts = s.splitn(3, '-');
    let (Some(y), Some(m), Some(d)) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    if y.len() != 4 || m.len() != 2 || d.len() != 2 {
        return false;
    }
    let (Ok(y), Ok(m), Ok(d)) = (y.parse::<i32>(), m.parse::<u8>(), d.parse::<u8>()) else {
        return false;
    };
    time::Month::try_from(m)
        .ok()
        .and_then(|m| time::Date::from_calendar_date(y, m, d).ok())
        .is_some()
}

/// A body's text field, trimmed, at most `max`; absent or empty is `None`.
fn body_text(body: &Value, key: &str, max: usize) -> Result<Option<String>, Refusal> {
    match body.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => {
            let s = bounded(key, s, max)?;
            Ok((!s.is_empty()).then_some(s))
        }
        Some(_) => Err(Refusal::Invalid(format!("`{key}` is text"))),
    }
}

/// An item's fields, checked: what a create or a replace stores. `findings`
/// are the project's findings' ids, for a risk's `finding_id`.
pub fn clean_item(
    kind: Kind,
    body: &Value,
    findings: &[String],
) -> Result<Map<String, Value>, Refusal> {
    let mut out = Map::new();
    let mut put = |k: &str, v: Option<String>| {
        out.insert(k.to_owned(), v.map_or(Value::Null, Value::String));
    };
    let required = |key: &str| -> Result<String, Refusal> {
        body_text(body, key, MAX_TITLE)?
            .ok_or_else(|| Refusal::Invalid(format!("a {} needs `{key}`", kind.noun())))
    };
    let choice = |key: &str, default: Option<&str>| -> Result<Option<String>, Refusal> {
        match body_text(body, key, 40)?.or(default.map(str::to_owned)) {
            Some(v) => one_of(key, &v, &vocabulary(kind.name(), key)).map(Some),
            None => Err(Refusal::Invalid(format!(
                "a {} needs `{key}`, one of {}",
                kind.noun(),
                vocabulary(kind.name(), key).join(", ")
            ))),
        }
    };
    match kind {
        Kind::Finding => {
            put("title", Some(required("title")?));
            put("severity", choice("severity", None)?);
            put("source", body_text(body, "source", MAX_TITLE)?);
            put("evidence", body_text(body, "evidence", MAX_TEXT)?);
            let origin = body_text(body, "origin", 40)?.unwrap_or_else(|| "manual".into());
            if !origin
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
            {
                return Err(Refusal::Invalid(
                    "`origin` is a word: lowercase letters, digits, `_` and `-`".into(),
                ));
            }
            put("origin", Some(origin));
            put("status", choice("status", Some("open"))?);
        }
        Kind::Risk => {
            put("title", Some(required("title")?));
            put("likelihood", choice("likelihood", None)?);
            put("impact", choice("impact", None)?);
            put("owner", body_text(body, "owner", MAX_TITLE)?);
            put("mitigation", body_text(body, "mitigation", MAX_TEXT)?);
            let finding = body_text(body, "finding_id", 64)?;
            if let Some(f) = &finding
                && !findings.contains(f)
            {
                return Err(Refusal::Invalid(format!(
                    "`finding_id` `{f}` is none of the deal's findings"
                )));
            }
            put("finding_id", finding);
            put("status", choice("status", Some("open"))?);
        }
        Kind::Question => {
            put("what", Some(required("what")?));
            put("who", body_text(body, "who", MAX_TITLE)?);
            let answer = body_text(body, "answer", MAX_TEXT)?;
            // An answer given with no status says the question is answered.
            let default = if answer.is_some() { "answered" } else { "open" };
            put("answer", answer);
            put("status", choice("status", Some(default))?);
        }
    }
    Ok(out)
}

/// The function: the deal, its items and its evidence.
pub struct Mna {
    runtime: Arc<dyn KitRuntime>,
    projects: Arc<dyn DealProjects>,
}

impl Mna {
    pub fn new(runtime: Arc<dyn KitRuntime>, projects: Arc<dyn DealProjects>) -> Self {
        Self { runtime, projects }
    }

    fn port(&self) -> Result<Arc<dyn crate::domain_model::port::DomainObjects>, Refusal> {
        self.runtime
            .models()
            .ok_or_else(|| Refusal::Internal(anyhow::anyhow!("the domain model is not running")))
    }

    /// The caller, acting in the project's organization, once the kit is
    /// shown to apply and the model to carry it: `None` where it does not
    /// apply.
    async fn applies(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
    ) -> Result<Option<(Uuid, SecurityContext)>, Refusal> {
        if !self.runtime.applies_to_project(ctx, project, SLUG).await? {
            return Ok(None);
        }
        let (org, at) = self.runtime.org_ctx(ctx, project).await?;
        // The model may not carry the kit's types yet: make it.
        self.runtime.models_in_step(org).await?;
        Ok(Some((org, at)))
    }

    async fn applying(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
    ) -> Result<(Uuid, SecurityContext), Refusal> {
        self.applies(ctx, project)
            .await?
            .ok_or_else(|| Refusal::KitNotInstalled(SLUG.to_owned()))
    }

    /// The project's owner, from its configuration: the deal lead.
    async fn deal_lead(&self, ctx: &SecurityContext, project: Uuid) -> Option<String> {
        let config = self.projects.config(ctx, project).await.ok()??;
        text(&config, "owner_id")
    }

    fn deal_of(payload: &Value, lead: Option<String>, caller: Uuid) -> Deal {
        Deal {
            installed: true,
            target: text(payload, "target"),
            thesis: text(payload, "thesis"),
            deal_phase: text(payload, "deal_phase"),
            ic_date: text(payload, "ic_date"),
            recommendation: text(payload, "recommendation"),
            conditions: texts(payload, "conditions"),
            signed_off_by: text(payload, "signed_off_by"),
            signed_off_at: text(payload, "signed_off_at"),
            may_sign_off: lead.as_deref() == Some(caller.to_string().as_str()),
            deal_lead: lead,
            phases: vocabulary(SUBTYPE, "deal_phase"),
            recommendations: vocabulary(SUBTYPE, "recommendation"),
        }
    }

    /// `project`'s deal. The caller has been shown to reach it.
    pub async fn deal(&self, ctx: &SecurityContext, project: Uuid) -> Result<Deal, Refusal> {
        let Some((_, at)) = self.applies(ctx, project).await? else {
            return Ok(Deal {
                phases: vocabulary(SUBTYPE, "deal_phase"),
                recommendations: vocabulary(SUBTYPE, "recommendation"),
                ..Deal::default()
            });
        };
        let payload = self
            .runtime
            .project_object(&at, project)
            .await?
            .map(|(_, p)| p)
            .unwrap_or(Value::Null);
        let lead = self.deal_lead(ctx, project).await;
        Ok(Self::deal_of(&payload, lead, ctx.subject_id()))
    }

    /// Write the project's object with `change` applied, as the caller.
    async fn write_project(
        &self,
        at: &SecurityContext,
        project: Uuid,
        change: impl FnOnce(&mut Map<String, Value>) -> Result<(), Refusal>,
    ) -> Result<(), Refusal> {
        let mut payload = self
            .runtime
            .project_object(at, project)
            .await?
            .map(|(_, p)| p)
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({ "tenant_id": project.to_string() }));
        let obj = payload.as_object_mut().expect("an object, checked above");
        change(obj)?;
        for key in ["_scope", "id"] {
            obj.remove(key);
        }
        // Through the runtime's pair, which alone names the type the
        // project's object is stored as (ADR-0073 §6, studio-web#1118).
        self.runtime
            .put_project_object(at, project, payload)
            .await
            .map_err(write_refusal)
    }

    /// Change the deal: each field `patch` names. A change of the
    /// recommendation or its conditions takes an earlier sign-off back.
    pub async fn update_deal(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        patch: DealPatch,
    ) -> Result<Deal, Refusal> {
        let mut set: Vec<(&str, Value)> = Vec::new();
        let text_or_null = |s: String| {
            if s.is_empty() {
                Value::Null
            } else {
                Value::String(s)
            }
        };
        if let Some(v) = &patch.target {
            set.push(("target", text_or_null(bounded("target", v, MAX_TITLE)?)));
        }
        if let Some(v) = &patch.thesis {
            set.push(("thesis", text_or_null(bounded("thesis", v, MAX_TEXT)?)));
        }
        if let Some(v) = &patch.deal_phase {
            let v = v.trim();
            let v = if v.is_empty() {
                Value::Null
            } else {
                json!(one_of("deal_phase", v, &vocabulary(SUBTYPE, "deal_phase"))?)
            };
            set.push(("deal_phase", v));
        }
        if let Some(v) = &patch.ic_date {
            let v = v.trim();
            if !v.is_empty() && !date_ok(v) {
                return Err(Refusal::Invalid(format!(
                    "`ic_date` is a day, YYYY-MM-DD, not `{v}`"
                )));
            }
            set.push(("ic_date", text_or_null(v.to_owned())));
        }
        if let Some(v) = &patch.recommendation {
            let v = v.trim();
            let v = if v.is_empty() {
                Value::Null
            } else {
                json!(one_of(
                    "recommendation",
                    v,
                    &vocabulary(SUBTYPE, "recommendation")
                )?)
            };
            set.push(("recommendation", v));
        }
        if let Some(list) = &patch.conditions {
            let mut out = Vec::new();
            for c in list {
                let c = bounded("conditions", c, MAX_TITLE * 2)?;
                if !c.is_empty() {
                    out.push(c);
                }
            }
            if out.len() > MAX_CONDITIONS {
                return Err(Refusal::Invalid(format!(
                    "at most {MAX_CONDITIONS} conditions"
                )));
            }
            set.push(("conditions", json!(out)));
        }
        let (_, at) = self.applying(ctx, project).await?;
        self.write_project(&at, project, |obj| {
            let mut unsigned = false;
            for (key, value) in set {
                let before = obj.get(key).cloned().unwrap_or(Value::Null);
                if matches!(key, "recommendation" | "conditions") && before != value {
                    unsigned = true;
                }
                obj.insert(key.to_owned(), value);
            }
            if unsigned {
                obj.insert("signed_off_by".into(), Value::Null);
                obj.insert("signed_off_at".into(), Value::Null);
            }
            Ok(())
        })
        .await?;
        self.deal(ctx, project).await
    }

    /// Sign the recommendation off, as the deal lead.
    pub async fn sign_off(&self, ctx: &SecurityContext, project: Uuid) -> Result<Deal, Refusal> {
        let deal = self.deal(ctx, project).await?;
        if !deal.installed {
            return Err(Refusal::KitNotInstalled(SLUG.to_owned()));
        }
        if !deal.may_sign_off {
            return Err(Refusal::Forbidden(DEAL_LEAD_REQUIRED));
        }
        if deal.recommendation.is_none() {
            return Err(Refusal::Precondition(
                "recommendation",
                "the deal has no recommendation to sign off yet".into(),
                NO_RECOMMENDATION,
            ));
        }
        let (_, at) = self.applying(ctx, project).await?;
        let by = ctx.subject_id().to_string();
        let now = now_rfc3339()?;
        self.write_project(&at, project, |obj| {
            obj.insert("signed_off_by".into(), json!(by));
            obj.insert("signed_off_at".into(), json!(now));
            Ok(())
        })
        .await?;
        self.deal(ctx, project).await
    }

    /// The stored objects of `kind` in the project: `(instance id, item)`,
    /// newest first.
    async fn stored(
        &self,
        at: &SecurityContext,
        project: Uuid,
        kind: Kind,
    ) -> Result<Vec<(String, Item)>, Refusal> {
        let rows = self
            .port()?
            .list_in(at, &kind.entity(), &project.to_string())
            .await
            .map_err(Refusal::Internal)?;
        let mut out: Vec<(String, Item)> = rows
            .into_iter()
            .filter_map(|r| {
                let id = text(&r.payload, ITEM_ID)?;
                let mut fields = r.payload.as_object().cloned().unwrap_or_default();
                for key in ["_scope", "id", ITEM_ID, "tenant_id"] {
                    fields.remove(key);
                }
                Some((r.instance_id, Item { id, fields }))
            })
            .collect();
        out.sort_by(|(_, a), (_, b)| {
            b.text("created_at")
                .cmp(&a.text("created_at"))
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(out)
    }

    /// The project's items of `kind`, newest first. Empty where the kit
    /// does not apply.
    pub async fn items(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        kind: Kind,
    ) -> Result<Vec<Item>, Refusal> {
        let Some((_, at)) = self.applies(ctx, project).await? else {
            return Ok(Vec::new());
        };
        Ok(self
            .stored(&at, project, kind)
            .await?
            .into_iter()
            .map(|(_, i)| i)
            .collect())
    }

    async fn finding_ids(
        &self,
        at: &SecurityContext,
        project: Uuid,
    ) -> Result<Vec<String>, Refusal> {
        Ok(self
            .stored(at, project, Kind::Finding)
            .await?
            .into_iter()
            .map(|(_, i)| i.id)
            .collect())
    }

    /// Record an item, or replace one (`id`): answers it as stored.
    pub async fn save_item(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        kind: Kind,
        id: Option<&str>,
        body: &Value,
    ) -> Result<Item, Refusal> {
        let (_, at) = self.applying(ctx, project).await?;
        let findings = if kind == Kind::Risk {
            self.finding_ids(&at, project).await?
        } else {
            Vec::new()
        };
        let mut fields = clean_item(kind, body, &findings)?;
        let now = now_rfc3339()?;
        let id = match id {
            Some(id) => {
                let existing = self
                    .stored(&at, project, kind)
                    .await?
                    .into_iter()
                    .find(|(_, i)| i.id == id)
                    .map(|(_, i)| i)
                    .ok_or_else(|| not_found(kind, id))?;
                for key in ["created_by", "created_at"] {
                    if let Some(v) = existing.fields.get(key) {
                        fields.insert(key.to_owned(), v.clone());
                    }
                }
                id.to_owned()
            }
            None => {
                fields.insert("created_by".into(), json!(ctx.subject_id().to_string()));
                fields.insert("created_at".into(), json!(now));
                Uuid::new_v4().to_string()
            }
        };
        fields.insert("updated_at".into(), json!(now));
        let mut payload = fields.clone();
        payload.insert(ITEM_ID.into(), json!(id));
        payload.insert("tenant_id".into(), json!(project.to_string()));
        self.port()?
            .upsert_in(
                &at,
                &kind.entity(),
                &id,
                &project.to_string(),
                Value::Object(payload),
            )
            .await
            .map_err(write_refusal)?;
        Ok(Item { id, fields })
    }

    /// Delete an item.
    pub async fn delete_item(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        kind: Kind,
        id: &str,
    ) -> Result<(), Refusal> {
        let (_, at) = self.applying(ctx, project).await?;
        let (instance, _) = self
            .stored(&at, project, kind)
            .await?
            .into_iter()
            .find(|(_, i)| i.id == id)
            .ok_or_else(|| not_found(kind, id))?;
        self.port()?
            .delete(&at, &instance)
            .await
            .map_err(write_refusal)
    }

    /// The evidence summary, read as the caller: `reads` are the other
    /// gears' routes, as the caller.
    pub async fn evidence(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        reads: &dyn GearReads,
    ) -> Result<Evidence, Refusal> {
        let (org, at) = self.applying(ctx, project).await?;
        let p = project.to_string();
        let q = |pairs: &[(&str, &str)]| -> Vec<(String, String)> {
            pairs
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect()
        };
        let org_s = org.to_string();
        let nodes_q = q(&[("type", "repo"), ("scope", &p), ("limit", "200")]);
        let metrics_q = q(&[
            ("organization_id", &org_s),
            ("project_id", &p),
            ("range", "90d"),
        ]);
        let by_project = q(&[("project_id", &p)]);
        let (config, nodes, metrics, runs, rollups) = tokio::join!(
            self.projects.config(ctx, project),
            reads.get("/studio-artifact-ingest/v1/nodes", &nodes_q),
            reads.get("/studio-organizations/v1/metrics", &metrics_q),
            reads.get("/studio-artifact-ingest/v1/runs", &by_project),
            reads.get("/studio-organizations/v1/rollups", &by_project),
        );
        let mut facts = Vec::new();

        // The repositories: the project's sources, and their sync.
        const SOURCES: &str = "the project's sources (project.config)";
        const SYNC: &str = "the repositories' last sync (studio-artifact-ingest)";
        let sources: Option<Vec<ProjectSource>> = match &config {
            Ok(Some(c)) => Some(crate::project_sources::parse(c)),
            Ok(None) => Some(Vec::new()),
            Err(_) => None,
        };
        let synced: Option<BTreeMap<String, String>> = nodes.as_ref().ok().map(|page| {
            page["nodes"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|n| {
                    let v = &n["value"];
                    Some((
                        text(v, "full_path")?.to_ascii_lowercase(),
                        text(v, "synced_at")?,
                    ))
                })
                .collect()
        });
        let mut repositories: Vec<EvidenceRepository> = sources
            .iter()
            .flatten()
            .map(|s| EvidenceRepository {
                full_path: s.full_path.clone(),
                branch: s.branch.clone(),
                synced_at: synced
                    .as_ref()
                    .and_then(|m| m.get(&s.full_path.to_ascii_lowercase()).cloned()),
                contributors: None,
                truck_factor: None,
            })
            .collect();
        match (&sources, &config) {
            (Some(s), _) => {
                facts.push(Fact::known("repositories", s.len() as f64, SOURCES));
                facts.push(match &synced {
                    Some(_) => Fact::known(
                        "repositories_synced",
                        repositories
                            .iter()
                            .filter(|r| r.synced_at.is_some())
                            .count() as f64,
                        SYNC,
                    )
                    .with_total(s.len() as f64),
                    None => Fact::missing(
                        "repositories_synced",
                        SYNC,
                        nodes.as_ref().err().cloned().unwrap_or_default(),
                    ),
                });
            }
            (None, Err(why)) => {
                facts.push(Fact::missing("repositories", SOURCES, why.clone()));
                facts.push(Fact::missing("repositories_synced", SYNC, why.clone()));
            }
            (None, Ok(_)) => {}
        }

        // People: contributors and the truck factor, from the history of the
        // server's checkout of each source (never the provider).
        const FROM_HISTORY: &str = "the commit history of the server's checkout of each source";
        let all = sources.clone().unwrap_or_default();
        let lists = futures_util::future::join_all(
            all.iter()
                .map(|s| self.projects.contributors(ctx, project, s)),
        )
        .await;
        let mut commits_by: BTreeMap<String, u64> = BTreeMap::new();
        let mut failures = Vec::new();
        for ((source, list), repo) in all.iter().zip(&lists).zip(repositories.iter_mut()) {
            match list {
                Ok(people) => {
                    let humans: Vec<&(String, u64)> =
                        people.iter().filter(|(l, _)| !is_bot(l)).collect();
                    repo.contributors = Some(u32::try_from(humans.len()).unwrap_or(u32::MAX));
                    repo.truck_factor =
                        truck_factor(&humans.iter().map(|(_, c)| *c).collect::<Vec<_>>());
                    for (login, c) in humans {
                        *commits_by.entry(login.to_ascii_lowercase()).or_default() += c;
                    }
                }
                Err(why) => failures.push(format!("{}: {why}", source.full_path)),
            }
        }
        let asked = lists.iter().filter(|l| l.is_ok()).count();
        if all.is_empty() {
            let why = "no repository is connected to the deal yet";
            facts.push(Fact::missing("contributors", FROM_HISTORY, why));
            facts.push(Fact::missing("truck_factor", FROM_HISTORY, why));
        } else if asked == 0 {
            let why = failures.join("; ");
            facts.push(Fact::missing("contributors", FROM_HISTORY, why.clone()));
            facts.push(Fact::missing("truck_factor", FROM_HISTORY, why));
        } else {
            let partial = (!failures.is_empty()).then(|| {
                format!(
                    "not every repository could be asked: {}",
                    failures.join("; ")
                )
            });
            let mut c = Fact::known("contributors", commits_by.len() as f64, FROM_HISTORY);
            let commits: Vec<u64> = commits_by.values().copied().collect();
            let mut t = match truck_factor(&commits) {
                Some(n) => Fact::known("truck_factor", f64::from(n), FROM_HISTORY)
                    .with_detail("the fewest people who made more than half of the commits"),
                None => Fact::missing(
                    "truck_factor",
                    FROM_HISTORY,
                    "the repositories have no commits",
                ),
            };
            if let Some(p) = partial {
                c = c.with_detail(p.clone());
                if t.available {
                    t = t.with_detail(p);
                }
            }
            facts.push(c);
            facts.push(t);
        }
        const INSIGHT: &str = "Insight: people with commits over the last 90 days";
        facts.push(match &metrics {
            Ok(m) if m["insight"]["state"] == "ok" => {
                let people = m["insight"]["measures"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|x| x["key"] == "git.contributors")
                    .and_then(|x| x["current"]["people"].as_f64());
                match people {
                    Some(n) => Fact::known("active_contributors", n, INSIGHT),
                    None => Fact::known("active_contributors", 0.0, INSIGHT)
                        .with_detail("no commits in the last 90 days"),
                }
            }
            Ok(m) => Fact::missing(
                "active_contributors",
                INSIGHT,
                text(&m["insight"], "detail")
                    .or_else(|| text(&m["insight"], "state"))
                    .unwrap_or_else(|| "Insight did not answer".into()),
            ),
            Err(why) => Fact::missing("active_contributors", INSIGHT, why.clone()),
        });

        // Delivery: CI runs.
        const CI: &str = "CI runs the last sync kept (studio-artifact-ingest)";
        match &runs {
            Ok(page) => {
                let items: Vec<&Value> = page["items"].as_array().into_iter().flatten().collect();
                let finished: Vec<&str> = items
                    .iter()
                    .filter(|r| r["status"].as_str().is_none_or(|s| s == "completed"))
                    .filter_map(|r| r["conclusion"].as_str())
                    .filter(|c| !matches!(*c, "cancelled" | "skipped" | "neutral" | ""))
                    .collect();
                if finished.is_empty() {
                    facts.push(Fact::missing(
                        "ci_pass_rate",
                        CI,
                        "no finished CI run is recorded",
                    ));
                } else {
                    let passed = finished.iter().filter(|c| **c == "success").count();
                    facts.push(
                        Fact::known("ci_pass_rate", passed as f64 / finished.len() as f64, CI)
                            .with_total(finished.len() as f64),
                    );
                }
                let latest = text(page, "latest_completed").and_then(|id| {
                    items
                        .iter()
                        .find(|r| r["id"].as_str() == Some(id.as_str()))
                        .copied()
                });
                facts.push(match latest {
                    Some(run) => {
                        let status = match run["conclusion"].as_str() {
                            Some("success") => "passed",
                            Some("cancelled") => "cancelled",
                            Some("skipped" | "neutral") => "skipped",
                            Some(c) if !c.is_empty() => "failed",
                            _ => "unknown",
                        };
                        Fact::known(
                            "mainline_build",
                            if status == "passed" { 1.0 } else { 0.0 },
                            CI,
                        )
                        .with_detail(status)
                    }
                    None => Fact::missing("mainline_build", CI, "no completed run on a mainline"),
                });
            }
            Err(why) => {
                facts.push(Fact::missing("ci_pass_rate", CI, why.clone()));
                facts.push(Fact::missing("mainline_build", CI, why.clone()));
            }
        }

        // Quality: spec checks and Spec Quality's findings.
        const SPECS: &str = "spec checks (studio-documents, the project's rollup)";
        const QUALITY: &str = "Spec Quality's findings in the specs (the project's rollup)";
        let row = rollups
            .as_ref()
            .map(|r| r["items"].as_array().and_then(|i| i.first()).cloned());
        let count = |key: &'static str, source: &str, unknown: &str| -> Fact {
            match &row {
                Ok(Some(r)) => match r[key].as_f64() {
                    Some(n) => Fact::known(key, n, source),
                    None => Fact::missing(key, source, unknown),
                },
                Ok(None) => Fact::missing(key, source, "the project's rollup is empty"),
                Err(why) => Fact::missing(key, source, (*why).clone()),
            }
        };
        facts.push(count(
            "specs_checked",
            SPECS,
            "the documents gear could not say",
        ));
        facts.push(count(
            "specs_failing",
            SPECS,
            "the documents gear could not say",
        ));
        let mut open = count(
            "open_findings",
            QUALITY,
            "Spec Quality is not configured or could not say",
        );
        open.key = "spec_findings_open";
        facts.push(open);

        // The deal's own records.
        const OWN: &str = "this deal's records (kit mna)";
        for (key, kind) in [
            ("findings_open", Kind::Finding),
            ("risks_open", Kind::Risk),
            ("questions_open", Kind::Question),
        ] {
            let items = self.stored(&at, project, kind).await?;
            let open = items
                .iter()
                .filter(|(_, i)| {
                    i.text("status")
                        .is_none_or(|s| kind.open().contains(&s.as_str()))
                })
                .count();
            facts.push(Fact::known(key, open as f64, OWN).with_total(items.len() as f64));
        }

        Ok(Evidence {
            repositories,
            facts,
            read_at: now_rfc3339()?,
        })
    }
}

fn not_found(kind: Kind, id: &str) -> Refusal {
    Refusal::NotFound(
        id.to_owned(),
        format!("the deal has no {} {id}", kind.noun()),
    )
}

fn write_refusal(e: anyhow::Error) -> Refusal {
    if is_refusal(&e) {
        Refusal::Forbidden(DOMAIN_EDIT_REQUIRED)
    } else {
        Refusal::Internal(e)
    }
}

#[cfg(test)]
#[path = "deal_tests.rs"]
mod tests;
