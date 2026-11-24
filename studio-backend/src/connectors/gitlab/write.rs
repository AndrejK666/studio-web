//! Writes to GitLab: what publishing a document, sharing with the team, a
//! scaffold and a release need -- commits of several files, single files,
//! branches, tags, merge requests, issues, commit statuses and pipelines.
//!
//! Each write is safe to ask for twice, because the caller (or a person
//! pressing the button again) does:
//!
//! - a commit onto a new branch that already holds exactly these files
//!   answers that branch's head instead of a conflict;
//! - a file whose content is already what is asked is not committed again;
//! - a tag already at the commit is the answer; at another commit it is
//!   refused and left alone;
//! - a merge request already open for the branch is found and reused;
//! - a commit status GitLab already holds in that state is not an error.
//!
//! GitLab's refusals map onto [`GitLabErrorKind`]: 403 is a protected branch
//! or a read-only token, 409 a conflict, 400/422 a request GitLab will not
//! take (its message says which), and the message is kept.

use reqwest::Method;
use serde::Deserialize;
use serde_json::{Value, json};

use super::super::driver::{
    CommitStatus, ConnectionAuth, CreatedIssue, CreatedRepository, FileToWrite, OpenedPullRequest,
    WrittenFile,
};
use super::GitLabDriver;
use super::client::{Api, GitLabErrorKind, encode, kind_of, project_path};

#[derive(Deserialize)]
struct CommitCreated {
    id: String,
}

#[derive(Deserialize)]
struct FileMeta {
    #[serde(default)]
    blob_id: Option<String>,
    #[serde(default)]
    last_commit_id: Option<String>,
}

#[derive(Deserialize)]
struct MergeRequestCreated {
    iid: i64,
    #[serde(default)]
    web_url: Option<String>,
}

#[derive(Deserialize)]
struct IssueCreated {
    iid: i64,
    #[serde(default)]
    web_url: Option<String>,
}

#[derive(Deserialize)]
struct UserId {
    id: i64,
    username: String,
}

#[derive(Deserialize)]
struct TagAt {
    commit: TagCommit,
}

#[derive(Deserialize)]
struct TagCommit {
    id: String,
}

#[derive(Deserialize)]
struct Namespace {
    id: i64,
}

#[derive(Deserialize)]
struct ProjectCreated {
    path_with_namespace: String,
    web_url: String,
    #[serde(default)]
    default_branch: Option<String>,
}

/// Whether an error is GitLab saying `needle` with one of `kinds`.
fn refused(e: &anyhow::Error, kinds: &[GitLabErrorKind], needle: &str) -> bool {
    e.downcast_ref::<super::client::GitLabError>()
        .is_some_and(|g| kinds.contains(&g.kind) && g.says(needle))
}

/// GitLab's commit-status states from the trait's (GitHub's) four.
pub(super) fn status_state(state: &str) -> &'static str {
    match state {
        "success" => "success",
        "pending" => "pending",
        "running" => "running",
        "canceled" | "cancelled" => "canceled",
        // `failure` and `error` alike: GitLab has one failed state.
        _ => "failed",
    }
}

impl GitLabDriver {
    /// The commit `files` (and `deleted`) make, as GitLab's `actions`:
    /// `create` for a path `at` does not have, `update` for one it has.
    async fn actions(
        &self,
        api: &Api<'_>,
        repo: &str,
        at: &str,
        files: &[FileToWrite],
        deleted: &[String],
    ) -> anyhow::Result<Vec<Value>> {
        let mut actions = Vec::with_capacity(files.len() + deleted.len());
        for f in files {
            let exists = self.file_meta(api, repo, &f.path, at).await?.is_some();
            actions.push(json!({
                "action": if exists { "update" } else { "create" },
                "file_path": f.path,
                "content": f.content,
                "encoding": "text",
            }));
        }
        for d in deleted
            .iter()
            .filter(|d| !files.iter().any(|f| &f.path == *d))
        {
            if self.file_meta(api, repo, d, at).await?.is_some() {
                actions.push(json!({ "action": "delete", "file_path": d }));
            }
        }
        Ok(actions)
    }

