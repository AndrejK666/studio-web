//! What another gear may ask studio-documents to do.
//!
//! One method, deliberately. `studio-artifact-ingest` walks a repository and
//! ends up holding every file's path and text; this gear owns the type
//! catalogue and decides what each file is. Neither can answer alone and
//! neither should learn the other's job, so the seam between them is a trait
//! this gear declares and the ingest gear calls.
//!
//! Published on the ClientHub rather than reached for directly: the documents
//! gear stands down when it has no database, and a consumer that resolves the
//! client and finds nothing simply does not classify — rather than failing a
//! repository sync over it.

use async_trait::async_trait;
use toolkit_security::SecurityContext;
use uuid::Uuid;

/// One file offered for classification, as the gear that walked it has it.
#[derive(Debug, Clone)]
pub struct IngestedDocument {
    /// Instance id of the `gts.cf.studio.artifact.file` node holding the bytes.
    pub node_id: String,
    /// Repo-relative path, e.g. `docs/adr/0007-shell-tokens.md`.
    pub path: String,
    /// The file's text. Read to classify and validate; never stored here.
    ///
    /// Empty for a file whose path is not prose. The verdict for one is the
    /// path alone, so the walker does not copy a repository's source bytes to
    /// be told what its own extensions already say.
    pub content: String,
}

/// What a classification pass did.
#[derive(Debug, Clone, Copy, Default)]
pub struct ClassifiedCounts {
    /// Files given a type, or left undetermined for a person to settle.
    pub classified: usize,
    /// Files recorded as not documents, by their path.
    pub not_documents: usize,
    /// Files left exactly as they were, because a person had already ruled on
    /// them or Spec Quality had paid for the answer.
    pub kept: usize,
}

#[async_trait]
pub trait DocumentClassifier: Send + Sync + 'static {
    /// Decide what each file is and record it, against the workspace's
    /// effective type catalogue.
    ///
    /// Idempotent by `(tenant, project, node)`: running it again after a
    /// re-sync updates the same rows, and never overturns a verdict a person
    /// settled or a detector paid for.
    async fn classify_ingested(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        project_id: Option<Uuid>,
        files: Vec<IngestedDocument>,
    ) -> anyhow::Result<ClassifiedCounts>;
}

/// How much a project has in it, as this gear counts it.
///
/// Separate from [`DocumentClassifier`] because it is a different seam: the
/// classifier is this gear doing work for another, and this is another gear
/// asking this one a question about its own rows. Both are published the same
/// way, and both stand down the same way when the gear has no database.
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
}

/// Whether a path could hold a specification document at all.
///
/// Re-exported because a caller holding a whole repository wants to filter
/// before it copies the text of every file into a request — and filtering by a
/// second, drifting copy of this rule is how the two ends start disagreeing
/// about what a document is.
pub use super::classify::is_prose_path;
