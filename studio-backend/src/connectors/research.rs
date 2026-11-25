//! Constructor Research driver: where a member's products are built and run
//! on the hardware Research allocates (ADR-0049).
//!
//! Studio never reaches into Research's cluster. The connection's address is
//! Research's own public API (`https://<stand>/api/platform-account/v1`),
//! and every call goes there with an access token of the member's own.
//!
//! The member either pastes an `rk-` access key made in Research itself, or
//! signs in to the shared Constructor identity provider ([`super::oauth`])
//! once; with the token that comes back Studio makes the member an `rk-`
//! access key that runs out after [`KEY_LIFETIME_DAYS`], and the connection
//! stores the key (ADR-0049 §1).
//! Research limits a key to the routes Studio calls. When it runs out, the
//! member signs in again. A connection made before the keys stored a refresh
//! token, and still trades it for an access token on each use. A successful
//! `GET /auth/session` is the proof that the member controls that Research
//! account (ADR-0012).
//!
//! A deployment with no client at the stand's identity provider runs the
//! driver key-only: nothing to sign in to, and a pasted `rk-` key is the only
//! way in. A pasted key is stored as it is, and called with as it is.

use anyhow::anyhow;
use async_trait::async_trait;

use serde::{Deserialize, Serialize};

use super::driver::{
    AccessToken, ConnectionAuth, ConnectorCategory, ConnectorDriver, DriverIdentity, SignedIn,
};
use super::oauth::{OAuthClient, Pkce, Tokens};
use super::research_api::{ACCESS_KEY_PREFIX, ResearchApi};

/// How long a key Studio makes lasts.
pub const KEY_LIFETIME_DAYS: i64 = 90;

/// What a connection stores: the member's key, its id (to delete it by) and
/// when it runs out.
#[derive(Serialize, Deserialize)]
struct StoredKey {
    key: String,
    id: String,
    expires_at: String,
}

pub const PROVIDER: &str = "research";

pub struct ResearchDriver {
    http: reqwest::Client,
    /// The client at the identity provider, when this deployment has one;
    /// without it the driver takes pasted keys only.
    oauth: Option<OAuthClient>,
    /// Research's public API in this deployment, offered as the
    /// connection's default. Leaked once at boot: the contract hands it out as
    /// `&'static str`, and a driver lives as long as the process.
    api_url: &'static str,
}

impl ResearchDriver {
    fn oauth(&self) -> anyhow::Result<&OAuthClient> {
        self.oauth.as_ref().ok_or_else(|| {
            anyhow!(
                "this deployment has no sign-in to Constructor Research; paste a \
                 Research access key (rk-…) instead"
            )
        })
    }

    pub fn new(http: reqwest::Client, oauth: Option<OAuthClient>, api_url: String) -> Self {
        Self {
            http,
            oauth,
            api_url: Box::leak(api_url.into_boxed_str()),
        }
    }
}

