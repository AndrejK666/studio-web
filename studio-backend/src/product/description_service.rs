//! A project's product description as Studio keeps it (ADR-0053): the latest
//! revision -- taken over from where the project's record says it was last
//! saved, the first time it is read (§5) -- a new one, publishing it to the
//! repository on one branch (§3), reading back a change merged there, and the
//! old `product/*` branches a project may now delete.
//!
//! A child of `service`, so it reaches the service's repository plumbing.

use std::sync::Arc;

use anyhow::{Context, anyhow};
use serde_json::{Value, json};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::ProductService;
use crate::connectors::sdk::{FileToWrite, Repository};
use crate::product::descriptions::{
    self, DescriptionStore, NewRevision, Revision, SOURCE_MIGRATED, Saved,
};

/// Who a revision Studio took itself is by.
pub const STUDIO_AUTHOR: &str = "studio";

/// The caller does not reach the project (or it hangs under no
/// organization): "not yours" and "not there" are one answer, a 404.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProjectNotReachable(pub Uuid);

impl std::fmt::Display for ProjectNotReachable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "project {} is not found", self.0)
    }
}

impl std::error::Error for ProjectNotReachable {}

/// What publishing wrote.
#[derive(Debug, Clone)]
pub struct Publication {
    pub revision: i64,
    pub branch: String,
    pub commit_sha: String,
    pub pr_url: Option<String>,
    pub path: String,
}

/// The file on the repository's base branch, when it is not the latest
/// revision and changed after the last publish: a change made in the
/// repository, which the person may take as a new revision (ADR-0053 §3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepositoryChange {
    pub path: String,
    pub branch: String,
    pub text: String,
    pub sha256: String,
}

/// A `product/*` branch of the project's repository from before Studio kept
/// the description (ADR-0053 §5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OldBranch {
    pub branch: String,
    pub commit_sha: String,
    pub pr_url: Option<String>,
    /// Studio holds a revision with exactly this branch's description, so
    /// nothing is lost with the branch.
    pub held: bool,
}

/// Where the project's description lives in its repository: where it was
/// last written or published, else `products/<id>/product.gdl` -- the same
/// rule a preview writes by (`rest::product_path_for`).
pub fn description_path(record: Option<&Value>) -> Option<String> {
    let recorded = ["/published/path", "/written/path", "/description/path"]
        .iter()
        .find_map(|p| record.and_then(|r| r.pointer(p)).and_then(Value::as_str))
        .filter(|p| crate::product::gearbox::is_product_path(p))
        .map(str::to_owned);
    recorded.or_else(|| {
        record
            .and_then(|r| r.get("product_id"))
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .map(crate::product::gearbox::product_gdl_path)
    })
}

/// The ref a record says its description was last saved at: the commit when
/// it has one, else the branch (ADR-0053 §5).
pub fn saved_ref(record: &Value) -> Option<String> {
    let written = record.get("written")?;
    ["commit_sha", "branch"].iter().find_map(|k| {
        written
            .get(*k)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    })
}

/// Whether the base branch's file is a change to offer: not the latest
/// revision, and not what Studio itself last published.
pub fn is_repository_change(
    file_sha: &str,
    latest: Option<&Revision>,
    published_sha: Option<&str>,
) -> bool {
    latest.is_none_or(|l| l.sha256 != file_sha) && published_sha != Some(file_sha)
}

impl ProductService {
    /// Keep descriptions in `store` (the gear's database).
    pub fn set_descriptions(&self, store: Arc<DescriptionStore>) {
        let _ = self.descriptions.set(store);
    }

    /// The description store; `None` without a database.
    pub fn descriptions(&self) -> Option<Arc<DescriptionStore>> {
        self.descriptions.get().cloned()
    }

    /// The tenant a project's description is kept under: the organization the
    /// project hangs under, read as the caller -- never the tenant the request
    /// happens to act in. One project has one description whoever asks: the
    /// portal acting in `?organization_id=` and the desktop acting in the
    /// member's home tenant reach the same revisions. A caller who cannot
    /// read the project is refused ([`ProjectNotReachable`], a 404).
    pub async fn description_tenant(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
    ) -> anyhow::Result<Uuid> {
        self.organization_of_project(ctx, project)
            .await
            .ok_or_else(|| ProjectNotReachable(project).into())
    }

    fn store(&self) -> anyhow::Result<Arc<DescriptionStore>> {
        self.descriptions()
            .ok_or_else(|| anyhow!("product descriptions are not kept in this deployment"))
    }

