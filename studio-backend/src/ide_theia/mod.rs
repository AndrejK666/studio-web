//! The `ide-theia` kit's runtime (ADR-0080 §3): the Theia session image as
//! studio-session launches and reaches it. Today's IDE, unchanged: the image,
//! the gate on 3003, the `theia` container, and the v1 control path and token
//! the image has always answered on (an image from before v2 answers only
//! those, so the backend keeps dialling them). The bridge gear is
//! `studio_theia`, behind the `theia-bridge` feature; this descriptor is not,
//! because a session launches whether or not the bridge is linked.

use crate::ide_runtime::{Capability, IdeControl, IdeRuntime};

/// v1 (`ide-bridge/protocol.json`, `control.v1`).
pub const CONTROL_V1: IdeControl = IdeControl {
    path: "/internal/theia/v1",
    header: "X-CFS-Theia-Token",
    token_env: "STUDIO_THEIA_S2S_TOKEN",
};

inventory::submit! {
    IdeRuntime {
        id: "theia",
        label: "Theia",
        default_image: "ghcr.io/constructorfabric/studio-web/cf-studio-theia:edge",
        container_port: 3003,
        container_name: "theia",
        launch_env: &[],
        control: CONTROL_V1,
        adopt_token_envs: &["STUDIO_THEIA_S2S_TOKEN", "STUDIO_IDE_CONTROL_TOKEN"],
        capabilities: &Capability::ALL,
        default: true,
    }
}
