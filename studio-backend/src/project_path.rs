//! A project's ONE path, from its sources to its running product: the stages
//! Overview, Product and Releases all draw, numbered and worded the same.
//!
//! Before this, three paths were drawn: Overview's (studio-organizations
//! `status.rs`: a repository, typed documents, the project domain model, its
//! findings, the product, a build), Product's (the portal: configure, save to
//! product.gdl, build, deploy) and Releases' (studio-environments `path.rs`:
//! product, build, image, environment, running). They said different things
//! about the same project. Now:
//!
//! | # | Stage         | Decided from                                                         |
//! |---|---------------|----------------------------------------------------------------------|
//! | 1 | `sources`     | status.rs `repos`: the project's repositories (rollup)                |
//! | 2 | `documents`   | status.rs `types`: the Specs queues                                   |
//! | 3 | `model`       | status.rs `model`: the project domain model                           |
//! | 4 | `findings`    | status.rs `findings`: open findings, a high one blocks                |
//! | 5 | `product`     | the product record (gears, last check `checks.<profile>`, last preview) and its saved description revision |
//! | 6 | `build`       | path.rs `build` (Studio's build records), else the newest CI run on the main branch (status.rs `BuildFacts`) |
//! | 7 | `images`      | path.rs `image`                                                       |
//! | 8 | `environment` | path.rs `environment`                                                 |
//! | 9 | `deploy`      | path.rs `running`                                                     |
//!
//! Nothing here reads: the two gears read their facts as they always did and
//! hand them here. Stages 1-4 are status.rs' steps re-said ([`upstream`]);
//! stages 5-9 are [`delivery_stages`], which studio-environments computes for
//! `GET /project-path` and hands studio-organizations through its port for
//! `GET /project-status` -- so the Releases tab and the Overview say the same
//! thing about a build, in the same words.
//!
//! A stage is `done`, `current` (the one to do now), `blocked` (something is
//! missing before it can go on), `todo`, `running`, `failed`, or `unknown`
//! (its read failed: never counted as not done). The FOCUS is the first stage
//! that is neither done nor unknown -- the one to look at; when it is merely
//! to do, it is `current`.

use uuid::Uuid;

use crate::organizations::status::{self, BuildFacts, Kits, ProductFacts, Step};
use crate::plural::plural;

/// The stages, in the order a project goes through them. A stage's number
/// is its place here, the same on every tab.
pub const STAGES: [&str; 9] = [
    "sources",
    "documents",
    "model",
    "findings",
    "product",
    "build",
    "images",
    "environment",
    "deploy",
];

/// Where a stage stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StageState {
    Done,
    /// The stage to do now: the focus, with nothing in its way.
    Current,
    /// Something is missing before it can go on; the cause says what.
    Blocked,
    Todo,
    /// A build or a deploy runs.
    Running,
    /// The last attempt failed, or the product does not resolve.
    Failed,
    /// Its read failed: not known, never counted as not done.
    Unknown,
}

impl StageState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Done => "done",
            Self::Current => "current",
            Self::Blocked => "blocked",
            Self::Todo => "todo",
            Self::Running => "running",
            Self::Failed => "failed",
            Self::Unknown => "unknown",
        }
    }
}

/// What moves a stage on: the action's kind (`open` a tab, `build`,
/// `deploy`, `save_product`, `open_product`, and path.rs' kinds) and its
/// label in English. The screen words it by the kind where it can.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StageAction {
    pub kind: String,
    pub label: String,
}

impl StageAction {
    fn new(kind: &str, label: &str) -> Self {
        Self {
            kind: kind.to_owned(),
            label: label.to_owned(),
        }
    }
}

/// Where a delivery step stands, as the kit that delivers says it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeliveryState {
    /// Nothing waits here.
    Done,
    /// Something runs: a build, a deploy.
    Active,
    /// The last attempt failed.
    Failed,
    /// Something is missing before it can go on.
    Blocked,
    /// The step to do now.
    Next,
    /// Waits for an earlier step.
    Later,
}

/// One step of the delivery path, what stages 6-9 are decided from: the
/// delivering kit (studio-environments' `path.rs`) hands its steps here in
/// these words, so the core never names it (ADR-0079).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeliveryStep {
    /// `product`, `build`, `image`, `environment`, `running`.
    pub id: &'static str,
    pub state: DeliveryState,
    pub reason: String,
    pub action: Option<StageAction>,
    pub build_id: Option<String>,
    pub environment_id: Option<Uuid>,
    pub deployment_id: Option<Uuid>,
}