    /// The project's latest revision. A project with none whose record says
    /// where its description was last saved gets that text as revision 1
    /// (ADR-0053 §5); one that never saved any has none.
    pub async fn latest_description(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
    ) -> anyhow::Result<Option<Revision>> {
        let store = self.store()?;
        let tenant = self.description_tenant(ctx, project).await?;
        if let Some(latest) = store.latest(tenant, project).await? {
            return Ok(Some(latest));
        }
        let record = self
            .get_project_product(ctx, &project.to_string())
            .await?
            .map(|n| n.value);
        let (Some(record), Some(path)) = (record.as_ref(), description_path(record.as_ref()))
        else {
            return Ok(None);
        };
        let Some(at) = saved_ref(record) else {
            return Ok(None);
        };
        let text = match self
            .read_project_file_at(ctx, &project.to_string(), &path, Some(&at))
            .await
        {
            Ok(Some(text)) if descriptions::checked_text(&text).is_ok() => text,
            Ok(_) => return Ok(None),
            Err(e) => {
                tracing::warn!(%project, error = %format!("{e:#}"), "studio-product: the description could not be taken over from where it was last saved");
                return Ok(None);
            }
        };
        let saved = store
            .save(
                tenant,
                project,
                &NewRevision {
                    base_revision: None,
                    text: &text,
                    author: STUDIO_AUTHOR,
                    source: SOURCE_MIGRATED,
                },
            )
            .await?;
        tracing::info!(%project, %path, at = %at, "studio-product: the description is kept by Studio from now on (revision 1 taken from where it was saved)");
        Ok(Some(match saved {
            Saved::Created(r) | Saved::Unchanged(r) | Saved::Stale(r) => r,
        }))
    }

    /// One revision of the project's description.
    pub async fn description_revision(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        revision: i64,
    ) -> anyhow::Result<Option<Revision>> {
        self.store()?
            .get(
                self.description_tenant(ctx, project).await?,
                project,
                revision,
            )
            .await
    }

    /// The project's revisions, newest first.
    pub async fn description_revisions(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        limit: u64,
    ) -> anyhow::Result<Vec<Revision>> {
        self.store()?
            .list(self.description_tenant(ctx, project).await?, project, limit)
            .await
    }

    /// Save `text` as the project's next revision, made against `base`, by
    /// the caller. The record learns the revision and the path, so a build
    /// that names nothing builds it.
    pub async fn save_description(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        base: Option<i64>,
        text: &str,
        source: &str,
        path: Option<&str>,
    ) -> anyhow::Result<Saved> {
        let author = ctx.subject_id().to_string();
        let saved = self
            .store()?
            .save(
                self.description_tenant(ctx, project).await?,
                project,
                &NewRevision {
                    base_revision: base,
                    text,
                    author: &author,
                    source,
                },
            )
            .await?;
        if let Saved::Created(r) = &saved {
            let record = self
                .get_project_product(ctx, &project.to_string())
                .await?
                .map(|n| n.value);
            let path = path
                .map(str::to_owned)
                .or_else(|| description_path(record.as_ref()));
            let mut patch = serde_json::Map::new();
            patch.insert(
                "description".into(),
                json!({ "revision": r.revision, "sha256": r.sha256, "path": path }),
            );
            if let Err(e) = self
                .update_project_product(ctx, &project.to_string(), patch)
                .await
            {
                tracing::warn!(error = %format!("{e:#}"), "studio-product: the record could not learn the description's revision");
            }
        }
        Ok(saved)
    }

    /// The base branch's file, when it was changed in the repository after
    /// Studio last published it (ADR-0053 §3). Only for a project that
    /// publishes: one that never did keeps its description in Studio alone,
    /// and reading the repository on every open would cost it a provider
    /// call for nothing.
    pub async fn repository_change(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        latest: Option<&Revision>,
    ) -> Option<RepositoryChange> {
        let record = self
            .get_project_product(ctx, &project.to_string())
            .await
            .ok()
            .flatten()?
            .value;
        let published = record.get("published")?;
        let path = description_path(Some(&record))?;
        let published_sha = published.get("sha256").and_then(Value::as_str);
        let target = self.write_target(ctx, &project.to_string()).await.ok()?;
        let text = self
            .read_project_file_at(ctx, &project.to_string(), &path, None)
            .await
            .ok()
            .flatten()?;
        let sha256 = descriptions::digest(&text);
        is_repository_change(&sha256, latest, published_sha).then_some(RepositoryChange {
            path,
            branch: target.base_branch,
            text,
            sha256,
        })
    }

