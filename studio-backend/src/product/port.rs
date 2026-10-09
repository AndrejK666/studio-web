//! What another gear asks studio-product for, through the ClientHub.
//!
//! - [`ProjectProducts`]: a project's records. The catalogue reads a
//!   project's gear repository through it to say what the project's code
//!   depends on.
//! - [`engine`]: the Gearbox engine, when this deployment configures one. The
//!   catalogue asks it what each gear's `gear.gdl` says and checks the gears
//!   repository out with it, so the catalogue and the previews read one
//!   corpus.
//! - [`GearDeclarations`]: Declare it (ADR-0041 P3) -- the manifest that
//!   makes existing code a gear, written on a branch with a pull request.
//!
//! All are resolved when used, so a consumer does not depend on the order
//! gears start in.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::gearbox::Gearbox;

#[async_trait]
pub trait ProjectProducts: Send + Sync + 'static {
    /// The gear repository connected to a project, as recorded:
    /// `{tenant, connection_id, repo, branch}`. `None` when none is connected.
    async fn gear_repo(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
    ) -> anyhow::Result<Option<Value>>;
}

#[async_trait]
impl ProjectProducts for super::service::ProductService {
    async fn gear_repo(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
    ) -> anyhow::Result<Option<Value>> {
        Ok(self
            .get_project_repo(ctx, project_id)
            .await?
            .map(|n| n.value))
    }
}

/// [`ProjectProducts`], resolved from the ClientHub when used.
#[derive(Clone)]
pub struct Products {
    hub: Arc<ClientHub>,
}

impl Products {
    pub fn new(hub: Arc<ClientHub>) -> Self {
        Self { hub }
    }

    /// `None` before studio-product has published it, or in an assembly
    /// without it.
    pub fn get(&self) -> Option<Arc<dyn ProjectProducts>> {
        self.hub.get::<dyn ProjectProducts>().ok()
    }
}

/// The Gearbox engine studio-product published at `init`. `None` when
/// `STUDIO_GEARBOX_WORKDIR` is not set, or in an assembly without the gear.
pub fn engine(hub: &ClientHub) -> Option<Arc<Gearbox>> {
    hub.get::<Gearbox>().ok()
}

// ── Declare it (ADR-0041 P3) ──────────────────────────────────────────────────

/// Existing code to declare a gear: where its manifest goes and what it says.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DeclarationSpec {
    /// The gear's name, kebab-case: the engine's id for its `gear.gdl`.
    pub name: String,
    /// The directory the manifest is written into: the module's or crate's.
    pub dir: String,
    pub description: String,
    pub category: Option<String>,
    pub capabilities: Vec<String>,
    pub plugin: bool,
}

/// One file a declaration writes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeclarationFile {
    pub path: String,
    pub content: String,
}

/// The repository a declaration is written into, through which connection,
/// and the branch its pull request goes back to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepositoryTarget {
    /// The tenant whose connection reaches the repository.
    pub tenant: Uuid,
    pub connection_id: Option<Uuid>,
    /// `owner/name`.
    pub repo: String,
    pub base_branch: String,
}

/// The words of a declaration's commit and pull request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PullRequestText {
    pub message: String,
    pub title: String,
    pub body: String,
}

/// Where a declaration landed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeclarationWritten {
    pub branch: String,
    pub commit_sha: String,
    pub pr_url: Option<String>,
}

/// What studio-product offers for declaring existing code a gear: the files
/// (`gear.toml`, and `gear.gdl` from the engine when one is configured), and
/// writing them on a branch with a pull request, through the repository's
/// connection. The catalogue's registry asks it for Declare it.
#[async_trait]
pub trait GearDeclarations: Send + Sync {
    /// The files a declaration writes. Nothing is written.
    async fn declaration_files(
        &self,
        spec: &DeclarationSpec,
    ) -> anyhow::Result<Vec<DeclarationFile>>;

    /// Commit `files` onto `branch` off the target's base branch and open a
    /// pull request back (or answer the one already open). `ctx` must reach
    /// the target's connection: the project's tenant.
    async fn open_declaration(
        &self,
        ctx: &SecurityContext,
        target: &RepositoryTarget,
        branch: &str,
        files: &[DeclarationFile],
        text: &PullRequestText,
    ) -> anyhow::Result<DeclarationWritten>;
}

/// studio-product's [`GearDeclarations`]: the skeleton's manifest, the
/// engine's `gear.gdl`, and the scaffold's writer.
pub struct Declarations {
    service: Arc<super::service::ProductService>,
    hub: Arc<ClientHub>,
}

impl Declarations {
    pub(super) fn new(service: Arc<super::service::ProductService>, hub: Arc<ClientHub>) -> Self {
        Self { service, hub }
    }
}

#[async_trait]
impl GearDeclarations for Declarations {
    async fn declaration_files(
        &self,
        spec: &DeclarationSpec,
    ) -> anyhow::Result<Vec<DeclarationFile>> {
        let slug = super::skeleton::gear_slug(&spec.name);
        // The engine's own description, so the gear is composable from its
        // first commit; without an engine, or when it refuses, the manifest
        // alone declares it.
        let gdl = match engine(&self.hub) {
            Some(gearbox) => match gearbox
                .scaffold_gdl(super::gearbox::GearScaffold {
                    crate_name: slug.clone(),
                    name: super::skeleton::title_case(&slug),
                    kind: super::gearbox::GearKind::Service,
                    plugin: None,
                })
                .await
            {
                Ok(gdl) => Some(gdl),
                Err(e) => {
                    tracing::warn!(error = %format!("{e:#}"), gear = %slug, "gearbox: no gear.gdl for the declaration");
                    None
                }
            },
            None => None,
        };
        Ok(super::skeleton::declaration(
            &spec.dir,
            &slug,
            &spec.description,
            spec.category.as_deref(),
            &spec.capabilities,
            spec.plugin,
            gdl,
        )
        .into_iter()
        .map(|f| DeclarationFile {
            path: f.path,
            content: f.content,
        })
        .collect())
    }

    async fn open_declaration(
        &self,
        ctx: &SecurityContext,
        target: &RepositoryTarget,
        branch: &str,
        files: &[DeclarationFile],
        text: &PullRequestText,
    ) -> anyhow::Result<DeclarationWritten> {
        let files: Vec<super::scaffold::ScaffoldFile> = files
            .iter()
            .map(|f| super::scaffold::ScaffoldFile {
                path: f.path.clone(),
                content: f.content.clone(),
            })
            .collect();
        let w = self
            .service
            .write_to_repository(ctx, target, branch, &files, text)
            .await?;
        Ok(DeclarationWritten {
            branch: w.branch,
            commit_sha: w.commit_sha,
            pr_url: w.pr_url,
        })
    }
}
