//! Project domain — the rules that made this a gear instead of data.
//!
//! ADR-0002 put Projects on Resource Group metadata and said a dedicated gear
//! is only worth it once the logic outgrows CRUD. These are the pieces that
//! did: a project has two mutually exclusive *shapes* (start from an idea, or
//! start from existing code), a stage selection with a mandatory member, a
//! status ladder that only goes one way, and a name that must be unique inside
//! its workspace. The first three live here as types; the fourth is a unique
//! index in `migrations`.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// What kind of project this is — the "two options" on the creation screen.
///
/// These are not a flag on one shape; they are two different shapes, and the
/// difference is enforced by [`ProjectSource`]: a greenfield project has no
/// source to import, a modernization has exactly one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// "Build Something New" — the input is a description, not a codebase.
    Greenfield,
    /// "Modernize Legacy Code" — the input is an existing codebase.
    Modernize,
}

impl Mode {
    #[must_use]
    pub fn as_smallint(self) -> i16 {
        match self {
            Self::Greenfield => 1,
            Self::Modernize => 2,
        }
    }

    #[must_use]
    pub fn from_smallint(v: i16) -> Option<Self> {
        match v {
            1 => Some(Self::Greenfield),
            2 => Some(Self::Modernize),
            _ => None,
        }
    }

    /// Wire name, also what the REST API accepts.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Greenfield => "greenfield",
            Self::Modernize => "modernize",
        }
    }

    /// Parse the wire name. Accepts the UI's own wording too, because the
    /// screen says "Build Something New" / "Modernize Legacy Code" and a
    /// client that sends what it displays should not get a puzzling 400.
    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().replace([' ', '-'], "_").as_str() {
            "greenfield" | "new" | "build_something_new" => Some(Self::Greenfield),
            "modernize" | "legacy" | "modernize_legacy_code" => Some(Self::Modernize),
            _ => None,
        }
    }
}

/// Where the project's material comes from. One variant per [`Mode`], which is
/// what makes an impossible combination unrepresentable rather than merely
/// rejected: there is no way to build a `Greenfield` that carries a repository,
/// or a `Modernize` that carries none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProjectSource {
    /// Free-form description of the idea. Optional: a project can be created
    /// empty and filled in later, which is how the "draft" status is useful.
    Idea { brief: Option<String> },
    /// A repository to import. Any URL the connector layer can clone.
    Git { url: String },
    /// An archive or folder already uploaded to the file-storage gear.
    ///
    /// Only the id is kept. Bytes belong to file-storage, and there is no
    /// in-process way to reach them anyway: `FileStorageClientV1` is still a
    /// stub with a single `module_name()` method, so the portal uploads over
    /// REST and hands us the id — the same split as connector tokens, where
    /// credstore holds the value and we hold the reference.
    Upload { file_id: Uuid },
}

impl ProjectSource {
    #[must_use]
    pub fn mode(&self) -> Mode {
        match self {
            Self::Idea { .. } => Mode::Greenfield,
            Self::Git { .. } | Self::Upload { .. } => Mode::Modernize,
        }
    }

    /// Storage discriminator for the `source_kind` column. `None` for a
    /// greenfield project, whose row carries no source at all.
    #[must_use]
    pub fn kind_smallint(&self) -> Option<i16> {
        match self {
            Self::Idea { .. } => None,
            Self::Git { .. } => Some(1),
            Self::Upload { .. } => Some(2),
        }
    }
}

/// Lifecycle status. The ladder only goes up: see [`Status::can_transition_to`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// Created, not yet handed to the agents.
    Draft,
    /// Running.
    Active,
    /// Finished or abandoned; terminal.
    Archived,
}

impl Status {
    #[must_use]
    pub fn as_smallint(self) -> i16 {
        match self {
            Self::Draft => 1,
            Self::Active => 2,
            Self::Archived => 3,
        }
    }

    #[must_use]
    pub fn from_smallint(v: i16) -> Option<Self> {
        match v {
            1 => Some(Self::Draft),
            2 => Some(Self::Active),
            3 => Some(Self::Archived),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Active => "active",
            Self::Archived => "archived",
        }
    }

    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "draft" => Some(Self::Draft),
            "active" => Some(Self::Active),
            "archived" => Some(Self::Archived),
            _ => None,
        }
    }

    /// `draft → active → archived`, plus the shortcut `draft → archived` for
    /// abandoning something that never started. Archived is terminal: there is
    /// no un-archive, because reopening should create a new project rather than
    /// silently resurrect one whose agents already ran.
    ///
    /// A transition to the current status is allowed and is a no-op, so a
    /// client retrying a PATCH it already applied does not get a 409.
    #[must_use]
    pub fn can_transition_to(self, next: Self) -> bool {
        match (self, next) {
            (a, b) if a == b => true,
            (Self::Draft, Self::Active | Self::Archived) | (Self::Active, Self::Archived) => true,
            _ => false,
        }
    }
}

/// One entry in the journey-stage catalogue.
pub struct StageSpec {
    /// Wire key, stored verbatim.
    pub key: &'static str,
    /// Label the creation screen shows.
    pub label: &'static str,
    /// Whether the stage can be deselected.
    pub required: bool,
}

/// The journey stages, in canonical order.
///
/// Order matters twice: it is the order the UI renders, and the order a stored
/// selection is normalised into, so `["testing","intent"]` and
/// `["intent","testing"]` are the same row rather than two different strings
/// that compare unequal.
pub const STAGES: [StageSpec; 8] = [
    StageSpec { key: "intent", label: "Intent", required: true },
    StageSpec { key: "brd", label: "BRD", required: false },
    StageSpec { key: "prd", label: "PRD", required: false },
    StageSpec { key: "prd_spec", label: "PRD-Spec", required: false },
    StageSpec { key: "architecture", label: "Architecture", required: false },
    StageSpec { key: "ui_design", label: "UI Design", required: false },
    StageSpec { key: "user_stories", label: "User Stories", required: false },
    StageSpec { key: "testing", label: "Testing", required: false },
];