    async fn file_meta(
        &self,
        api: &Api<'_>,
        repo: &str,
        path: &str,
        git_ref: &str,
    ) -> anyhow::Result<Option<FileMeta>> {
        let url = api.project(
            repo,
            &format!("/repository/files/{}?ref={}", encode(path), encode(git_ref)),
        );
        api.get_opt::<FileMeta>(&url).await
    }

    /// Whether `branch` already holds every one of `files`, byte for byte,
    /// and none of `deleted`.
    async fn branch_holds(
        &self,
        auth: &ConnectionAuth,
        repo: &str,
        branch: &str,
        files: &[FileToWrite],
        deleted: &[String],
    ) -> anyhow::Result<bool> {
        use super::super::driver::ConnectorDriver as _;
        for f in files {
            match self
                .read_file_bytes(auth, repo, &f.path, Some(branch))
                .await?
            {
                Some(bytes) if bytes == f.content.as_bytes() => {}
                _ => return Ok(false),
            }
        }
        for d in deleted {
            if self
                .read_file_bytes(auth, repo, d, Some(branch))
                .await?
                .is_some()
            {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// See [`ConnectorDriver::commit_changes`](super::super::driver::ConnectorDriver::commit_changes):
    /// one atomic commit through `POST /repository/commits`, which takes many
    /// actions and, with `start_branch`, creates the branch in the same call.
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn write_commit(
        &self,
        auth: &ConnectionAuth,
        repo: &str,
        base_branch: &str,
        branch: &str,
        files: &[FileToWrite],
        deleted: &[String],
        message: &str,
    ) -> anyhow::Result<String> {
        use super::super::driver::ConnectorDriver as _;
        let api = self.api(auth);
        let url = api.project(repo, "/repository/commits");
        if branch == base_branch {
            // Onto the base itself: GitLab commits on its current head, so a
            // push that landed meanwhile is built on, never dropped.
            let actions = self
                .actions(&api, repo, base_branch, files, deleted)
                .await?;
            let created: CommitCreated = api
                .write(
                    Method::POST,
                    &url,
                    &json!({ "branch": branch, "commit_message": message, "actions": actions }),
                )
                .await
                .map_err(|e| e.context(format!("commit onto '{branch}'")))?;
            return Ok(created.id);
        }
        if let Some(head) = self.branch_head(auth, repo, branch).await? {
            return self
                .existing_branch_answer(auth, repo, branch, head, files, deleted)
                .await;
        }
        let actions = self
            .actions(&api, repo, base_branch, files, deleted)
            .await?;
        let created: anyhow::Result<CommitCreated> = api
            .write(
                Method::POST,
                &url,
                &json!({
                    "branch": branch,
                    "start_branch": base_branch,
                    "commit_message": message,
                    "actions": actions,
                }),
            )
            .await;
        match created {
            Ok(c) => Ok(c.id),
            // Made meanwhile, by a retry or a second click.
            Err(e) if refused(&e, &[GitLabErrorKind::Invalid], "already exists") => {
                let head = self.branch_head(auth, repo, branch).await?.ok_or(e)?;
                self.existing_branch_answer(auth, repo, branch, head, files, deleted)
                    .await
            }
            Err(e) => Err(e.context(format!("commit onto new branch '{branch}'"))),
        }
    }

    /// A branch that exists already is the answer when it holds exactly what
    /// was asked; otherwise its name is taken and nothing is moved.
    async fn existing_branch_answer(
        &self,
        auth: &ConnectionAuth,
        repo: &str,
        branch: &str,
        head: String,
        files: &[FileToWrite],
        deleted: &[String],
    ) -> anyhow::Result<String> {
        if self
            .branch_holds(auth, repo, branch, files, deleted)
            .await?
        {
            Ok(head)
        } else {
            Err(anyhow::anyhow!(
                "branch '{branch}' already exists with different content; nothing was \
                 overwritten. Delete or rename it, or pick another branch"
            ))
        }
    }

    /// See [`ConnectorDriver::commit_replacing_branch`](super::super::driver::ConnectorDriver::commit_replacing_branch):
    /// GitLab's `force` makes the commit on top of `start_branch` and points
    /// `branch` at it whether or not it existed.
    pub(super) async fn write_replacing_branch(
        &self,
        auth: &ConnectionAuth,
        repo: &str,
        base_branch: &str,
        branch: &str,
        files: &[FileToWrite],
        message: &str,
    ) -> anyhow::Result<String> {
        if branch == base_branch {
            anyhow::bail!("'{branch}' is the base branch; it is never recreated");
        }
        let api = self.api(auth);
        let actions = self.actions(&api, repo, base_branch, files, &[]).await?;
        let created: CommitCreated = api
            .write(
                Method::POST,
                &api.project(repo, "/repository/commits"),
                &json!({
                    "branch": branch,
                    "start_branch": base_branch,
                    "force": true,
                    "commit_message": message,
                    "actions": actions,
                }),
            )
            .await
            .map_err(|e| e.context(format!("recreate branch '{branch}'")))?;
        Ok(created.id)
    }

    /// See [`ConnectorDriver::put_file`](super::super::driver::ConnectorDriver::put_file).
    pub(super) async fn write_file(
        &self,
        auth: &ConnectionAuth,
        repo: &str,
        branch: Option<&str>,
        path: &str,
        content: &str,
        message: &str,
    ) -> anyhow::Result<WrittenFile> {
        use super::super::driver::ConnectorDriver as _;
        let path = super::repo_file_path(path)?;
        let api = self.api(auth);
        let branch = match branch.map(str::trim).filter(|b| !b.is_empty()) {
            Some(b) => b.to_owned(),
            None => self.default_branch(auth, repo).await?,
        };
        let prior = self
            .read_file_bytes(auth, repo, &path, Some(&branch))
            .await?;
        let url = api.project(repo, &format!("/repository/files/{}", encode(&path)));
        let body = json!({
            "branch": branch,
            "content": content,
            "encoding": "text",
            "commit_message": message,
        });
        match &prior {
            // Already what is asked: committing it again would be an empty
            // change, which GitLab refuses.
            Some(bytes) if bytes == content.as_bytes() => {}
            Some(_) => {
                let _: Value = api
                    .write(Method::PUT, &url, &body)
                    .await
                    .map_err(|e| e.context(format!("write {path} on '{branch}'")))?;
            }
            None => {
                let created: anyhow::Result<Value> = api.write(Method::POST, &url, &body).await;
                match created {
                    Ok(_) => {}
                    // Created meanwhile: replace it, as the trait promises.
                    Err(e) if refused(&e, &[GitLabErrorKind::Invalid], "already exists") => {
                        let _: Value = api
                            .write(Method::PUT, &url, &body)
                            .await
                            .map_err(|e| e.context(format!("write {path} on '{branch}'")))?;
                    }
                    Err(e) => return Err(e.context(format!("create {path} on '{branch}'"))),
                }
            }
        }
        let meta = self.file_meta(&api, repo, &path, &branch).await?;
        Ok(WrittenFile {
            url: Some(format!(
                "{}/{}/-/blob/{}/{}",
                api.root(),
                project_path(repo),
                branch,
                path
            )),
            sha: meta
                .as_ref()
                .and_then(|m| m.blob_id.clone())
                .unwrap_or_default(),
            commit: meta.and_then(|m| m.last_commit_id),
            branch: Some(branch),
            path,
            updated: prior.is_some(),
        })
    }

    /// `POST /repository/branches`.
    pub(super) async fn write_branch(
        &self,
        auth: &ConnectionAuth,
        repo: &str,
        branch: &str,
        from_sha: &str,
    ) -> anyhow::Result<()> {
        let api = self.api(auth);
        let url = api.project(
            repo,
            &format!(
                "/repository/branches?branch={}&ref={}",
                encode(branch),
                encode(from_sha)
            ),
        );
        let _: Value = api
            .write(Method::POST, &url, &json!({}))
            .await
            .map_err(|e| e.context(format!("create branch '{branch}'")))?;
        Ok(())
    }

    /// `POST /repository/tags`; a tag already at `sha` is the answer.
    pub(super) async fn write_tag(
        &self,
        auth: &ConnectionAuth,
        repo: &str,
        tag: &str,
        sha: &str,
    ) -> anyhow::Result<()> {
        let api = self.api(auth);
        let url = api.project(
            repo,
            &format!(
                "/repository/tags?tag_name={}&ref={}",
                encode(tag),
                encode(sha)
            ),
        );
        let created: anyhow::Result<Value> = api.write(Method::POST, &url, &json!({})).await;
        match created {
            Ok(_) => Ok(()),
            Err(e)
                if refused(
                    &e,
                    &[GitLabErrorKind::Invalid, GitLabErrorKind::Conflict],
                    "already exists",
                ) =>
            {
                let at: TagAt = api
                    .get(&api.project(repo, &format!("/repository/tags/{}", encode(tag))))
                    .await
                    .map_err(|e| e.context(format!("read existing tag '{tag}'")))?;
                if at.commit.id == sha {
                    Ok(())
                } else {
                    Err(anyhow::anyhow!(
                        "the tag '{tag}' already points at {}, not {sha}; nothing was moved",
                        at.commit.id
                    ))
                }
            }
            Err(e) => Err(e.context(format!("create tag '{tag}'"))),
        }
    }

    /// `POST /merge_requests`; one already open for the branch is reused.
    pub(super) async fn write_merge_request(
        &self,
        auth: &ConnectionAuth,
        repo: &str,
        head: &str,
        base: &str,
        title: &str,
        body: Option<&str>,
    ) -> anyhow::Result<OpenedPullRequest> {
        use super::super::driver::ConnectorDriver as _;
        let api = self.api(auth);
        let mut payload = json!({ "source_branch": head, "target_branch": base, "title": title });
        if let Some(text) = body {
            payload["description"] = Value::String(text.to_owned());
        }
        let created: anyhow::Result<MergeRequestCreated> = api
            .write(
                Method::POST,
                &api.project(repo, "/merge_requests"),
                &payload,
            )
            .await;
        match created {
            Ok(mr) => Ok(OpenedPullRequest {
                number: mr.iid,
                url: mr.web_url,
                created: true,
            }),
            // "Another open merge request already exists for this source
            // branch": 409 on current GitLab, 422 on some older ones.
            Err(e)
                if matches!(
                    kind_of(&e),
                    Some(GitLabErrorKind::Conflict | GitLabErrorKind::Invalid)
                ) =>
            {
                match self.find_open_pull_request(auth, repo, head, base).await? {
                    Some(existing) => Ok(existing),
                    None => Err(e.context(format!("open a merge request {head} → {base}"))),
                }
            }
            Err(e) => Err(e.context(format!("open a merge request {head} → {base}"))),
        }
    }

    /// `GET /merge_requests?state=opened&source_branch=&target_branch=`.
    pub(super) async fn open_merge_request(
        &self,
        auth: &ConnectionAuth,
        repo: &str,
        head: &str,
        base: &str,
    ) -> anyhow::Result<Option<OpenedPullRequest>> {
        let api = self.api(auth);
        let url = api.project(
            repo,
            &format!(
                "/merge_requests?state=opened&source_branch={}&target_branch={}",
                encode(head),
                encode(base)
            ),
        );
        let open: Vec<MergeRequestCreated> = api.get(&url).await?;
        Ok(open.into_iter().next().map(|mr| OpenedPullRequest {
            number: mr.iid,
            url: mr.web_url,
            created: false,
        }))
    }

    /// `POST /issues`, assigned to the accounts the logins name. A login
    /// GitLab does not know is left out rather than failing the issue.
    pub(super) async fn write_issue(
        &self,
        auth: &ConnectionAuth,
        repo: &str,
        title: &str,
        body: &str,
        assignees: &[String],
    ) -> anyhow::Result<CreatedIssue> {
        let api = self.api(auth);
        let mut ids = Vec::new();
        for login in assignees.iter().map(|l| l.trim()).filter(|l| !l.is_empty()) {
            let url = api.v4(&format!("users?username={}", encode(login)));
            match api.get::<Vec<UserId>>(&url).await {
                Ok(found) => ids.extend(
                    found
                        .into_iter()
                        .filter(|u| u.username.eq_ignore_ascii_case(login))
                        .map(|u| u.id),
                ),
                Err(e) => tracing::debug!(error = %e, login, "gitlab: assignee not found"),
            }
        }
        let issue: IssueCreated = api
            .write(
                Method::POST,
                &api.project(repo, "/issues"),
                &json!({ "title": title, "description": body, "assignee_ids": ids }),
            )
            .await
            .map_err(|e| e.context(format!("open an issue in {repo}")))?;
        Ok(CreatedIssue {
            number: issue.iid,
            url: issue.web_url,
        })
    }

    /// `POST /statuses/:sha`. GitLab refuses to move a status to the state it
    /// is already in ("Cannot transition status"), which for a repeated
    /// report is the answer, not a failure.
    pub(super) async fn write_status(
        &self,
        auth: &ConnectionAuth,
        repo: &str,
        sha: &str,
        status: &CommitStatus,
    ) -> anyhow::Result<()> {
        let api = self.api(auth);
        let mut body = json!({
            "state": status_state(&status.state),
            "name": status.context,
            "description": status.description.chars().take(140).collect::<String>(),
        });
        if let Some(target) = &status.target_url {
            body["target_url"] = Value::String(target.clone());
        }
        let posted: anyhow::Result<Value> = api
            .write(
                Method::POST,
                &api.project(repo, &format!("/statuses/{}", encode(sha))),
                &body,
            )
            .await;
        match posted {
            Ok(_) => Ok(()),
            Err(e) if refused(&e, &[GitLabErrorKind::Invalid], "cannot transition status") => {
                Ok(())
            }
            Err(e) => Err(e.context(format!("set the status of {sha}"))),
        }
    }

    /// `POST /pipeline`: GitLab has one pipeline definition, so "which
    /// workflow" travels as the variable `STUDIO_WORKFLOW`, for the
    /// `.gitlab-ci.yml` rules to select jobs by.
    pub(super) async fn write_pipeline(
        &self,
        auth: &ConnectionAuth,
        repo: &str,
        workflow: &str,
        git_ref: &str,
    ) -> anyhow::Result<()> {
        let api = self.api(auth);
        let _: Value = api
            .write(
                Method::POST,
                &api.project(repo, "/pipeline"),
                &json!({
                    "ref": git_ref,
                    "variables": [
                        { "key": "STUDIO_WORKFLOW", "value": workflow, "variable_type": "env_var" }
                    ],
                }),
            )
            .await
            .map_err(|e| e.context(format!("start a pipeline on {repo}@{git_ref}")))?;
        Ok(())
    }

    /// `POST /projects` under the group `owner` names (when `is_org`) or the
    /// token's own namespace, with a README so a base branch exists.
    pub(super) async fn write_project(
        &self,
        auth: &ConnectionAuth,
        owner: Option<&str>,
        is_org: bool,
        name: &str,
        private: bool,
    ) -> anyhow::Result<CreatedRepository> {
        let api = self.api(auth);
        let mut body = json!({
            "name": name,
            "path": name,
            "visibility": if private { "private" } else { "public" },
            "initialize_with_readme": true,
        });
        if let Some(group) = owner.map(str::trim).filter(|o| is_org && !o.is_empty()) {
            let ns: Namespace = api
                .get(&api.v4(&format!("namespaces/{}", encode(group))))
                .await
                .map_err(|e| e.context(format!("find the group '{group}'")))?;
            body["namespace_id"] = json!(ns.id);
        }
        let created: ProjectCreated = api
            .write(Method::POST, &api.v4("projects"), &body)
            .await
            .map_err(|e| e.context(format!("create project '{name}'")))?;
        Ok(CreatedRepository {
            full_name: created.path_with_namespace,
            html_url: created.web_url,
            default_branch: created.default_branch.unwrap_or_else(|| "main".into()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_map_to_gitlab_s_states() {
        assert_eq!(status_state("success"), "success");
        assert_eq!(status_state("pending"), "pending");
        assert_eq!(status_state("failure"), "failed");
        assert_eq!(status_state("error"), "failed");
    }
}
