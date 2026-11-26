//! What another gear uses of the connectors, and nothing else.
//!
//! There is one [`ConnectorService`] in the process. `studio-connector` builds
//! it at `init` and publishes it on the ClientHub; a gear that reads
//! connections or talks to a provider through them holds a [`Connectors`]
//! handle and resolves the service when it needs it. Resolving per use rather
//! than at `init` keeps the consumer independent of the order gears start in:
//! Studio gears share one crate, so the toolkit's `deps` cannot order them.
//!
//! A gear that reads or writes a repository opens a [`Repository`] -- the
//! connection's driver bound to one repository and ref -- instead of speaking
//! the provider's API itself.
//!
//! The drivers, the REST surface and the graph sync stay private to the gear.

use std::sync::Arc;

use toolkit::client_hub::ClientHub;

pub use super::assembly_service::{
    PROVIDER as ASSEMBLY_SERVICE_PROVIDER, STRATEGY_OPTION as ASSEMBLY_SERVICE_STRATEGY_OPTION,
};
/// A working copy on disk: shallow clone, fast-forward, walk. Credentials go
/// to `git` through a helper, never the URL or argv.
pub(crate) use super::clone as git_checkout;
pub use super::driver::CommitStatus;
#[cfg(test)]
pub use super::driver::RemoteReleaseAsset;
#[cfg(test)]
pub use super::driver::RemoteReview;
pub use super::driver::{
    ConnectionAuth, ConnectorDriver, CreatedRepository, DownloadNeedsProxy, DownloadTarget,
    FileToWrite, NotifyMessage, PullRequestThreads, RemoteBuildArtifact, RemoteComment,
    RemoteCommit, RemoteFile, RemoteFileList, RemoteIssue, RemotePullRequest, RemoteRelease,
    RemoteWorkflowJob, RemoteWorkflowRun,
};
/// What another gear's test needs to stand in for a provider.
#[cfg(test)]
pub use super::driver::{ConnectorCategory, DriverIdentity};
pub use super::gear_repository::PROVIDER as GEAR_REPOSITORY_PROVIDER;
/// Whether a name is a gear repository's source id, as the engine takes it.
pub use super::gear_repository::is_source_id;
pub use super::references::{Mention, NumberRef, RefKind, Relation, find as find_references};
pub use super::registry::{
    CatalogVersion, Oci, RegistryAccess, RegistryCatalog, TokenScopes, catalog_for, same_registry,
    token_scopes, too_broad,
};
pub use super::research::KEY_LIFETIME_DAYS as RESEARCH_KEY_LIFETIME_DAYS;
pub use super::research::PROVIDER as RESEARCH_PROVIDER;
/// The Research connector's calls to Research's public API (ADR-0049 §6).
pub mod research {
    pub use super::super::research_api::*;
}
pub use super::repository::{Repository, create_repository};
pub use super::service::{
    ConnectorService, GearRepositorySource, check_owned, connection_by_id, holder_of_row,
    own_connection,
};

/// The connector-driver port (ADR-0079 §4): what a kit's gear needs to bring
/// the driver of a concrete system. The core stores connections and secrets
/// and does sign-in and test; a driver says how to reach one provider and
/// what its form asks for.
///
/// A kit's driver plugin gear implements [`drivers::ConnectorDriver`],
/// registers it in its `init` with [`drivers::register_driver`], and names
/// its instance id once with
/// `inventory::submit! { crate::connectors::sdk::drivers::DriverSlot { instance_id: … } }`,
/// so studio-connector looks for it without the core naming the kit.
pub mod drivers {
    pub use super::super::driver::{
        ConnectionAuth, ConnectorCategory, ConnectorDriver, DriverCheck, DriverIdentity,
    };
    /// The form a driver describes (`ConnectorDriver::form_fields`, `holder`).
    /// No kit's driver describes one of its own yet: the model providers'
    /// take the default.
    #[allow(unused_imports)]
    pub use super::super::driver::{FieldKind, FormField, Holder};
    pub use super::super::plugin::register_driver;
    pub(crate) use super::super::url_guard::HostRule;

    /// A driver instance id a kit's plugin gear registers its driver under.
    /// studio-connector resolves every submitted slot beside its own
    /// drivers'; one whose plugin is not linked yields no driver.
    pub struct DriverSlot {
        /// Derived from the connector plugin contract
        /// (`cf.studio.connector.plugin.v1~`).
        pub instance_id: &'static str,
    }

    inventory::collect!(DriverSlot);

    /// The submitted slots' instance ids, sorted.
    pub fn slots() -> Vec<&'static str> {
        let mut ids: Vec<&'static str> = inventory::iter::<DriverSlot>
            .into_iter()
            .map(|s| s.instance_id)
            .collect();
        ids.sort_unstable();
        ids
    }

    /// Where a connection of `driver` would point when `supplied` is typed
    /// (`None`: the driver's default), or why it may not: the guard every
    /// address passes, for a kit's driver to test its rule against.
    #[cfg(test)]
    pub fn resolve_base_url(
        driver: &dyn ConnectorDriver,
        supplied: Option<&str>,
    ) -> anyhow::Result<String> {
        super::super::service::resolve_base_url(driver, supplied)
    }
}

/// Whose connection a tenant may use: an organization, and anything under
/// it, only one held by itself, one of its workspaces or one of its
/// projects. The pure rule; [`ConnectorService::ensure_owned`] applies it
/// over the real tree and catalogue.
pub mod ownership {
    pub use super::super::ownership::*;
}

/// The connector service, resolved from the ClientHub when used.
#[derive(Clone)]
pub struct Connectors {
    hub: Arc<ClientHub>,
}

impl Connectors {
    pub fn new(hub: Arc<ClientHub>) -> Self {
        Self { hub }
    }

    /// The service `studio-connector` published, or `None` before it has, or
    /// in an assembly without it.
    pub fn get(&self) -> Option<Arc<ConnectorService>> {
        self.hub.get::<ConnectorService>().ok()
    }
}
