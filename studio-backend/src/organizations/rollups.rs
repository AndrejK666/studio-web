//! What a workspace or a project CONTAINS, counted once, on the server.
//!
//! The portfolio and the projects table name their rows and then have to say
//! something about them: which of these has anything in it, and which needs
//! attention. Answering that in the row is what stops somebody opening three
//! projects to find out which one to open.
//!
//! IT USED TO BE ANSWERED IN THE BROWSER, and that is why this exists. The
//! prototype composed every row itself — `tenantChildren` for a workspace, then
//! `docBindings` + `listArtifactNodes` + `workspaceSettings` for each project.
//! Three requests per row, from a client, over a link it does not control; and
//! one of the three was the artifact listing, which cannot narrow by payload and
//! so walks the tenant's whole typed node set on every call (28,717 nodes and a
//! p95 of 8.06 s, measured on studio-dev). A ten-project table asked for that
//! ten times.
//!
//! Worse than slow, it was unshareable: the next portal would have to write the
//! same composition again, and the three rules below with it.
//!
//! ── The three rules, which are the whole point ──────────────────────────────
//!
//! **A count that is not known is `None`, never 0.** A zero that really means
//! "the gear did not answer" is the most expensive kind of wrong here: it tells
//! somebody deciding where to look that a project is empty.
//!
//! **One failure costs one number.** Every count is settled independently, so a
//! self-managed tenant answering 404 from outside its subtree — which is tenant
//! isolation working correctly — leaves the other columns alone.
//!
//! **Counts come from the store's total, never from `len()`.** Each source is
//! asked for a single row and reports how many there are. Fetching the rows to
//! count them reads a project's whole document set to render one cell.

use std::sync::Arc;

use account_management_sdk::AccountManagementClient;
use toolkit_odata::ODataQuery;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use crate::artifact_ingest::port::ArtifactCounter;
use crate::documents::port::DocumentCounter;

/// Tenant type of a workspace, as account-management records it.
pub const WORKSPACE_TENANT_TYPE: &str =
    "gts.cf.core.am.tenant_type.v1~cf.studio.tenant.workspace.v1~";
/// Tenant type of a project.
pub const PROJECT_TENANT_TYPE: &str = "gts.cf.core.am.tenant_type.v1~cf.studio.tenant.project.v1~";
/// Where a project's attached repositories are recorded.
const SETTINGS_METADATA_TYPE: &str =
    "gts.cf.core.am.tenant_metadata.v1~cf.studio.workspace.settings.v1~";
/// The node type a detector writes its verdicts as.
const FINDING_TYPE_LEAF: &str = "spec_finding";

/// Which kind of row this is. A workspace is counted by what it holds; a
/// project by what is in it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RollupKind {
    Workspace,
    Project,
}

impl RollupKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RollupKind::Workspace => "workspace",
            RollupKind::Project => "project",
        }
    }
}

/// One row's counts. Every number is optional, and the option carries the
/// difference between "none" and "nobody could tell me".
#[derive(Debug, Clone)]
pub struct Rollup {
    pub id: Uuid,
    pub name: String,
    pub kind: RollupKind,
    /// The workspace a project belongs to. `None` on a workspace row.
    ///
    /// Carried because the portfolio draws a tree: without it a client that
    /// received a flat list would have to ask again for the parentage this
    /// call already walked.
    pub parent_id: Option<Uuid>,
    /// Workspaces only: child tenants of type project.
    pub projects: Option<u32>,
    /// Projects only: files bound to a document type, or still undecided.
    pub documents: Option<u32>,
    /// Projects only: detector verdicts across those documents.
    pub findings: Option<u32>,
    /// Projects only: repositories attached in the project's settings.
    pub repos: Option<u32>,
}

/// The sources a rollup reads.
///
/// Each counter is optional because each gear stands down independently — no
/// database, no connector driver — and a rollup missing one number is worth
/// more than no rollup at all.
pub struct Sources {
    pub am: Arc<dyn AccountManagementClient>,
    pub documents: Option<Arc<dyn DocumentCounter>>,
    pub artifacts: Option<Arc<dyn ArtifactCounter>>,
}

impl Sources {
    /// Every workspace under the caller's tenant, and every project under those.
    ///
    /// The caller's tenant comes from the security context and is never a
    /// parameter: a tenant somebody can type is not a scope (convention C1).
    pub async fn portfolio(&self, ctx: &SecurityContext) -> Vec<Rollup> {
        let root = ctx.subject_tenant_id();
        let mut out = Vec::new();
        for (workspace_id, workspace_name) in
            self.children_of(ctx, root, WORKSPACE_TENANT_TYPE).await
        {
            let projects = self
                .children_of(ctx, workspace_id, PROJECT_TENANT_TYPE)
                .await;
            out.push(Rollup {
                id: workspace_id,
                name: workspace_name,
                kind: RollupKind::Workspace,
                parent_id: None,
                // The children were listed in order to walk into them, so this
                // count is what that listing already said — not a second
                // question asked for the number alone.
                projects: Some(u32::try_from(projects.len()).unwrap_or(u32::MAX)),
                documents: None,
                findings: None,
                repos: None,
            });
            for (project_id, name) in projects {
                out.push(self.project(ctx, workspace_id, project_id, name).await);
            }
        }
        out
    }

