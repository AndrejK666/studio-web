//! GitLab's REST shapes, as much of each as the driver reads.
//!
//! Every field a GitLab version may lack is optional or defaulted: an
//! installation a few majors behind gitlab.com is the normal case for a
//! self-hosted one, and a missing field must read as "not said", never fail a
//! whole page.

use serde::Deserialize;

use super::super::driver::{RemoteCommit, RemoteRepo};

/// `GET /user`.
#[derive(Deserialize)]
pub(super) struct User {
    pub username: String,
    #[serde(default)]
    pub name: Option<String>,
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
