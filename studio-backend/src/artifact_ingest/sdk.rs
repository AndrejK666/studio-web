//! What another gear uses of the artifact graph: the scrubbing every graph
//! write needs, and the sync's identity to the GitHub mirror.

/// Who the artifact sync is when it reads through the GitHub mirror; the
/// Studio PDP lets only it reach the mirror (#1094).
pub use super::mirror_identity::MirrorSyncIdentity;

#[cfg(feature = "graph")]
pub(crate) use super::graph_backend::{str_without_nul, without_nul};
