//! How a clone or fetch of a project's source went, and the port its writers
//! record it through (#1071).
//!
//! A core port (ADR-0079): the code paths that clone a project's sources (an
//! IDE session's launch, Studio's Git remote, the server's sync) say how it
//! went through [`CloneOutcomes`], which the gear that keeps clone status
//! registers in the `ClientHub`. A deployment without that gear records
//! nothing, and the writers never name it.

use async_trait::async_trait;

/// Who cloned or fetched a source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloneChannel {
    /// A desktop, through Studio's Git remote (`studio-git`).
    Desktop,
    /// A portal IDE session, at its launch.
    IdeSession,
    /// The server's own sync, fetching the checkout the IDE shares.
    Sync,
}

impl CloneChannel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Desktop => "desktop",
            Self::IdeSession => "ide_session",
            Self::Sync => "sync",
        }
    }
}

/// What fixes a failed clone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloneAction {
    /// Pick a connection for the source.
    Connect,
    /// Pick the source's connection again, or give it a token that works.
    Reconnect,
    /// Something only an organization admin can change.
    AskAdmin,
    /// The repository's name or URL is wrong, or the connection cannot see it.
    CheckRepository,
    /// Nothing is wrong on Studio's side; try again later.
    Retry,
    /// The source names a branch the repository no longer has.
    PickBranch,
}

impl CloneAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Connect => "connect",
            Self::Reconnect => "reconnect",
            Self::AskAdmin => "ask_admin",
            Self::CheckRepository => "check_repository",
            Self::Retry => "retry",
            Self::PickBranch => "pick_branch",
        }
    }

    /// The action in a sentence, for a reader without the portal's labels.
    pub fn text(self) -> &'static str {
        match self {
            Self::Connect => "Connect the source through one of the organization's connections.",
            Self::Reconnect => {
                "Reconnect the source: pick its connection again, or update the connection's token."
            }
            Self::AskAdmin => {
                "Ask an organization admin to connect the repository through the organization's own connection."
            }
            Self::CheckRepository => {
                "Check the repository's name and URL, and that the connection can see it."
            }
            Self::Retry => "Try again later; the repository's host did not answer.",
            Self::PickBranch => {
                "Point the source at a branch that exists, or connect the repository again on its default branch."
            }
        }
    }
}

/// Why a clone failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloneCause {
    /// The source names no connection, and its host asked for credentials,
    /// or answered 404, which a private repository can hide behind.
    NoConnection,
    /// The source names a connection that is not found from the project.
    ConnectionNotFound,
    /// The connection is one person's, and its token is not lent to others.
    ConnectionPersonal,
    /// The connection is held outside the project's organization.
    HeldOutside,
    /// The connection's token could not be read.
    TokenUnreadable,
    /// The host refused the token (401/403).
    ProviderRefused,
    /// The host says the repository does not exist (404).
    RepositoryNotFound,
    /// The host could not be reached.
    Unreachable,
    /// The host failed to answer (any other status).
    ProviderError,
    /// The source is not an http(s) repository.
    NotHttp,
    /// The branch the source names is gone from the repository (deleted
    /// after a merge, say); `detail` names it.
    BranchNotFound,
}

impl CloneCause {
    pub(crate) const ALL: [Self; 11] = [
        Self::BranchNotFound,
        Self::NoConnection,
        Self::ConnectionNotFound,
        Self::ConnectionPersonal,
        Self::HeldOutside,
        Self::TokenUnreadable,
        Self::ProviderRefused,
        Self::RepositoryNotFound,
        Self::Unreachable,
        Self::ProviderError,
        Self::NotHttp,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::NoConnection => "no_connection",
            Self::ConnectionNotFound => "connection_not_found",
            Self::ConnectionPersonal => "connection_personal",
            Self::HeldOutside => "held_outside",
            Self::TokenUnreadable => "token_unreadable",
            Self::ProviderRefused => "provider_refused",
            Self::RepositoryNotFound => "repository_not_found",
            Self::Unreachable => "unreachable",
            Self::ProviderError => "provider_error",
            Self::NotHttp => "not_http",
            Self::BranchNotFound => "branch_not_found",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|c| c.as_str() == value)
    }

    /// What fixes it.
    pub fn action(self) -> CloneAction {
        match self {
            Self::NoConnection | Self::ConnectionPersonal => CloneAction::Connect,
            Self::ConnectionNotFound | Self::TokenUnreadable | Self::ProviderRefused => {
                CloneAction::Reconnect
            }
            Self::HeldOutside => CloneAction::AskAdmin,
            Self::RepositoryNotFound | Self::NotHttp => CloneAction::CheckRepository,
            Self::Unreachable | Self::ProviderError => CloneAction::Retry,
            Self::BranchNotFound => CloneAction::PickBranch,
        }
    }

    /// The cause in a plain sentence.
    pub fn text(self) -> &'static str {
        match self {
            Self::NoConnection => {
                "The source names no connection, and the repository's host did not serve it without credentials."
            }
            Self::ConnectionNotFound => {
                "The source's connection was not found, so it was cloned without a token."
            }
            Self::ConnectionPersonal => {
                "The source's connection is one person's, and its token is not lent to others."
            }
            Self::HeldOutside => {
                "The source's connection is held outside the organization, so its token is not used."
            }
            Self::TokenUnreadable => "The connection's token could not be read.",
            Self::ProviderRefused => "The repository's host refused the connection's token.",
            Self::RepositoryNotFound => "The repository's host answered that it does not exist.",
            Self::Unreachable => "The repository's host could not be reached.",
            Self::ProviderError => "The repository's host failed to answer.",
            Self::NotHttp => {
                "The source is not an http(s) repository, so it cannot be cloned through Studio."
            }
            Self::BranchNotFound => {
                "The branch the source names no longer exists on the repository's host."
            }
        }
    }
}

