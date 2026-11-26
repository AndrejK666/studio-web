//! GitLab driver (gitlab.com and self-hosted installations).
//!
//! Reads what the artifact graph, the server-side clones and the people view
//! need, through the same trait the GitHub driver implements, so every
//! consumer works for GitLab unchanged. GitLab's quirks -- how it pages, how
//! it throttles, which refusals are fatal, which fields were renamed between
//! versions -- follow Insight's GitLab connector, which met them first; see
//! [`client`] for the transport rules.
//!
//! The token is a personal, group or project access token with `read_api` and
//! `read_repository` to read, and `api` (which includes `write_repository`) to
//! publish: commits, files, branches, tags, merge requests, issues, commit
//! statuses and pipelines ([`write`]).

mod ci;
mod client;
mod model;
mod outputs;
mod reviews;
mod write;

#[cfg(test)]
mod mock;
#[cfg(test)]
mod tests;

use async_trait::async_trait;
use futures_util::{StreamExt, TryStreamExt, stream};

use super::driver::{
    CommitStatus, ConnectionAuth, ConnectorCategory, ConnectorDriver, Contributor, CreatedIssue,
    CreatedRepository, DownloadTarget, DriverIdentity, FileToWrite, OpenedPullRequest,
    PullRequestThreads, RemoteBuildArtifact, RemoteComment, RemoteCommit, RemoteFile,
    RemoteFileList, RemoteFileText, RemoteIssue, RemotePullRequest, RemoteRelease, RemoteRepo,
    RemoteWorkflowJob, RemoteWorkflowRun, RepoTree, RepoTreeEntry, WrittenFile,
};
use super::references::ReferenceSyntax;
use client::{Api, Family, Gate, Retry, encode, is_item_refusal};
use model::{
    Approvals, Branch, Changes, Commit, Diff, Discussion, Issue, MergeRequest, Note, Project, Tag,
    TreeItem, User, noreply_username,
};
use reviews::ReviewState;

/// Pages one walk of a listing the sync reads whole -- a repository's tree, a
/// merge request's changed files, an item's notes -- follows before it calls
/// the listing endless. A runaway bound, not a limit: 100 entries a page is
/// ten million entries, which no repository has, and a walk that gets there
/// is logged as an error. Lower bounds here used to cut a large repository
/// short without a word (a tree at 20,000 entries, an item at 1,000 notes).
const ALL_PAGES: u32 = 100_000;

/// Pages of jobs (100 each, newest first) searched for artifact archives.
const JOB_PAGES: u32 = 5;

/// Pages of the repository listing walked to fill one `limit`.
const MAX_REPO_PAGES: u32 = 20;

/// Reads about single merge requests (their files, their discussions) kept
/// in flight at once. A large project has thousands of merge requests and
/// one round trip each; strictly one after another, 2,356 of them did not
/// fit in a sync's fifteen minutes. Six stays well inside GitLab.com's
/// per-user limits (2,000 requests a minute for the API), and a throttle any
/// of them meets holds all of them ([`client::Gate`]).
const ITEM_READS: usize = 6;

pub struct GitLabDriver {
    http: reqwest::Client,
    retry: Retry,
    gate: Gate,
}

impl GitLabDriver {
    pub fn new(http: reqwest::Client) -> Self {
        Self {
            http,
            retry: Retry::default(),
            gate: Gate::default(),
        }
    }

    /// The same driver with another retry policy: tests wait milliseconds,
    /// not seconds.
    #[cfg(test)]
    pub(crate) fn with_retry(http: reqwest::Client, retry: Retry) -> Self {
        Self {
            http,
            retry,
            gate: Gate::default(),
        }
    }

    fn api<'a>(&'a self, auth: &'a ConnectionAuth) -> Api<'a> {
        Api::new(&self.http, &self.retry, &self.gate, auth)
    }

    /// The ref to read at: the caller's, or the project's default branch.
    async fn resolve_ref(
        &self,
        api: &Api<'_>,
        repo_full_path: &str,
        git_ref: Option<&str>,
    ) -> anyhow::Result<String> {
        match git_ref.map(str::trim).filter(|r| !r.is_empty()) {
            Some(r) => Ok(r.to_owned()),
            None => {
                let project: Project = api.get(&api.project(repo_full_path, "")).await?;
                Ok(project.default_branch.unwrap_or_else(|| "main".into()))
            }
        }
    }

