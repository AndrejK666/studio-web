//! Who is told that a repository's sync has finished.
//!
//! What another gear derives from a project's repositories (its components,
//! later its status and its conformance) is computed from what a sync stored,
//! not read from the provider on every request. So the derivation has to
//! know when the inputs moved: each sync that finishes tells the observers
//! registered here, which queue their own recomputation (`crate::derived_view`).
//!
//! An observer must be quick and must not fail the sync: it is called after
//! the sync's work is stored, and what it does is its own business.

use std::sync::{Arc, Mutex, OnceLock};

use async_trait::async_trait;
use toolkit_security::SecurityContext;
use uuid::Uuid;

/// One repository's sync, as it finished.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncedRepository {
    /// The tenant the sync's run belongs to (the organization that asked).
    pub run_tenant: Uuid,
    /// The project whose source it is, when it is a project's.
    pub project_id: Option<String>,
    pub workspace_id: Option<String>,
    /// `owner/repo`.
    pub repo_full_path: String,
}

/// Something that wants to know when a repository has been synced.
#[async_trait]
pub trait RepositorySynced: Send + Sync + 'static {
    /// `ctx` is the sync's worker identity in [`SyncedRepository::run_tenant`].
    async fn synced(&self, ctx: &SecurityContext, repo: &SyncedRepository);
}

fn observers() -> &'static Mutex<Vec<Arc<dyn RepositorySynced>>> {
    static OBSERVERS: OnceLock<Mutex<Vec<Arc<dyn RepositorySynced>>>> = OnceLock::new();
    OBSERVERS.get_or_init(Mutex::default)
}

/// Be told of every repository sync that finishes in this process.
pub fn on_repository_synced(observer: Arc<dyn RepositorySynced>) {
    if let Ok(mut o) = observers().lock() {
        o.push(observer);
    }
}

/// Tell every observer; called once a sync has stored its work.
pub(super) async fn notify(ctx: &SecurityContext, repo: &SyncedRepository) {
    let all: Vec<Arc<dyn RepositorySynced>> =
        observers().lock().map(|o| o.clone()).unwrap_or_default();
    for observer in all {
        observer.synced(ctx, repo).await;
    }
}
