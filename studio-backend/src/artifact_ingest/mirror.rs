//! A repository's metadata from the GitHub Mirror gear, in-process (#1095,
//! track 1).
//!
//! A connection marked `platform_auth` reads its issues, pull requests,
//! comments, commits, workflow runs, build outputs and releases from the
//! mirror instead of from github.com. The mirror runs in this process, so the
//! sync calls it directly: no loopback HTTP, no platform token. Every call is
//! made as the sync's own service identity ([`MIRROR_SYNC_SUBJECT_ID`]) in the
//! run's tenant, the organization's tenant the sync writes the graph in, so
//! the mirror reads (and refreshes) that tenant's copy of the repository, and
//! the Studio PDP can tell the sync from a person (#1094).
//!
//! Two halves, because the mirror publishes two things:
//!
//! - **The SDK client** (`GithubMirrorClientV1`, the gear's `LocalClient`)
//!   brings the tenant's copy up to date with `sync_repository` before the
//!   reads. Its surface stops there: the SDK has no reads yet.
//! - **The reads** ([`MirrorReads`]) go to the mirror's domain service, which
//!   the gear registers in the ClientHub beside its client. They return the
//!   SDK's own models. When the SDK grows list methods, [`MirrorReads`] is
//!   the one seam to move onto them.
//!
//! What a read returns is mapped here onto the connector driver's types,
//! field for field as the GitHub driver read the mirror's GitHub-shaped JSON
//! before, so the graph a sync writes does not change with the transport.
//! Everything outside metadata (the clone, the file listing, downloads,
//! review threads) still goes to the provider with the connection's key.

use std::sync::Arc;

use anyhow::anyhow;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use github_mirror_sdk as sdk;
use github_mirror_sdk::GithubMirrorClientV1;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use crate::connectors::sdk::{
    ConnectionAuth, ConnectorDriver, RemoteBuildArtifact, RemoteComment, RemoteCommit, RemoteIssue,
    RemotePullRequest, RemoteRelease, RemoteReleaseAsset, RemoteWorkflow, RemoteWorkflowJob,
    RemoteWorkflowRun,
};
use crate::tasks::sdk::SyncReporter;

/// The listing GitHub (and the mirror) caps a page at.
const MAX_PER_PAGE: u32 = 100;

/// How many pages of a pull request's files the driver walks; the mirror
/// path walks as many.
const PR_FILE_PAGES: u32 = 10;

/// The mirror's reads, one page at a time, in the caller's tenant.
///
/// `page` is 1-based and `per_page` at most [`MAX_PER_PAGE`], as on GitHub.
#[async_trait]
pub trait MirrorReads: Send + Sync {
    /// Issues and pull requests both, as GitHub's `/issues` lists them;
    /// every state, most recently updated first, updated at or after `since`.
    async fn issues(
        &self,
        ctx: &SecurityContext,
        owner: &str,
        name: &str,
        page: u32,
        per_page: u32,
        since: Option<DateTime<Utc>>,
    ) -> anyhow::Result<Vec<sdk::Issue>>;

