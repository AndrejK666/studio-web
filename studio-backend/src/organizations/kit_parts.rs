//! Which kit owns which part of a project's status and delivery path
//! (ADR-0079 §4), declared by the kits instead of listed by the core.
//!
//! Every signal and step of a project's status, and every stage of its
//! delivery path but Sources, names the kit whose tab it opens (ADR-0070 §7):
//! a part whose kit does not apply to the project is left out
//! ([`super::status::Kits`]). The kit's gear registers what it owns in its
//! own module:
//!
//! ```ignore
//! inventory::submit! {
//!     crate::organizations::port::ProjectKitParts {
//!         kit: "project-product",
//!         steps: &["kind", "product"],
//!         signals: &["product"],
//!         stages: &[PathStage { id: "product", title: "Product", tab: "product" }],
//!     }
//! }
//! ```
//!
//! What a step, signal or stage is and where it stands on the path stay the
//! core's (`status.rs`, `project_path.rs`); a part no kit claims is the
//! shell's own.

/// The parts of a project's status and path one kit owns.
pub struct ProjectKitParts {
    /// The kit (`project-specs`), as `kit_registry` lists it.
    pub kit: &'static str,
    /// Steps of the status path done in its tab (`types`, `model`).
    pub steps: &'static [&'static str],
    /// Signals read for it, by key (`stuck`, `specs`).
    pub signals: &'static [&'static str],
    /// Stages of the delivery path (`project_path.rs`) shown in its tab.
    pub stages: &'static [PathStage],
}

/// A stage of the delivery path, as the kit whose tab holds it says it.
pub struct PathStage {
    /// The stage (`documents`, `build`): one of `project_path::STAGES`.
    pub id: &'static str,
    /// Its title (`Domain model`).
    pub title: &'static str,
    /// The project tab that holds its evidence (`releases`).
    pub tab: &'static str,
}

inventory::collect!(ProjectKitParts);

fn registered() -> impl Iterator<Item = &'static ProjectKitParts> {
    inventory::iter::<ProjectKitParts>.into_iter()
}

/// The kit a step of the status path is done in; `None` for the shell's own.
pub fn step_kit(id: &str) -> Option<&'static str> {
    registered().find(|p| p.steps.contains(&id)).map(|p| p.kit)
}

/// The kit a signal belongs to, by its key; `None` for the shell's own.
pub fn signal_kit(key: &str) -> Option<&'static str> {
    registered()
        .find(|p| p.signals.contains(&key))
        .map(|p| p.kit)
}

/// A delivery path stage's title, tab and kit, as its kit declares it.
pub fn stage(id: &str) -> Option<(&'static str, &'static str, &'static str)> {
    registered().find_map(|p| {
        p.stages
            .iter()
            .find(|s| s.id == id)
            .map(|s| (s.title, s.tab, p.kit))
    })
}