    /// Publish the latest revision (ADR-0053 §3): onto the base branch when
    /// `onto_base`, else onto `product/<id>`, recreated from the base branch,
    /// with one pull request opened or kept open. The record keeps which
    /// revision it was.
    pub async fn publish_description(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        onto_base: bool,
    ) -> anyhow::Result<Publication> {
        let latest = self
            .latest_description(ctx, project)
            .await?
            .ok_or_else(|| anyhow!("the project has no description to publish yet"))?;
        let key = project.to_string();
        let record = self.get_project_product(ctx, &key).await?.map(|n| n.value);
        let product_id = record
            .as_ref()
            .and_then(|r| r.get("product_id"))
            .and_then(Value::as_str)
            .filter(|s| crate::product::gearbox::is_kebab_id(s))
            .map(str::to_owned)
            .ok_or_else(|| anyhow!("the project's product has no id yet"))?;
        let path = description_path(record.as_ref())
            .unwrap_or_else(|| crate::product::gearbox::product_gdl_path(&product_id));
        let target = self.write_target(ctx, &key).await?;
        self.ensure_owned(ctx, super::scope_of(ctx, &key), &target)
            .await?;
        let repo = self.open_target(ctx, &target, None).await?;
        let message = format!(
            "product: describe {product_id} (Studio revision {})",
            latest.revision
        );
        let files = [FileToWrite {
            path: path.clone(),
            content: latest.text.clone(),
        }];
        let (branch, commit_sha, pr_url) = if onto_base {
            let sha = repo
                .commit_changes(
                    &target.base_branch,
                    &target.base_branch,
                    &files,
                    &[],
                    &message,
                )
                .await
                .context("the description could not be committed onto the base branch")?;
            (target.base_branch.clone(), sha, None)
        } else {
            let branch = publish_branch(&product_id);
            let sha = repo
                .commit_replacing_branch(&target.base_branch, &branch, &files, &message)
                .await
                .context("the description's branch could not be written")?;
            let pr = repo
                .open_pull_request(
                    &branch,
                    &target.base_branch,
                    &format!("Describe the {product_id} product"),
                    Some(&format!(
                        "Published by Constructor Studio: revision {} of the product's \
                         description, which Studio keeps (ADR-0053). Merged, `{path}` on \
                         `{}` is the published description; the CLI and the repository's \
                         own CI read it there. Publishing again updates this branch and \
                         this pull request.",
                        latest.revision, target.base_branch
                    )),
                )
                .await
                .context("the pull request could not be opened")?;
            (branch, sha, pr.url)
        };
        let publication = Publication {
            revision: latest.revision,
            branch,
            commit_sha,
            pr_url,
            path,
        };
        let mut patch = serde_json::Map::new();
        let at = descriptions::rfc3339(
            i64::try_from(time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000)
                .unwrap_or(0),
        );
        patch.insert(
            "published".into(),
            json!({
                "revision": publication.revision,
                "sha256": latest.sha256,
                "branch": publication.branch,
                "commit_sha": publication.commit_sha,
                "pr_url": publication.pr_url,
                "path": publication.path,
                "at": at,
            }),
        );
        // What the Product step wrote, in the shape readers of `written`
        // already know: the path a build finds the description at.
        patch.insert(
            "written".into(),
            json!({
                "branch": publication.branch,
                "commit_sha": publication.commit_sha,
                "pr_url": publication.pr_url,
                "path": publication.path,
            }),
        );
        self.update_project_product(ctx, &key, patch).await?;
        Ok(publication)
    }