/// Why a clone failed, with what else is known.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloneFailure {
    pub cause: CloneCause,
    /// The source host's HTTP status, when it answered one.
    pub upstream_status: Option<u16>,
    /// Free text; the gear that keeps it redacts it before it is stored.
    pub detail: String,
}

impl CloneFailure {
    pub fn new(cause: CloneCause) -> Self {
        Self {
            cause,
            upstream_status: None,
            detail: String::new(),
        }
    }

    #[must_use]
    pub fn with_status(mut self, status: u16) -> Self {
        self.upstream_status = Some(status);
        self
    }

    #[must_use]
    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = detail.into();
        self
    }
}

/// One clone or fetch: `failure` is `None` when it went through.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloneOutcome {
    pub channel: CloneChannel,
    pub failure: Option<CloneFailure>,
    /// When it happened, as a [`clone_order`]: stamped where the outcome is
    /// built, before the writer hands it to a background task, so a write
    /// that reaches the database late cannot pass for the newer one.
    pub order: i64,
}

impl CloneOutcome {
    pub fn cloned(channel: CloneChannel) -> Self {
        Self {
            channel,
            failure: None,
            order: clone_order(),
        }
    }

    pub fn failed(channel: CloneChannel, failure: CloneFailure) -> Self {
        Self {
            channel,
            failure: Some(failure),
            order: clone_order(),
        }
    }
}

/// The order of clone-status operations: nanoseconds since the epoch, and
/// strictly increasing within this process, so two operations in the same
/// millisecond, or the same nanosecond, still have an order.
///
/// The store applies an operation only over an older one (#1070 review): an
/// outcome replaces the stored row when its order is greater, and a
/// [`clear_failure`](CloneOutcomes::clear_failure) deletes a
/// failure only when the failure's order is smaller. Equal orders (two
/// replicas in the same nanosecond) keep what is stored.
pub fn clone_order() -> i64 {
    use std::sync::atomic::{AtomicI64, Ordering};
    static LAST: AtomicI64 = AtomicI64::new(0);
    let now = i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    )
    .unwrap_or(i64::MAX);
    let mut last = LAST.load(Ordering::Relaxed);
    loop {
        let next = now.max(last.saturating_add(1));
        match LAST.compare_exchange_weak(last, next, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => return next,
            Err(seen) => last = seen,
        }
    }
}

/// Where the code paths that clone a project's sources say how it went
/// (#1071): `studio-git` for a desktop's clone or fetch, `studio-session` for
/// an IDE session's launch. Only the last outcome per (project, repository)
/// is kept. Absent where the gear has no database; a writer that resolves
/// nothing records nothing.
#[async_trait]
pub trait CloneOutcomes: Send + Sync + 'static {
    /// Record the outcome of a clone or fetch of `clone_url`, a source of
    /// `project`. The URL is reduced to host and path; no credential in it is
    /// kept. An outcome older than the stored one (by `order`) is dropped.
    async fn record(
        &self,
        project: uuid::Uuid,
        clone_url: &str,
        outcome: CloneOutcome,
    ) -> anyhow::Result<()>;

    /// Forget a failure `channel` recorded for `clone_url`, now that it no
    /// longer holds. Anything else recorded is kept, and so is a failure
    /// recorded after `order`: a [`clone_order`] taken when the caller learnt
    /// that the failure no longer holds.
    async fn clear_failure(
        &self,
        project: uuid::Uuid,
        clone_url: &str,
        channel: CloneChannel,
        order: i64,
    ) -> anyhow::Result<()>;
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use toolkit::client_hub::ClientHub;

    use super::*;

    #[derive(Default)]
    struct Kept(Mutex<Vec<(String, Option<CloneCause>)>>);

    #[async_trait]
    impl CloneOutcomes for Kept {
        async fn record(
            &self,
            _: uuid::Uuid,
            clone_url: &str,
            outcome: CloneOutcome,
        ) -> anyhow::Result<()> {
            self.0
                .lock()
                .unwrap()
                .push((clone_url.to_owned(), outcome.failure.map(|f| f.cause)));
            Ok(())
        }

        async fn clear_failure(
            &self,
            _: uuid::Uuid,
            _: &str,
            _: CloneChannel,
            _: i64,
        ) -> anyhow::Result<()> {
            Ok(())
        }
    }

    /// A writer reaches the store the keeping gear registered, by the port
    /// alone; each outcome is ordered after the one before it.
    #[tokio::test]
    async fn a_writer_records_through_the_registered_port() {
        let hub = ClientHub::new();
        let kept = Arc::new(Kept::default());
        hub.register::<dyn CloneOutcomes>(kept.clone());
        let outcomes = hub.get::<dyn CloneOutcomes>().unwrap();
        let first = CloneOutcome::cloned(CloneChannel::Desktop);
        let failed = CloneOutcome::failed(
            CloneChannel::IdeSession,
            CloneFailure::new(CloneCause::HeldOutside),
        );
        assert!(failed.order > first.order);
        let project = uuid::Uuid::from_u128(0x70);
        outcomes
            .record(project, "https://h/a.git", first)
            .await
            .unwrap();
        outcomes
            .record(project, "https://h/b.git", failed)
            .await
            .unwrap();
        assert_eq!(
            *kept.0.lock().unwrap(),
            [
                ("https://h/a.git".to_owned(), None),
                ("https://h/b.git".to_owned(), Some(CloneCause::HeldOutside)),
            ]
        );
        for cause in CloneCause::ALL {
            assert_eq!(CloneCause::parse(cause.as_str()), Some(cause));
        }
    }
}
