//! Who the artifact sync is when it reads through the GitHub mirror (#1094).
//!
//! A connection with `platform_auth` is read through the github-mirror gear,
//! and the sync calls it with a token of the OAuth client configured in this
//! gear's `client_credentials`. The Studio PDP lets that identity, and nobody
//! else, reach the mirror's resources, so it has to know which subject the
//! client's token resolves to.
//!
//! The answer comes from the same exchange the sync makes, not from a
//! hard-coded id: the subject is whatever the identity provider says the
//! configured client is. It is resolved once and kept, because a client's
//! service account does not change while the process runs.

use std::sync::{Arc, OnceLock};

use anyhow::anyhow;
use authn_resolver_sdk::{AuthNResolverClient, ClientCredentialsRequest};
use secrecy::SecretString;
use toolkit_security::SecurityContext;
use tracing::warn;
use uuid::Uuid;

/// The artifact sync's service identity: the configured OAuth client.
pub struct MirrorSyncIdentity {
    authn: Arc<dyn AuthNResolverClient>,
    client_id: String,
    client_secret: String,
    /// The subject the client's token resolved to, once one exchange has
    /// succeeded.
    subject: OnceLock<Uuid>,
}

impl MirrorSyncIdentity {
    #[must_use]
    pub fn new(
        authn: Arc<dyn AuthNResolverClient>,
        client_id: String,
        client_secret: String,
    ) -> Self {
        Self {
            authn,
            client_id,
            client_secret,
            subject: OnceLock::new(),
        }
    }

    /// Exchange the client's credentials for a token, and remember whose
    /// token it is.
    ///
    /// # Errors
    /// When the identity provider refuses the exchange.
    pub async fn exchange(&self) -> anyhow::Result<SecurityContext> {
        let result = self
            .authn
            .exchange_client_credentials(&ClientCredentialsRequest {
                client_id: self.client_id.clone(),
                client_secret: SecretString::from(self.client_secret.clone()),
                scopes: Vec::new(),
            })
            .await
            .map_err(|e| anyhow!("client credentials exchange failed: {e}"))?;
        let ctx = result.security_context;
        let _ = self.subject.set(ctx.subject_id());
        Ok(ctx)
    }

    /// The subject the configured client's token carries, or `None` when the
    /// exchange cannot be made. `None` means nobody is the sync, so the PDP
    /// refuses every mirror request: the failure narrows, never widens.
    pub async fn subject_id(&self) -> Option<Uuid> {
        if let Some(subject) = self.subject.get() {
            return Some(*subject);
        }
        match self.exchange().await {
            Ok(ctx) => Some(ctx.subject_id()),
            Err(error) => {
                warn!(client_id = %self.client_id, %error, "the artifact sync's identity could not be resolved");
                None
            }
        }
    }
}
