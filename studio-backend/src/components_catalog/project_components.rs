//! A project's components that are not gears, derived when its repositories
//! are synced and kept (`crate::derived_view`), never read from the provider
//! on a request.
//!
//! `GET /project-components` used to open every source repository through
//! its connection, list its whole tree, ask GraphQL for the open pull
//! requests and their files and read the history of up to 25 directories,
//! on every open of the tab: 16.8-18.2 s on the local stand (2026-11-24).
//! Each input is something a sync already holds:
//!
//! | what | from |
//! |---|---|
//! | the files a component is detected in | the sync's `repository-file` objects |
//! | the open pull requests and their files | the sync's `pull-request` objects and their `modifies_file` links |
//! | who changed a directory, and when last | `git log` of the server's clone of the repository |
//!
//! A repository the server has no clone of still lists its components, with
//! no owners and no last change, and its input says so.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use crate::artifact_ingest::port::{ArtifactFiles, LoggedCommit, OpenPullFiles, RepoFileReader};
use crate::derived_view::{Derive, Derived, ViewInput, ViewSpec};

use super::services::{Facts, Readiness, detect, readiness};

/// The view: one `project-component` per component, one
/// `project-component-view` per project.
pub(crate) static VIEW: ViewSpec = ViewSpec {
    gear: "studio-components-catalog",
    view: "project-components",
    task_type: "components.project-components",
    item_entity: "project-component",
    item_name: "Project Component",
    item_description: "A service or application in a project's repositories that is not a \
                       gear, found from its build manifest when the repository was synced.",
    item_fields: &[
        ("repo", "string"),
        ("dir", "string"),
        ("name", "string"),
        ("kind", "string"),
    ],
    state_entity: "project-component-view",
    state_name: "Project Components View",
};

/// The commits of a clone's history read per repository: enough to find
/// who changed each component (30 commits under it) in any but the busiest.
const HISTORY_COMMITS: usize = 3000;
/// The commits under one component its owners are counted from.
const COMPONENT_COMMITS: usize = 30;

/// One component as it is kept: the facts, not the verdict, which depends
/// on the day it is read.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct StoredComponent {
    pub repo: String,
    pub dir: String,
    pub name: String,
    pub kind: String,
    pub manifests: Vec<String>,
    pub contracts: Vec<String>,
    pub has_tests: bool,
    pub has_readme: bool,
    /// The people who changed it most, likeliest owner first (at most 3).
    pub owners: Vec<String>,
    /// How many people changed it in the history read.
    pub authors: usize,
    pub last_change: Option<String>,
    pub open_pulls: u32,
    pub open_pulls_partial: bool,
    /// The commit its files and history were read at, when known.
    pub commit: Option<String>,
}

impl StoredComponent {
    /// Its readiness on `now`.
    pub(crate) fn readiness(&self, now: time::OffsetDateTime) -> Readiness {
        let days = self.last_change.as_deref().and_then(|t| {
            time::OffsetDateTime::parse(t, &time::format_description::well_known::Rfc3339)
                .ok()
                .map(|at| (now - at).whole_days())
        });
        readiness(&Facts {
            days_since_change: days,
            authors: self.authors,
            open_pulls: usize::try_from(self.open_pulls).unwrap_or(usize::MAX),
            open_pulls_partial: self.open_pulls_partial,
            has_tests: self.has_tests,
            has_readme: self.has_readme,
            has_contract: !self.contracts.is_empty(),
        })
    }

    fn key(&self) -> String {
        format!("{}:{}", self.repo.to_ascii_lowercase(), self.dir)
    }
}

fn bot(login: &str) -> bool {
    let a = login.to_ascii_lowercase();
    a.ends_with("[bot]") || a.ends_with("-bot") || a == "github-actions" || a.contains("dependabot")
}

/// Who a commit is by: the GitHub login its no-reply address carries
/// (`123+login@users.noreply.github.com`), else the author's name.
fn author_of(c: &LoggedCommit) -> Option<String> {
    let login = c
        .author_email
        .as_deref()
        .and_then(|e| e.strip_suffix("@users.noreply.github.com"))
        .map(|local| local.rsplit('+').next().unwrap_or(local).to_owned())
        .filter(|l| !l.is_empty());
    login
        .or_else(|| c.author_name.clone())
        .filter(|w| !w.trim().is_empty() && !bot(w))
}

/// The components of one repository, from its file paths, the files each
/// open pull request changes, and its history when the server has a clone.
pub(crate) fn components_of(
    repo: &str,
    paths: &[String],
    open: &[&OpenPullFiles],
    open_partial: bool,
    history: Option<&[LoggedCommit]>,
    commit: Option<&str>,
) -> Vec<StoredComponent> {
    let gear_dirs: BTreeSet<String> = paths
        .iter()
        .filter(|p| p.ends_with("gear.gdl") || p.ends_with("gear.toml"))
        .map(|p| {
            p.rsplit_once('/')
                .map_or(String::new(), |(d, _)| d.to_string())
        })
        .collect();
    detect(repo, paths, &gear_dirs)
        .into_iter()
        .map(|f| {
            let prefix = if f.dir.is_empty() {
                String::new()
            } else {
                format!("{}/", f.dir)
            };
            let under = |p: &String| p.starts_with(&prefix);
            let open_pulls = open.iter().filter(|pr| pr.paths.iter().any(under)).count();
            let (owners, authors, last_change) = match history {
                Some(log) => {
                    let mine: Vec<&LoggedCommit> = log
                        .iter()
                        .filter(|c| prefix.is_empty() || c.paths.iter().any(under))
                        .take(COMPONENT_COMMITS)
                        .collect();
                    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
                    for who in mine.iter().filter_map(|c| author_of(c)) {
                        *counts.entry(who).or_default() += 1;
                    }
                    let mut ranked: Vec<(String, usize)> = counts.into_iter().collect();
                    ranked.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
                    let authors = ranked.len();
                    let last = mine.iter().filter_map(|c| c.committed_at.clone()).max();
                    (
                        ranked.into_iter().take(3).map(|(w, _)| w).collect(),
                        authors,
                        last,
                    )
                }
                None => (Vec::new(), 0, None),
            };
            StoredComponent {
                repo: repo.to_owned(),
                dir: f.dir,
                name: f.name,
                kind: f.kind,
                manifests: f.manifests,
                contracts: f.contracts,
                has_tests: f.has_tests,
                has_readme: f.has_readme,
                owners,
                authors,
                last_change,
                open_pulls: u32::try_from(open_pulls).unwrap_or(u32::MAX),
                open_pulls_partial: open_partial,
                commit: commit.map(str::to_owned),
            }
        })
        .collect()
}

