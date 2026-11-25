//! A project's one checkout of each source on this server, as the last sync
//! left it: the core's port (ADR-0079) every gear reads a project's code
//! through. The gear that syncs the sources (artifact-ingest) registers the
//! [`ProjectCheckout`] in the `ClientHub`; a reader never names it.

use async_trait::async_trait;

use crate::connectors::sdk::git_checkout::LoggedCommit;

/// Which layout a [`SourceCheckout`] was found in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckoutLayout {
    /// `{root}/{project_id}/{source dir}`: the project's one checkout, which
    /// the sync fetches. The root is `STUDIO_WORKSPACES_ROOT` when set (the
    /// IDE works in the same directory), else `STUDIO_ARTIFACT_WORKDIR`.
    Project,
    /// `{STUDIO_ARTIFACT_WORKDIR}/{secret_ref}__{owner_repo}`: the sync's own
    /// shallow clone from before the one-checkout rule. Read while it is all
    /// there is; a sync of the project replaces it with a [`Self::Project`]
    /// checkout.
    LegacySyncClone,
}

/// One project source's checkout on this server, at the commit the last sync
/// read (see [`ProjectCheckout`]).
///
/// Every read goes through local git at [`Self::commit`] -- `cat-file`,
/// `ls-tree`, `log` -- never through the working tree, which the IDE may have
/// moved or edited since, and never through the provider. All of them run off
/// the async runtime.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceCheckout {
    /// `owner/repo` (or a GitLab group path).
    pub full_path: String,
    /// The checkout's directory.
    pub dir: std::path::PathBuf,
    /// The full SHA the last sync read (`refs/studio/synced`), or `HEAD` for
    /// a checkout no sync has marked yet.
    pub commit: String,
    /// The checkout holds only part of its history.
    pub shallow: bool,
    pub layout: CheckoutLayout,
}

impl SourceCheckout {
    /// Look at what is on disk at `dir`: `None` when it is not a checkout.
    /// Blocking.
    pub fn at(dir: std::path::PathBuf, full_path: &str, layout: CheckoutLayout) -> Option<Self> {
        use crate::connectors::sdk::git_checkout;
        if !dir.join(".git").exists() {
            return None;
        }
        let commit = git_checkout::synced_commit(&dir)?;
        Some(Self {
            full_path: full_path.trim().to_owned(),
            shallow: git_checkout::is_shallow(&dir),
            dir,
            commit,
            layout,
        })
    }

    /// `file://` and the directory: a URL to mirror this checkout from on the
    /// same server (`git_checkout::clone_or_update_into` reads it locally).
    pub fn local_url(&self) -> String {
        crate::connectors::sdk::git_checkout::local_url(&self.dir)
    }

    /// `path`'s text at the synced commit; `None` when it holds no such file.
    pub async fn read_file(&self, path: &str) -> anyhow::Result<Option<String>> {
        self.read_file_at(&self.commit, path).await
    }

    /// `path`'s text at `rev` (a commit, a tag, a branch the checkout holds).
    /// `None` when the checkout does not hold `rev`, or `rev` no such file.
    pub async fn read_file_at(&self, rev: &str, path: &str) -> anyhow::Result<Option<String>> {
        let (dir, rev, path) = (self.dir.clone(), rev.to_owned(), path.to_owned());
        tokio::task::spawn_blocking(move || {
            crate::connectors::sdk::git_checkout::show_file_at(&dir, &rev, &path)
        })
        .await
        .map_err(|e| anyhow::anyhow!("the checkout read did not finish: {e}"))
    }

    /// `rev` as a full commit id, when the checkout holds it.
    pub async fn resolve(&self, rev: &str) -> Option<String> {
        let (dir, rev) = (self.dir.clone(), rev.to_owned());
        tokio::task::spawn_blocking(move || {
            crate::connectors::sdk::git_checkout::resolve_commit(&dir, &rev)
        })
        .await
        .ok()
        .flatten()
    }

    /// The newest `max` commits up to the synced commit that touched `path`
    /// (the whole repository when `None`), each with the files it changed.
    pub async fn log(&self, path: Option<&str>, max: usize) -> anyhow::Result<Vec<LoggedCommit>> {
        self.log_at(&self.commit, path, max).await
    }

    /// [`Self::log`] from `rev`.
    pub async fn log_at(
        &self,
        rev: &str,
        path: Option<&str>,
        max: usize,
    ) -> anyhow::Result<Vec<LoggedCommit>> {
        let (dir, rev, path) = (self.dir.clone(), rev.to_owned(), path.map(str::to_owned));
        tokio::task::spawn_blocking(move || {
            crate::connectors::sdk::git_checkout::log_at(&dir, &rev, path.as_deref(), max)
        })
        .await
        .map_err(|e| anyhow::anyhow!("the history read did not finish: {e}"))?
        .ok_or_else(|| anyhow::anyhow!("{}'s history could not be read", self.full_path))
    }

