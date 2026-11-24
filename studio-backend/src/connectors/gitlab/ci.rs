//! GitLab CI as Studio's CI runs and jobs (ADR-0045): pipelines and their
//! jobs, read through GraphQL with the queries Insight's GitLab connector
//! uses (#3863).
//!
//! REST would need a second call per pipeline for its source, its user and
//! its merge request; GraphQL answers the whole row in one paged query. Its
//! ids are global (`gid://gitlab/Ci::Pipeline/123`); the numeric tail is what
//! REST and the UI show, and what a run is keyed by. A project the token can
//! list but not query answers `project: null` with no error: no rows.
//!
//! GitLab has no workflows: one `.gitlab-ci.yml` makes every pipeline, so
//! the driver lists none and the sync reads runs repository-wide.

use serde::Deserialize;

use super::super::driver::{RemoteWorkflowJob, RemoteWorkflowRun};

/// The pipelines of one project, newest first.
pub(super) const PIPELINES_QUERY: &str = r"
query($project: ID!, $first: Int!, $cursor: String) {
  project(fullPath: $project) {
    pipelines(first: $first, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        iid
        sha
        ref
        status
        source
        createdAt
        updatedAt
        startedAt
        finishedAt
        user { username }
        mergeRequest { iid }
      }
    }
  }
}";

/// The jobs of one pipeline, by its per-project iid.
pub(super) const JOBS_QUERY: &str = r"
query($project: ID!, $iid: ID!, $cursor: String) {
  project(fullPath: $project) {
    pipeline(iid: $iid) {
      jobs(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          name
          status
          stage { name }
          allowFailure
          retried
          startedAt
          finishedAt
        }
      }
    }
  }
}";

#[derive(Deserialize, Default)]
pub(super) struct PageInfo {
    #[serde(rename = "hasNextPage", default)]
    pub has_next_page: bool,
    #[serde(rename = "endCursor", default)]
    pub end_cursor: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct Connection<T> {
    #[serde(rename = "pageInfo", default)]
    pub page_info: PageInfo,
    #[serde(default = "Vec::new")]
    pub nodes: Vec<T>,
}

#[derive(Deserialize)]
pub(super) struct PipelinesData {
    #[serde(default)]
    pub project: Option<PipelinesProject>,
}

#[derive(Deserialize)]
pub(super) struct PipelinesProject {
    #[serde(default)]
    pub pipelines: Option<Connection<Pipeline>>,
}

#[derive(Deserialize)]
pub(super) struct Pipeline {
    pub id: String,
    #[serde(default)]
    pub iid: Option<String>,
    #[serde(default)]
    pub sha: Option<String>,
    #[serde(rename = "ref", default)]
    pub git_ref: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(rename = "createdAt", default)]
    pub created_at: Option<String>,
    #[serde(rename = "updatedAt", default)]
    pub updated_at: Option<String>,
    #[serde(rename = "startedAt", default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub user: Option<Actor>,
    #[serde(rename = "mergeRequest", default)]
    pub merge_request: Option<MergeRequestRef>,
}

#[derive(Deserialize)]
pub(super) struct Actor {
    pub username: String,
}

#[derive(Deserialize)]
pub(super) struct MergeRequestRef {
    pub iid: String,
}

#[derive(Deserialize)]
pub(super) struct JobsData {
    #[serde(default)]
    pub project: Option<JobsProject>,
}

#[derive(Deserialize)]
pub(super) struct JobsProject {
    #[serde(default)]
    pub pipeline: Option<JobsPipeline>,
}

#[derive(Deserialize)]
pub(super) struct JobsPipeline {
    #[serde(default)]
    pub jobs: Option<Connection<Job>>,
}