/// One stage of the path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stage {
    /// One of [`STAGES`].
    pub id: &'static str,
    /// Its place in [`STAGES`], from 1.
    pub number: u32,
    pub title: &'static str,
    pub state: StageState,
    /// Why it is where it is, in one line.
    pub cause: String,
    /// The project tab that holds the evidence: `sources`, `specs`, `model`,
    /// `issues`, `product`, `releases`.
    pub tab: &'static str,
    /// The object on that tab the cause is about: a build id, a deploy or an
    /// environment id.
    pub object: Option<String>,
    /// What moves it on; none for a stage that is done.
    pub action: Option<StageAction>,
    /// The kit whose tab that is; `None` for Sources, the shell's own.
    pub kit: Option<&'static str>,
    /// The stage to look at now: the first neither done nor unknown.
    pub focus: bool,
}

/// A stage's title, tab and kit.
fn shape(id: &str) -> (&'static str, &'static str, Option<&'static str>) {
    match id {
        "sources" => ("Sources", "sources", None),
        "documents" => ("Documents", "specs", Some(status::SPECS_KIT)),
        "model" => ("Domain model", "model", Some(status::DOMAIN_MODEL_KIT)),
        "findings" => ("Findings", "issues", Some(status::DOMAIN_MODEL_KIT)),
        "product" => ("Product", "product", Some(status::PRODUCT_KIT)),
        "build" => ("Build", "releases", Some(status::DELIVERY_KIT)),
        "images" => ("Images", "releases", Some(status::DELIVERY_KIT)),
        "environment" => ("Environment", "releases", Some(status::DELIVERY_KIT)),
        "deploy" => ("Deploy", "releases", Some(status::DELIVERY_KIT)),
        _ => ("", "", None),
    }
}

/// A stage's place in [`STAGES`], from 1; 0 for an id that is not one.
pub fn number_of(id: &str) -> u32 {
    STAGES
        .iter()
        .position(|s| *s == id)
        .map_or(0, |i| u32::try_from(i + 1).unwrap_or(0))
}

impl Stage {
    pub fn new(id: &'static str, state: StageState, cause: impl Into<String>) -> Self {
        let number = number_of(id);
        let (title, tab, kit) = shape(id);
        Self {
            id,
            number,
            title,
            state,
            cause: cause.into(),
            tab,
            object: None,
            action: None,
            kit,
            focus: false,
        }
    }

    fn with_action(mut self, kind: &str, label: &str) -> Self {
        self.action = Some(StageAction::new(kind, label));
        self
    }
}

// ── Stages 1-4: the project's status path ───────────────────────────────────

/// The stage a status step is, by its id; the product and the build are the
/// delivery's ([`delivery_stages`]), with the product record's facts.
fn upstream_id(step: &str) -> Option<&'static str> {
    match step {
        "repos" => Some("sources"),
        "types" => Some("documents"),
        "model" => Some("model"),
        "findings" => Some("findings"),
        _ => None,
    }
}

/// Stages 1-4 from the status path (`status::project_path_for`), as decided
/// there: a step done is done, unknown is unknown, open high findings block,
/// the rest is to do. The kits that do not apply are already left out.
pub fn upstream(steps: &[Step], facts: &status::PathFacts) -> Vec<Stage> {
    steps
        .iter()
        .filter_map(|s| {
            let id = upstream_id(s.id)?;
            let state = match (s.state, status::flow_state(s, facts)) {
                (status::StepState::Unknown, _) => StageState::Unknown,
                (status::StepState::Done, _) => StageState::Done,
                (_, "failed") => StageState::Failed,
                (_, "warn") => StageState::Blocked,
                _ => StageState::Todo,
            };
            let stage = Stage::new(id, state, s.status.clone());
            Some(if state == StageState::Done {
                stage
            } else {
                stage.with_action("open", s.action)
            })
        })
        .collect()
}

// ── Stages 5-9: from the product to running ─────────────────────────────────

/// The engine's last verdict kept on the product record
/// (`checks.<profile>`, product-tab-speed): whether it resolves, its
/// errors, and the description revision it was about.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CheckFacts {
    pub ok: bool,
    pub errors: u32,
    pub revision: Option<i64>,
}

/// The newest verdict of the product record's `checks`, whichever profile.
pub fn check_facts(record: &serde_json::Value) -> Option<CheckFacts> {
    let at = |c: &serde_json::Value| c["checked_at"].as_str().unwrap_or_default().to_owned();
    record["checks"]
        .as_object()?
        .values()
        .filter(|c| c["ok"].is_boolean())
        .max_by_key(|c| at(c))
        .map(|c| CheckFacts {
            ok: c["ok"].as_bool().unwrap_or(false),
            errors: c["errors"]
                .as_u64()
                .map_or(0, |n| u32::try_from(n).unwrap_or(u32::MAX)),
            revision: c["revision"].as_i64(),
        })
}