/// Validation failures a caller can fix. Everything here maps to 400.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValidationError {
    NameEmpty,
    NameTooLong { max: usize },
    UnknownStage { key: String },
    NoStages,
    GitUrlEmpty,
    BriefTooLong { max: usize },
    IllegalTransition { from: Status, to: Status },
}

impl core::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::NameEmpty => write!(f, "name must not be empty"),
            Self::NameTooLong { max } => write!(f, "name must be at most {max} characters"),
            Self::UnknownStage { key } => {
                let known: Vec<&str> = STAGES.iter().map(|s| s.key).collect();
                write!(f, "unknown journey stage '{key}'; known stages: {}", known.join(", "))
            }
            Self::NoStages => write!(f, "at least one journey stage must be selected"),
            Self::GitUrlEmpty => write!(f, "git source requires a non-empty url"),
            Self::BriefTooLong { max } => write!(f, "brief must be at most {max} characters"),
            Self::IllegalTransition { from, to } => write!(
                f,
                "cannot change status from '{}' to '{}'",
                from.as_str(),
                to.as_str()
            ),
        }
    }
}

impl std::error::Error for ValidationError {}

/// Max project name length; matches the CHECK constraint in the migration.
pub const NAME_MAX: usize = 200;
/// Max brief length. Generous — it holds a pasted PRD — but bounded, because
/// an unbounded text column reachable from an unauthenticated-adjacent API is
/// a denial-of-service surface.
pub const BRIEF_MAX: usize = 100_000;

/// Trim and check a project name.
pub fn normalize_name(raw: &str) -> Result<String, ValidationError> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(ValidationError::NameEmpty);
    }
    if name.chars().count() > NAME_MAX {
        return Err(ValidationError::NameTooLong { max: NAME_MAX });
    }
    Ok(name.to_owned())
}

/// Normalise a stage selection: validate every key, add the required stages
/// whether or not the caller sent them, drop duplicates, and return them in
/// catalogue order.
///
/// Adding `intent` silently rather than rejecting its absence is deliberate:
/// the UI renders it as a checked, disabled checkbox, so a client that omits it
/// is describing the same intent as one that sends it, and failing the request
/// would only teach callers to send a field they cannot influence.
pub fn normalize_stages(raw: &[String]) -> Result<Vec<String>, ValidationError> {
    for key in raw {
        let key = key.trim();
        if !STAGES.iter().any(|s| s.key == key) {
            return Err(ValidationError::UnknownStage { key: key.to_owned() });
        }
    }
    let selected: Vec<String> = STAGES
        .iter()
        .filter(|s| s.required || raw.iter().any(|r| r.trim() == s.key))
        .map(|s| s.key.to_owned())
        .collect();
    if selected.is_empty() {
        return Err(ValidationError::NoStages);
    }
    Ok(selected)
}

/// Validate a source and normalise the strings inside it.
pub fn normalize_source(source: ProjectSource) -> Result<ProjectSource, ValidationError> {
    match source {
        ProjectSource::Git { url } => {
            let url = url.trim().to_owned();
            if url.is_empty() {
                return Err(ValidationError::GitUrlEmpty);
            }
            Ok(ProjectSource::Git { url })
        }
        ProjectSource::Idea { brief } => {
            let brief = brief.map(|b| b.trim().to_owned()).filter(|b| !b.is_empty());
            if let Some(b) = &brief
                && b.chars().count() > BRIEF_MAX
            {
                return Err(ValidationError::BriefTooLong { max: BRIEF_MAX });
            }
            Ok(ProjectSource::Idea { brief })
        }
        upload @ ProjectSource::Upload { .. } => Ok(upload),
    }
}

/// A validated creation request, ready for the repository.
#[derive(Debug, Clone)]
pub struct NewProject {
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub name: String,
    pub source: ProjectSource,
    pub stages: Vec<String>,
    pub created_by: Uuid,
}

impl NewProject {
    /// Build a creation request, validating every field.
    ///
    /// # Errors
    /// Returns the first [`ValidationError`] found.
    pub fn build(
        tenant_id: Uuid,
        created_by: Uuid,
        name: &str,
        source: ProjectSource,
        stages: &[String],
    ) -> Result<Self, ValidationError> {
        Ok(Self {
            id: Uuid::new_v4(),
            tenant_id,
            name: normalize_name(name)?,
            source: normalize_source(source)?,
            stages: normalize_stages(stages)?,
            created_by,
        })
    }

    #[must_use]
    pub fn mode(&self) -> Mode {
        self.source.mode()
    }
}

/// A stored project.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Project {
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub name: String,
    pub status: Status,
    pub source: ProjectSource,
    pub stages: Vec<String>,
    /// Resource Group group holding the project's members, when RG was
    /// reachable at creation time. `None` means members are unavailable for
    /// this project — see `service::create`.
    pub rg_group_id: Option<Uuid>,
    pub created_by: Uuid,
    pub created_at: time::OffsetDateTime,
    pub updated_at: time::OffsetDateTime,
}

impl Project {
    #[must_use]
    pub fn mode(&self) -> Mode {
        self.source.mode()
    }
}

#[cfg(test)]
#[path = "model_tests.rs"]
mod model_tests;