#[derive(Deserialize)]
pub(super) struct Job {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub stage: Option<Stage>,
    #[serde(rename = "allowFailure", default)]
    pub allow_failure: bool,
    #[serde(default)]
    pub retried: bool,
    #[serde(rename = "startedAt", default)]
    pub started_at: Option<String>,
    #[serde(rename = "finishedAt", default)]
    pub finished_at: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct Stage {
    pub name: String,
}

/// `REST GET /projects/:id/pipelines/:id`: what turns the run id the sync
/// holds into the iid GraphQL asks by.
#[derive(Deserialize)]
pub(super) struct PipelineIid {
    pub iid: i64,
}

/// The numeric tail of a global id: `gid://gitlab/Ci::Pipeline/123` → 123.
pub(super) fn gid_tail(gid: &str) -> Option<i64> {
    gid.rsplit('/').next()?.parse().ok()
}

/// A GitLab status as Studio's run vocabulary (GitHub's): a status, and for
/// a finished one its conclusion.
pub(super) fn status_of(status: Option<&str>) -> (Option<String>, Option<String>) {
    let Some(status) = status else {
        return (None, None);
    };
    let (status, conclusion) = match status.to_ascii_uppercase().as_str() {
        "SUCCESS" => ("completed", Some("success")),
        "FAILED" => ("completed", Some("failure")),
        "CANCELED" => ("completed", Some("cancelled")),
        "SKIPPED" => ("completed", Some("skipped")),
        "RUNNING" | "CANCELING" => ("in_progress", None),
        // A manual job, or a pipeline stopped at one, waits for a person.
        "MANUAL" => ("waiting", None),
        _ => ("queued", None),
    };
    (Some(status.into()), conclusion.map(str::to_owned))
}

/// What started a pipeline, in the words the GitHub runs use where there is
/// one: a merge request pipeline is `pull_request`, one started by hand or
/// through the API is `workflow_dispatch`.
fn event_of(source: &str) -> String {
    match source {
        "merge_request_event" | "external_pull_request_event" => "pull_request".into(),
        "web" | "api" | "trigger" => "workflow_dispatch".into(),
        other => other.to_owned(),
    }
}

impl Pipeline {
    /// `root` and `project` make the pipeline's page.
    pub fn into_run(self, root: &str, project: &str) -> Option<RemoteWorkflowRun> {
        let id = gid_tail(&self.id)?;
        let (status, conclusion) = status_of(self.status.as_deref());
        let iid = self.iid.as_deref().and_then(|i| i.parse::<i64>().ok());
        let title = match (&self.merge_request, &self.git_ref) {
            (Some(mr), _) => Some(format!("Merge request !{}", mr.iid)),
            (None, Some(r)) => Some(r.clone()),
            (None, None) => None,
        };
        Some(RemoteWorkflowRun {
            id,
            workflow: "GitLab CI".into(),
            workflow_path: Some(".gitlab-ci.yml".into()),
            title,
            event: self.source.as_deref().map(event_of),
            branch: self.git_ref,
            sha: self.sha.unwrap_or_default(),
            status,
            conclusion,
            actor: self.user.map(|u| u.username),
            url: Some(format!("{root}/{project}/-/pipelines/{id}")),
            run_number: iid,
            attempt: None,
            created_at: self.created_at,
            started_at: self.started_at,
            updated_at: self.updated_at,
        })
    }
}

impl Job {
    /// `None` for a retried job: the run's latest attempt is the one kept.
    pub fn into_job(self, root: &str, project: &str) -> Option<RemoteWorkflowJob> {
        if self.retried {
            return None;
        }
        let id = gid_tail(&self.id)?;
        let (status, mut conclusion) = status_of(self.status.as_deref());
        // A job allowed to fail did not fail its pipeline.
        if self.allow_failure && conclusion.as_deref() == Some("failure") {
            conclusion = Some("neutral".into());
        }
        // GitLab jobs have no steps; the stage is the nearest thing to "where".
        let failed_step = match conclusion.as_deref() {
            Some("failure") => self.stage.map(|s| s.name),
            _ => None,
        };
        Some(RemoteWorkflowJob {
            id,
            name: self.name.unwrap_or_else(|| format!("job {id}")),
            status,
            conclusion,
            failed_step,
            started_at: self.started_at,
            completed_at: self.finished_at,
            url: Some(format!("{root}/{project}/-/jobs/{id}")),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_global_id_is_its_numeric_tail() {
        assert_eq!(gid_tail("gid://gitlab/Ci::Pipeline/123"), Some(123));
        assert_eq!(gid_tail("gid://gitlab/Ci::Bridge/7"), Some(7));
        assert_eq!(gid_tail("nope"), None);
    }

    #[test]
    fn statuses_read_as_runs_do() {
        let s = |x| status_of(Some(x));
        assert_eq!(
            s("SUCCESS"),
            (Some("completed".into()), Some("success".into()))
        );
        assert_eq!(
            s("failed"),
            (Some("completed".into()), Some("failure".into()))
        );
        assert_eq!(
            s("CANCELED"),
            (Some("completed".into()), Some("cancelled".into()))
        );
        assert_eq!(s("RUNNING"), (Some("in_progress".into()), None));
        assert_eq!(s("MANUAL"), (Some("waiting".into()), None));
        assert_eq!(s("WAITING_FOR_RESOURCE"), (Some("queued".into()), None));
        assert_eq!(status_of(None), (None, None));
    }
}
