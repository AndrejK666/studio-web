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
//! `read_repository`. Nothing here writes: publishing to GitLab (commits,
//! branches, merge requests) is still refused by the trait's defaults.

mod ci;
mod client;
mod model;
mod reviews;

#[cfg(test)]
mod mock;
#[cfg(test)]
mod tests;

use async_trait::async_trait;

use super::driver::{
    ConnectionAuth, ConnectorCategory, ConnectorDriver, Contributor, DriverIdentity,
    PullRequestThreads, RemoteComment, RemoteCommit, RemoteFile, RemoteFileList, RemoteFileText,
    RemoteIssue, RemotePullRequest, RemoteRepo, RemoteWorkflowJob, RemoteWorkflowRun, RepoTree,
    RepoTreeEntry,
};
use super::references::ReferenceSyntax;
use client::{Api, Family, Retry, encode, is_item_refusal};
use model::{
    Approvals, Branch, Changes, Commit, Diff, Discussion, Issue, MergeRequest, Note, Project, Tag,
    TreeItem, User, noreply_username,
};
use reviews::ReviewState;

/// Pages of a repository tree read before the listing is called truncated:
/// 100 entries each, so 20,000 entries -- the artifact ingest's own file cap
/// is 10,000.
const MAX_TREE_PAGES: u32 = 200;

/// Pages of the repository listing walked to fill one `limit`.
const MAX_REPO_PAGES: u32 = 20;

pub struct GitLabDriver {
    http: reqwest::Client,
    retry: Retry,
}

impl GitLabDriver {
    pub fn new(http: reqwest::Client) -> Self {
        Self {
            http,
            retry: Retry::default(),
        }
    }

    /// The same driver with another retry policy: tests wait milliseconds,
    /// not seconds.
    #[cfg(test)]
    pub(crate) fn with_retry(http: reqwest::Client, retry: Retry) -> Self {
        Self { http, retry }
    }

    fn api<'a>(&'a self, auth: &'a ConnectionAuth) -> Api<'a> {
        Api::new(&self.http, &self.retry, auth)
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
        let (items, truncated) = api
            .walk::<TreeItem>(&url, Family::Scope, MAX_TREE_PAGES)
            .await?;
        if truncated {
            tracing::warn!(
                repo = repo_full_path,
                git_ref,
                "gitlab: repository tree cut at {} entries -- the listing is partial",
                MAX_TREE_PAGES * 100
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
            &listing_query("/issues?scope=all&state=all", since, page, per_page),
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
        let api = self.api(auth);
        let mrs = self
            .merge_requests(&api, repo_full_path, "all", since, page, per_page)
            .await?;
        let mut out = Vec::with_capacity(mrs.len());
        for mr in mrs {
            let reviewers = mr.reviewer_logins();
            let requested = if mr.is_open() && !reviewers.is_empty() {
                match self.review_state(&api, repo_full_path, &mr, false).await {
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
            out.push(mr.into_remote(requested));
        }
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
        let api = self.api(auth);
        let want = max_pulls.max(1) as usize;
        let mut out = Vec::new();
        for page in 1..=want.div_ceil(100) as u32 {
            let mrs = self
                .merge_requests(&api, repo_full_path, "opened", None, page, 100)
                .await?;
            let full = mrs.len() == 100;
            for mr in mrs {
                if out.len() >= want {
                    break;
                }
                let state = self.review_state(&api, repo_full_path, &mr, true).await?;
                out.push(PullRequestThreads {
                    number: mr.iid,
                    open: state.open_threads,
                    total: state.total_threads,
                    reviews: state.reviews,
                });
            }
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
                    out.extend(api.walk::<Diff>(&next, Family::Item, 10).await?.0);
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

    async fn list_comments(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        since: Option<&str>,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<RemoteComment>> {
        // GitLab has no project-wide notes listing: notes hang off each merge
        // request and issue. Comment page N is therefore the notes of item
        // page N -- the merge requests and issues updated since `since` (a new
        // note updates its item) -- `COMMENT_ITEMS` of each. Pages whose items
        // hold no comment at all are stepped over, because an empty answer
        // ends the caller's walk; the caller may then read a page twice, which
        // an upsert by note id makes harmless.
        let api = self.api(auth);
        let since = since.map(str::trim).filter(|s| !s.is_empty());
        let per_items = per_page.clamp(1, COMMENT_ITEMS);
        let mut item_page = page.max(1);
        for _ in 0..MAX_SILENT_PAGES {
            let mrs = self
                .merge_requests(&api, repo_full_path, "all", since, item_page, per_items)
                .await?;
            let issues_url = api.project(
                repo_full_path,
                &listing_query("/issues?scope=all&state=all", since, item_page, per_items),
            );
            let issues: Vec<Issue> = api
                .page::<Issue>(&issues_url, Family::Item)
                .await?
                .map(|p| p.items)
                .unwrap_or_default();
            if mrs.is_empty() && issues.is_empty() {
                return Ok(Vec::new());
            }
            let mut out = Vec::new();
            let targets = mrs
                .iter()
                .map(|m| (true, m.iid, m.web_url.clone()))
                .chain(issues.iter().map(|i| (false, i.iid, i.web_url.clone())));
            for (is_mr, iid, web_url) in targets {
                let kind = if is_mr { "merge_requests" } else { "issues" };
                let url = api.project(
                    repo_full_path,
                    &format!("/{kind}/{iid}/notes?sort=asc&order_by=created_at&per_page=100"),
                );
                let (notes, _) = api.walk::<Note>(&url, Family::Item, 10).await?;
                out.extend(
                    notes
                        .into_iter()
                        .filter(|n| !n.system)
                        .filter(|n| since.is_none_or(|s| not_before(n.updated_at.as_deref(), s)))
                        .map(|n| RemoteComment {
                            id: n.id.to_string(),
                            target_number: iid,
                            target_is_pull_request: Some(is_mr),
                            author: n.author_login(),
                            url: web_url.as_ref().map(|u| format!("{u}#note_{}", n.id)),
                            body: n.body,
                            created_at: n.created_at,
                            updated_at: n.updated_at,
                        }),
                );
            }
            if !out.is_empty() {
                return Ok(out);
            }
            item_page += 1;
        }
        Ok(Vec::new())
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
        list.sort_by(|a, b| b.commits.cmp(&a.commits));
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

/// Items whose notes make one page of comments: each costs a call of its
/// own, so a page stays small.
const COMMENT_ITEMS: u32 = 20;

/// Item pages without a single comment stepped over before a comment page
/// answers empty.
const MAX_SILENT_PAGES: u32 = 5;

impl GitLabDriver {
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

    /// One page of a project's merge requests, most recently updated first.
    /// `state` is GitLab's: `all`, `opened`, `merged`, `closed`.
    async fn merge_requests(
        &self,
        api: &Api<'_>,
        repo_full_path: &str,
        state: &str,
        since: Option<&str>,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<MergeRequest>> {
        let url = api.project(
            repo_full_path,
            &listing_query(
                &format!("/merge_requests?state={state}"),
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

/// A dated listing's query: newest activity first, one page, and
/// `updated_after` for an incremental sync.
fn listing_query(path: &str, since: Option<&str>, page: u32, per_page: u32) -> String {
    let mut q = format!(
        "{path}&order_by=updated_at&sort=desc&per_page={}&page={}",
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