    /// The whole recursive tree at `git_ref`, keyset-paged where the
    /// installation supports it (GitLab follows `Link` either way).
    async fn tree(
        &self,
        api: &Api<'_>,
        repo_full_path: &str,
        git_ref: &str,
    ) -> anyhow::Result<(Vec<TreeItem>, bool)> {
        let url = api.project(
            repo_full_path,
            &format!(
                "/repository/tree?recursive=true&per_page=100&pagination=keyset&ref={}",
                encode(git_ref)
            ),
        );
        let (items, truncated) = api.walk::<TreeItem>(&url, Family::Scope, ALL_PAGES).await?;
        if truncated {
            tracing::error!(
                repo = repo_full_path,
                git_ref,
                pages = ALL_PAGES,
                "gitlab: repository tree did not end -- the listing is partial"
            );
        }
        Ok((items, truncated))
    }
}

/// A repository-relative path, refused when it climbs out of the repository.
fn repo_file_path(path: &str) -> anyhow::Result<String> {
    let parts: Vec<&str> = path
        .split('/')
        .filter(|s| !s.is_empty() && *s != ".")
        .collect();
    if parts.is_empty() || parts.contains(&"..") {
        anyhow::bail!("'{path}' is not a path inside the repository");
    }
    Ok(parts.join("/"))
}

