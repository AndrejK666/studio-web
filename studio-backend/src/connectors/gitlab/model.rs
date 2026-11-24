//! GitLab's REST shapes, as much of each as the driver reads.
//!
//! Every field a GitLab version may lack is optional or defaulted: an
//! installation a few majors behind gitlab.com is the normal case for a
//! self-hosted one, and a missing field must read as "not said", never fail a
//! whole page.

use serde::Deserialize;

use super::super::driver::{RemoteCommit, RemoteIssue, RemotePullRequest, RemoteRepo};

/// `GET /user`.
#[derive(Deserialize)]
pub(super) struct User {
    pub username: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub avatar_url: Option<String>,
}

/// A person as a listing names them. `null` where the account was deleted,
/// so every holder of one keeps it optional.
#[derive(Deserialize, Clone)]
pub(super) struct UserRef {
    pub username: String,
}

fn login(user: Option<UserRef>) -> Option<String> {
    user.map(|u| u.username).filter(|u| !u.trim().is_empty())
}

/// `GET /projects/:id/issues`.
#[derive(Deserialize)]
pub(super) struct Issue {
    pub id: i64,
    pub iid: i64,
    pub title: String,
    /// `opened` or `closed`.
    pub state: String,
    #[serde(default)]
    pub author: Option<UserRef>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub web_url: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub milestone: Option<Milestone>,
}

#[derive(Deserialize)]
pub(super) struct Milestone {
    pub title: String,
}

/// `opened` → `open`: the vocabulary the graph shares with GitHub.
fn open_or(state: &str) -> String {
    match state {
        "opened" | "reopened" | "locked" => "open".into(),
        other => other.into(),
    }
}

impl Issue {
    pub fn into_remote(self) -> RemoteIssue {
        RemoteIssue {
            id: self.id.to_string(),
            number: self.iid,
            title: self.title,
            state: open_or(&self.state),
            author: login(self.author),
            body: self.description,
            url: self.web_url,
            created_at: self.created_at,
            updated_at: self.updated_at,
            labels: self.labels,
            // An epic is a group's, not the project's; nothing to place.
            parent: None,
            iteration: self.milestone.map(|m| m.title),
        }
    }
}

/// `GET /projects/:id/merge_requests`.
///
/// Fields GitLab renamed are read under both names (Insight's fallbacks):
/// `draft` was `work_in_progress` before 14.0, and a single `assignee`
/// predates `assignees`. `reviewers` arrived in 13.8, so it defaults to none.
#[derive(Deserialize)]
pub(super) struct MergeRequest {
    pub id: i64,
    pub iid: i64,
    pub title: String,
    /// `opened`, `closed`, `merged` or `locked` (mid-merge).
    pub state: String,
    #[serde(default)]
    pub author: Option<UserRef>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub web_url: Option<String>,
    #[serde(default)]
    pub source_branch: Option<String>,
    #[serde(default)]
    pub target_branch: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub merged_at: Option<String>,
    #[serde(default)]
    pub draft: Option<bool>,
    #[serde(default)]
    pub work_in_progress: Option<bool>,
    #[serde(default)]
    pub reviewers: Vec<Option<UserRef>>,
    #[serde(default)]
    pub assignees: Vec<Option<UserRef>>,
    #[serde(default)]
    pub assignee: Option<UserRef>,
    #[serde(default)]
    pub sha: Option<String>,
    #[serde(default)]
    pub merge_commit_sha: Option<String>,
    #[serde(default)]
    pub squash_commit_sha: Option<String>,
}

impl MergeRequest {
    pub fn is_open(&self) -> bool {
        open_or(&self.state) == "open"
    }

    /// Everyone asked to review it, as GitLab lists them.
    pub fn reviewer_logins(&self) -> Vec<String> {
        self.reviewers.iter().cloned().filter_map(login).collect()
    }

    /// `requested_reviewers` is who still owes a review: the caller passes
    /// the reviewers that have not answered yet.
    pub fn into_remote(self, requested_reviewers: Vec<String>) -> RemotePullRequest {
        let merged = self.state == "merged" || self.merged_at.is_some();
        let mut assignees: Vec<String> = self.assignees.into_iter().filter_map(login).collect();
        if assignees.is_empty() {
            assignees.extend(login(self.assignee));
        }
        RemotePullRequest {
            id: self.id.to_string(),
            number: self.iid,
            title: self.title,
            state: if merged {
                "merged".into()
            } else {
                open_or(&self.state)
            },
            author: login(self.author),
            body: self.description,
            url: self.web_url,
            source_branch: self.source_branch,
            target_branch: self.target_branch,
            merged,
            created_at: self.created_at,
            updated_at: self.updated_at,
            draft: self.draft.or(self.work_in_progress),
            requested_reviewers,
            requested_teams: Vec::new(),
            assignees,
            head_sha: self.sha,
            merge_sha: if merged {
                self.merge_commit_sha.or(self.squash_commit_sha)
            } else {
                None
            },
        }
    }
}

