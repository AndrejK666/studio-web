//! CI runs as execution evidence, read back per project and revision
//! (`docs/design/studio-artifact-ingest.md`, "CI runs"; issue #783).
//!
//! The sync already keeps every workflow run of a project's repositories as a
//! `workflow_run` node (ADR-0045). This is the typed reading of them: which
//! runs a revision or a branch had, and which completed run speaks for the
//! project's mainline now — the evidence a "tests pass" stage gate waits for.

use serde_json::Value;

/// One CI run as the sync kept it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CiRun {
    pub id: String,
    /// The repo node it ran in.
    pub repo: Option<String>,
    pub workflow: String,
    pub workflow_path: Option<String>,
    pub title: Option<String>,
    pub event: Option<String>,
    pub branch: Option<String>,
    pub sha: String,
    /// `queued`, `in_progress`, `completed`.
    pub status: Option<String>,
    /// For a completed run: `success`, `failure`, `cancelled`, …
    pub conclusion: Option<String>,
    pub url: Option<String>,
    pub number: Option<i64>,
    /// Which attempt the run is at: a re-run reads the same run again.
    pub attempt: Option<i64>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

/// One job of a CI run's latest attempt, as the sync kept it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CiJob {
    pub id: String,
    /// The run's node.
    pub run: String,
    pub attempt: Option<i64>,
    pub name: String,
    pub status: Option<String>,
    pub conclusion: Option<String>,
    /// The first step that failed, when one did.
    pub failed_step: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub url: Option<String>,
}

/// A `workflow_job` node's payload as a job; `None` without its run.
pub fn job_of(id: &str, v: &Value) -> Option<CiJob> {
    Some(CiJob {
        id: id.to_string(),
        run: s(v, "run")?,
        attempt: v.get("attempt").and_then(Value::as_i64),
        name: s(v, "title").unwrap_or_default(),
        status: s(v, "status"),
        conclusion: s(v, "conclusion"),
        failed_step: s(v, "failed_step"),
        started_at: s(v, "started_at"),
        completed_at: s(v, "completed_at"),
        url: s(v, "url"),
    })
}

/// A run's jobs, in the order they started: those of the attempt the run is
/// at, so the jobs of an attempt a re-run replaced are not shown as its own.
pub fn jobs_of_run<'a>(run: &CiRun, jobs: &'a [CiJob]) -> Vec<&'a CiJob> {
    let mut mine: Vec<&CiJob> = jobs
        .iter()
        .filter(|j| j.run == run.id && (run.attempt.is_none() || j.attempt == run.attempt))
        .collect();
    mine.sort_by(|a, b| a.started_at.cmp(&b.started_at).then(a.name.cmp(&b.name)));
    mine
}

fn s(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_string)
}

/// A `workflow_run` node's payload as a run; `None` without a sha.
pub fn run_of(id: &str, v: &Value) -> Option<CiRun> {
    Some(CiRun {
        id: id.to_string(),
        repo: s(v, "repo"),
        workflow: s(v, "workflow").unwrap_or_default(),
        workflow_path: s(v, "workflow_path"),
        title: s(v, "title"),
        event: s(v, "event"),
        branch: s(v, "branch"),
        sha: s(v, "sha")?,
        status: s(v, "status"),
        conclusion: s(v, "conclusion"),
        url: s(v, "url"),
        number: v.get("number").and_then(Value::as_i64),
        attempt: v.get("attempt").and_then(Value::as_i64),
        created_at: s(v, "created_at"),
        updated_at: s(v, "updated_at"),
    })
}

/// The runs a revision (a full or short sha) or a branch had, newest first.
pub fn filter(mut runs: Vec<CiRun>, revision: Option<&str>, branch: Option<&str>) -> Vec<CiRun> {
    if let Some(rev) = revision.map(str::trim).filter(|r| !r.is_empty()) {
        runs.retain(|r| r.sha.starts_with(rev));
    }
    if let Some(b) = branch.map(str::trim).filter(|b| !b.is_empty()) {
        runs.retain(|r| r.branch.as_deref() == Some(b));
    }
    runs.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
    runs
}

/// The branches taken to be a repository's mainline when nothing says which.
pub const MAINLINES: [&str; 3] = ["main", "master", "trunk"];

/// The newest completed run on a mainline, else the newest completed run at
/// all: what says whether the project's code passes its CI now.
pub fn latest_completed(runs: &[CiRun]) -> Option<&CiRun> {
    let completed = || {
        runs.iter()
            .filter(|r| r.status.as_deref() == Some("completed"))
    };
    completed()
        .filter(|r| r.branch.as_deref().is_some_and(|b| MAINLINES.contains(&b)))
        .max_by(|a, b| a.created_at.cmp(&b.created_at))
        .or_else(|| completed().max_by(|a, b| a.created_at.cmp(&b.created_at)))
}

#[cfg(test)]
#[path = "ci_runs_tests.rs"]
mod tests;
