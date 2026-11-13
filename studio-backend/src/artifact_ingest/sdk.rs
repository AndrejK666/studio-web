//! What another gear uses of the artifact graph: the scrubbing every graph
//! write needs, and who the sync is to the GitHub mirror.

/// The subject (and its type) every mirror call of the artifact sync is made
/// as; the Studio PDP lets only it reach the mirror (#1094).
#[allow(unused_imports)] // read by the PDP once #1094's rule lands
pub use super::mirror::{MIRROR_SYNC_SUBJECT_ID, SERVICE_SUBJECT_TYPE};

#[cfg(feature = "graph")]
pub(crate) use super::graph_backend::{str_without_nul, without_nul};