    /// Pull requests, every state, most recently updated first.
    async fn pull_requests(
        &self,
        ctx: &SecurityContext,
        owner: &str,
        name: &str,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<sdk::PullRequest>>;

    async fn pull_request_files(
        &self,
        ctx: &SecurityContext,
        owner: &str,
        name: &str,
        number: i64,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<sdk::PullRequestFile>>;

    /// Comments on every issue and pull request, most recently updated
    /// first, updated at or after `since`.
    async fn comments(
        &self,
        ctx: &SecurityContext,
        owner: &str,
        name: &str,
        page: u32,
        per_page: u32,
        since: Option<DateTime<Utc>>,
    ) -> anyhow::Result<Vec<sdk::Comment>>;

    async fn commits(
        &self,
        ctx: &SecurityContext,
        owner: &str,
        name: &str,
        page: u32,
        per_page: u32,
        since: Option<DateTime<Utc>>,
    ) -> anyhow::Result<Vec<sdk::Commit>>;

    async fn workflows(
        &self,
        ctx: &SecurityContext,
        owner: &str,
        name: &str,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<sdk::Workflow>>;

    /// One workflow's runs, or every run of the repository.
    async fn workflow_runs(
        &self,
        ctx: &SecurityContext,
        owner: &str,
        name: &str,
        workflow: Option<i64>,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<sdk::WorkflowRun>>;

    async fn artifacts(
        &self,
        ctx: &SecurityContext,
        owner: &str,
        name: &str,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<sdk::Artifact>>;

    async fn releases(
        &self,
        ctx: &SecurityContext,
        owner: &str,
        name: &str,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<sdk::Release>>;

    async fn workflow_jobs(
        &self,
        ctx: &SecurityContext,
        owner: &str,
        name: &str,
        run_id: i64,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<sdk::WorkflowJob>>;
}

/// The mirror as the sync uses it: its client and its reads.
#[derive(Clone)]
pub struct Mirror {
    pub client: Arc<dyn GithubMirrorClientV1>,
    pub reads: Arc<dyn MirrorReads>,
}

/// The mirror this process links, from the ClientHub: `None` in a build
/// without the `github-mirror` feature or a profile that does not configure
/// the gear. A `platform_auth` sync then fails and says why.
#[cfg(feature = "github-mirror")]
pub(super) fn from_hub(hub: &toolkit::client_hub::ClientHub) -> Option<Mirror> {
    let client = hub.get::<dyn GithubMirrorClientV1>().ok()?;
    let service = hub.get::<github_mirror::domain::service::Service>().ok()?;
    Some(Mirror {
        client,
        reads: Arc::new(linked::ServiceReads(service)),
    })
}

#[cfg(not(feature = "github-mirror"))]
pub(super) fn from_hub(_hub: &toolkit::client_hub::ClientHub) -> Option<Mirror> {
    None
}

/// Why a `platform_auth` sync cannot run here.
pub(super) const NOT_LINKED: &str = "the connection reads through the GitHub mirror, but this \
     backend has no GitHub Mirror gear (built without the `github-mirror` feature, or the \
     profile does not configure `github-mirror`)";

/// Where a sync reads its metadata from: the provider with the connection's
/// key, or the mirror in the run's tenant. Same calls, same results.
pub(super) enum Metadata<'a> {
    Provider {
        driver: &'a dyn ConnectorDriver,
        auth: &'a ConnectionAuth,
    },
    Mirror(MirrorRepo<'a>),
}

/// The subject the artifact sync is to the GitHub mirror.
///
/// One fixed service identity, so the Studio PDP can tell the sync from a
/// person by id alone (#1094): no client-credentials exchange, no token, and
/// nothing a person's sign-in could ever resolve to. Every mirror call of a
/// sync is made as this subject, in the run's tenant ([`mirror_context`]).
pub const MIRROR_SYNC_SUBJECT_ID: Uuid = Uuid::from_u128(0x9f1d_7c22_4e0b_4a8f_b3c5_6a17_e2d4_51a0);

/// The subject type a service carries (`s2s_oauth.default_subject_type` in
/// every profile), which the PDP checks beside the id.
pub const SERVICE_SUBJECT_TYPE: &str = "gts.cf.core.security.subject_service.v1~";

/// The context a sync calls the mirror with: [`MIRROR_SYNC_SUBJECT_ID`] in
/// `tenant`, the organization's tenant the run writes the graph in.
///
/// Its own identity rather than the task worker's: the worker is every
/// `studio-tasks` run, and only this one may reach the mirror. The scopes are
/// the worker's (`*`), so the mirror's PEP sees what it saw before; the
/// tenant clamp stays the outer bound.
pub(super) fn mirror_context(tenant: Uuid) -> anyhow::Result<SecurityContext> {
    SecurityContext::builder()
        .subject_id(MIRROR_SYNC_SUBJECT_ID)
        .subject_type(SERVICE_SUBJECT_TYPE)
        .subject_tenant_id(tenant)
        .token_scopes(vec!["*".to_owned()])
        .build()
        .map_err(|e| anyhow!("studio-artifact-ingest: cannot build the mirror context: {e}"))
}

/// One repository in the mirror, read as the sync in one tenant.
pub(super) struct MirrorRepo<'a> {
    mirror: &'a Mirror,
    ctx: SecurityContext,
    owner: &'a str,
    name: &'a str,
}

impl<'a> MirrorRepo<'a> {
    /// `run` is the run's own context; the mirror is called in its tenant,
    /// as the sync ([`mirror_context`]).
    pub(super) fn new(
        mirror: &'a Mirror,
        run: &SecurityContext,
        repo_full_path: &'a str,
    ) -> anyhow::Result<Self> {
        let (owner, name) = split_repo(repo_full_path)?;
        Ok(Self {
            mirror,
            ctx: mirror_context(run.subject_tenant_id())?,
            owner,
            name,
        })
    }

    /// Bring the tenant's copy up to date through the SDK. Best-effort: a
    /// refresh that fails (a sync of it already running, GitHub refusing the
    /// mirror's key) leaves what was mirrored before, and the reads say so if
    /// that is nothing.
    pub(super) async fn refresh(&self, progress: &SyncReporter) {
        progress.set("bringing the GitHub mirror up to date…");
        match self
            .mirror
            .client
            .sync_repository(&self.ctx, self.owner, self.name)
            .await
        {
            Ok(summary) => tracing::info!(
                repo = %summary.repository,
                issues = summary.issues_synced,
                pull_requests = summary.pull_requests_synced,
                commits = summary.commits_synced,
                "studio-artifact-ingest: the GitHub mirror is up to date"
            ),
            Err(e) => tracing::warn!(
                owner = self.owner,
                name = self.name,
                error = %e,
                "studio-artifact-ingest: the GitHub mirror could not refresh the repository; \
                 reading what it holds"
            ),
        }
    }
}

fn split_repo(repo_full_path: &str) -> anyhow::Result<(&str, &str)> {
    match repo_full_path.trim_matches('/').split_once('/') {
        Some((owner, name)) if !owner.is_empty() && !name.is_empty() && !name.contains('/') => {
            Ok((owner, name))
        }
        _ => Err(anyhow!(
            "`{repo_full_path}` is not an owner/name GitHub repository, which is all the GitHub \
             mirror holds"
        )),
    }
}

fn since_of(since: Option<&str>) -> anyhow::Result<Option<DateTime<Utc>>> {
    since
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|raw| {
            DateTime::parse_from_rfc3339(raw)
                .map(|at| at.with_timezone(&Utc))
                .map_err(|e| anyhow!("`{raw}` is not an RFC 3339 timestamp: {e}"))
        })
        .transpose()
}

fn page_args(page: u32, per_page: u32) -> (u32, u32) {
    (page.max(1), per_page.clamp(1, MAX_PER_PAGE))
}

impl Metadata<'_> {
    pub(super) async fn list_issues(
        &self,
        repo_full_path: &str,
        since: Option<&str>,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<RemoteIssue>> {
        match self {
            Self::Provider { driver, auth } => {
                driver
                    .list_issues(auth, repo_full_path, since, page, per_page)
                    .await
            }
            Self::Mirror(m) => {
                let (page, per_page) = page_args(page, per_page);
                let items = m
                    .mirror
                    .reads
                    .issues(&m.ctx, m.owner, m.name, page, per_page, since_of(since)?)
                    .await?;
                Ok(items.into_iter().filter_map(issue).collect())
            }
        }
    }

    pub(super) async fn list_pull_requests(
        &self,
        repo_full_path: &str,
        since: Option<&str>,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<RemotePullRequest>> {
        match self {
            Self::Provider { driver, auth } => {
                driver
                    .list_pull_requests(auth, repo_full_path, since, page, per_page)
                    .await
            }
            // No `since`, as on GitHub: the caller stops once it walks past
            // its cursor.
            Self::Mirror(m) => {
                let (page, per_page) = page_args(page, per_page);
                let items = m
                    .mirror
                    .reads
                    .pull_requests(&m.ctx, m.owner, m.name, page, per_page)
                    .await?;
                Ok(items.into_iter().map(pull_request).collect())
            }
        }
    }

    pub(super) async fn pull_request_files(
        &self,
        repo_full_path: &str,
        number: i64,
    ) -> anyhow::Result<Vec<String>> {
        match self {
            Self::Provider { driver, auth } => {
                driver
                    .pull_request_files(auth, repo_full_path, number)
                    .await
            }
            // Paged and best-effort like the driver: a page that fails ends
            // the walk with what came before it.
            Self::Mirror(m) => {
                let mut out = Vec::new();
                for page in 1..=PR_FILE_PAGES {
                    let Ok(files) = m
                        .mirror
                        .reads
                        .pull_request_files(&m.ctx, m.owner, m.name, number, page, MAX_PER_PAGE)
                        .await
                    else {
                        break;
                    };
                    let n = files.len();
                    out.extend(files.into_iter().map(|f| f.filename));
                    if n < MAX_PER_PAGE as usize {
                        break;
                    }
                }
                Ok(out)
            }
        }
    }

    pub(super) async fn list_comments(
        &self,
        repo_full_path: &str,
        since: Option<&str>,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<RemoteComment>> {
        match self {
            Self::Provider { driver, auth } => {
                driver
                    .list_comments(auth, repo_full_path, since, page, per_page)
                    .await
            }
            Self::Mirror(m) => {
                let (page, per_page) = page_args(page, per_page);
                let items = m
                    .mirror
                    .reads
                    .comments(&m.ctx, m.owner, m.name, page, per_page, since_of(since)?)
                    .await?;
                Ok(items.into_iter().map(comment).collect())
            }
        }
    }

    pub(super) async fn list_commits(
        &self,
        repo_full_path: &str,
        since: Option<&str>,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<RemoteCommit>> {
        match self {
            Self::Provider { driver, auth } => {
                driver
                    .list_commits(auth, repo_full_path, since, page, per_page)
                    .await
            }
            Self::Mirror(m) => {
                let (page, per_page) = page_args(page, per_page);
                let items = m
                    .mirror
                    .reads
                    .commits(&m.ctx, m.owner, m.name, page, per_page, since_of(since)?)
                    .await?;
                Ok(items
                    .into_iter()
                    .map(|c| commit(c, m.owner, m.name))
                    .collect())
            }
        }
    }

    pub(super) async fn list_workflows(
        &self,
        repo_full_path: &str,
    ) -> anyhow::Result<Vec<RemoteWorkflow>> {
        match self {
            Self::Provider { driver, auth } => driver.list_workflows(auth, repo_full_path).await,
            // One page of 100, as the driver asks GitHub for.
            Self::Mirror(m) => {
                let items = m
                    .mirror
                    .reads
                    .workflows(&m.ctx, m.owner, m.name, 1, MAX_PER_PAGE)
                    .await?;
                Ok(items
                    .into_iter()
                    .map(|w| RemoteWorkflow {
                        id: w.id,
                        state: Some(w.state),
                    })
                    .collect())
            }
        }
    }

    pub(super) async fn list_workflow_runs(
        &self,
        repo_full_path: &str,
        workflow: Option<i64>,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<RemoteWorkflowRun>> {
        match self {
            Self::Provider { driver, auth } => {
                driver
                    .list_workflow_runs(auth, repo_full_path, workflow, page, per_page)
                    .await
            }
            Self::Mirror(m) => {
                let (page, per_page) = page_args(page, per_page);
                let items = m
                    .mirror
                    .reads
                    .workflow_runs(&m.ctx, m.owner, m.name, workflow, page, per_page)
                    .await?;
                Ok(items.into_iter().map(workflow_run).collect())
            }
        }
    }

    pub(super) async fn list_build_artifacts(
        &self,
        repo_full_path: &str,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<RemoteBuildArtifact>> {
        match self {
            Self::Provider { driver, auth } => {
                driver
                    .list_build_artifacts(auth, repo_full_path, page, per_page)
                    .await
            }
            Self::Mirror(m) => {
                let (page, per_page) = page_args(page, per_page);
                let items = m
                    .mirror
                    .reads
                    .artifacts(&m.ctx, m.owner, m.name, page, per_page)
                    .await?;
                let now = Utc::now();
                Ok(items.into_iter().map(|a| artifact(a, now)).collect())
            }
        }
    }

    pub(super) async fn list_releases(
        &self,
        repo_full_path: &str,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<RemoteRelease>> {
        match self {
            Self::Provider { driver, auth } => {
                driver
                    .list_releases(auth, repo_full_path, page, per_page)
                    .await
            }
            Self::Mirror(m) => {
                let (page, per_page) = page_args(page, per_page);
                let items = m
                    .mirror
                    .reads
                    .releases(&m.ctx, m.owner, m.name, page, per_page)
                    .await?;
                Ok(items.into_iter().map(release).collect())
            }
        }
    }

    pub(super) async fn list_workflow_jobs(
        &self,
        repo_full_path: &str,
        run_id: i64,
    ) -> anyhow::Result<Vec<RemoteWorkflowJob>> {
        match self {
            Self::Provider { driver, auth } => {
                driver
                    .list_workflow_jobs(auth, repo_full_path, run_id)
                    .await
            }
            // One page of 100, as the driver asks GitHub for.
            Self::Mirror(m) => {
                let items = m
                    .mirror
                    .reads
                    .workflow_jobs(&m.ctx, m.owner, m.name, run_id, 1, MAX_PER_PAGE)
                    .await?;
                Ok(items.into_iter().map(workflow_job).collect())
            }
        }
    }
}

/* ── From the mirror's models to the driver's ──
 *
 * Each one gives what the GitHub driver made of the mirror's GitHub-shaped
 * answer for the same row: the mirror's DTO and then the driver's parser,
 * collapsed into one step.
 */

/// The author's login: the stored `user` object, else the bare login rows
/// mirrored before it carried one.
fn author_of(author: Option<sdk::Actor>, login: Option<String>) -> Option<String> {
    author.map(|a| a.login).or(login)
}

/// An issue, or `None` for a pull request: GitHub's `/issues` lists both,
/// and the sync reads pull requests from their own listing.
fn issue(i: sdk::Issue) -> Option<RemoteIssue> {
    if i.is_pull_request {
        return None;
    }
    Some(RemoteIssue {
        id: i.id.to_string(),
        number: i.number,
        title: i.title,
        state: i.state,
        author: author_of(i.author, i.author_login),
        body: i.body,
        url: i.html_url,
        created_at: Some(i.created_at),
        updated_at: Some(i.updated_at),
        labels: i.labels.into_iter().map(|l| l.name).collect(),
        // The mirror keeps neither an issue's parent nor its milestone.
        parent: None,
        iteration: None,
    })
}

fn pull_request(p: sdk::PullRequest) -> RemotePullRequest {
    let merged = p.merged_at.is_some();
    RemotePullRequest {
        id: p.id.to_string(),
        number: p.number,
        title: p.title,
        state: if merged { "merged".to_owned() } else { p.state },
        author: author_of(p.author, p.author_login),
        body: p.body,
        url: p.html_url,
        source_branch: p.head_ref,
        target_branch: p.base_ref,
        merged,
        created_at: Some(p.created_at),
        updated_at: Some(p.updated_at),
        draft: Some(p.draft),
        requested_reviewers: p.requested_reviewers.into_iter().map(|a| a.login).collect(),
        // The mirror keeps neither requested teams nor the merge commit.
        requested_teams: Vec::new(),
        assignees: p.assignees.into_iter().map(|a| a.login).collect(),
        head_sha: p.head_sha,
        merge_sha: None,
    }
}

fn comment(c: sdk::Comment) -> RemoteComment {
    RemoteComment {
        id: c.id.to_string(),
        target_number: c.issue_number,
        author: c.author_login,
        body: c.body,
        url: c.html_url,
        created_at: Some(c.created_at),
        updated_at: Some(c.updated_at),
    }
}

fn commit(c: sdk::Commit, owner: &str, name: &str) -> RemoteCommit {
    let url = c
        .html_url
        .unwrap_or_else(|| format!("https://github.com/{owner}/{name}/commit/{}", c.sha));
    RemoteCommit {
        sha: c.sha,
        message: Some(c.message),
        author: c.author_login,
        // The mirror keeps the author's account, not the name in the commit.
        author_name: None,
        url: Some(url),
        created_at: c.authored_at,
        committed_at: c.committed_at,
    }
}

fn workflow_run(r: sdk::WorkflowRun) -> RemoteWorkflowRun {
    RemoteWorkflowRun {
        id: r.id,
        workflow: r.name.unwrap_or_default(),
        // The mirror keeps neither the workflow's file nor the run's title
        // and start on the run.
        workflow_path: None,
        title: None,
        event: Some(r.event),
        branch: r.head_branch,
        sha: r.head_sha,
        status: r.status,
        conclusion: r.conclusion,
        actor: r.actor_login,
        url: r.html_url,
        run_number: Some(r.run_number),
        attempt: Some(r.run_attempt),
        created_at: Some(r.created_at),
        started_at: None,
        updated_at: Some(r.updated_at),
    }
}

/// An artifact past its expiry is expired, whatever the last sync saw.
fn artifact(a: sdk::Artifact, now: DateTime<Utc>) -> RemoteBuildArtifact {
    let expired = a.expired
        || a.expires_at
            .as_deref()
            .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
            .is_some_and(|at| at <= now);
    // The run's branch and commit ride on the run reference, so without a
    // run there are none, as in GitHub's shape.
    let run = a.workflow_run_id;
    RemoteBuildArtifact {
        id: a.id,
        name: a.name,
        size_in_bytes: Some(a.size_in_bytes),
        expired,
        created_at: a.created_at,
        expires_at: a.expires_at,
        run_id: run,
        branch: run.and(a.head_branch),
        sha: run.and(a.head_sha),
    }
}

fn release(r: sdk::Release) -> RemoteRelease {
    RemoteRelease {
        id: r.id,
        tag: r.tag_name,
        name: r.name.filter(|n| !n.trim().is_empty()),
        draft: r.draft,
        prerelease: r.prerelease,
        url: r.html_url,
        created_at: Some(r.created_at),
        published_at: r.published_at,
        // An asset without an id cannot be downloaded by it; the driver
        // refused the whole page over one, this leaves just that asset out.
        assets: r
            .assets
            .into_iter()
            .filter_map(|a| {
                Some(RemoteReleaseAsset {
                    id: a.id?,
                    name: a.name,
                    size: a.size,
                    content_type: a.content_type,
                    download_count: a.download_count,
                })
            })
            .collect(),
    }
}

/// A job, and the first of its steps that failed, by step number.
fn workflow_job(j: sdk::WorkflowJob) -> RemoteWorkflowJob {
    let mut steps = j.steps;
    steps.sort_by_key(|s| s.number);
    let failed_step = steps
        .into_iter()
        .find(|s| s.conclusion.as_deref() == Some("failure"))
        .map(|s| s.name);
    RemoteWorkflowJob {
        id: j.id,
        name: j.name,
        status: j.status,
        conclusion: j.conclusion,
        failed_step,
        started_at: j.started_at,
        completed_at: j.completed_at,
        url: j.html_url,
    }
}

/// The reads, on the mirror's domain service.
#[cfg(feature = "github-mirror")]
mod linked {
    use std::sync::Arc;

    use anyhow::anyhow;
    use async_trait::async_trait;
    use chrono::{DateTime, Utc};
    use github_mirror::domain::error::DomainError;
    use github_mirror::domain::repo::{ListingDirection, ListingFilter, ListingSort, PageWindow};
    use github_mirror::domain::service::Service;
    use github_mirror_sdk as sdk;
    use toolkit_security::SecurityContext;

    use super::MirrorReads;

    pub(super) struct ServiceReads(pub(super) Arc<Service>);

    fn window(page: u32, per_page: u32) -> anyhow::Result<PageWindow> {
        let per_page = u64::from(per_page);
        let offset = u64::from(page.saturating_sub(1)).saturating_mul(per_page);
        PageWindow::bounded(per_page, offset).map_err(failed)
    }

    /// Every state, most recently updated first: what the driver asks
    /// GitHub for.
    fn updated_first(since: Option<DateTime<Utc>>) -> ListingFilter {
        ListingFilter {
            state: None,
            sort: ListingSort::Updated,
            direction: ListingDirection::Desc,
            since,
        }
    }

    fn failed(e: DomainError) -> anyhow::Error {
        anyhow!("the GitHub mirror: {e}")
    }

    #[async_trait]
    impl MirrorReads for ServiceReads {
        async fn issues(
            &self,
            ctx: &SecurityContext,
            owner: &str,
            name: &str,
            page: u32,
            per_page: u32,
            since: Option<DateTime<Utc>>,
        ) -> anyhow::Result<Vec<sdk::Issue>> {
            let (items, _) = self
                .0
                .list_issues(
                    ctx,
                    owner,
                    name,
                    window(page, per_page)?,
                    updated_first(since),
                )
                .await
                .map_err(failed)?;
            Ok(items.items)
        }

        async fn pull_requests(
            &self,
            ctx: &SecurityContext,
            owner: &str,
            name: &str,
            page: u32,
            per_page: u32,
        ) -> anyhow::Result<Vec<sdk::PullRequest>> {
            let (items, _) = self
                .0
                .list_pull_requests(
                    ctx,
                    owner,
                    name,
                    window(page, per_page)?,
                    updated_first(None),
                )
                .await
                .map_err(failed)?;
            Ok(items.items)
        }

        async fn pull_request_files(
            &self,
            ctx: &SecurityContext,
            owner: &str,
            name: &str,
            number: i64,
            page: u32,
            per_page: u32,
        ) -> anyhow::Result<Vec<sdk::PullRequestFile>> {
            Ok(self
                .0
                .list_pull_request_files(ctx, owner, name, number, window(page, per_page)?)
                .await
                .map_err(failed)?
                .items)
        }

        async fn comments(
            &self,
            ctx: &SecurityContext,
            owner: &str,
            name: &str,
            page: u32,
            per_page: u32,
            since: Option<DateTime<Utc>>,
        ) -> anyhow::Result<Vec<sdk::Comment>> {
            Ok(self
                .0
                .list_repo_comments(
                    ctx,
                    owner,
                    name,
                    window(page, per_page)?,
                    updated_first(since),
                )
                .await
                .map_err(failed)?
                .items)
        }

        async fn commits(
            &self,
            ctx: &SecurityContext,
            owner: &str,
            name: &str,
            page: u32,
            per_page: u32,
            since: Option<DateTime<Utc>>,
        ) -> anyhow::Result<Vec<sdk::Commit>> {
            let (items, _) = self
                .0
                .list_commits(ctx, owner, name, window(page, per_page)?, since)
                .await
                .map_err(failed)?;
            Ok(items.items)
        }

        async fn workflows(
            &self,
            ctx: &SecurityContext,
            owner: &str,
            name: &str,
            page: u32,
            per_page: u32,
        ) -> anyhow::Result<Vec<sdk::Workflow>> {
            let (items, _) = self
                .0
                .list_workflows(ctx, owner, name, window(page, per_page)?)
                .await
                .map_err(failed)?;
            Ok(items.items)
        }

        async fn workflow_runs(
            &self,
            ctx: &SecurityContext,
            owner: &str,
            name: &str,
            workflow: Option<i64>,
            page: u32,
            per_page: u32,
        ) -> anyhow::Result<Vec<sdk::WorkflowRun>> {
            let window = window(page, per_page)?;
            let (items, _) = match workflow {
                Some(id) => {
                    self.0
                        .list_workflow_runs_of_workflow(ctx, owner, name, &id.to_string(), window)
                        .await
                }
                None => self.0.list_workflow_runs(ctx, owner, name, window).await,
            }
            .map_err(failed)?;
            Ok(items.items)
        }

        async fn artifacts(
            &self,
            ctx: &SecurityContext,
            owner: &str,
            name: &str,
            page: u32,
            per_page: u32,
        ) -> anyhow::Result<Vec<sdk::Artifact>> {
            let (items, _) = self
                .0
                .list_artifacts(ctx, owner, name, window(page, per_page)?)
                .await
                .map_err(failed)?;
            Ok(items.items)
        }

        async fn releases(
            &self,
            ctx: &SecurityContext,
            owner: &str,
            name: &str,
            page: u32,
            per_page: u32,
        ) -> anyhow::Result<Vec<sdk::Release>> {
            Ok(self
                .0
                .list_releases(ctx, owner, name, window(page, per_page)?)
                .await
                .map_err(failed)?
                .items)
        }

        async fn workflow_jobs(
            &self,
            ctx: &SecurityContext,
            owner: &str,
            name: &str,
            run_id: i64,
            page: u32,
            per_page: u32,
        ) -> anyhow::Result<Vec<sdk::WorkflowJob>> {
            let (items, _) = self
                .0
                .list_workflow_jobs(ctx, owner, name, run_id, window(page, per_page)?)
                .await
                .map_err(failed)?;
            Ok(items.items)
        }
    }
}

#[cfg(test)]
#[path = "mirror_tests.rs"]
mod tests;
