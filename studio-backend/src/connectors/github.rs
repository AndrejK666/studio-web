//! GitHub driver (github.com and GitHub Enterprise Server).

use async_trait::async_trait;
use serde::Deserialize;

use super::driver::{
    ConnectionAuth, ConnectorCategory, ConnectorDriver, DriverIdentity, RemoteRepo,
};

pub struct GitHubDriver {
    http: reqwest::Client,
}

impl GitHubDriver {
    pub fn new(http: reqwest::Client) -> Self {
        Self { http }
    }

    /// GitHub rejects requests without a User-Agent, and pins the response
    /// shape to the Accept header.
    fn request(&self, url: &str, auth: &ConnectionAuth) -> reqwest::RequestBuilder {
        self.http
            .get(url)
            .header("Authorization", format!("Bearer {}", auth.token))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header("User-Agent", "constructor-studio")
    }
}

#[derive(Deserialize)]
struct GitHubUser {
    login: String,
    name: Option<String>,
}

#[derive(Deserialize)]
struct GitHubRepo {
    id: i64,
    name: String,
    full_name: String,
    clone_url: String,
    default_branch: Option<String>,
    description: Option<String>,
    private: bool,
}

#[async_trait]
impl ConnectorDriver for GitHubDriver {
    fn provider(&self) -> &'static str {
        "github"
    }

    fn display_name(&self) -> &'static str {
        "GitHub"
    }

    fn default_base_url(&self) -> &'static str {
        "https://api.github.com"
    }

    fn category(&self) -> ConnectorCategory {
        ConnectorCategory::SourceCode
    }

    fn credential_hint(&self) -> &'static str {
        "ghp_…"
    }

    async fn test(&self, auth: &ConnectionAuth) -> anyhow::Result<DriverIdentity> {
        let url = format!("{}/user", auth.root());
        let res = self.request(&url, auth).send().await?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            anyhow::bail!(
                "GitHub {status}: {}",
                body.chars().take(200).collect::<String>()
            );
        }
        let user: GitHubUser = res.json().await?;
        Ok(DriverIdentity {
            account: user.login,
            display_name: user.name,
        })
    }

    async fn list_repositories(
        &self,
        auth: &ConnectionAuth,
        search: Option<&str>,
        limit: u32,
    ) -> anyhow::Result<Vec<RemoteRepo>> {
        // /user/repos has no server-side search, so the filter is applied
        // locally over the most recently touched page.
        let url = format!(
            "{}/user/repos?sort=updated&per_page={}",
            auth.root(),
            limit.clamp(1, 100)
        );
        let res = self.request(&url, auth).send().await?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            anyhow::bail!(
                "GitHub {status}: {}",
                body.chars().take(200).collect::<String>()
            );
        }
        let repos: Vec<GitHubRepo> = res.json().await?;
        let needle = search
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty());
        Ok(repos
            .into_iter()
            .filter(|r| {
                needle
                    .as_ref()
                    .is_none_or(|n| r.full_name.to_lowercase().contains(n))
            })
            .map(|r| RemoteRepo {
                id: r.id.to_string(),
                name: r.name,
                full_path: r.full_name,
                clone_url: r.clone_url,
                default_branch: r.default_branch,
                description: r.description,
                visibility: Some(if r.private { "private" } else { "public" }.to_string()),
            })
            .collect())
    }
}