    /// The project's `product/*` branches other than the one publishing
    /// writes, each with its pull request and whether Studio holds its
    /// description (ADR-0053 §5). Nothing is deleted here.
    pub async fn old_product_branches(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
    ) -> anyhow::Result<Vec<OldBranch>> {
        let key = project.to_string();
        let record = self.get_project_product(ctx, &key).await?.map(|n| n.value);
        let keep = record
            .as_ref()
            .and_then(|r| r.get("product_id"))
            .and_then(Value::as_str)
            .map(publish_branch);
        let path = description_path(record.as_ref());
        let target = self.write_target(ctx, &key).await?;
        self.ensure_owned(ctx, super::scope_of(ctx, &key), &target)
            .await?;
        let repo = self.open_target(ctx, &target, None).await?;
        let held: std::collections::HashSet<String> = self
            .description_revisions(ctx, project, 500)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|r| r.sha256)
            .collect();
        let mut out = Vec::new();
        for (branch, commit_sha) in repo.branches_with_prefix("product/").await? {
            if keep.as_deref() == Some(branch.as_str()) {
                continue;
            }
            let pr_url = repo
                .open_pull_request_from(&branch, &target.base_branch)
                .await
                .ok()
                .flatten()
                .and_then(|p| p.url);
            let mut holds = false;
            if let Some(path) = &path
                && let Ok(at) = self.open_target(ctx, &target, Some(&commit_sha)).await
                && let Ok(Some(file)) = at.read_file(path).await
            {
                holds = held.contains(&descriptions::digest(&file.text));
            }
            out.push(OldBranch {
                branch,
                commit_sha,
                pr_url,
                held: holds,
            });
        }
        Ok(out)
    }

    /// `target`'s repository through its connection, at `git_ref` (its
    /// default branch when `None`).
    async fn open_target(
        &self,
        ctx: &SecurityContext,
        target: &crate::product::port::RepositoryTarget,
        git_ref: Option<&str>,
    ) -> anyhow::Result<Repository> {
        let connectors = self
            .connector_service()
            .ok_or_else(|| anyhow!("connectors service unavailable"))?;
        Repository::open(
            &connectors,
            ctx,
            target.tenant,
            target.connection_id,
            "github",
            &target.repo,
            git_ref,
        )
        .await
    }

    /// The text of `path` in the project's repository at `git_ref` (its base
    /// branch when `None`); `None` when there is no such file there.
    pub async fn read_project_file_at(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
        path: &str,
        git_ref: Option<&str>,
    ) -> anyhow::Result<Option<String>> {
        let target = self.write_target(ctx, project_id).await?;
        self.ensure_owned(ctx, super::scope_of(ctx, project_id), &target)
            .await?;
        let at = git_ref.unwrap_or(&target.base_branch).to_owned();
        let repo = self.open_target(ctx, &target, Some(&at)).await?;
        Ok(repo.read_file(path).await?.map(|f| f.text))
    }
}

/// The one branch a product's description is published on (ADR-0053 §3).
pub fn publish_branch(product_id: &str) -> String {
    format!("product/{product_id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rev(sha: &str) -> Revision {
        Revision {
            revision: 3,
            text: String::new(),
            author: "u".into(),
            created_at_ms: 0,
            sha256: sha.into(),
            source: descriptions::SOURCE_STUDIO.into(),
        }
    }

    #[test]
    fn the_path_is_where_it_was_published_written_or_kept_else_the_products_own() {
        assert_eq!(description_path(None), None);
        let fresh = json!({ "product_id": "shop" });
        assert_eq!(
            description_path(Some(&fresh)).as_deref(),
            Some("products/shop/product.gdl")
        );
        let written = json!({ "product_id": "shop", "written": { "path": "product.gdl" } });
        assert_eq!(
            description_path(Some(&written)).as_deref(),
            Some("product.gdl")
        );
        let kept =
            json!({ "product_id": "shop", "description": { "path": "products/x/product.gdl" } });
        assert_eq!(
            description_path(Some(&kept)).as_deref(),
            Some("products/x/product.gdl")
        );
    }

    #[test]
    fn a_record_is_taken_over_from_its_commit_else_its_branch() {
        let r = json!({ "written": { "branch": "product/shop-1a2b", "commit_sha": "abc123" } });
        assert_eq!(saved_ref(&r).as_deref(), Some("abc123"));
        let r = json!({ "written": { "branch": "product/shop-1a2b", "commit_sha": "" } });
        assert_eq!(saved_ref(&r).as_deref(), Some("product/shop-1a2b"));
        assert_eq!(saved_ref(&json!({ "gears": [] })), None);
    }

    #[test]
    fn only_a_change_made_in_the_repository_is_offered_back() {
        // What Studio published, unchanged: nothing to offer.
        assert!(!is_repository_change("p", Some(&rev("q")), Some("p")));
        // The latest already is the file.
        assert!(!is_repository_change("q", Some(&rev("q")), Some("p")));
        // Edited in the repository after the publish.
        assert!(is_repository_change("r", Some(&rev("q")), Some("p")));
        assert_eq!(publish_branch("shop"), "product/shop");
    }
}