/// A source the computation left out, and why: kept on the view's state,
/// answered as the listing's `unreadable`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Unreadable {
    pub source: String,
    pub reason: String,
}

/// What the view's state keeps beside its rows.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct Detail {
    /// Repositories whose files were read.
    pub repos: u32,
    pub unreadable: Vec<Unreadable>,
}

/// The computation, as `components.project-components` runs it.
pub(crate) struct ProjectComponents {
    hub: Arc<ClientHub>,
}

impl ProjectComponents {
    pub(crate) fn new(hub: Arc<ClientHub>) -> Self {
        Self { hub }
    }
}

#[async_trait]
impl Derive for ProjectComponents {
    fn spec(&self) -> &'static ViewSpec {
        &VIEW
    }

    async fn derive(
        &self,
        ctx: &SecurityContext,
        org: &SecurityContext,
        project: Uuid,
    ) -> anyhow::Result<Derived> {
        let scope = project.to_string();
        let mut unreadable: Vec<Unreadable> = Vec::new();
        // The project's sources, as its config names them: which repositories
        // and where the server checks each out.
        let sources = match self
            .hub
            .get::<dyn account_management_sdk::AccountManagementClient>()
        {
            Ok(am) => match crate::project_sources::read_checked(am.as_ref(), org, project).await {
                Ok(s) => s.unwrap_or_default(),
                Err(reason) => {
                    unreadable.push(Unreadable {
                        source: crate::project_sources::CONFIG_SOURCE.to_owned(),
                        reason,
                    });
                    Vec::new()
                }
            },
            Err(_) => Vec::new(),
        };
        let files_port = self
            .hub
            .get::<dyn ArtifactFiles>()
            .map_err(|_| anyhow::anyhow!("studio-artifact-ingest is not available"))?;
        let reader = self.hub.get::<dyn RepoFileReader>().ok();

        // What the syncs stored for the project: files by repository, and
        // the open pull requests with what they change.
        let repo_paths = files_port.repo_paths(ctx, &scope).await?;
        let mut by_repo: HashMap<String, Vec<String>> = HashMap::new();
        for f in files_port.list_files(ctx, &scope).await? {
            if let Some(full) = repo_paths.get(&f.repo) {
                by_repo
                    .entry(full.to_ascii_lowercase())
                    .or_default()
                    .push(f.path);
            }
        }
        let (open, open_partial) = match files_port.open_pull_files(ctx, &scope).await {
            Ok(open) => (open, false),
            Err(e) => {
                tracing::warn!(%project, error = %format!("{e:#}"), "project components: the open pull requests could not be read");
                (Vec::new(), true)
            }
        };

        let mut items: Vec<(String, Value)> = Vec::new();
        let mut inputs: Vec<ViewInput> = Vec::new();
        let mut repos = 0u32;
        let mut seen: BTreeSet<String> = BTreeSet::new();
        for source in sources {
            let lower = source.full_path.trim().to_ascii_lowercase();
            if !seen.insert(lower.clone()) {
                continue;
            }
            let Some(paths) = by_repo.get(&lower) else {
                unreadable.push(Unreadable {
                    source: source.full_path.clone(),
                    reason: "it has not been synced yet: its files are not on the server".into(),
                });
                continue;
            };
            repos += 1;
            // The server's clone of it, where the IDE and the sync share one:
            // its history says who changed what. Never the provider.
            let history = match &reader {
                Some(r) => r
                    .checkout_history(&scope, &source.dir, HISTORY_COMMITS)
                    .await
                    .unwrap_or_else(|e| {
                        tracing::warn!(%project, repo = %source.full_path, error = %format!("{e:#}"), "project components: the clone's history could not be read");
                        None
                    }),
                None => None,
            };
            let note = match &history {
                None => Some("no clone on the server: owners and last change unknown".to_owned()),
                Some(h) if h.shallow => Some(
                    "the server's clone is shallow: owners are from part of the history".to_owned(),
                ),
                Some(_) => None,
            };
            let commit = history.as_ref().map(|h| h.commit.clone());
            let open_here: Vec<&OpenPullFiles> = open
                .iter()
                .filter(|pr| pr.repo.eq_ignore_ascii_case(&source.full_path))
                .collect();
            for c in components_of(
                &source.full_path,
                paths,
                &open_here,
                open_partial,
                history.as_ref().map(|h| h.commits.as_slice()),
                commit.as_deref(),
            ) {
                items.push((c.key(), serde_json::to_value(&c)?));
            }
            inputs.push(ViewInput {
                source: source.full_path.clone(),
                commit,
                synced_at: None,
                note,
            });
        }
        Ok(Derived {
            inputs,
            items,
            detail: serde_json::to_value(Detail { repos, unreadable })?,
        })
    }
}

#[cfg(test)]
#[path = "project_components_tests.rs"]
mod tests;