/// `GET …/merge_requests/:iid/notes`, `…/issues/:iid/notes`, and each note of
/// a discussion.
#[derive(Deserialize, Clone)]
pub(super) struct Note {
    pub id: i64,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub author: Option<UserRef>,
    /// GitLab's own record of an event (an approval, a review request), not
    /// something a person wrote.
    #[serde(default)]
    pub system: bool,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub resolvable: bool,
    #[serde(default)]
    pub resolved: Option<bool>,
}

impl Note {
    pub fn author_login(&self) -> Option<String> {
        login(self.author.clone())
    }
}

/// `GET …/merge_requests/:iid/diffs` (15.7+) and each entry of the older
/// `…/changes`.
#[derive(Deserialize)]
pub(super) struct Diff {
    pub new_path: String,
}

/// `GET …/merge_requests/:iid/changes`, before `/diffs` existed.
#[derive(Deserialize)]
pub(super) struct Changes {
    #[serde(default)]
    pub changes: Vec<Diff>,
}

/// `GET /projects/:id/repository/contributors`: keyed by e-mail, not account.
#[derive(Deserialize)]
pub(super) struct Contributor {
    pub name: String,
    pub email: String,
    #[serde(default)]
    pub commits: u64,
}

/// `GET /projects`, `GET /projects/:id`.
#[derive(Deserialize)]
pub(super) struct Project {
    pub id: i64,
    pub name: String,
    pub path_with_namespace: String,
    pub http_url_to_repo: String,
    #[serde(default)]
    pub default_branch: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub visibility: Option<String>,
}

impl Project {
    pub fn into_remote(self) -> RemoteRepo {
        RemoteRepo {
            id: self.id.to_string(),
            name: self.name,
            full_path: self.path_with_namespace,
            clone_url: self.http_url_to_repo,
            default_branch: self.default_branch,
            description: self.description,
            visibility: self.visibility,
        }
    }
}

/// `GET /projects/:id/repository/tree`.
#[derive(Deserialize)]
pub(super) struct TreeItem {
    pub id: String,
    pub path: String,
    /// `blob`, `tree` or `commit` (a submodule).
    #[serde(rename = "type")]
    pub kind: String,
}

/// `GET /projects/:id/repository/branches[/:branch]`.
#[derive(Deserialize)]
pub(super) struct Branch {
    pub name: String,
    pub commit: CommitId,
}

#[derive(Deserialize)]
pub(super) struct CommitId {
    pub id: String,
}

/// `GET /projects/:id/repository/tags`.
#[derive(Deserialize)]
pub(super) struct Tag {
    pub name: String,
}

/// `GET /projects/:id/repository/commits`.
#[derive(Deserialize)]
pub(super) struct Commit {
    pub id: String,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub author_name: Option<String>,
    #[serde(default)]
    pub author_email: Option<String>,
    #[serde(default)]
    pub authored_date: Option<String>,
    #[serde(default)]
    pub committed_date: Option<String>,
    #[serde(default)]
    pub web_url: Option<String>,
}

impl Commit {
    pub fn into_remote(self) -> RemoteCommit {
        RemoteCommit {
            author: self.author_email.as_deref().and_then(noreply_username),
            sha: self.id,
            message: self.message.or(self.title),
            author_name: self.author_name,
            url: self.web_url,
            created_at: self.authored_date,
            committed_at: self.committed_date,
        }
    }
}

/// The account behind a GitLab noreply address, `{id}-{username}@users.noreply.{host}`.
///
/// A commit carries an e-mail, not an account; this is the one address form
/// that names the account by itself (Insight reads it the same way). Any
/// other address stays unattributed rather than guessed at.
pub(super) fn noreply_username(email: &str) -> Option<String> {
    let (local, domain) = email.trim().split_once('@')?;
    if !domain.to_ascii_lowercase().starts_with("users.noreply.") {
        return None;
    }
    let (id, username) = local.split_once('-')?;
    (!id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()) && !username.is_empty())
        .then(|| username.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_noreply_address_names_its_account_and_nothing_else_does() {
        assert_eq!(
            noreply_username("1234-ada.l@users.noreply.gitlab.com").as_deref(),
            Some("ada.l")
        );
        assert_eq!(
            noreply_username("7-bob@users.noreply.git.corp.example").as_deref(),
            Some("bob")
        );
        assert_eq!(noreply_username("ada@example.com"), None);
        assert_eq!(noreply_username("ada@users.noreply.gitlab.com"), None);
        assert_eq!(noreply_username("x-ada@users.noreply.gitlab.com"), None);
    }
}