#[async_trait]
impl ConnectorDriver for GitLabDriver {
    fn provider(&self) -> &'static str {
        "gitlab"
    }

    fn display_name(&self) -> &'static str {
        "GitLab"
    }

    fn default_base_url(&self) -> &'static str {
        "https://gitlab.com"
    }

    fn category(&self) -> ConnectorCategory {
        ConnectorCategory::SourceCode
    }

    fn credential_hint(&self) -> &'static str {
        "glpat-…"
    }

    fn item_read_concurrency(&self) -> usize {
        ITEM_READS
    }

    async fn test(&self, auth: &ConnectionAuth) -> anyhow::Result<DriverIdentity> {
        let api = self.api(auth);
        let user: User = api.get(&api.v4("user")).await?;
        Ok(DriverIdentity {
            avatar_url: user.avatar_url,
            checks: Vec::new(),
            account: user.username,
            display_name: user.name,
        })
    }

    async fn list_repositories(
        &self,
        auth: &ConnectionAuth,
        search: Option<&str>,
        limit: u32,
    ) -> anyhow::Result<Vec<RemoteRepo>> {
        // `membership=true` keeps the listing to projects the token's owner
        // belongs to -- without it a large instance answers with its whole
        // public catalogue. Most recently active first, which is what a
        // person picking a repository is looking for; the walk follows `Link`
        // until `limit` is held.
        let api = self.api(auth);
        let want = limit.max(1) as usize;
        let mut url = api.v4(&format!(
            "projects?membership=true&order_by=last_activity_at&sort=desc&per_page={}",
            limit.clamp(1, 100)
        ));
        if let Some(q) = search.map(str::trim).filter(|q| !q.is_empty()) {
            url.push_str("&search=");
            url.push_str(&encode(q));
        }
        let mut out: Vec<RemoteRepo> = Vec::new();
        for _ in 0..MAX_REPO_PAGES {
            let Some(page) = api.page::<Project>(&url, Family::Scope).await? else {
                break;
            };
            out.extend(page.items.into_iter().map(Project::into_remote));
            match page.next {
                Some(next) if out.len() < want => url = next,
                _ => break,
            }
        }
        out.truncate(want);
        Ok(out)
    }

    async fn list_files(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        git_ref: Option<&str>,
    ) -> anyhow::Result<RemoteFileList> {
        let api = self.api(auth);
        let git_ref = self.resolve_ref(&api, repo_full_path, git_ref).await?;
        let (items, truncated) = self.tree(&api, repo_full_path, &git_ref).await?;
        Ok(RemoteFileList {
            files: items
                .into_iter()
                .filter(|e| e.kind == "blob" || e.kind == "tree")
                .map(|e| RemoteFile {
                    is_dir: e.kind == "tree",
                    path: e.path,
                    sha: e.id,
                    size: None,
                })
                .collect(),
            truncated,
        })
    }

    fn clone_url(&self, base_url: &str, repo_full_path: &str) -> anyhow::Result<String> {
        // GitLab serves git beside its API on the same root, self-hosted under
        // a path prefix included.
        Ok(format!(
            "{}/{}.git",
            client::instance_root(base_url),
            client::project_path(repo_full_path)
        ))
    }

    /// `oauth2` is the username GitLab documents for a token over HTTPS, and
    /// the one Studio's git proxy already sends.
    fn clone_credentials<'a>(&self, token: &'a str) -> (&'static str, &'a str) {
        ("oauth2", token)
    }

    async fn repo_tree(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        git_ref: Option<&str>,
    ) -> anyhow::Result<RepoTree> {
        let api = self.api(auth);
        let git_ref = self.resolve_ref(&api, repo_full_path, git_ref).await?;
        let (items, truncated) = self.tree(&api, repo_full_path, &git_ref).await?;
        Ok(RepoTree {
            git_ref,
            entries: items
                .into_iter()
                .filter(|e| e.kind == "blob" || e.kind == "tree")
                .map(|e| RepoTreeEntry {
                    is_dir: e.kind == "tree",
                    path: e.path,
                })
                .collect(),
            truncated,
        })
    }

    async fn read_file(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        path: &str,
        git_ref: Option<&str>,
    ) -> anyhow::Result<Option<RemoteFileText>> {
        let path = repo_file_path(path)?;
        let api = self.api(auth);
        let url = raw_file_url(&api, repo_full_path, &path, git_ref);
        let Some((headers, bytes)) = api.get_raw(&url).await? else {
            return Ok(None);
        };
        let text =
            String::from_utf8(bytes).map_err(|_| anyhow::anyhow!("{path} is not a text file"))?;
        Ok(Some(RemoteFileText {
            text,
            sha: headers
                .get("x-gitlab-blob-id")
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned),
        }))
    }

    async fn read_file_bytes(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        path: &str,
        git_ref: Option<&str>,
    ) -> anyhow::Result<Option<Vec<u8>>> {
        let path = repo_file_path(path)?;
        let api = self.api(auth);
        let url = raw_file_url(&api, repo_full_path, &path, git_ref);
        Ok(api.get_raw(&url).await?.map(|(_, bytes)| bytes))
    }

    async fn path_history(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        path: &str,
        git_ref: Option<&str>,
        limit: u32,
    ) -> anyhow::Result<Vec<RemoteCommit>> {
        let api = self.api(auth);
        let mut url = api.project(
            repo_full_path,
            &format!(
                "/repository/commits?path={}&per_page={}",
                encode(path.trim_matches('/')),
                limit.clamp(1, 100)
            ),
        );
        if let Some(r) = git_ref.map(str::trim).filter(|r| !r.is_empty()) {
            url.push_str("&ref_name=");
            url.push_str(&encode(r));
        }
        let commits: Vec<Commit> = api.get(&url).await?;
        Ok(commits.into_iter().map(Commit::into_remote).collect())
    }

    async fn list_tags(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<String>> {
        let api = self.api(auth);
        let url = api.project(
            repo_full_path,
            &format!(
                "/repository/tags?per_page={}&page={}",
                per_page.clamp(1, 100),
                page.max(1)
            ),
        );
        let tags: Vec<Tag> = api.get(&url).await?;
        Ok(tags.into_iter().map(|t| t.name).collect())
    }

    async fn default_branch(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
    ) -> anyhow::Result<String> {
        let api = self.api(auth);
        let project: Project = api.get(&api.project(repo_full_path, "")).await?;
        project.default_branch.ok_or_else(|| {
            anyhow::anyhow!("GitLab project {repo_full_path} has no default branch (it is empty)")
        })
    }

    async fn branch_head(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        branch: &str,
    ) -> anyhow::Result<Option<String>> {
        let api = self.api(auth);
        let url = api.project(
            repo_full_path,
            &format!("/repository/branches/{}", encode(branch)),
        );
        Ok(api.get_opt::<Branch>(&url).await?.map(|b| b.commit.id))
    }

    async fn branches_with_prefix(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        prefix: &str,
    ) -> anyhow::Result<Vec<(String, String)>> {
        // `search=^prefix` anchors GitLab's search at the start; the filter
        // below keeps the answer exact on an installation that reads `^`
        // literally.
        let api = self.api(auth);
        let url = api.project(
            repo_full_path,
            &format!(
                "/repository/branches?per_page=100&search={}",
                encode(&format!("^{prefix}"))
            ),
        );
        let (branches, _) = api.walk::<Branch>(&url, Family::Scope, 20).await?;
        Ok(branches
            .into_iter()
            .filter(|b| b.name.starts_with(prefix))
            .map(|b| (b.name, b.commit.id))
            .collect())
    }

    async fn graphql(
        &self,
        auth: &ConnectionAuth,
        body: &serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        self.api(auth).graphql_raw(body).await
    }

    async fn list_workflow_runs(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        workflow: Option<i64>,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<RemoteWorkflowRun>> {
        // No workflows on GitLab (`list_workflows` lists none), so `workflow`
        // is never one of ours. GraphQL pages by cursor: page N is reached by
        // walking the N-1 before it, which the sync's few pages afford.
        let _ = workflow;
        let api = self.api(auth);
        let project = client::project_path(repo_full_path).to_owned();
        let first = per_page.clamp(1, 100);
        let mut cursor: Option<String> = None;
        for at in 1..=page.max(1) {
            let data: ci::PipelinesData = api
                .graphql(
                    ci::PIPELINES_QUERY,
                    serde_json::json!({ "project": project, "first": first, "cursor": cursor }),
                )
                .await?;
            let Some(pipelines) = data.project.and_then(|p| p.pipelines) else {
                return Ok(Vec::new());
            };
            if at == page.max(1) {
                return Ok(pipelines
                    .nodes
                    .into_iter()
                    .filter_map(|p| p.into_run(api.root(), &project))
                    .collect());
            }
            match pipelines.page_info.end_cursor {
                Some(next) if pipelines.page_info.has_next_page => cursor = Some(next),
                _ => return Ok(Vec::new()),
            }
        }
        Ok(Vec::new())
    }

    async fn list_workflow_jobs(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        run_id: i64,
    ) -> anyhow::Result<Vec<RemoteWorkflowJob>> {
        // The sync holds the pipeline's global id; GraphQL asks by its iid,
        // which one REST call gives. A pipeline gone since is no jobs.
        let api = self.api(auth);
        let project = client::project_path(repo_full_path).to_owned();
        let url = api.project(repo_full_path, &format!("/pipelines/{run_id}"));
        let iid = match api.get::<ci::PipelineIid>(&url).await {
            Ok(p) => p.iid,
            Err(e) if is_item_refusal(&e) => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        let mut out = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..20 {
            let data: ci::JobsData = api
                .graphql(
                    ci::JOBS_QUERY,
                    serde_json::json!({ "project": project, "iid": iid.to_string(), "cursor": cursor }),
                )
                .await?;
            let Some(jobs) = data.project.and_then(|p| p.pipeline).and_then(|p| p.jobs) else {
                break;
            };
            out.extend(
                jobs.nodes
                    .into_iter()
                    .filter_map(|j| j.into_job(api.root(), &project)),
            );
            match jobs.page_info.end_cursor {
                Some(next) if jobs.page_info.has_next_page => cursor = Some(next),
                _ => break,
            }
        }
        Ok(out)
    }

    /* ── Writes (write.rs) ── */

    async fn put_file(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        branch: Option<&str>,
        path: &str,
        content: &str,
        message: &str,
    ) -> anyhow::Result<WrittenFile> {
        self.write_file(auth, repo_full_path, branch, path, content, message)
            .await
    }

    async fn commit_files(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        base_branch: &str,
        branch: &str,
        files: &[FileToWrite],
        message: &str,
    ) -> anyhow::Result<String> {
        self.write_commit(
            auth,
            repo_full_path,
            base_branch,
            branch,
            files,
            &[],
            message,
        )
        .await
    }

    async fn commit_changes(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        base_branch: &str,
        branch: &str,
        files: &[FileToWrite],
        deleted: &[String],
        message: &str,
    ) -> anyhow::Result<String> {
        self.write_commit(
            auth,
            repo_full_path,
            base_branch,
            branch,
            files,
            deleted,
            message,
        )
        .await
    }

    async fn commit_replacing_branch(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        base_branch: &str,
        branch: &str,
        files: &[FileToWrite],
        message: &str,
    ) -> anyhow::Result<String> {
        self.write_replacing_branch(auth, repo_full_path, base_branch, branch, files, message)
            .await
    }

    async fn create_branch(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        branch: &str,
        from_sha: &str,
    ) -> anyhow::Result<()> {
        self.write_branch(auth, repo_full_path, branch, from_sha)
            .await
    }

    async fn create_tag(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        tag: &str,
        sha: &str,
    ) -> anyhow::Result<()> {
        self.write_tag(auth, repo_full_path, tag, sha).await
    }

    async fn open_pull_request(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        head: &str,
        base: &str,
        title: &str,
        body: Option<&str>,
    ) -> anyhow::Result<OpenedPullRequest> {
        self.write_merge_request(auth, repo_full_path, head, base, title, body)
            .await
    }

    fn supports_pull_requests(&self) -> bool {
        true
    }

    async fn find_open_pull_request(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        head: &str,
        base: &str,
    ) -> anyhow::Result<Option<OpenedPullRequest>> {
        self.open_merge_request(auth, repo_full_path, head, base)
            .await
    }

    async fn create_issue(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        title: &str,
        body: &str,
        assignees: &[String],
    ) -> anyhow::Result<CreatedIssue> {
        self.write_issue(auth, repo_full_path, title, body, assignees)
            .await
    }

    async fn set_commit_status(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        sha: &str,
        status: &CommitStatus,
    ) -> anyhow::Result<()> {
        self.write_status(auth, repo_full_path, sha, status).await
    }

    async fn dispatch_workflow(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        workflow: &str,
        git_ref: &str,
    ) -> anyhow::Result<()> {
        self.write_pipeline(auth, repo_full_path, workflow, git_ref)
            .await
    }

    async fn create_repository(
        &self,
        auth: &ConnectionAuth,
        owner: Option<&str>,
        is_org: bool,
        name: &str,
        private: bool,
    ) -> anyhow::Result<CreatedRepository> {
        self.write_project(auth, owner, is_org, name, private).await
    }

    /* ── Outputs (outputs.rs) ── */

    async fn list_releases(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<RemoteRelease>> {
        let api = self.api(auth);
        let url = api.project(
            repo_full_path,
            &format!(
                "/releases?order_by=released_at&sort=desc&per_page={}&page={}",
                per_page.clamp(1, 100),
                page.max(1)
            ),
        );
        // A project with releases turned off has none.
        Ok(api
            .page::<outputs::Release>(&url, Family::Item)
            .await?
            .map(|p| {
                p.items
                    .into_iter()
                    .map(outputs::Release::into_remote)
                    .collect()
            })
            .unwrap_or_default())
    }

    async fn list_build_artifacts(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<RemoteBuildArtifact>> {
        // GitLab cannot list only the jobs that kept an archive, and most do
        // not. A short page would end the caller's walk, so page 1 is every
        // archive among the newest `JOB_PAGES` pages of jobs, and later
        // pages are empty.
        let _ = per_page;
        if page > 1 {
            return Ok(Vec::new());
        }
        let api = self.api(auth);
        let url = api.project(
            repo_full_path,
            "/jobs?scope[]=success&scope[]=failed&per_page=100",
        );
        let (jobs, _) = api
            .walk::<outputs::Job>(&url, Family::Item, JOB_PAGES)
            .await?;
        let now = chrono::Utc::now();
        Ok(jobs
            .into_iter()
            .filter_map(|j| j.into_artifact(now))
            .collect())
    }

    async fn download_link(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        target: DownloadTarget,
    ) -> anyhow::Result<String> {
        let api = self.api(auth);
        match target {
            DownloadTarget::BuildArtifact(job) => {
                let url = api.project(repo_full_path, &format!("/jobs/{job}/artifacts"));
                let res = api.get_unfollowed(&url).await?;
                match res
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                {
                    Some(location) if res.status().is_redirection() => Ok(location.to_owned()),
                    _ => Err(outputs::needs_proxy()),
                }
            }
            DownloadTarget::ReleaseAsset(link) => {
                let target = self.release_link(&api, repo_full_path, link).await?;
                // A file in this project's own package registry needs the
                // token; a link anywhere else is the file's own address.
                if api.same_origin(&target) {
                    Err(outputs::needs_proxy())
                } else {
                    Ok(target)
                }
            }
        }
    }

    async fn download(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        target: DownloadTarget,
    ) -> anyhow::Result<reqwest::Response> {
        let api = self.api(auth);
        let url = match target {
            DownloadTarget::BuildArtifact(job) => {
                api.project(repo_full_path, &format!("/jobs/{job}/artifacts"))
            }
            DownloadTarget::ReleaseAsset(link) => {
                self.release_link(&api, repo_full_path, link).await?
            }
        };
        if !api.same_origin(&url) {
            // Somebody else's address: fetched as anyone would, no token.
            return Ok(reqwest::get(&url).await?.error_for_status()?);
        }
        let res = api.get_unfollowed(&url).await?;
        if res.status().is_redirection() {
            // Object storage's signed link: no token goes with it.
            let location = res
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| anyhow::anyhow!("GitLab redirected the download nowhere"))?
                .to_owned();
            return Ok(reqwest::get(&location).await?.error_for_status()?);
        }
        Ok(res)
    }

    /// GitLab numbers issues (`#5`) and merge requests (`!5`) separately.
    fn reference_syntax(&self) -> ReferenceSyntax {
        ReferenceSyntax::GitLab
    }

    async fn list_issues(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        since: Option<&str>,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<RemoteIssue>> {
        // A project with its issues turned off answers 403 or 404 here. That
        // is about the feature, not the connection: the sync carries on with
        // the merge requests, and a project the token cannot see fails there.
        let api = self.api(auth);
        let url = api.project(
            repo_full_path,
            &listing_query(
                "/issues?scope=all&state=all",
                Order::Created,
                since,
                page,
                per_page,
            ),
        );
        Ok(api
            .page::<Issue>(&url, Family::Item)
            .await?
            .map(|p| p.items.into_iter().map(Issue::into_remote).collect())
            .unwrap_or_default())
    }

    async fn list_pull_requests(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        since: Option<&str>,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<RemotePullRequest>> {
        // GitLab lists everyone asked to review; Studio's
        // `requested_reviewers` is who still owes it. For an open merge
        // request with reviewers that takes its discussions (one walk each);
        // a closed one is nobody's queue, so it keeps the list as GitLab has it.
        //
        // Several merge requests' discussions are read at once; `buffered`
        // answers in the listing's order whichever read finishes first.
        let api = self.api(auth);
        let mrs = self
            .merge_requests(
                &api,
                repo_full_path,
                "all",
                Order::Created,
                since,
                page,
                per_page,
            )
            .await?;
        let api = &api;
        let out = stream::iter(mrs.into_iter().map(|mr| async move {
            let reviewers = mr.reviewer_logins();
            let requested = if mr.is_open() && !reviewers.is_empty() {
                match self.review_state(api, repo_full_path, &mr, false).await {
                    Ok(state) => state.owed,
                    Err(e) => {
                        tracing::warn!(
                            error = %e,
                            repo = repo_full_path,
                            mr = mr.iid,
                            "gitlab: review state unreadable; every reviewer reads as owed"
                        );
                        reviewers
                    }
                }
            } else {
                reviewers
            };
            mr.into_remote(requested)
        }))
        .buffered(ITEM_READS)
        .collect::<Vec<_>>()
        .await;
        Ok(out)
    }

    async fn open_review_threads(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        max_pulls: u32,
    ) -> anyhow::Result<Option<Vec<PullRequestThreads>>> {
        // GitLab's REST carries resolution on each note of a discussion, so
        // GitLab can say what GitHub's REST cannot. The open merge requests,
        // most recently updated first, up to `max_pulls`.
        // Each one's discussions and approvals are read `ITEM_READS` at a
        // time, answered in the listing's order.
        let api = self.api(auth);
        let api = &api;
        let want = max_pulls.max(1) as usize;
        let mut out: Vec<PullRequestThreads> = Vec::new();
        for page in 1..=want.div_ceil(100) as u32 {
            let mrs = self
                .merge_requests(
                    api,
                    repo_full_path,
                    "opened",
                    Order::Updated,
                    None,
                    page,
                    100,
                )
                .await?;
            let full = mrs.len() == 100;
            let room = want.saturating_sub(out.len());
            let read: Vec<PullRequestThreads> =
                stream::iter(mrs.into_iter().take(room).map(|mr| async move {
                    let state = self.review_state(api, repo_full_path, &mr, true).await?;
                    Ok::<_, anyhow::Error>(PullRequestThreads {
                        number: mr.iid,
                        open: state.open_threads,
                        total: state.total_threads,
                        reviews: state.reviews,
                    })
                }))
                .buffered(ITEM_READS)
                .try_collect()
                .await?;
            out.extend(read);
            if !full || out.len() >= want {
                break;
            }
        }
        Ok(Some(out))
    }

    async fn pull_request_files(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        number: i64,
    ) -> anyhow::Result<Vec<String>> {
        // `/diffs` pages (15.7+); an older GitLab has only `/changes`, which
        // answers the whole list at once.
        let api = self.api(auth);
        let url = api.project(
            repo_full_path,
            &format!("/merge_requests/{number}/diffs?per_page=100"),
        );
        let diffs: Vec<Diff> = match api.page::<Diff>(&url, Family::Item).await? {
            Some(first) => {
                let mut out = first.items;
                if let Some(next) = first.next {
                    let (rest, endless) = api.walk::<Diff>(&next, Family::Item, ALL_PAGES).await?;
                    if endless {
                        tracing::error!(
                            repo = repo_full_path,
                            mr = number,
                            pages = ALL_PAGES,
                            "gitlab: merge request diffs did not end -- its file list is partial"
                        );
                    }
                    out.extend(rest);
                }
                out
            }
            None => {
                let url = api.project(repo_full_path, &format!("/merge_requests/{number}/changes"));
                match api.get::<Changes>(&url).await {
                    Ok(c) => c.changes,
                    Err(e) if is_item_refusal(&e) => Vec::new(),
                    Err(e) => return Err(e),
                }
            }
        };
        Ok(diffs.into_iter().map(|d| d.new_path).collect())
    }

    fn comments_per_item(&self) -> bool {
        // No project-wide notes listing: notes hang off each merge request
        // and issue.
        true
    }

    async fn list_item_comments(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        since: Option<&str>,
        is_pull_request: bool,
        number: i64,
    ) -> anyhow::Result<Vec<RemoteComment>> {
        // Every note of the item, oldest first, without the system notes
        // GitLab writes itself ("approved this merge request"). A refusal
        // (the feature off in this edition, the item gone) reads as none.
        let api = self.api(auth);
        let since = since.map(str::trim).filter(|s| !s.is_empty());
        let kind = if is_pull_request {
            "merge_requests"
        } else {
            "issues"
        };
        let url = api.project(
            repo_full_path,
            &format!("/{kind}/{number}/notes?sort=asc&order_by=created_at&per_page=100"),
        );
        let (notes, endless) = api.walk::<Note>(&url, Family::Item, ALL_PAGES).await?;
        if endless {
            tracing::error!(
                repo = repo_full_path,
                kind,
                number,
                pages = ALL_PAGES,
                "gitlab: notes did not end -- this item's comments are partial"
            );
        }
        // Each note's link is its item's page and an anchor. The notes API
        // does not say the item's page, so it is built the way GitLab builds it.
        let web_base = format!(
            "{}/{}/-/{kind}/{number}",
            api.root(),
            client::project_path(repo_full_path)
        );
        Ok(notes
            .into_iter()
            .filter(|n| !n.system)
            .filter(|n| since.is_none_or(|s| not_before(n.updated_at.as_deref(), s)))
            .map(|n| RemoteComment {
                id: n.id.to_string(),
                target_number: number,
                target_is_pull_request: Some(is_pull_request),
                author: n.author_login(),
                url: Some(format!("{web_base}#note_{}", n.id)),
                body: n.body,
                created_at: n.created_at,
                updated_at: n.updated_at,
            })
            .collect())
    }

    async fn list_commits(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        since: Option<&str>,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<RemoteCommit>> {
        let api = self.api(auth);
        let mut url = api.project(
            repo_full_path,
            &format!(
                "/repository/commits?per_page={}&page={}",
                per_page.clamp(1, 100),
                page.max(1)
            ),
        );
        if let Some(s) = since.map(str::trim).filter(|s| !s.is_empty()) {
            url.push_str("&since=");
            url.push_str(&encode(s));
        }
        let commits: Vec<Commit> = api.get(&url).await?;
        Ok(commits.into_iter().map(Commit::into_remote).collect())
    }

    async fn contributors(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        max: u32,
    ) -> anyhow::Result<Vec<Contributor>> {
        // GitLab counts contributors by commit e-mail, not by account. The
        // noreply form names the account; any other address stands for
        // itself rather than being matched to an account by guesswork.
        let api = self.api(auth);
        let url = api.project(
            repo_full_path,
            "/repository/contributors?order_by=commits&sort=desc&per_page=100",
        );
        let pages = max.max(1).div_ceil(100).min(10);
        let (mut list, _) = api
            .walk::<model::Contributor>(&url, Family::Scope, pages)
            .await?;
        list.sort_by_key(|b| std::cmp::Reverse(b.commits));
        list.truncate(max.max(1) as usize);
        Ok(list
            .into_iter()
            .map(|c| Contributor {
                login: noreply_username(&c.email).unwrap_or(c.email),
                display_name: Some(c.name).filter(|n| !n.trim().is_empty()),
                contributions: c.commits,
            })
            .collect())
    }
}

impl GitLabDriver {
    /// Where release asset link `link` points, from the project's releases
    /// (newest first, a few pages): the trait names an asset by its id only.
    async fn release_link(
        &self,
        api: &Api<'_>,
        repo_full_path: &str,
        link: i64,
    ) -> anyhow::Result<String> {
        let url = api.project(repo_full_path, "/releases?per_page=100");
        let (releases, _) = api.walk::<outputs::Release>(&url, Family::Item, 5).await?;
        releases
            .iter()
            .flat_map(|r| r.assets.links.iter())
            .find(|l| l.id == link)
            .and_then(|l| l.target().map(str::to_owned))
            .ok_or_else(|| {
                anyhow::anyhow!("no release of {repo_full_path} has the asset {link} any more")
            })
    }

    /// Where one merge request stands in review ([`reviews::fold`]): its
    /// discussions, and with `approvals` the `/approvals` extra, which an
    /// unlicensed edition answers with 402 and which is then left out.
    async fn review_state(
        &self,
        api: &Api<'_>,
        repo_full_path: &str,
        mr: &MergeRequest,
        approvals: bool,
    ) -> anyhow::Result<ReviewState> {
        let url = api.project(
            repo_full_path,
            &format!("/merge_requests/{}/discussions?per_page=100", mr.iid),
        );
        let (discussions, _) = api.walk::<Discussion>(&url, Family::Item, 20).await?;
        let approved_by = if approvals {
            let url = api.project(
                repo_full_path,
                &format!("/merge_requests/{}/approvals", mr.iid),
            );
            match api.get::<Approvals>(&url).await {
                Ok(a) => a.logins(),
                Err(e) => {
                    tracing::debug!(error = %e, mr = mr.iid, "gitlab: approvals not read");
                    Vec::new()
                }
            }
        } else {
            Vec::new()
        };
        let author = mr.author.as_ref().map(|a| a.username.as_str());
        Ok(reviews::fold(
            author,
            &mr.reviewer_logins(),
            &discussions,
            &approved_by,
        ))
    }

    /// One page of a project's merge requests, newest first by `order`.
    /// `state` is GitLab's: `all`, `opened`, `merged`, `closed`.
    #[allow(clippy::too_many_arguments)]
    async fn merge_requests(
        &self,
        api: &Api<'_>,
        repo_full_path: &str,
        state: &str,
        order: Order,
        since: Option<&str>,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<MergeRequest>> {
        let url = api.project(
            repo_full_path,
            &listing_query(
                &format!("/merge_requests?state={state}"),
                order,
                since,
                page,
                per_page,
            ),
        );
        Ok(api
            .page::<MergeRequest>(&url, Family::Scope)
            .await?
            .map(|p| p.items)
            .unwrap_or_default())
    }
}

/// What a dated listing is ordered by, newest first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Order {
    /// When each item was created. The sync's listings: a creation time
    /// never moves, so a page boundary stays put while the walk runs and a
    /// walk stopped at page N goes on from page N (`listing_cursor`).
    Created,
    /// When each item last changed: the most active first, for a listing cut
    /// at a few pages (the open merge requests' review state).
    Updated,
}

impl Order {
    fn field(self) -> &'static str {
        match self {
            Order::Created => "created_at",
            Order::Updated => "updated_at",
        }
    }
}

/// A dated listing's query: newest first by `order`, one page, and
/// `updated_after` for an incremental sync.
fn listing_query(
    path: &str,
    order: Order,
    since: Option<&str>,
    page: u32,
    per_page: u32,
) -> String {
    let mut q = format!(
        "{path}&order_by={}&sort=desc&per_page={}&page={}",
        order.field(),
        per_page.clamp(1, 100),
        page.max(1)
    );
    if let Some(s) = since.map(str::trim).filter(|s| !s.is_empty()) {
        q.push_str("&updated_after=");
        q.push_str(&encode(s));
    }
    q
}

/// Whether `at` is not before `since`, both RFC 3339. A time that does not
/// parse is kept: dropping a comment over a format is the worse mistake.
fn not_before(at: Option<&str>, since: &str) -> bool {
    let parse = |s: &str| chrono::DateTime::parse_from_rfc3339(s.trim()).ok();
    match (at.and_then(parse), parse(since)) {
        (Some(at), Some(since)) => at >= since,
        _ => true,
    }
}

/// `/repository/files/{path}/raw?ref=…`. Without a ref GitLab reads `HEAD`,
/// which is the default branch.
fn raw_file_url(api: &Api<'_>, repo_full_path: &str, path: &str, git_ref: Option<&str>) -> String {
    let git_ref = git_ref
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .unwrap_or("HEAD");
    api.project(
        repo_full_path,
        &format!(
            "/repository/files/{}/raw?ref={}",
            encode(path),
            encode(git_ref)
        ),
    )
}