/// What stages 5-9 are decided from. `None` on any of them: that read
/// failed (or, for `path`, the delivery was not read at all).
#[derive(Clone, Copy, Debug, Default)]
pub struct DeliveryFacts<'a> {
    /// The product record: gears picked, the last preview, saved or not.
    pub product: Option<&'a ProductFacts>,
    /// The saved description's revision Studio keeps; `Some(0)` for one in
    /// the repository only (path.rs' `product_revision`).
    pub revision: Option<i64>,
    pub check: Option<&'a CheckFacts>,
    /// The newest finished CI run on the main branch.
    pub ci: Option<&'a BuildFacts>,
    /// The delivery path's steps (path.rs): Studio's builds, images, environments,
    /// deploys.
    pub path: Option<&'a [DeliveryStep]>,
}

/// Stage 5: the product configured (gears picked, resolving) and saved.
pub fn product_stage(
    product: Option<&ProductFacts>,
    revision: Option<i64>,
    check: Option<&CheckFacts>,
) -> Stage {
    let Some(p) = product else {
        return Stage::new(
            "product",
            StageState::Unknown,
            "Could not read the product.",
        );
    };
    let gears = plural(p.gears, "gear", "gears");
    // The verdict on the saved text when one was kept for it, else the last
    // preview of the product as configured.
    let verdict = match (check, revision) {
        (Some(c), Some(r)) if c.revision == Some(r) => Some((c.ok, c.errors)),
        _ => p.resolves.map(|ok| (ok, p.errors)),
    };
    let saved = revision.is_some() || p.written;
    if p.gears == 0 && !saved {
        return Stage::new("product", StageState::Todo, "No gears picked yet.")
            .with_action("open_product", "Compose the product");
    }
    if let Some((false, errors)) = verdict {
        return Stage::new(
            "product",
            StageState::Failed,
            format!(
                "{gears}, does not resolve ({}).",
                plural(errors, "error", "errors")
            ),
        )
        .with_action("open_product", "Fix the product");
    }
    let checked = match verdict {
        Some(_) => ", resolves",
        None => ", not checked yet",
    };
    match revision {
        Some(0) => Stage::new(
            "product",
            StageState::Done,
            "The product is described in the project's repository.",
        ),
        Some(r) if p.gears == 0 => Stage::new(
            "product",
            StageState::Done,
            format!("Saved as revision {r}."),
        ),
        Some(r) => Stage::new(
            "product",
            StageState::Done,
            format!("{gears}{checked}, saved as revision {r}."),
        ),
        None if p.written => Stage::new(
            "product",
            StageState::Done,
            format!("{gears}{checked}, saved to the repository."),
        ),
        None => Stage::new(
            "product",
            StageState::Todo,
            format!("{gears}{checked}, not saved to product.gdl yet."),
        )
        .with_action("save_product", "Save to product.gdl"),
    }
}

/// A delivery step (path.rs) as the stage `id`.
fn from_delivery(id: &'static str, s: &DeliveryStep) -> Stage {
    let state = match s.state {
        DeliveryState::Done => StageState::Done,
        DeliveryState::Active => StageState::Running,
        DeliveryState::Failed => StageState::Failed,
        DeliveryState::Blocked => StageState::Blocked,
        DeliveryState::Next | DeliveryState::Later => StageState::Todo,
    };
    let mut stage = Stage::new(id, state, s.reason.clone());
    stage.object = s
        .deployment_id
        .map(|d| d.to_string())
        .or_else(|| s.build_id.clone())
        .or_else(|| s.environment_id.map(|e| e.to_string()));
    stage.action = s.action.clone();
    stage
}

/// Stage 6: Studio's newest build record when there is one (or what runs
/// was built elsewhere), else the newest finished CI run on the main branch,
/// else what the delivery path says.
pub fn build_stage(step: Option<&DeliveryStep>, ci: Option<&BuildFacts>) -> Stage {
    if let Some(s) = step
        && (s.build_id.is_some() || s.state == DeliveryState::Done)
    {
        return from_delivery("build", s);
    }
    if let Some(BuildFacts::Last { status, sha }) = ci {
        let at = if sha.is_empty() {
            String::new()
        } else {
            format!(" at {sha}")
        };
        let said = format!("The last CI build on the main branch {status}{at}.");
        return match status.as_str() {
            "passed" => Stage::new("build", StageState::Done, said),
            "failed" => {
                Stage::new("build", StageState::Failed, said).with_action("open", "Open Releases")
            }
            _ => Stage::new("build", StageState::Todo, said).with_action("build", "Build"),
        };
    }
    match (step, ci) {
        (Some(s), _) => from_delivery("build", s),
        (None, Some(BuildFacts::Never)) => {
            Stage::new("build", StageState::Todo, "Nothing is built yet.")
                .with_action("build", "Build")
        }
        _ => Stage::new("build", StageState::Unknown, "Could not read the builds."),
    }
}

