//! Builds the IDE reports, and builds started from the portal (ADR-0045
//! phases 2 and 3).
//!
//! The IDE's Build and Run -- in a member's desktop or in a session -- report a
//! build's start and its end: what was built (the product, its profile, the
//! commit), where, by whom, and how it ended, with the first error when it
//! failed. Each report is one `build` node in the project's graph, keyed by
//! the build's id, so the end lands on the start. A finished build is a
//! record: a report for it after it ended is refused.
//!
//! A build in CI is started here too: Build dispatches the project's build
//! workflow (`project.config` `build`) through the connection of the project's
//! repository, and the run arrives in the next sync like any other.
//!
//! What is checked lives here, without a graph or a provider, so it can be
//! tested; [`super::service::IngestService`] stores and dispatches.

use serde_json::{Map, Value, json};

use crate::connectors::sdk::ownership::NotOwned;

/// Where a build ran.
pub const WHERE: [&str; 2] = ["desktop", "session"];
/// What the member pressed.
pub const ACTIONS: [&str; 2] = ["build", "run"];
/// A build's status: running until its end is reported.
pub const STATUSES: [&str; 4] = ["running", "passed", "failed", "cancelled"];
/// Images a build may name as its outputs.
const MAX_OUTPUTS: usize = 20;

/// One report from the IDE, as it arrives.
#[derive(Debug, Clone, Default)]
pub struct BuildReport {
    /// The IDE's id for the build: the same in the report of its start and of
    /// its end.
    pub build_id: String,
    pub r#where: String,
    pub action: Option<String>,
    pub status: String,
    /// The product's id, as `product.gdl` names it.
    pub product: Option<String>,
    pub profile: Option<String>,
    /// `owner/repo` of the repository the product lives in.
    pub repository: Option<String>,
    pub commit: Option<String>,
    pub branch: Option<String>,
    /// The `product.lock` hash: which gears, at which versions.
    pub lock_hash: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    /// The first error, when it failed.
    pub failure: Option<String>,
    /// The step it failed in (`protoc`, `compile`, `link`).
    pub failure_step: Option<String>,
    /// The images it built, `name:tag` or with a digest.
    pub outputs: Vec<String>,
}

/// Why a build is not recorded, or not started.
#[derive(Debug)]
pub enum BuildRefusal {
    /// The report or the request does not say what it must.
    Invalid(String),
    /// The project, or its repository, is not one the caller reaches.
    NotFound(String),
    /// The build ended already; its record is not edited.
    Finished(String),
    /// The repository's connection is held outside the project's organization.
    NotOwned(NotOwned),
    /// The provider refused, in its own words.
    Provider(String),
    /// Something on this side failed.
    Internal(anyhow::Error),
}

impl From<anyhow::Error> for BuildRefusal {
    fn from(e: anyhow::Error) -> Self {
        Self::Internal(e)
    }
}

fn clean(v: Option<&str>, field: &str, max: usize) -> Result<Option<String>, BuildRefusal> {
    let Some(v) = v.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if v.chars().count() > max {
        return Err(BuildRefusal::Invalid(format!(
            "{field} is longer than {max} characters"
        )));
    }
    if v.chars().any(char::is_control) {
        return Err(BuildRefusal::Invalid(format!(
            "{field} holds a control character"
        )));
    }
    Ok(Some(v.to_owned()))
}

/// A commit or lock hash: hex, 7 to 64 characters.
fn hash(v: Option<&str>, field: &str) -> Result<Option<String>, BuildRefusal> {
    let Some(v) = clean(v, field, 64)? else {
        return Ok(None);
    };
    if v.len() >= 7 && v.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(Some(v.to_ascii_lowercase()))
    } else {
        Err(BuildRefusal::Invalid(format!("{field} '{v}' is not a hex hash")))
    }
}

/// An RFC 3339 instant.
fn instant(v: Option<&str>, field: &str) -> Result<Option<time::OffsetDateTime>, BuildRefusal> {
    let Some(v) = clean(v, field, 40)? else {
        return Ok(None);
    };
    time::OffsetDateTime::parse(&v, &time::format_description::well_known::Rfc3339)
        .map(Some)
        .map_err(|_| BuildRefusal::Invalid(format!("{field} '{v}' is not an RFC 3339 time")))
}

fn rfc3339(t: time::OffsetDateTime) -> String {
    t.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

/// A build id the IDE generates: letters, digits and `-`, 8 to 64.
fn build_id(v: &str) -> Result<String, BuildRefusal> {
    let v = v.trim();
    if (8..=64).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        Ok(v.to_owned())
    } else {
        Err(BuildRefusal::Invalid(
            "build_id is 8 to 64 letters, digits and hyphens".into(),
        ))
    }
}

fn one_of(v: &str, allowed: &[&str], field: &str) -> Result<String, BuildRefusal> {
    let v = v.trim();
    if allowed.contains(&v) {
        Ok(v.to_owned())
    } else {
        Err(BuildRefusal::Invalid(format!(
            "{field} is one of {}, not '{v}'",
            allowed.join(", ")
        )))
    }
}

/// The build's id, checked: what keys its node.
pub fn checked_id(report: &BuildReport) -> Result<String, BuildRefusal> {
    build_id(&report.build_id)
}

