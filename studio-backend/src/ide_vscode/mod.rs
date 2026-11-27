//! The `ide-vscode` kit's runtime (ADR-0080 §3): openvscode-server on the
//! shared session base, with the `constructorfabric.studio-bridge` extension
//! serving the v2 control endpoint behind the same gate on 3003.
//!
//! The minimal flavour: files, portal documents (read-only), notifications and
//! repositories. No git operation queue, no kit install, one person per
//! session, no idle report (the extension host cannot see the browser), no
//! desktop app, and no frame channel — the portal reaches it through the
//! backend's control channel only. Its bridge is the same control client as
//! Theia's on the v2 path, so it has no gear of its own.

use crate::ide_runtime::{CONTROL_V2, Capability, IdeRuntime};

inventory::submit! {
    IdeRuntime {
        id: "vscode",
        label: "VS Code",
        default_image: "ghcr.io/constructorfabric/studio-web/cf-studio-vscode:edge",
        container_port: 3003,
        container_name: "ide",
        launch_env: &["STUDIO_IDE=vscode"],
        control: CONTROL_V2,
        adopt_token_envs: &["STUDIO_IDE_CONTROL_TOKEN"],
        capabilities: &[
            Capability::OpenFile,
            Capability::OpenDocument,
            Capability::Notify,
            Capability::Repositories,
        ],
        default: false,
    }
}
