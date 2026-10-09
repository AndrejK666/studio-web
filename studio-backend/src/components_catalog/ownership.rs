//! Whose connection an organization reads and writes through.
//!
//! Connections are inherited downwards: a project sees its workspace's, its
//! organization's and the platform root's. Seeing one is not owning it. An
//! organization uses only a connection held by itself, one of its workspaces
//! or one of its projects -- never one held above it, such as the platform's
//! root, whose token would read (or write) the organization's repositories
//! with the platform's rights. The platform's own catalogue, synced in the
//! root, reads with the root's connections by design: there the root is the
//! organization.
//!
//! The rules ask the tree and the connections through [`Tree`] and
//! [`Holders`], so they are tested with tables.

use uuid::Uuid;

use super::registry::RepoWalk;
use super::service::{ProjectRepo, RepoSource, SyncSources};
use super::tiers::PLATFORM_TENANT;

/// What a person can do about a repository refused for its connection.
pub const NOT_OWNED_HINT: &str = "The project's connection belongs to the platform or another tenant, not to this organization; connect the repository with an organization-scope connection of your own.";

/// The machine-readable reason an organization's source naming a tenant
/// outside the organization is refused with.
pub const SOURCE_TENANT_NOT_OWNED: &str = "SOURCE_TENANT_NOT_OWNED";

/// The tenant tree as the caller reads it.
#[async_trait::async_trait]
pub trait Tree: Send + Sync {
    /// `tenant`'s parent: `Some(None)` for a tenant with none, `None` when it
    /// cannot be read.
    async fn parent_of(&self, tenant: Uuid) -> Option<Option<Uuid>>;
}

/// Where connections are held.
#[async_trait::async_trait]
pub trait Holders: Send + Sync {
    /// The tenant holding the connection a read from `tenant` would use --
    /// `connection_id`'s, or the default one when none is named -- found by
    /// walking up from `tenant`; `None` when there is none.
    async fn holder_of(&self, tenant: Uuid, connection_id: Option<Uuid>) -> Option<Uuid>;
}

/// Whether `tenant` is `org` or below it. Fails closed: a tenant whose
/// ancestry cannot be read, the platform's root (unless it is `org`) and
/// anything above `org` are not within it.
pub async fn within(org: Uuid, tenant: Uuid, tree: &dyn Tree) -> bool {
    if tenant == org {
        return true;
    }
    if tenant == PLATFORM_TENANT {
        return false;
    }
    // Project -> workspace -> organization: nothing Studio keeps is deeper.
    let mut current = tenant;
    for _ in 0..4 {
        match tree.parent_of(current).await {
            Some(Some(p)) if p == org => return true,
            Some(Some(p)) if p == PLATFORM_TENANT => return false,
            Some(Some(p)) => current = p,
            _ => return false,
        }
    }
    false
}

/// A repository the walk refused to read, as its project's status says it.
pub fn refused_walk(repo: &str, holder: Uuid) -> RepoWalk {
    let whose = if holder == PLATFORM_TENANT {
        "the platform's root".to_owned()
    } else {
        format!("tenant {holder}")
    };
    RepoWalk {
        repo: repo.to_owned(),
        status: "failed".to_owned(),
        components: 0,
        error: Some(format!(
            "not read: its connection is held by {whose}, outside the organization"
        )),
        hint: Some(NOT_OWNED_HINT.to_owned()),
    }
}

/// Split a project's repositories into those read through a connection the
/// organization `org` owns and, for the others, what the walk reports.
/// Each repository's `tenant` is the tenant holding its connection.
pub(super) async fn split_owned(
    org: Uuid,
    repos: Vec<ProjectRepo>,
    tree: &dyn Tree,
) -> (Vec<ProjectRepo>, Vec<RepoWalk>) {
    let mut owned = Vec::with_capacity(repos.len());
    let mut refused = Vec::new();
    for r in repos {
        if within(org, r.tenant, tree).await {
            owned.push(r);
        } else {
            refused.push(refused_walk(&r.repo, r.tenant));
        }
    }
    (owned, refused)
}

/// Take out of an organization's sync every source whose connection is not
/// the organization's: one naming a tenant outside it, or one whose
/// connection -- named, or the default the read would take -- is held above
/// it. Answers what was taken, `repo` or `owner/number`.
pub async fn retain_owned_sources(
    org: Uuid,
    sources: &mut SyncSources,
    holders: &dyn Holders,
    tree: &dyn Tree,
) -> Vec<String> {
    let mut refused = Vec::new();
    let mut repos = Vec::with_capacity(sources.repos.len());
    for s in std::mem::take(&mut sources.repos) {
        if source_is_owned(org, s.tenant, s.connection_id, holders, tree).await {
            repos.push(s);
        } else {
            refused.push(s.repo.clone());
        }
    }
    sources.repos = repos;
    let mut roadmaps = Vec::with_capacity(sources.roadmaps.len());
    for r in std::mem::take(&mut sources.roadmaps) {
        if source_is_owned(org, r.tenant, r.connection_id, holders, tree).await {
            roadmaps.push(r);
        } else {
            refused.push(format!("{}/{}", r.owner, r.number));
        }
    }
    sources.roadmaps = roadmaps;
    refused
}

async fn source_is_owned(
    org: Uuid,
    tenant: Uuid,
    connection_id: Option<Uuid>,
    holders: &dyn Holders,
    tree: &dyn Tree,
) -> bool {
    if !within(org, tenant, tree).await {
        return false;
    }
    match holders.holder_of(tenant, connection_id).await {
        Some(holder) => within(org, holder, tree).await,
        // Nothing to read through: the read fails on its own, saying so.
        None => true,
    }
}

/// The tenant an organization's source names, checked: the organization when
/// none is named (the nil id), the one named when it is within the
/// organization, else `Err` with the tenant refused.
pub async fn source_tenant(org: Uuid, named: Uuid, tree: &dyn Tree) -> Result<Uuid, Uuid> {
    if named.is_nil() {
        return Ok(org);
    }
    if within(org, named, tree).await {
        Ok(named)
    } else {
        Err(named)
    }
}

/// [`RepoSource`] with its tenant checked by [`source_tenant`].
pub async fn owned_source(
    org: Uuid,
    mut source: RepoSource,
    tree: &dyn Tree,
) -> Result<RepoSource, Uuid> {
    source.tenant = source_tenant(org, source.tenant, tree).await?;
    Ok(source)
}

#[cfg(test)]
#[path = "ownership_tests.rs"]
mod tests;
