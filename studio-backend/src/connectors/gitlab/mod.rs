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

mod client;
mod model;

#[cfg(test)]
mod mock;
#[cfg(test)]
mod tests;

use async_trait::async_trait;

use super::driver::{
    ConnectionAuth, ConnectorCategory, ConnectorDriver, DriverIdentity, RemoteCommit, RemoteFile,
    RemoteFileList, RemoteFileText, RemoteRepo, RepoTree, RepoTreeEntry,
};
use client::{Api, Family, Retry, encode};
use model::{Branch, Commit, Project, Tag, TreeItem, User};

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
        let text = String::from_utf8(bytes)
            .map_err(|_| anyhow::anyhow!("{path} is not a text file"))?;
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
}

/// `/repository/files/{path}/raw?ref=…`. Without a ref GitLab reads `HEAD`,
/// which is the default branch.
fn raw_file_url(api: &Api<'_>, repo_full_path: &str, path: &str, git_ref: Option<&str>) -> String {
    let git_ref = git_ref.map(str::trim).filter(|r| !r.is_empty()).unwrap_or("HEAD");
    api.project(
        repo_full_path,
        &format!(
            "/repository/files/{}/raw?ref={}",
            encode(path),
            encode(git_ref)
        ),
    )
}
