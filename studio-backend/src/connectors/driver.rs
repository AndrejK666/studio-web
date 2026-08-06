//! The connector driver contract.
//!
//! A driver knows how to talk to one flavour of source host (GitLab, GitHub,
//! …). It is deliberately narrow: authenticate, enumerate repositories,
//! produce a clone URL. Everything tenant-shaped — which connections exist,
//! who may see them, where the token is kept — belongs to the connector
//! service, not here, so adding a provider stays a small, local job.

use async_trait::async_trait;

/// Everything a driver needs to reach an installation. Assembled per call by
/// the service from the stored connection plus the credstore secret; drivers
/// never see the catalogue and never cache credentials.
#[derive(Debug, Clone)]
pub struct ConnectionAuth {
    /// Installation root, e.g. `https://gitlab.constr.dev` or
    /// `https://api.github.com`. Trailing slashes are tolerated.
    pub base_url: String,
    /// Personal access token.
    pub token: String,
}

impl ConnectionAuth {
    /// `base_url` without trailing slashes, for safe path concatenation.
    pub fn root(&self) -> &str {
        self.base_url.trim_end_matches('/')
    }
}

/// What a provider is for. Decides which affordances the UI offers: only a
/// source host can be browsed for repositories.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectorCategory {
    /// Git hosting — repositories can be listed and attached to a workspace.
    SourceCode,
    /// Model provider — the credential is handed to agents, nothing to browse.
    Ai,
}

impl ConnectorCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SourceCode => "source_code",
            Self::Ai => "ai",
        }
    }
}

/// What a credential resolves to, shown after a successful test so a human can
/// confirm they pasted the one they meant to.
///
/// Source hosts answer with a username. Model providers have no account
/// endpoint at all, so their drivers put a short capability summary here
/// instead (e.g. how many models the key can see) — the honest maximum the
/// provider is willing to tell us.
#[derive(Debug, Clone)]
pub struct DriverIdentity {
    pub account: String,
    pub display_name: Option<String>,
}

/// One repository as the provider describes it.
#[derive(Debug, Clone)]
pub struct RemoteRepo {
    /// Provider-native id, stringified (GitLab numeric, GitHub node id).
    pub id: String,
    /// Short name — the default directory name inside a workspace.
    pub name: String,
    /// Namespaced path, e.g. `hypotheses/hypothesis-workspace`.
    pub full_path: String,
    /// HTTPS clone URL as advertised by the provider.
    pub clone_url: String,
    pub default_branch: Option<String>,
    pub description: Option<String>,
    /// `private` | `internal` | `public` when the provider reports it.
    pub visibility: Option<String>,
}

#[async_trait]
pub trait ConnectorDriver: Send + Sync + 'static {
    /// Stable provider key used in the API and the UI (`gitlab`, `github`).
    fn provider(&self) -> &'static str;

    /// Human label for the provider picker.
    fn display_name(&self) -> &'static str;

    /// Default installation root, offered as a placeholder in the UI.
    fn default_base_url(&self) -> &'static str;

    /// What this provider is for.
    fn category(&self) -> ConnectorCategory;

    /// Label for the credential field: source hosts say "Personal Access
    /// Token", model providers say "API Key".
    fn credential_label(&self) -> &'static str {
        match self.category() {
            ConnectorCategory::SourceCode => "Personal Access Token (PAT)",
            ConnectorCategory::Ai => "API Key",
        }
    }

    /// Placeholder hinting at the credential's shape (`glpat-…`, `sk-ant-…`).
    fn credential_hint(&self) -> &'static str {
        ""
    }

    /// Verify the credential and report whose it is.
    async fn test(&self, auth: &ConnectionAuth) -> anyhow::Result<DriverIdentity>;

    /// Repositories the credential can reach. `search` narrows server-side
    /// where the provider supports it; `limit` caps one page.
    ///
    /// Defaulted so a model-provider driver does not have to implement a
    /// concept it has no notion of; the REST layer turns this into a 400
    /// rather than pretending the listing is empty.
    async fn list_repositories(
        &self,
        auth: &ConnectionAuth,
        search: Option<&str>,
        limit: u32,
    ) -> anyhow::Result<Vec<RemoteRepo>> {
        let _ = (auth, search, limit);
        Err(anyhow::anyhow!(
            "{} is not a source host — it has no repositories to list",
            self.display_name()
        ))
    }
}