    /// Commit authors by the number of commits, most first, over the newest
    /// `max` commits: what a provider's contributor list answers, by name
    /// rather than login.
    pub async fn authors(&self, max: usize) -> anyhow::Result<Vec<(String, u64)>> {
        let log = self.log(None, max).await?;
        let mut counts: std::collections::BTreeMap<String, u64> = Default::default();
        for c in log {
            if let Some(name) = c.author_name.filter(|n| !n.trim().is_empty()) {
                *counts.entry(name).or_default() += 1;
            }
        }
        let mut out: Vec<(String, u64)> = counts.into_iter().collect();
        out.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        Ok(out)
    }
}

/// **The project's one checkout of each source, as the last sync left it.**
///
/// Reads never go to GitHub or GitLab. A project source has one clone on this
/// server, `{root}/{project_id}/{source dir}` -- the root is
/// `STUDIO_WORKSPACES_ROOT` when set, the directory the IDE's session works
/// in, and otherwise `STUDIO_ARTIFACT_WORKDIR` (a cluster whose sessions keep
/// their own volumes) -- and only the artifact sync fetches
/// it from the provider, marking the commit it read (`refs/studio/synced`).
/// Every other gear reads that commit through this port: files, tree,
/// history, authors. Nothing here touches the network; a source never synced
/// answers `None`, and the reader says "not synced yet" rather than asking
/// the provider instead.
///
/// The organization is not part of the key: a project id is a tenant id,
/// unique across organizations. Who may read is decided by reading the
/// project's config as the caller ([`Self::project_checkouts`]).
#[async_trait]
pub trait ProjectCheckout: Send + Sync + 'static {
    /// The checkout of `source` of `project`: the project layout, else a
    /// legacy sync clone keyed by the connection's `secret_ref`. `None` when
    /// it was never synced to this server.
    async fn source_checkout(
        &self,
        project: uuid::Uuid,
        source: &crate::project_sources::ProjectSource,
        secret_ref: Option<&str>,
    ) -> Option<SourceCheckout>;

    /// Every source of `project`, read as `ctx` reads its config, with its
    /// checkout. Empty when the config cannot be read by `ctx`.
    async fn project_checkouts(
        &self,
        ctx: &toolkit_security::SecurityContext,
        project: uuid::Uuid,
    ) -> Vec<(
        crate::project_sources::ProjectSource,
        Option<SourceCheckout>,
    )>;

    /// The checkout of the project's source `full_path` (`owner/repo`, any
    /// case). `None` when it is no source of the project's or was never
    /// synced.
    async fn checkout_of(
        &self,
        ctx: &toolkit_security::SecurityContext,
        project: uuid::Uuid,
        full_path: &str,
    ) -> Option<SourceCheckout> {
        let wanted = full_path.trim().trim_matches('/');
        self.project_checkouts(ctx, project)
            .await
            .into_iter()
            .find(|(s, _)| s.full_path.trim().eq_ignore_ascii_case(wanted))
            .and_then(|(_, c)| c)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_sources::ProjectSource;

    /// Two sources, one synced; what the port's default `checkout_of` finds.
    struct Two;

    #[async_trait]
    impl ProjectCheckout for Two {
        async fn source_checkout(
            &self,
            _: uuid::Uuid,
            _: &ProjectSource,
            _: Option<&str>,
        ) -> Option<SourceCheckout> {
            None
        }

        async fn project_checkouts(
            &self,
            _: &toolkit_security::SecurityContext,
            _: uuid::Uuid,
        ) -> Vec<(ProjectSource, Option<SourceCheckout>)> {
            let source = |full_path: &str| ProjectSource {
                full_path: full_path.to_owned(),
                ..ProjectSource::default()
            };
            let synced = SourceCheckout {
                full_path: "Acme/Api".to_owned(),
                dir: std::path::PathBuf::from("/nowhere/api"),
                commit: "a".repeat(40),
                shallow: false,
                layout: CheckoutLayout::Project,
            };
            vec![
                (source("Acme/Api"), Some(synced)),
                (source("acme/web"), None),
            ]
        }
    }

    #[tokio::test]
    async fn a_source_is_found_by_its_path_in_any_case_and_an_unsynced_one_is_not() {
        let ctx = toolkit_security::SecurityContext::builder()
            .subject_id(uuid::Uuid::from_u128(0x5e))
            .subject_tenant_id(uuid::Uuid::from_u128(0x0a))
            .build()
            .unwrap();
        let project = uuid::Uuid::from_u128(0x70);
        let found = Two.checkout_of(&ctx, project, "/acme/API/").await.unwrap();
        assert_eq!(found.dir, std::path::PathBuf::from("/nowhere/api"));
        assert!(Two.checkout_of(&ctx, project, "acme/web").await.is_none());
        assert!(Two.checkout_of(&ctx, project, "acme/other").await.is_none());
    }

    #[test]
    fn a_directory_without_git_is_no_checkout() {
        let dir = std::env::temp_dir().join(format!("no-checkout-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(SourceCheckout::at(dir.clone(), "acme/api", CheckoutLayout::Project).is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
