//! The rollup counts port (ADR-0079 §4): what the portfolio and the projects
//! table count per project, declared here and answered by the kits that hold
//! the rows -- the documents a project binds and how its specs stand, the
//! artifact graph's nodes, and the project's review and pull request signals.
//!
//! Each is a seam a kit's gear publishes on the ClientHub in its own module
//! (`register::<dyn crate::organizations::port::DocumentCounter>`); the
//! rollup resolves them in its REST phase, and each is optional: a missing
//! one leaves its columns unknown, never zero (`rollups.rs`).

use async_trait::async_trait;
use toolkit_security::SecurityContext;
use uuid::Uuid;

/// How much a project has in it, as the gear holding its documents counts it.
///
/// Separate from the documents gear's classifier because it is a different
/// seam: the classifier is that gear doing work for another, and this is
/// another gear asking it a question about its own rows. Both are published
/// the same way, and both stand down the same way when the gear has no
/// database.
///
/// The portfolio needs one number per project and nothing else, so the trait
/// returns a number rather than a page. A caller that receives `Ok(n)` knows
/// `n`; a caller that receives `Err` knows NOTHING, which is not the same as
/// zero and must not be rendered as one.
#[async_trait]
pub trait DocumentCounter: Send + Sync + 'static {
    /// Document bindings recorded for this project.
    ///
    /// `workspace_id` is the PARENT workspace: bindings are stored against it
    /// and scoped to the project, which is the pairing the Documents section
    /// uses and the one the rollup has to repeat to count the same rows.
    async fn count_bindings(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        project_id: Uuid,
    ) -> anyhow::Result<u32>;

    /// How this project's specs stand: how many, how many written in Studio,
    /// how many checked and how many of those fail. Same pairing of
    /// `workspace_id` and `project_id` as [`Self::count_bindings`].
    async fn spec_summary(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        project_id: Uuid,
    ) -> anyhow::Result<SpecSummary>;

    /// [`Self::count_bindings`] and [`Self::spec_summary`] for several
    /// projects of one workspace at once, as a table of projects asks: the
    /// same numbers, counted for all of them together rather than read row
    /// by row per project.
    ///
    /// Every project asked for has an entry; a number that could not be read
    /// is `None` in it. Defaulted to the two calls per project.
    async fn project_documents(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        projects: &[Uuid],
    ) -> std::collections::HashMap<Uuid, ProjectDocumentCounts> {
        let mut out = std::collections::HashMap::new();
        for p in projects {
            let (bindings, specs) = tokio::join!(
                self.count_bindings(ctx, workspace_id, *p),
                self.spec_summary(ctx, workspace_id, *p),
            );
            out.insert(
                *p,
                ProjectDocumentCounts {
                    bindings: bindings.ok(),
                    specs: specs.ok(),
                },
            );
        }
        out
    }
}

/// A project's documents as the projects table counts them; `None` is a
/// number nobody could tell.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProjectDocumentCounts {
    /// [`DocumentCounter::count_bindings`].
    pub bindings: Option<u32>,
    /// [`DocumentCounter::spec_summary`].
    pub specs: Option<SpecSummary>,
}

/// How a project's specs stand, for its one cell in the projects table.
///
/// A spec is what the Bound queue lists: a repository file somebody confirmed
/// or chose a type for, or a document written in Studio. A file a detector only
/// proposed is not one yet — it is waiting in Needs review.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SpecSummary {
    pub specs: u32,
    /// Of those, written in Studio rather than found in a repository.
    pub authored: u32,
    /// Of those, with a validation verdict of either kind.
    pub checked: u32,
    /// Of the checked, the ones that do not conform.
    pub failing: u32,
}

/// How much of the artifact graph belongs to one scope.
///
/// A second seam, added for the portfolio's per-project counts.
///
/// WHY NOT THE LISTING ENDPOINT. `GET /v1/nodes` answers the same question, and
/// the portfolio used to ask it that way — once per row, with `limit=1`,
/// reading `total`. That limit saves nothing: the projection cannot narrow by
/// payload, so the endpoint walks the tenant's whole typed node set and slices
/// it in this process. Measured on studio-dev: 28,717 nodes, 31 MB and 144
/// sequential round trips per call, a p95 of 8.06 s. A table of ten projects
/// asked for that ten times, from a browser.
///
/// Through here it is asked once per rollup, against the projection this
/// process already holds, and the caller is handed a number rather than a page
/// it has to count.
#[async_trait]
pub trait ArtifactCounter: Send + Sync + 'static {
    /// Nodes of `type_leaf` (`spec_finding`, `issue`, `file`, …) whose payload
    /// names `scope` as its workspace or its project.
    ///
    /// `Ok(n)` means n. An `Err` means the count is UNKNOWN, which a caller
    /// must not render as zero: "this project has no findings" and "nobody
    /// could tell me" are different sentences on a screen people use to decide
    /// where to look next.
    async fn count_nodes(
        &self,
        ctx: &toolkit_security::SecurityContext,
        type_leaf: &str,
        scope: &str,
    ) -> anyhow::Result<u32>;

    /// [`Self::count_nodes`] for several projects at once, as a table of
    /// projects asks: one question per type, not one per type and project.
    ///
    /// A project missing from the answer is UNKNOWN, by the same rule as an
    /// `Err` above. Defaulted to one count per project, which keeps the
    /// projects whose count failed out of the answer.
    async fn count_nodes_in_projects(
        &self,
        ctx: &toolkit_security::SecurityContext,
        type_leaf: &str,
        projects: &[String],
    ) -> std::collections::HashMap<String, u32> {
        let mut out = std::collections::HashMap::new();
        for p in projects {
            if let Ok(n) = self.count_nodes(ctx, type_leaf, p).await {
                out.insert(p.clone(), n);
            }
        }
        out
    }
}

/// What a project's row in the projects table says about its review and its
/// sources, as the gear holding its repositories folds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowSignals {
    /// Findings still to fix, placed in the text.
    pub open_findings: u32,
    /// Unresolved threads the project's repositories report, on documents
    /// and on pull requests under review. `None` when no repository could say.
    pub open_comments: Option<u32>,
    /// Pull requests over the window, folded across every repository of the
    /// project. `None` when none was ever synced: no activity to show, which
    /// is a different sentence from a quiet week.
    pub pulls: Option<PullCounts>,
    /// The newest thing the Activity feed lists, when it has a time.
    pub last_event: Option<LastEvent>,
}

/// A project's pull requests over the window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullCounts {
    /// Open now, however old.
    pub open: u32,
    /// Merged inside the window.
    pub merged: u32,
    /// Pull requests that moved, per day, oldest first, always the window long.
    pub days: Vec<u32>,
}

/// The newest event of a project, as the Activity feed words it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LastEvent {
    /// What happened (`Document checked`, `Comment`).
    pub event: String,
    /// What it happened to.
    pub subject: String,
    /// When, RFC 3339.
    pub recorded: Option<String>,
}

/// A project's review and pull request signals, for its row: open findings,
/// open comments, pull requests over a window and the last thing that
/// happened -- each a screen of its own, read here for a whole table at once.
#[async_trait]
pub trait RowSignalSource: Send + Sync + 'static {
    /// The rows for `projects` (their tenant ids), over the last `days`
    /// days. A project missing from the answer is UNKNOWN.
    async fn row_signals_in(
        &self,
        ctx: &SecurityContext,
        projects: &[String],
        days: usize,
    ) -> std::collections::HashMap<String, RowSignals>;
}
