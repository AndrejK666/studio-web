//! Resolving a session to its IDE control endpoint + S2S token.
//!
//! [`StudioSessionResolver`] consumes the studio-session discovery client from
//! `ClientHub` (looked up lazily, so gear init order does not matter) and maps
//! its [`IdeControlEndpoint`](crate::studio_session::sdk::IdeControlEndpoint)
//! onto a dial-able [`TheiaEndpoint`]. Tenant scoping happens inside
//! studio-session, under the caller's `SecurityContext`. The endpoint carries
//! the session's IDE runtime (ADR-0080): Theia's on the v1 path, any other on
//! v2, so this one client reaches both.

use std::sync::Arc;

use async_trait::async_trait;
use toolkit::client_hub::ClientHub;
use toolkit_canonical_errors::CanonicalError;
use toolkit_security::SecurityContext;

use crate::studio_session::sdk::{
    DesktopSessionsClientV1, SessionIdentity, StudioSessionDiscoveryClientV1,
};
use crate::studio_theia::sdk::{SessionTarget, TheiaControlError};

/// A concrete, dial-able IDE control endpoint for one session.
#[derive(Debug, Clone)]
pub struct TheiaEndpoint {
    /// Base URL of the internal control API, e.g. `http://127.0.0.1:41007`.
    pub base_url: String,
    /// S2S token to present on the runtime's control header.
    pub token: String,
    /// The session's IDE: the path and header to call it on, and what it can
    /// be asked.
    pub runtime: &'static crate::ide_runtime::IdeRuntime,
}

/// Resolves a [`SessionTarget`] to a [`TheiaEndpoint`] under the caller's
/// identity (so the tenant boundary is enforced before any container call).
#[async_trait]
pub trait TheiaEndpointResolver: Send + Sync {
    async fn resolve(
        &self,
        ctx: &SecurityContext,
        target: &SessionTarget,
    ) -> Result<TheiaEndpoint, TheiaControlError>;
}

/// Reverse-resolves a per-session S2S control token to its trusted session
/// identity. Separate from [`TheiaEndpointResolver`] because it runs with NO
/// caller `SecurityContext`: the token is the credential the ingress uses to
/// mint one.
#[async_trait]
pub trait ControlTokenResolver: Send + Sync {
    async fn resolve_token(
        &self,
        token: &str,
    ) -> Result<Option<SessionIdentity>, TheiaControlError>;
}

/// Resolver backed by the studio-session discovery client (ADR-0022 phase 2).
pub struct StudioSessionResolver {
    hub: Arc<ClientHub>,
}

impl StudioSessionResolver {
    pub fn new(hub: Arc<ClientHub>) -> Self {
        Self { hub }
    }
}

#[async_trait]
impl TheiaEndpointResolver for StudioSessionResolver {
    async fn resolve(
        &self,
        ctx: &SecurityContext,
        target: &SessionTarget,
    ) -> Result<TheiaEndpoint, TheiaControlError> {
        let discovery = self
            .hub
            .try_get::<dyn StudioSessionDiscoveryClientV1>()
            .ok_or_else(|| {
                CanonicalError::service_unavailable()
                    .with_detail("studio-session discovery client is not available")
                    .create()
            })?;
        let endpoint = discovery
            .resolve_ide_control(ctx, target.workspace_id)
            .await?
            .ok_or_else(|| {
                CanonicalError::service_unavailable()
                    .with_detail(format!(
                        "no live IDE session with a control endpoint for workspace {}",
                        target.workspace_id
                    ))
                    .create()
            })?;
        Ok(TheiaEndpoint {
            base_url: endpoint.base_url,
            token: endpoint.token,
            runtime: endpoint.runtime,
        })
    }
}

#[async_trait]
impl ControlTokenResolver for StudioSessionResolver {
    async fn resolve_token(
        &self,
        token: &str,
    ) -> Result<Option<SessionIdentity>, TheiaControlError> {
        let discovery = self
            .hub
            .try_get::<dyn StudioSessionDiscoveryClientV1>()
            .ok_or_else(|| {
                CanonicalError::service_unavailable()
                    .with_detail("studio-session discovery client is not available")
                    .create()
            })?;
        Ok(discovery.resolve_control_token(token).await?)
    }
}

/// Finds the caller's own live desktop session (ADR-0027 phases 4 and 5): a
/// desktop has no S2S token, so its events and the commands sent to it are
/// authorized by the member's token and the lease it holds.
#[async_trait]
pub trait DesktopSessionResolver: Send + Sync {
    async fn resolve_own_desktop(
        &self,
        ctx: &SecurityContext,
        desktop_session_id: uuid::Uuid,
    ) -> Result<Option<SessionIdentity>, TheiaControlError>;
}

#[async_trait]
impl DesktopSessionResolver for StudioSessionResolver {
    async fn resolve_own_desktop(
        &self,
        ctx: &SecurityContext,
        desktop_session_id: uuid::Uuid,
    ) -> Result<Option<SessionIdentity>, TheiaControlError> {
        let desktops = self
            .hub
            .try_get::<dyn DesktopSessionsClientV1>()
            .ok_or_else(|| {
                CanonicalError::service_unavailable()
                    .with_detail("studio-session desktop sessions are not available")
                    .create()
            })?;
        Ok(desktops
            .resolve_own_desktop_session(ctx, desktop_session_id)
            .await)
    }
}
