//! Who reaches a workspace's session.
//!
//! ## The question this gear was asking, and why it was the wrong one
//!
//! A session's identity has never carried a tenant. [`session_id_for`] is a
//! UUIDv5 over the WORKSPACE, the runtime names the Pod
//! `cf-studio-session-<workspace>`, and the REST contract says "idempotent per
//! workspace". Every lookup, though, compared the CALLER's home tenant with the
//! home tenant of whoever happened to launch the session — a property of a
//! person, not of the thing being reached.
//!
//! That comparison could not isolate anything, because two tenants asking for
//! one workspace are two attempts at one Pod name. What it did instead was
//! miss. Measured on the dev stand: a platform administrator (home tenant =
//! the platform root) and a member of the workspace's own tenant opened one
//! project. Neither lookup found the other's session, each fell through to
//! `launch`, and the driver — which names the Pod after the workspace alone —
//! destroyed the live container to make room for its replacement. Four
//! `Killing` events in eighteen minutes, each in the same second as a
//! `POST /v1/sessions`, each throwing the other person out of the IDE they were
//! typing in, each first refused by the namespace CPU quota because the Pod it
//! had just killed was still charged for. Co-editing cannot occur at all in
//! that state: every Pod's log holds exactly one frontend, so the collaboration
//! roster was always right to say nobody else was there.
//!
//! ## The question to ask instead
//!
//! ADR-0019: **"access to a project is membership, not a privilege"**. Projects
//! and workspaces are account-management tenants (ADR-0010), and the assembly
//! already has one way to ask whether a caller reaches one — resolve it under
//! the caller's own `SecurityContext`. Account-management answers `NotFound`
//! for a tenant outside the caller's PDP-compiled subtree, so the read IS the
//! decision. `documents` and `studio-kits` guard their workspace routes exactly
//! this way; this is the same guard, in front of this gear's.
//!
//! ## Why a trait rather than a call
//!
//! The same reason [`super::driver::SessionDriver`] is one: the part with the
//! rule in it is the part worth testing, and a test that has to stand up
//! account-management to reach a yes/no is a test nobody runs.

use std::sync::Arc;

use account_management_sdk::AccountManagementClient;
use async_trait::async_trait;
use toolkit_security::SecurityContext;
use uuid::Uuid;

/// May this caller reach this workspace at all?
///
/// Deliberately a yes/no and not a `Result`: the read paths turn "not yours"
/// and "not there" into the same answer on purpose, and a caller that had to
/// distinguish them would leak which workspaces exist.
#[async_trait]
pub trait WorkspaceAccess: Send + Sync + 'static {
    async fn may_reach(&self, ctx: &SecurityContext, workspace_id: Uuid) -> bool;
}

/// The real one: membership, as account-management understands it.
pub struct TenantMembership {
    client: Arc<dyn AccountManagementClient>,
}

impl TenantMembership {
    pub fn new(client: Arc<dyn AccountManagementClient>) -> Self {
        Self { client }
    }
}

#[async_trait]
impl WorkspaceAccess for TenantMembership {
    async fn may_reach(&self, ctx: &SecurityContext, workspace_id: Uuid) -> bool {
        match self.client.get_tenant(ctx, workspace_id).await {
            Ok(_) => true,
            Err(e) => {
                // Logged at debug, and without the caller's identity: a refusal
                // is the ordinary answer for a workspace somebody does not have
                // and is not worth a warning per poll.
                tracing::debug!(
                    workspace_id = %workspace_id,
                    "studio-session: workspace not reachable by this caller ({e})"
                );
                false
            }
        }
    }
}

/// The caller does not reach this workspace.
///
/// A marker rather than a message, and carried through `anyhow` for
/// [`super::driver::NoCapacity`]'s reason: the REST layer recovers it with
/// `downcast_ref` and answers 404, which is what `get_session` and
/// `delete_session` already answer for a session somebody may not have. A
/// refusal is not an internal error, and "no such workspace" is the only thing
/// worth telling a caller who cannot see it — naming the difference would be
/// telling them it exists.
#[derive(Debug)]
pub struct NotReachable {
    pub workspace_id: Uuid,
}

impl std::fmt::Display for NotReachable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "workspace {} is not reachable by this caller",
            self.workspace_id
        )
    }
}

impl std::error::Error for NotReachable {}
