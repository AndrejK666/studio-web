//! What another gear uses of the artifact graph: the scrubbing every graph
//! write needs. The sync's identity reaches the PDP through its port
//! (`studio_authz_plugin::MirrorSyncSubject`), not from here.

#[cfg(feature = "graph")]
pub(crate) use super::graph_backend::{str_without_nul, without_nul};