    /// One project, for a screen that shows a project rather than a portfolio.
    pub async fn one_project(&self, ctx: &SecurityContext, project_id: Uuid) -> Option<Rollup> {
        let tenant = self.am.get_tenant(ctx, project_id).await.ok()?;
        // Bindings are stored against the PARENT workspace and scoped to the
        // project. Without the parent this would count nothing, which is better
        // than counting the wrong rows — so it says it does not know.
        let workspace_id = tenant.parent_id?;
        Some(
            self.project(ctx, workspace_id.0, project_id, tenant.name)
                .await,
        )
    }

    /// Children of `parent` of one tenant type, as `(id, name)`.
    ///
    /// An unreadable parent yields no children rather than an error: a
    /// self-managed subtree refusing an ancestor is tenant isolation working as
    /// designed, and the rest of the portfolio still renders.
    async fn children_of(
        &self,
        ctx: &SecurityContext,
        parent: Uuid,
        tenant_type: &str,
    ) -> Vec<(Uuid, String)> {
        match self
            .am
            .list_children(ctx, parent, &ODataQuery::default())
            .await
        {
            Ok(page) => page
                .items
                .into_iter()
                .filter(|t| t.tenant_type.as_deref() == Some(tenant_type))
                .map(|t| (t.id.0, t.name))
                .collect(),
            Err(_) => Vec::new(),
        }
    }

    /// One project's three counts, each settled on its own.
    async fn project(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        project_id: Uuid,
        name: String,
    ) -> Rollup {
        let documents = match &self.documents {
            Some(counter) => counter
                .count_bindings(ctx, workspace_id, project_id)
                .await
                .ok(),
            None => None,
        };
        let findings = match &self.artifacts {
            Some(counter) => counter
                .count_nodes(ctx, FINDING_TYPE_LEAF, &project_id.to_string())
                .await
                .ok(),
            None => None,
        };
        Rollup {
            id: project_id,
            name,
            kind: RollupKind::Project,
            parent_id: Some(workspace_id),
            projects: None,
            documents,
            findings,
            repos: self.repos(ctx, project_id).await,
        }
    }

    /// Repositories attached to a project.
    ///
    /// A project whose settings read back has exactly as many repositories as
    /// they list, including none. A project whose settings could not be read has
    /// an unknown number — which is why a settings entry without the field is
    /// `Some(0)` and a failed read is `None`.
    async fn repos(&self, ctx: &SecurityContext, project_id: Uuid) -> Option<u32> {
        let entry = self
            .am
            .get_metadata(ctx, project_id, gts::GtsTypeId::new(SETTINGS_METADATA_TYPE))
            .await
            .ok();
        repos_in(entry.as_ref().map(|e| &e.value))
    }
}

/// How many repositories a project's settings list.
///
/// `None` in means the settings could not be read, and `None` out says so. A
/// settings document that simply has no `repos` is `Some(0)` — the project
/// really has none, which is a different sentence and renders differently.
///
/// Pulled out of the read so the distinction can be tested without standing up
/// an account-management client: this is the rule, the read is plumbing.
fn repos_in(settings: Option<&serde_json::Value>) -> Option<u32> {
    let repos = settings?
        .get("repos")
        .and_then(serde_json::Value::as_array)
        .map(|repos| repos.len())
        .unwrap_or(0);
    Some(u32::try_from(repos).unwrap_or(u32::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The distinction the whole file turns on, at the one place it is decided.
    #[test]
    fn settings_that_could_not_be_read_are_unknown_not_empty() {
        assert_eq!(repos_in(None), None);
    }

    #[test]
    fn settings_without_the_field_mean_the_project_has_none() {
        assert_eq!(repos_in(Some(&json!({}))), Some(0));
        assert_eq!(repos_in(Some(&json!({ "repos": [] }))), Some(0));
    }

    #[test]
    fn repositories_are_counted_as_listed() {
        assert_eq!(
            repos_in(Some(&json!({ "repos": ["a", "b", "c"] }))),
            Some(3)
        );
    }

    /// A `repos` of the wrong shape is a malformed document, not a claim that
    /// the project has repositories nobody can name.
    #[test]
    fn a_repos_field_of_the_wrong_shape_counts_as_none_listed() {
        assert_eq!(repos_in(Some(&json!({ "repos": "nope" }))), Some(0));
    }

    #[test]
    fn a_rollup_names_its_kind_the_way_the_api_spells_it() {
        assert_eq!(RollupKind::Workspace.as_str(), "workspace");
        assert_eq!(RollupKind::Project.as_str(), "project");
    }
}