#[async_trait]
impl ConnectorDriver for ResearchDriver {
    fn provider(&self) -> &'static str {
        PROVIDER
    }

    fn display_name(&self) -> &'static str {
        "Constructor Research"
    }

    fn default_base_url(&self) -> &'static str {
        self.api_url
    }

    fn category(&self) -> ConnectorCategory {
        ConnectorCategory::Compute
    }

    fn credential_label(&self) -> &'static str {
        "Research access key"
    }

    fn credential_hint(&self) -> &'static str {
        "Log in to Research, make an access key (rk-…) and paste it here"
    }

    fn signs_in(&self) -> bool {
        self.oauth.is_some()
    }

    fn takes_pasted_key(&self) -> bool {
        true
    }

    fn check_pasted_key(&self, token: &str) -> anyhow::Result<()> {
        if token.starts_with(ACCESS_KEY_PREFIX) {
            return Ok(());
        }
        Err(anyhow!(
            "Constructor Research takes a Research access key, which starts with \
             `{ACCESS_KEY_PREFIX}`: log in to Research, make an access key and paste it"
        ))
    }

    fn sign_in_url(
        &self,
        state: &str,
        pkce: &Pkce,
        redirect_uri: Option<&str>,
    ) -> anyhow::Result<(String, String)> {
        let oauth = self.oauth()?;
        let redirect_uri = oauth.redirect_uri(redirect_uri)?;
        Ok((oauth.authorize(state, pkce, &redirect_uri)?, redirect_uri))
    }

    async fn exchange_code(
        &self,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> anyhow::Result<Tokens> {
        // A sign-in started before the callback was kept has none: it was the
        // default's.
        let oauth = self.oauth()?;
        let redirect_uri = oauth.redirect_uri(Some(redirect_uri))?;
        oauth
            .exchange_code(&self.http, code, verifier, &redirect_uri)
            .await
    }

    async fn signed_in(&self, base_url: &str, tokens: Tokens) -> anyhow::Result<SignedIn> {
        let expires_at = (chrono::Utc::now() + chrono::Duration::days(KEY_LIFETIME_DAYS))
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let made = ResearchApi::new(self.http.clone(), base_url, tokens.access_token)
            .create_access_key("studio", &expires_at)
            .await?;
        let stored = serde_json::to_string(&StoredKey {
            key: made.key.clone(),
            id: made.id,
            expires_at,
        })?;
        Ok(SignedIn {
            stored,
            token: made.key,
        })
    }

    async fn access_token(&self, stored: &str) -> anyhow::Result<AccessToken> {
        if let Ok(k) = serde_json::from_str::<StoredKey>(stored) {
            return Ok(AccessToken {
                token: k.key,
                rotated: None,
            });
        }
        // A pasted key is stored as it is.
        if stored.starts_with(ACCESS_KEY_PREFIX) {
            return Ok(AccessToken {
                token: stored.to_owned(),
                rotated: None,
            });
        }
        let tokens = self
            .oauth()?
            .refresh(&self.http, stored)
            .await
            .map_err(|e| anyhow!("{e}; sign in to Constructor Research again"))?;
        Ok(AccessToken {
            rotated: tokens.refresh_token.filter(|t| t != stored),
            token: tokens.access_token,
        })
    }

    async fn test(&self, auth: &ConnectionAuth) -> anyhow::Result<DriverIdentity> {
        let me = ResearchApi::new(self.http.clone(), auth.root(), auth.token.clone())
            .me()
            .await?;
        Ok(DriverIdentity {
            avatar_url: None,
            checks: Vec::new(),
            display_name: me.display_name(),
            account: me.id,
        })
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    const API: &str = "https://research.example.com/api/platform-account/v1";

    fn key_only() -> ResearchDriver {
        ResearchDriver::new(reqwest::Client::new(), None, API.into())
    }

    fn signing_in() -> ResearchDriver {
        let oauth = OAuthClient {
            authorize_url: "https://idp.example.com/idp/connect/authorize".into(),
            token_url: "https://idp.example.com/idp/connect/token".into(),
            client_id: "constructor-studio".into(),
            client_secret: "s".into(),
            scope: "openid profile user platform".into(),
            redirect_uris: vec!["https://studio.example.com/connections/oauth/callback".into()],
        };
        ResearchDriver::new(reqwest::Client::new(), Some(oauth), API.into())
    }

    #[test]
    fn without_a_client_it_takes_a_pasted_key_and_offers_no_sign_in() {
        let d = key_only();
        assert!(!d.signs_in());
        assert!(d.takes_pasted_key());
        let err = d
            .sign_in_url("state", &Pkce::new(), None)
            .unwrap_err()
            .to_string();
        assert!(err.contains("paste a Research access key"), "{err}");
    }

    #[test]
    fn with_a_client_it_offers_both() {
        let d = signing_in();
        assert!(d.signs_in());
        assert!(d.takes_pasted_key());
    }

    #[test]
    fn only_a_research_access_key_is_taken_pasted() {
        let d = key_only();
        d.check_pasted_key("rk-abc123").unwrap();
        let err = d.check_pasted_key("eyJhbGciOi").unwrap_err().to_string();
        assert!(err.contains("starts with `rk-`"), "{err}");
        assert!(err.contains("make an access key"), "{err}");
    }

    #[tokio::test]
    async fn a_pasted_key_is_called_with_as_it_is() {
        let t = key_only().access_token("rk-abc123").await.unwrap();
        assert_eq!(t.token, "rk-abc123");
        assert!(t.rotated.is_none());
    }

    #[tokio::test]
    async fn a_key_studio_made_is_read_from_what_it_stored() {
        let stored = r#"{"key":"rk-made","id":"k1","expires_at":"2027-01-01T00:00:00Z"}"#;
        let t = key_only().access_token(stored).await.unwrap();
        assert_eq!(t.token, "rk-made");
    }

    #[tokio::test]
    async fn a_refresh_token_without_a_client_asks_for_a_key() {
        let err = key_only()
            .access_token("an-old-refresh-token")
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("paste a Research access key"), "{err}");
    }
}