/// Stages 5-9, the focus among them marked.
pub fn delivery_stages(f: &DeliveryFacts) -> Vec<Stage> {
    let step = |id: &str| f.path.and_then(|p| p.iter().find(|s| s.id == id));
    let mut out = vec![
        product_stage(f.product, f.revision, f.check),
        build_stage(step("build"), f.ci),
    ];
    for (from, id) in [
        ("image", "images"),
        ("environment", "environment"),
        ("running", "deploy"),
    ] {
        out.push(match step(from) {
            Some(s) => from_delivery(id, s),
            None => Stage::new(id, StageState::Unknown, "Could not read the releases."),
        });
    }
    focus(out)
}

// ── The whole path ──────────────────────────────────────────────────────────

/// Mark the focus: the first stage neither done nor unknown; `current` when
/// it is merely to do. Any other `current` goes back to `todo`.
pub fn focus(mut stages: Vec<Stage>) -> Vec<Stage> {
    for s in &mut stages {
        s.focus = false;
        if s.state == StageState::Current {
            s.state = StageState::Todo;
        }
    }
    if let Some(s) = stages
        .iter_mut()
        .find(|s| !matches!(s.state, StageState::Done | StageState::Unknown))
    {
        s.focus = true;
        if s.state == StageState::Todo {
            s.state = StageState::Current;
        }
    }
    stages
}

/// The whole path: stages 1-4 and 5-9 in order, a stage of a kit that does
/// not apply to the project left out, the focus marked across all of them.
pub fn join(upstream: Vec<Stage>, delivery: Vec<Stage>, kits: &Kits) -> Vec<Stage> {
    let mut all: Vec<Stage> = upstream
        .into_iter()
        .chain(delivery)
        .filter(|s| kits.has(s.kit))
        .collect();
    all.sort_by_key(|s| s.number);
    focus(all)
}

// ── On the wire ─────────────────────────────────────────────────────────────

/// What moves a stage on.
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(response)]
pub struct ProjectStageActionDto {
    /// `open` (the stage's tab), `open_product`, `save_product`, `build`,
    /// `deploy`, and the delivery path's own kinds (`open_build`,
    /// `bind_profile`, `provide_secret`, `sign_in`, `open_deployment`,
    /// `open_app`, `ask_admin`, `open_gear`, `choose_hardware`,
    /// `ask_organization`, `check_environment`, `open_log`).
    pub kind: String,
    /// The button in English; a screen words it by `kind` where it can.
    pub label: String,
}

/// One stage of a project's path from its sources to its running product:
/// the same stage, number and words on Overview, Product and Releases.
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(response)]
pub struct ProjectStageDto {
    /// `sources`, `documents`, `model`, `findings`, `product`, `build`,
    /// `images`, `environment`, `deploy`.
    pub id: String,
    /// Its place on the whole path, from 1: Product is 5 on every tab.
    pub number: u32,
    /// "Sources", "Documents", ... in English.
    pub title: String,
    /// `done`, `current`, `blocked`, `todo`, `running`, `failed`, or
    /// `unknown` when its read failed.
    pub state: String,
    /// Why it is where it is, in one line.
    pub cause: String,
    /// The project tab that holds the evidence: `sources`, `specs`, `model`,
    /// `issues`, `product`, `releases`.
    pub tab: String,
    /// The object there the cause is about: a build id, a deploy or an
    /// environment id.
    pub object: Option<String>,
    pub action: Option<ProjectStageActionDto>,
    /// The kit whose tab that is; null for Sources, the shell's own.
    pub kit: Option<String>,
    /// The stage to look at now: the first that is neither done nor unknown.
    pub focus: bool,
}

impl From<&Stage> for ProjectStageDto {
    fn from(s: &Stage) -> Self {
        Self {
            id: s.id.to_owned(),
            number: s.number,
            title: s.title.to_owned(),
            state: s.state.as_str().to_owned(),
            cause: s.cause.clone(),
            tab: s.tab.to_owned(),
            object: s.object.clone(),
            action: s.action.as_ref().map(|a| ProjectStageActionDto {
                kind: a.kind.clone(),
                label: a.label.clone(),
            }),
            kit: s.kit.map(str::to_owned),
            focus: s.focus,
        }
    }
}

/// The stages as the wire carries them.
pub fn stages_dto(stages: &[Stage]) -> Vec<ProjectStageDto> {
    stages.iter().map(ProjectStageDto::from).collect()
}

#[cfg(test)]
#[path = "project_path_tests.rs"]
mod tests;
