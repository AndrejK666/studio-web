//! What another gear may ask the components catalogue to do to a project's
//! repository.
//!
//! Three acts, and they are acts rather than reads: create the repository a
//! project is written in, record one it already has, and write a starter gear
//! into it. They exist as a trait because creating a project needs all three
//! IN SEQUENCE with a tenant and a configuration, and that sequence has to
//! survive the browser that started it — so something other than a REST caller
//! has to be able to perform them.
//!
//! Published on the ClientHub like every other seam here, and absent the same
//! way: a deployment with no connector driver has no catalogue service, and a
//! provisioning run then fails the repository step with a reason rather than
//! failing to exist.

use async_trait::async_trait;
use toolkit_security::SecurityContext;
use uuid::Uuid;

/// A repository as the provider created it.
#[derive(Debug, Clone)]
pub struct CreatedRepo {
    /// `owner/name`.
    pub full_name: String,
    pub default_branch: String,
    /// Where a person can open it.
    pub html_url: String,
}

/// What to create, for whoever is creating it.
#[derive(Debug, Clone)]
pub struct NewRepo {
    /// The tenant whose connection is used. A project's repository is created
    /// through the WORKSPACE's connection, not the project's — the project may
    /// have none of its own on the day it is made.
    pub connection_tenant: Uuid,
    /// The connection to use, or `None` to take the tenant's GitHub one.
    pub connection_id: Option<Uuid>,
    /// The account or organization to create it under. `None` means the
    /// connection's own user.
    pub owner: Option<String>,
    pub is_org: bool,
    pub name: String,
    pub private: bool,
}

/// A starter gear to write.
#[derive(Debug, Clone)]
pub struct Scaffold {
    pub slug: String,
    pub app_title: String,
    pub problem: String,
    pub origin: String,
    pub parent_dir: String,
    /// Open a pull request rather than committing to the base branch.
    pub open_pr: bool,
}

#[async_trait]
pub trait ProjectRepos: Send + Sync + 'static {
    /// The repository this project is recorded as using, if it has one.
    ///
    /// `Ok(None)` means it has none; an `Err` means the question could not be
    /// asked, which a caller deciding whether to create one must not read as
    /// "it has none" — creating a second repository is not recoverable the way
    /// asking again is.
    async fn attached_repo(
        &self,
        ctx: &SecurityContext,
        project_id: Uuid,
    ) -> anyhow::Result<Option<String>>;

    /// Create a repository and record it as the project's.
    async fn create_repo(
        &self,
        ctx: &SecurityContext,
        project_id: Uuid,
        spec: &NewRepo,
    ) -> anyhow::Result<CreatedRepo>;

    /// Record a repository the project already has, without creating one.
    async fn attach_repo(
        &self,
        ctx: &SecurityContext,
        project_id: Uuid,
        connection_tenant: Uuid,
        connection_id: Option<Uuid>,
        repo: &str,
        branch: &str,
    ) -> anyhow::Result<()>;

    /// Write a starter gear into the project's repository.
    ///
    /// The skeleton is composed HERE, from the spec, rather than posted by the
    /// caller: it was moved out of the browser for that reason, and a second
    /// caller composing its own would be the same mistake again.
    async fn scaffold(
        &self,
        ctx: &SecurityContext,
        project_id: Uuid,
        spec: &Scaffold,
    ) -> anyhow::Result<()>;
}
