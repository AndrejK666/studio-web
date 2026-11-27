//! studio-theia — backend-to-backend bridge to the per-session Theia node
//! backend (ADR-0022). Publishes [`sdk::TheiaControlClientV1`] for
//! studio→Theia control calls and mounts the Theia→studio event ingress.
//!
//! Phase 2: endpoint discovery resolves through [`discovery::StudioSessionResolver`]
//! (studio-session control endpoint + per-session S2S token); the event ingress
//! authenticates and republishes onto `studio-events`. Dormant
//! unless `studio-theia.enabled = true`. See
//! `docs/adr/0022-theia-backend-bridge.md` and
//! `docs/theia-bridge-contract-v1.md`.

#[cfg(feature = "theia-bridge")]
pub mod commands;
#[cfg(feature = "theia-bridge")]
pub mod config;
#[cfg(feature = "theia-bridge")]
pub mod control_client;
#[cfg(feature = "theia-bridge")]
pub mod discovery;
#[cfg(feature = "theia-bridge")]
pub mod gear;
#[cfg(feature = "theia-bridge")]
pub mod ide_bridge;
#[cfg(feature = "theia-bridge")]
pub mod rest;
#[cfg(feature = "theia-bridge")]
pub mod sdk;
#[cfg(feature = "theia-bridge")]
pub mod service;
#[cfg(feature = "theia-bridge")]
pub mod sink;

// The kit this gear belongs to, and the API domain it serves: which kits
// start is the deployment's choice (`crate::composition`, ADR-0079 §5), and
// the core lists no kit's domain (`crate::api_contract`).
inventory::submit! {
    crate::composition::KitGear {
        gear: "studio-theia",
        kit: "ide",
    }
}
inventory::submit! { crate::api_contract::ApiDomain("studio-theia") }

// Comment threads waiting on someone are answered in the IDE, on the text each
// is about: the status signal opens the IDE's tab while this kit runs.
inventory::submit! {
    crate::organizations::port::ProjectKitParts {
        kit: "ide",
        steps: &[],
        signals: &[],
        stages: &[],
        opens: &[("threads-me", "ide")],
    }
}
