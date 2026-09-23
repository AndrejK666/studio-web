//! What another gear may ask studio-artifact-ingest for.
//!
//! One method, and the mirror of `documents::port`. That seam exists because
//! the ingest walks a repository and ends up holding every file's text, while
//! the documents gear owns the type catalogue — neither can answer alone. This
//! one is the same shape read the other way: the documents gear knows which
//! files are specs and what type each is, and needs their TEXT to have them
//! analysed.
//!
//! Nobody stored that text on purpose. The graph keeps an excerpt and drops the
//! rest (`bounded_payload`), and a binding records a path and a verdict, never
//! the bytes. So the only thing that can produce a document's text is whatever
//! holds the checkout, which is this gear.
//!
//! Until this existed, the only caller that could join the two was the browser:
//! it read the files through `GET /repo-files`, held a repository in memory,
//! and posted the text back to be analysed — a full round trip of bytes the
//! backend had just read off its own disk.
//!
//! Published on the ClientHub rather than reached for directly, for the same
//! reason as the other seam: a deployment without a checkout volume simply has
//! no reader, and a consumer that resolves nothing says so instead of failing.

use async_trait::async_trait;

/// Reads the working copy a sync left on disk.
#[async_trait]
pub trait RepoFileReader: Send + Sync + 'static {
    /// Every text file of one repository's checkout, as `(path, text)`.
    ///
    /// `repo_dir` is the directory a sync cloned into, as the workspace's
    /// settings record it. An empty vector is the ordinary answer for a
    /// repository nobody has cloned yet — not an error, because a project may
    /// legitimately have sources it has never synced.
    async fn read_repo_files(
        &self,
        workspace_id: &str,
        repo_dir: &str,
    ) -> anyhow::Result<Vec<(String, String)>>;
}
