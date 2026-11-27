//! The IDE a session runs, as the core launches and reaches it (ADR-0080 §2).
//!
//! studio-session keeps everything that is the same whatever the IDE is: the
//! lifecycle, the drivers, the gate, the checkout, the brokers. What differs
//! is a runtime's: its image, the port and container name the gate holds, the
//! env it starts with, the path and token the backend reaches it on, and what
//! it can do. An IDE kit registers one [`IdeRuntime`] with `inventory`; the
//! core never names one. [`crate::ide_bridge::IdeBridge`] stays the control
//! half: the calls the core makes over the endpoint described here.
//!
//! A session records the runtime it started with (the container label
//! [`LABEL`]) and keeps it for its life, whatever the deployment chooses
//! later. A session that carries no label predates the port and is the
//! runtime that declares itself [`IdeRuntime::default`].

/// The container label a session's runtime id is recorded under.
pub const LABEL: &str = "cf.studio/ide";

/// How the backend reaches an IDE's control API, and how it proves itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IdeControl {
    /// The path prefix under the session's address, e.g. `/internal/ide/v2`.
    pub path: &'static str,
    /// The header the per-session token travels on.
    pub header: &'static str,
    /// The container env the token is handed over in.
    pub token_env: &'static str,
}

/// The control protocol every IDE speaks from v2 on
/// (`ide-bridge/protocol.json`, `control.v2`).
pub const CONTROL_V2: IdeControl = IdeControl {
    path: "/internal/ide/v2",
    header: "X-CFS-Ide-Token",
    token_env: "STUDIO_IDE_CONTROL_TOKEN",
};

/// What an IDE can be asked to do. The core and the portal read these before
/// they ask; a call a runtime has not flagged is answered with
/// [`IdeRuntime::cannot`], a sentence, never a 404 from the IDE.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Capability {
    /// Open a workspace file from the portal.
    OpenFile,
    /// Open a portal document.
    OpenDocument,
    /// Show a notification.
    Notify,
    /// List the repositories the session has checked out.
    Repositories,
    /// The git operation queue and its journal.
    Operations,
    /// Install a kit into a repository of the session.
    InstallKit,
    /// Many people in one session, each as themselves (ADR-0030).
    SharedSession,
    /// Report how long no browser has had the IDE open.
    IdleReport,
    /// A desktop app of the same IDE (ADR-0027).
    Desktop,
    /// The portal's frame `postMessage` channel to the IDE page.
    FrameChannel,
}

impl Capability {
    pub const ALL: [Capability; 10] = [
        Capability::OpenFile,
        Capability::OpenDocument,
        Capability::Notify,
        Capability::Repositories,
        Capability::Operations,
        Capability::InstallKit,
        Capability::SharedSession,
        Capability::IdleReport,
        Capability::Desktop,
        Capability::FrameChannel,
    ];

    /// The wire name (`ide-bridge/protocol.json`, `capabilities`).
    pub fn name(self) -> &'static str {
        match self {
            Self::OpenFile => "open_file",
            Self::OpenDocument => "open_document",
            Self::Notify => "notify",
            Self::Repositories => "repositories",
            Self::Operations => "operations",
            Self::InstallKit => "install_kit",
            Self::SharedSession => "shared_session",
            Self::IdleReport => "idle_report",
            Self::Desktop => "desktop",
            Self::FrameChannel => "frame_channel",
        }
    }

    /// What it is to do it, for "this IDE cannot …".
    fn act(self) -> &'static str {
        match self {
            Self::OpenFile => "open a file from Studio",
            Self::OpenDocument => "open a Studio document",
            Self::Notify => "show a Studio notification",
            Self::Repositories => "list its repositories",
            Self::Operations => "queue git operations",
            Self::InstallKit => "install a kit",
            Self::SharedSession => "share one session among several people",
            Self::IdleReport => "report whether anyone has it open",
            Self::Desktop => "open in a desktop app",
            Self::FrameChannel => "talk to the portal page it is shown in",
        }
    }
}