/// The record a report makes, over `earlier` -- the record of the same build
/// so far, when its start was reported. A finished build is refused; a
/// running one keeps when it started and who started it. `now` stamps what
/// the report leaves out: the start of a running build, the end of a
/// finished one.
pub fn record(
    report: &BuildReport,
    project_id: &str,
    workspace_id: Option<&str>,
    reported_by: &str,
    now: time::OffsetDateTime,
    earlier: Option<&Value>,
) -> Result<Value, BuildRefusal> {
    let id = build_id(&report.build_id)?;
    if let Some(status) = earlier
        .and_then(|e| e.get("status"))
        .and_then(Value::as_str)
        .filter(|s| *s != "running")
    {
        return Err(BuildRefusal::Finished(format!(
            "build {id} ended already ({status}); its record is not changed"
        )));
    }
    let r#where = one_of(&report.r#where, &WHERE, "where")?;
    let action = one_of(report.action.as_deref().unwrap_or("build"), &ACTIONS, "action")?;
    let status = one_of(&report.status, &STATUSES, "status")?;
    let finished = status != "running";

    let earlier_text = |k: &str| {
        earlier
            .and_then(|e| e.get(k))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let started = match instant(report.started_at.as_deref(), "started_at")? {
        Some(t) => Some(t),
        None => earlier_text("started_at").and_then(|s| {
            time::OffsetDateTime::parse(&s, &time::format_description::well_known::Rfc3339).ok()
        }),
    }
    .unwrap_or(now);
    let ended = if finished {
        Some(instant(report.finished_at.as_deref(), "finished_at")?.unwrap_or(now))
    } else {
        None
    };
    if let Some(end) = ended
        && end < started
    {
        return Err(BuildRefusal::Invalid(
            "finished_at is before started_at".into(),
        ));
    }

    let mut outputs = Vec::new();
    for o in &report.outputs {
        if let Some(o) = clean(Some(o), "an output", 300)? {
            outputs.push(o);
        }
    }
    if outputs.len() > MAX_OUTPUTS {
        return Err(BuildRefusal::Invalid(format!(
            "a build names at most {MAX_OUTPUTS} outputs"
        )));
    }
    let failure = if status == "failed" {
        clean(report.failure.as_deref(), "failure", 500)?
    } else {
        None
    };
    let product = clean(report.product.as_deref(), "product", 100)?;
    let commit = hash(report.commit.as_deref(), "commit")?;
    let short_sha: Option<String> = commit.as_ref().map(|c| c.chars().take(7).collect());

    let mut v = Map::new();
    let mut put = |k: &str, value: Value| {
        if !value.is_null() {
            v.insert(k.to_owned(), value);
        }
    };
    put("build_id", json!(id));
    put(
        "title",
        json!(format!(
            "{} {}",
            if action == "run" { "Run" } else { "Build" },
            product.as_deref().unwrap_or("the product")
        )),
    );
    put("where", json!(r#where));
    put("action", json!(action));
    put("status", json!(status));
    put("product", json!(product));
    put("profile", json!(clean(report.profile.as_deref(), "profile", 60)?));
    put(
        "repository",
        json!(clean(report.repository.as_deref(), "repository", 200)?),
    );
    put("commit", json!(commit));
    put("short_sha", json!(short_sha));
    put("branch", json!(clean(report.branch.as_deref(), "branch", 200)?));
    put("lock_hash", json!(hash(report.lock_hash.as_deref(), "lock_hash")?));
    put("started_at", json!(rfc3339(started)));
    if let Some(end) = ended {
        put("finished_at", json!(rfc3339(end)));
        let ms = (end - started).whole_milliseconds();
        put("duration_ms", json!(i64::try_from(ms).unwrap_or(i64::MAX)));
    }
    put("failure", json!(failure));
    put(
        "failure_step",
        json!(if status == "failed" {
            clean(report.failure_step.as_deref(), "failure_step", 100)?
        } else {
            None
        }),
    );
    if !outputs.is_empty() {
        put("outputs", json!(outputs));
    }
    // Who started it stays who started it: the end may come from the same
    // person on another connection, never from someone else's report.
    put(
        "reported_by",
        json!(earlier_text("reported_by").unwrap_or_else(|| reported_by.to_owned())),
    );
    put("updated_at", json!(rfc3339(now)));
    put("project_id", json!(project_id));
    put("workspace_id", json!(workspace_id));
    Ok(Value::Object(v))
}

/// What Build asks for: the project's build workflow unless the request names
/// another, on a ref or the repository's default branch.
#[derive(Debug, Clone, Default)]
pub struct BuildDispatch {
    pub repo: Option<String>,
    pub workflow: Option<String>,
    pub git_ref: Option<String>,
}

/// A workflow as GitHub takes it in a path: its file name (`build.yml`, also
/// from `.github/workflows/build.yml`) or its numeric id.
pub fn workflow_file(workflow: &str) -> Result<String, BuildRefusal> {
    let name = workflow
        .trim()
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_owned();
    let numeric = !name.is_empty() && name.bytes().all(|b| b.is_ascii_digit());
    let file = (name.ends_with(".yml") || name.ends_with(".yaml"))
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    if numeric || file {
        Ok(name)
    } else {
        Err(BuildRefusal::Invalid(format!(
            "'{workflow}' names no workflow: give its file (build.yml) or its id"
        )))
    }
}

/// A branch or tag to run on, as git spells one.
pub fn checked_ref(git_ref: Option<&str>) -> Result<Option<String>, BuildRefusal> {
    let Some(r) = git_ref.map(str::trim).filter(|r| !r.is_empty()) else {
        return Ok(None);
    };
    if r.len() <= 200
        && !r.starts_with('/')
        && !r.contains("..")
        && r.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'/'))
    {
        Ok(Some(r.to_owned()))
    } else {
        Err(BuildRefusal::Invalid(format!("'{r}' is not a branch or tag")))
    }
}

#[cfg(test)]
#[path = "builds_tests.rs"]
mod tests;
