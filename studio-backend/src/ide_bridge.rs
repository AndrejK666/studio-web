//! The IDE a workspace has open, as the core reaches it (ADR-0079).
//!
//! studio-notify shows a message in a workspace's IDE, and studio-kits asks it
//! which repositories it has and installs a kit into one. Neither names the
//! gear that talks to the IDE: the IDE kit's gear (studio-theia, behind the
//! `theia-bridge` feature) registers an [`IdeBridge`] in the `ClientHub` when
//! it is wired, and a deployment without it has none. Every error the bridge
//! returns is already a sentence for the caller.

use async_trait::async_trait;
use toolkit_security::SecurityContext;
use uuid::Uuid;

/// Whether a workspace's IDE session can show something now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdeStatus {
    pub ready: bool,
    /// What the session is doing, for a message while it is not ready.
    pub workspace_mode: String,
}

/// A notification for the IDE to show.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorNote {
    /// `info`, `warning` or `error`.
    pub level: String,
    /// The headline.
    pub message: String,
    /// The line beneath it.
    pub detail: Option<String>,
    pub link: Option<String>,
    /// Who it is from.
    pub source: Option<String>,
}

/// One repository the IDE session has checked out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdeRepository {
    pub repository_id: String,
    pub label: String,
    /// `"project"` or `"source"`.
    pub kind: String,
    pub git_mode: Option<String>,
}

/// One file of a kit's IDE sources, as it travels to the IDE.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct IdeKitFile {
    pub path: String,
    /// Base64 keeps the exact bytes of text and binary files.
    pub content: String,
}

/// A kit to install into a repository of the IDE session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdeKitInstall {
    pub kit_slug: String,
    pub version: String,
    /// `None`: the IDE picks.
    pub repository_id: Option<String>,
    /// The kit's files, when they come from the organization's shelf.
    pub shelf_files: Option<Vec<IdeKitFile>>,
}

/// Where the IDE installed a kit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdeKitInstalled {
    pub repository_id: String,
    pub repository_label: String,
}

/// The IDE of a workspace, as the IDE kit's gear reaches it.
#[async_trait]
pub trait IdeBridge: Send + Sync {
    async fn status(&self, ctx: &SecurityContext, workspace_id: Uuid) -> anyhow::Result<IdeStatus>;

    /// `true` when an editor showed it; `false` when the session took it and
    /// no editor was open.
    async fn notify(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        note: &EditorNote,
    ) -> anyhow::Result<bool>;

    async fn repositories(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
    ) -> anyhow::Result<Vec<IdeRepository>>;

    async fn install_kit(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        kit: IdeKitInstall,
    ) -> anyhow::Result<IdeKitInstalled>;
}

/// Why there is no bridge to reach, in the words each caller used before the
/// port: a build without the IDE kit's gear cannot grow one, a deployment that
/// switched it off can.
pub fn compiled_in() -> bool {
    cfg!(feature = "theia-bridge")
}