/// The capability a control method needs (`ide-bridge/protocol.json`,
/// `control.methods`). `None`: every IDE answers it, or it is not a method.
pub fn method_capability(method: &str) -> Option<Capability> {
    match method {
        "getRepositories" => Some(Capability::Repositories),
        "enqueueOperation" | "getOperationDeltas" | "retryOperation" => {
            Some(Capability::Operations)
        }
        "openInEditor" => Some(Capability::OpenFile),
        "openDocument" => Some(Capability::OpenDocument),
        "notifyEditor" => Some(Capability::Notify),
        "installKit" => Some(Capability::InstallKit),
        _ => None,
    }
}

/// One IDE a session can run, as its kit registers it.
#[derive(Debug)]
pub struct IdeRuntime {
    /// `theia`, `vscode`: the label value and the config's name for it.
    pub id: &'static str,
    /// What a person calls it, in sentences.
    pub label: &'static str,
    /// The image when the deployment names none.
    pub default_image: &'static str,
    /// The port the session's gate holds inside the container.
    pub container_port: u16,
    /// The container's name in a Kubernetes Pod.
    pub container_name: &'static str,
    /// `KEY=VALUE` pairs the runtime starts with, beside the core's own.
    pub launch_env: &'static [&'static str],
    /// The control endpoint the backend dials for this runtime.
    pub control: IdeControl,
    /// Where adoption reads the control token back from, first found wins: a
    /// session started before a switch keeps its bridge.
    pub adopt_token_envs: &'static [&'static str],
    pub capabilities: &'static [Capability],
    /// The runtime of a session that carries no [`LABEL`], and of a
    /// deployment that names none. Exactly one runtime declares it.
    pub default: bool,
}

inventory::collect!(IdeRuntime);

impl IdeRuntime {
    pub fn can(&self, capability: Capability) -> bool {
        self.capabilities.contains(&capability)
    }

    /// "this IDE (VS Code) cannot install a kit".
    pub fn cannot(&self, capability: Capability) -> String {
        format!("this IDE ({}) cannot {}", self.label, capability.act())
    }

    /// The flagged capabilities' wire names, in [`Capability::ALL`]'s order.
    pub fn capability_names(&self) -> Vec<&'static str> {
        Capability::ALL
            .into_iter()
            .filter(|c| self.can(*c))
            .map(Capability::name)
            .collect()
    }
}

/// Every runtime this build registers.
pub fn all() -> impl Iterator<Item = &'static IdeRuntime> {
    inventory::iter::<IdeRuntime>.into_iter()
}

pub fn by_id(id: &str) -> Option<&'static IdeRuntime> {
    all().find(|r| r.id == id)
}

/// The runtime that declares itself the default.
pub fn default_runtime() -> Option<&'static IdeRuntime> {
    all().find(|r| r.default)
}

/// The runtime a deployment named, or the default when it named none.
pub fn resolve(named: Option<&str>) -> anyhow::Result<&'static IdeRuntime> {
    match named.map(str::trim).filter(|n| !n.is_empty()) {
        Some(id) => by_id(id).ok_or_else(|| {
            let known: Vec<&str> = all().map(|r| r.id).collect();
            anyhow::anyhow!(
                "no IDE called `{id}` is in this build (it has: {})",
                known.join(", ")
            )
        }),
        None => default_runtime().ok_or_else(|| anyhow::anyhow!("this build has no IDE")),
    }
}

/// The runtime a session recorded, from its [`LABEL`]: none is the default
/// runtime's; one this build no longer has is `None`.
pub fn of_label(label: Option<&str>) -> Option<&'static IdeRuntime> {
    match label.map(str::trim).filter(|l| !l.is_empty()) {
        Some(id) => by_id(id),
        None => default_runtime(),
    }
}

#[cfg(test)]
#[path = "ide_runtime_tests.rs"]
mod tests;
