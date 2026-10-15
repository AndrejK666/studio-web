//! Extract: a registered gear leaves its project for the organization's gear
//! repository (ADR-0044 §1, phase 2).
//!
//! `POST /registry/{name}/decisions` with `action: extract`, on a
//! `registered` Rust gear that passes the readiness check
//! (`registry_readiness.rs`), opens two pull requests:
//!
//! 1. Into the **organization's gear repository** (ADR-0042 §2): the gear as
//!    its own crate at `gears/<name>/`, on `extract/<name>`. A crate is copied
//!    as it is; a module becomes `src/lib.rs` (its `mod.rs` or `<name>.rs`)
//!    and `src/…` (the rest), its `crate::<module>::` paths now `crate::`,
//!    with a `Cargo.toml` written from the dependencies the readiness check
//!    listed. Its `gear.gdl`, `gear.toml` and README sit beside the manifest.
//! 2. Into the **project it leaves**, through the occurrence's own connection:
//!    the module's files deleted, the crate's `Cargo.toml` depending on the
//!    new crate at its tag (`<name>/v0.1.0`), and the parent module's
//!    `mod <name>;` now `use <crate> as <name>;`, so the project's other code
//!    compiles unchanged.
//!
//! The entry stays `registered` and records the `extraction`.
//! `complete_extraction` checks both are merged -- the crate's `Cargo.toml`
//! is on the gear repository's base branch, and the moved file is gone from
//! the project's -- tags the gear repository's tip, and moves the entry to
//! `extracted` at that version.
//!
//! The rules (where each file goes, the manifest, the project's edits) are
//! pure functions; reading and writing go through `OccurrenceFiles`,
//! [`ExtractionRepos`] and studio-product's `GearContributions`, so the
//! whole of it is tested without a provider.

use std::collections::BTreeMap;

use async_trait::async_trait;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::candidates::kebab;
use super::registry::{self, EntryRecord, Extraction, RegistryEntry, STATE_REGISTERED};
use super::registry_decisions::{
    Action, DecideFailure, Decider, DecisionError, DecisionInput, DecisionRecord, transition,
};
use super::registry_publish::{
    DEFAULT_PARENT, MAX_FILES, OccurrenceFiles, bounded, declaring_occurrence,
};
use super::registry_readiness::{self, Dependency, OUTSIDE_BUDGET, Unit};
use super::service::CatalogService;
use crate::product::port::{DeclarationFile, GearContributions, PullRequestText, RepositoryTarget};

/// The version a gear is extracted at.
pub const FIRST_VERSION: &str = "0.1.0";

/// The edition a new crate is written with when its project's manifest names
/// none.
const DEFAULT_EDITION: &str = "2021";

/// Files that describe a gear rather than build it: they sit beside the new
/// crate's manifest, not under `src/`.
const BESIDE_MANIFEST: [&str; 4] = ["gear.gdl", "gear.toml", "README.md", "CHANGELOG.md"];

/// Why extracting was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExtractError {
    NotFound(String),
    /// Only a `registered` entry is extracted.
    NotRegistered {
        state: String,
    },
    /// An extraction is open: its pull requests are not both merged yet.
    Open {
        gear_pr: Option<String>,
        source_pr: Option<String>,
    },
    /// Rust gears first (ADR-0044 §1, Defaults).
    NotRust {
        kind: String,
    },
    /// The organization names no gear repository.
    NoGearRepository,
    NoOccurrence,
    NoConnection,
    /// Read through a connection the organization only inherits.
    NotOwnConnection {
        tenant: Uuid,
    },
    /// It is in the organization's gear repository already.
    AlreadyInOrganization,
    /// The readiness check blocks it: each blocking check, in words.
    NotReady {
        blocking: Vec<String>,
    },
    /// Nothing is at the occurrence's path any more.
    Gone(String),
    /// A module outside any crate: there is no manifest to depend from.
    NoManifest,
    Empty {
        path: String,
    },
    TooLarge {
        files: usize,
        bytes: u64,
    },
    /// `complete_extraction` on an entry with no open extraction.
    NotExtracting,
    /// Not both merged yet: which.
    NotMerged {
        what: String,
    },
}

impl std::fmt::Display for ExtractError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(name) => write!(f, "the registry has no component `{name}`"),
            Self::NotRegistered { state } => write!(
                f,
                "a `{state}` entry cannot be extracted; register it first"
            ),
            Self::Open { gear_pr, source_pr } => write!(
                f,
                "an extraction is open: merge its pull requests ({}, {}) and complete it",
                gear_pr.as_deref().unwrap_or("into the gear repository"),
                source_pr.as_deref().unwrap_or("into the project")
            ),
            Self::NotRust { kind } => write!(
                f,
                "a `{kind}` component is not extracted yet: Rust gears first"
            ),
            Self::NoGearRepository => write!(
                f,
                "the organization has no gear repository to extract into; name one on the organization's Components page"
            ),
            Self::NoOccurrence => write!(
                f,
                "no repository declares this component, so there is nothing to move"
            ),
            Self::NoConnection => write!(
                f,
                "the registry does not know which connection reads this component's repository yet; read the project again"
            ),
            Self::NotOwnConnection { tenant } => write!(
                f,
                "the component's repository is read through a connection of tenant {tenant}, which the organization only inherits; connect the repository on the project's or the organization's Connections page and read the project again"
            ),
            Self::AlreadyInOrganization => write!(
                f,
                "the component is in the organization's gear repository already"
            ),
            Self::NotReady { blocking } => write!(
                f,
                "the component is not ready to leave its project: {}",
                blocking.join("; ")
            ),
            Self::Gone(path) => write!(f, "nothing is at `{path}` any more; read the project again"),
            Self::NoManifest => write!(
                f,
                "the component is not inside a crate, so there is no Cargo.toml to depend on it from"
            ),
            Self::Empty { path } => write!(f, "`{path}` holds no file to move"),
            Self::TooLarge { files, bytes } => write!(
                f,
                "the component holds {files} files and {bytes} bytes; Extract moves at most {MAX_FILES} files and {} bytes",
                super::registry_publish::MAX_BYTES
            ),
            Self::NotExtracting => write!(f, "no extraction is open for this component"),
            Self::NotMerged { what } => write!(f, "not both merged yet: {what}"),
        }
    }
}

/// A refusal by the rules, a decision refused, or a failure.
#[derive(Debug)]
pub enum ExtractFailure {
    Refused(ExtractError),
    Decision(DecisionError),
    Failed(anyhow::Error),
}

impl From<anyhow::Error> for ExtractFailure {
    fn from(e: anyhow::Error) -> Self {
        Self::Failed(e)
    }
}

impl From<DecideFailure> for ExtractFailure {
    fn from(e: DecideFailure) -> Self {
        match e {
            DecideFailure::Refused(e) => Self::Decision(e),
            DecideFailure::Failed(e) => Self::Failed(e),
        }
    }
}

/// What Extract asks of a repository beyond its files: its default branch,
/// and whether a file is on a branch. Through a connection in production; a
/// table in tests.
#[async_trait]
pub trait ExtractionRepos: Send + Sync {
    async fn default_branch(&self, ctx: &SecurityContext, at: &RepositoryTarget)
    -> anyhow::Result<String>;

    /// Whether `path` is on `at`'s base branch.
    async fn has_file(
        &self,
        ctx: &SecurityContext,
        at: &RepositoryTarget,
        path: &str,
    ) -> anyhow::Result<bool>;
}

/// [`ExtractionRepos`] through the target's connection.
pub struct ConnectionRepos<'a>(pub &'a CatalogService);

impl ConnectionRepos<'_> {
    async fn open(
        &self,
        ctx: &SecurityContext,
        at: &RepositoryTarget,
        branch: Option<&str>,
    ) -> anyhow::Result<crate::connectors::sdk::Repository> {
        let connectors = self
            .0
            .connector_service()
            .ok_or_else(|| anyhow::anyhow!("no connector service is available"))?;
        crate::connectors::sdk::Repository::open(
            &connectors,
            ctx,
            at.tenant,
            at.connection_id,
            "github",
            &at.repo,
            branch,
        )
        .await
    }
}

#[async_trait]
impl ExtractionRepos for ConnectionRepos<'_> {
    async fn default_branch(
        &self,
        ctx: &SecurityContext,
        at: &RepositoryTarget,
    ) -> anyhow::Result<String> {
        self.open(ctx, at, None).await?.default_branch().await
    }

    async fn has_file(
        &self,
        ctx: &SecurityContext,
        at: &RepositoryTarget,
        path: &str,
    ) -> anyhow::Result<bool> {
        Ok(self
            .open(ctx, at, Some(&at.base_branch))
            .await?
            .read_file(path)
            .await?
            .is_some())
    }
}

/// `<gear>/v<version>`.
pub fn tag_of(name: &str, version: &str) -> String {
    format!("{}/v{version}", kebab(name))
}

/// The branch both pull requests are written on.
pub fn branch_of(name: &str) -> String {
    format!("extract/{}", kebab(name))
}

/// A crate name as Rust code names it.
pub fn crate_ident(crate_name: &str) -> String {
    crate_name.replace('-', "_")
}

fn parent(path: &str) -> &str {
    path.rfind('/').map_or("", |i| &path[..i])
}

fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// `[package] name` of a manifest.
pub fn package_name(manifest: &str) -> Option<String> {
    let mut in_package = false;
    for line in manifest.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            in_package = t == "[package]";
            continue;
        }
        if in_package
            && let Some(rest) = t.strip_prefix("name")
            && let Some(value) = rest.trim_start().strip_prefix('=')
        {
            return Some(value.trim().trim_matches('"').to_owned());
        }
    }
    None
}

/// `[package] edition` of a manifest, when it names one.
pub fn package_edition(manifest: &str) -> Option<String> {
    let mut in_package = false;
    for line in manifest.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            in_package = t == "[package]";
            continue;
        }
        if in_package
            && let Some(rest) = t.strip_prefix("edition")
            && let Some(value) = rest.trim_start().strip_prefix('=')
        {
            let v = value.trim().trim_matches('"');
            // `edition.workspace = true` names no edition here.
            return (!v.is_empty() && v.chars().all(|c| c.is_ascii_digit())).then(|| v.to_owned());
        }
    }
    None
}

/// The module's code as its own crate's: `crate::<module path>::` is
/// `crate::` there.
pub fn rehome(text: &str, module_path: &[String]) -> String {
    if module_path.is_empty() {
        return text.to_owned();
    }
    let path = module_path.join("::");
    text.replace(&format!("crate::{path}::"), "crate::")
}

/// The new crate's `Cargo.toml`: its name and version, the edition its
/// project used, and the dependencies the readiness check listed.
pub fn cargo_toml(crate_name: &str, edition: &str, deps: &[Dependency]) -> String {
    let mut out = format!(
        "[package]\nname = \"{crate_name}\"\nversion = \"{FIRST_VERSION}\"\nedition = \"{edition}\"\npublish = false\n\n[dependencies]\n"
    );
    let mut workspace = false;
    for d in deps {
        let spec = d.spec.clone().unwrap_or_else(|| "\"*\"".to_owned());
        workspace |= spec.contains("workspace");
        out.push_str(&format!("{} = {spec}\n", d.name));
    }
    if workspace {
        out.push_str(
            "\n# `workspace = true` entries resolve against the gear repository's workspace:\n# list them in its root Cargo.toml.\n",
        );
    }
    out
}

/// Where each of the unit's files goes in the new crate, under `dest`, and
/// what is not moved (not text). A crate moves as it is; a module's top file
/// is `src/lib.rs`, its other files `src/…`, its descriptions beside the
/// manifest, its code re-homed ([`rehome`]).
pub fn crate_files(
    unit: &Unit,
    texts: &BTreeMap<String, String>,
    dest: &str,
    crate_name: &str,
    edition: &str,
    deps: &[Dependency],
) -> (Vec<DeclarationFile>, Vec<String>) {
    let mut placed = Vec::new();
    let mut skipped = Vec::new();
    let root = unit.path.trim_matches('/');
    for file in &unit.files {
        let Some(text) = texts.get(file) else {
            skipped.push(file.clone());
            continue;
        };
        let rel = file
            .strip_prefix(&format!("{root}/"))
            .unwrap_or_else(|| file_name(file));
        let (to, content) = if unit.kind == "crate" {
            (format!("{dest}/{rel}"), text.clone())
        } else if file == &format!("{root}.rs") || file == &format!("{root}/mod.rs") {
            (
                format!("{dest}/src/lib.rs"),
                rehome(text, &unit.module_path),
            )
        } else if !rel.contains('/') && BESIDE_MANIFEST.contains(&rel) {
            (format!("{dest}/{rel}"), text.clone())
        } else if rel.ends_with(".rs") {
            (
                format!("{dest}/src/{rel}"),
                rehome(text, &unit.module_path),
            )
        } else {
            (format!("{dest}/src/{rel}"), text.clone())
        };
        placed.push(DeclarationFile { path: to, content });
    }
    if unit.kind != "crate" {
        placed.push(DeclarationFile {
            path: format!("{dest}/Cargo.toml"),
            content: cargo_toml(crate_name, edition, deps),
        });
    }
    (placed, skipped)
}

/// The project's manifest depending on the new crate at its tag: one line
/// under `[dependencies]`, the section added when there is none. A manifest
/// that already names the crate is left as it is.
pub fn depend_on(manifest: &str, crate_name: &str, git_url: &str, tag: &str) -> String {
    let line = format!("{crate_name} = {{ git = \"{git_url}\", tag = \"{tag}\" }}");
    if manifest
        .lines()
        .any(|l| l.trim_start().starts_with(&format!("{crate_name} ")) || l.trim_start().starts_with(&format!("{crate_name}=")))
    {
        return manifest.to_owned();
    }
    let mut out = String::with_capacity(manifest.len() + line.len() + 1);
    let mut added = false;
    for l in manifest.lines() {
        out.push_str(l);
        out.push('\n');
        if !added && l.trim() == "[dependencies]" {
            out.push_str(&line);
            out.push('\n');
            added = true;
        }
    }
    if !added {
        if !out.ends_with("\n\n") {
            out.push('\n');
        }
        out.push_str("[dependencies]\n");
        out.push_str(&line);
        out.push('\n');
    }
    out
}

/// The parent module's `mod <name>;` as `use <crate> as <name>;`, its
/// visibility kept, so every `crate::<name>::…` in the project still
/// resolves. `None` when no such line is there.
pub fn reexport(parent_text: &str, module: &str, crate_ident: &str) -> Option<String> {
    let mut found = false;
    let out: Vec<String> = parent_text
        .lines()
        .map(|l| {
            let t = l.trim();
            let indent = &l[..l.len() - l.trim_start().len()];
            let (vis, rest) = match t.find("mod ") {
                Some(i) => (&t[..i], &t[i + 4..]),
                None => return l.to_owned(),
            };
            let vis_ok = vis.is_empty() || (vis.starts_with("pub") && vis.ends_with(' '));
            let rest = rest.trim();
            let name = rest.strip_suffix(';').map(str::trim);
            if !found && vis_ok && name == Some(module) {
                found = true;
                // The module moved out: its code is the crate's now.
                format!("{indent}{vis}use {crate_ident} as {module};")
            } else {
                l.to_owned()
            }
        })
        .collect();
    found.then(|| {
        let mut s = out.join("\n");
        if parent_text.ends_with('\n') {
            s.push('\n');
        }
        s
    })
}

/// The file that declares the module `module_path` in its crate: `lib.rs`
/// (or `main.rs`) for a top module, else the parent module's `mod.rs` or
/// `<parent>.rs`. From the listing.
pub fn parent_module_file(listing: &[String], manifest: &str, module_path: &[String]) -> Option<String> {
    let src = if parent(manifest).is_empty() {
        "src".to_owned()
    } else {
        format!("{}/src", parent(manifest))
    };
    let has = |p: &str| listing.iter().any(|f| f == p);
    let candidates: Vec<String> = match module_path.split_last() {
        None => return None,
        Some((_, [])) => vec![format!("{src}/lib.rs"), format!("{src}/main.rs")],
        Some((_, up)) => {
            let dir = format!("{src}/{}", up.join("/"));
            vec![format!("{dir}/mod.rs"), format!("{dir}.rs")]
        }
    };
    candidates.into_iter().find(|c| has(c))
}

/// The words of the two pull requests.
pub fn extraction_texts(
    organization: &str,
    entry: &EntryRecord,
    x: &Extraction,
    skipped: &[String],
) -> (PullRequestText, PullRequestText) {
    let name = &entry.name;
    let owner = entry
        .owner
        .as_ref()
        .map(|o| format!("{} ({})", o.name, o.kind))
        .unwrap_or_else(|| "nobody named".to_owned());
    let from = format!(
        "`{}` at `{}`{}",
        x.source_repo,
        x.source_path,
        x.project_name
            .as_deref()
            .map(|p| format!(" (project {p})"))
            .unwrap_or_default()
    );
    let mut gear_body = format!(
        "**{organization}** extracts the gear `{name}` from its project into the organization's gear repository (ADR-0044).\n\n\
         - Crate: `{crate_name}` {version}, placed at `{path}`\n\
         - From: {from}\n\
         - Owner: {owner}\n\
         - The project's pull request: {source_pr}\n\n\
         Once both are merged, Studio tags this repository `{tag}` and the registry marks `{name}` extracted. \
         Check the crate builds on its own before merging: Studio wrote its `Cargo.toml` from the dependencies the readiness check found.",
        crate_name = x.crate_name,
        version = x.version,
        path = x.gear_path,
        tag = x.tag,
        source_pr = x.source_pr_url.as_deref().unwrap_or("opened with this one"),
    );
    if !skipped.is_empty() {
        gear_body.push_str(&format!(
            "\n\nNot moved (not text): {}",
            skipped
                .iter()
                .map(|s| format!("`{s}`"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    let source_body = format!(
        "The gear `{name}` leaves this project for **{organization}**'s gear repository (ADR-0044).\n\n\
         - Removed: `{path}`\n\
         - Now a dependency: `{crate_name} = {{ git = \"https://github.com/{repo}.git\", tag = \"{tag}\" }}`\n\
         {top}\n\
         Merge the gear repository's pull request first ({gear_pr}): the tag `{tag}` is made once both are merged.",
        path = x.source_path,
        crate_name = x.crate_name,
        repo = x.gear_repo,
        tag = x.tag,
        top = x
            .source_top
            .as_deref()
            .map(|t| format!("- `{t}` uses the crate in the module's place, so the rest of the code is unchanged\n"))
            .unwrap_or_default(),
        gear_pr = x.gear_pr_url.as_deref().unwrap_or("opened with this one"),
    );
    (
        PullRequestText {
            message: format!("extract: {name} from {}", x.source_repo),
            title: format!("Extract {name} from {}", x.source_repo),
            body: gear_body,
        },
        PullRequestText {
            message: format!("extract: {name} moves to {}", x.gear_repo),
            title: format!("{name} moves to {}", x.gear_repo),
            body: source_body,
        },
    )
}

/// What Extract writes, before it is written: a dry run's answer.
#[derive(Clone, Debug, PartialEq)]
pub struct ExtractPlan {
    pub extraction: Extraction,
    pub gear_target: RepositoryTarget,
    pub gear_files: Vec<DeclarationFile>,
    pub source_target: RepositoryTarget,
    pub source_files: Vec<DeclarationFile>,
    pub source_deleted: Vec<String>,
    pub skipped: Vec<String>,
    pub gear_text: PullRequestText,
    pub source_text: PullRequestText,
    /// The tenant the project's pull request is written as.
    pub source_tenant: Option<Uuid>,
}

impl CatalogService {
    /// What extracting the registered entry `name` would write, and where.
    /// Nothing is written. Every refusal of [`Self::extract_registry`] is made
    /// here.
    pub async fn plan_extract(
        &self,
        ctx: &SecurityContext,
        name: &str,
        by: &Decider,
        files: &dyn OccurrenceFiles,
        repos: &dyn ExtractionRepos,
    ) -> Result<(RegistryEntry, ExtractPlan), ExtractFailure> {
        let refuse = |e| Err(ExtractFailure::Refused(e));
        let wanted = name.trim();
        let Some(entry) = self.registry_entry(ctx, wanted).await? else {
            return refuse(ExtractError::NotFound(wanted.to_owned()));
        };
        let e = &entry.entry;
        if transition(Action::Extract, &e.state, true).is_none() || e.state != STATE_REGISTERED {
            return refuse(ExtractError::NotRegistered {
                state: e.state.clone(),
            });
        }
        if let Some(x) = &e.extraction
            && x.completed_at.is_none()
        {
            return refuse(ExtractError::Open {
                gear_pr: x.gear_pr_url.clone(),
                source_pr: x.source_pr_url.clone(),
            });
        }
        if matches!(e.kind.as_str(), "frontx" | "kit" | "package") {
            return refuse(ExtractError::NotRust {
                kind: e.kind.clone(),
            });
        }
        let Some(gear_repo) = self.gear_repository(ctx).await? else {
            return refuse(ExtractError::NoGearRepository);
        };
        let Some(occ) = declaring_occurrence(&entry).cloned() else {
            return refuse(ExtractError::NoOccurrence);
        };
        if occ.in_organization() {
            return refuse(ExtractError::AlreadyInOrganization);
        }
        let Some(occ_tenant) = occ.tenant else {
            return refuse(ExtractError::NoConnection);
        };
        if !self
            .connection_is_organizations(ctx, occ_tenant, occ.project_id)
            .await
        {
            return refuse(ExtractError::NotOwnConnection { tenant: occ_tenant });
        }
        let Some(project_id) = occ.project_id else {
            return refuse(ExtractError::NoConnection);
        };
        let octx = registry::in_tenant(ctx, project_id)?;

        // Ready, by the same check the registry shows.
        let readiness = match self
            .registry_readiness(ctx, &occ, files, OUTSIDE_BUDGET)
            .await
        {
            Ok(r) => r,
            Err(registry_readiness::ReadinessFailure::Gone(p)) => {
                return refuse(ExtractError::Gone(p));
            }
            Err(registry_readiness::ReadinessFailure::Read(e)) => return Err(e.into()),
            Err(_) => return refuse(ExtractError::NoConnection),
        };
        if !readiness.ready {
            return refuse(ExtractError::NotReady {
                blocking: readiness
                    .checks
                    .iter()
                    .filter(|c| !c.ok && c.blocks)
                    .map(|c| format!("{}: {}", c.key, c.summary))
                    .collect(),
            });
        }
        let unit = readiness.unit.clone();
        let Some(manifest) = unit.manifest.clone() else {
            return refuse(ExtractError::NoManifest);
        };

        // The unit's files, bounded as a contribution is, and the files the
        // project's side edits.
        let sizes = files.listing(&octx, &occ).await?;
        let listing: Vec<String> = sizes.iter().map(|(p, _)| p.clone()).collect();
        let unit_sizes: Vec<(String, Option<i64>)> = sizes
            .iter()
            .filter(|(p, _)| unit.files.contains(p))
            .cloned()
            .collect();
        if unit_sizes.is_empty() {
            return refuse(ExtractError::Empty {
                path: occ.path.clone(),
            });
        }
        bounded(&unit_sizes).map_err(|e| match e {
            super::registry_publish::PublishError::TooLarge { files, bytes } => {
                ExtractFailure::Refused(ExtractError::TooLarge { files, bytes })
            }
            other => ExtractFailure::Failed(anyhow::anyhow!("{other}")),
        })?;
        let top = if unit.kind == "crate" {
            None
        } else {
            parent_module_file(&listing, &manifest, &unit.module_path)
        };
        let mut wanted_paths = unit.files.clone();
        let project_manifest = if unit.kind == "crate" {
            // A crate leaves its workspace: the workspace's members change by
            // hand; a crate that depended on it is the project's to repoint.
            None
        } else {
            Some(manifest.clone())
        };
        wanted_paths.extend(project_manifest.iter().cloned());
        wanted_paths.extend(top.iter().cloned());
        wanted_paths.push(manifest.clone());
        wanted_paths.sort();
        wanted_paths.dedup();
        let texts: BTreeMap<String, String> = files
            .read(&octx, &occ, &wanted_paths)
            .await?
            .into_iter()
            .filter_map(|(p, t)| t.map(|t| (p, t)))
            .collect();
        let manifest_text = texts.get(&manifest).cloned().unwrap_or_default();

        let crate_name = if unit.kind == "crate" {
            package_name(&manifest_text).unwrap_or_else(|| kebab(&e.name))
        } else {
            kebab(&e.name)
        };
        let edition = package_edition(&manifest_text).unwrap_or_else(|| DEFAULT_EDITION.to_owned());
        let dest = format!("{DEFAULT_PARENT}/{}", kebab(&e.name));
        let (gear_files, skipped) =
            crate_files(&unit, &texts, &dest, &crate_name, &edition, &readiness.dependencies);
        if gear_files.is_empty() {
            return refuse(ExtractError::Empty {
                path: occ.path.clone(),
            });
        }

        let tag = tag_of(&e.name, FIRST_VERSION);
        let git_url = format!("https://github.com/{}.git", gear_repo.repo);
        let mut source_files = Vec::new();
        if let Some(m) = &project_manifest {
            source_files.push(DeclarationFile {
                path: m.clone(),
                content: depend_on(
                    texts.get(m).map(String::as_str).unwrap_or_default(),
                    &crate_name,
                    &git_url,
                    &tag,
                ),
            });
        }
        let mut source_top = None;
        if let (Some(t), Some(module)) = (&top, unit.module_path.last())
            && let Some(edited) = texts
                .get(t)
                .and_then(|text| reexport(text, module, &crate_ident(&crate_name)))
        {
            source_files.push(DeclarationFile {
                path: t.clone(),
                content: edited,
            });
            source_top = Some(t.clone());
        }
        let source_deleted: Vec<String> = unit
            .files
            .iter()
            .filter(|f| !source_files.iter().any(|s| &s.path == *f))
            .cloned()
            .collect();

        let gear_target = RepositoryTarget {
            tenant: gear_repo.tenant,
            connection_id: Some(gear_repo.connection_id),
            repo: gear_repo.repo.clone(),
            base_branch: gear_repo.branch.clone(),
        };
        let mut source_target = RepositoryTarget {
            tenant: occ_tenant,
            connection_id: occ.connection_id,
            repo: occ.repo.clone(),
            base_branch: occ
                .git_ref
                .as_deref()
                .map(|r| r.trim().trim_start_matches("refs/heads/"))
                .filter(|r| !r.is_empty() && *r != "HEAD")
                .unwrap_or_default()
                .to_owned(),
        };
        if source_target.base_branch.is_empty() {
            source_target.base_branch = repos.default_branch(&octx, &source_target).await?;
        }

        let org = ctx.subject_tenant_id();
        let organization = self.organization_name(ctx, org).await;
        let branch = branch_of(&e.name);
        let extraction = Extraction {
            crate_name,
            version: FIRST_VERSION.to_owned(),
            tag,
            gear_repo: gear_target.repo.clone(),
            gear_base: gear_target.base_branch.clone(),
            gear_path: dest,
            gear_branch: branch.clone(),
            gear_pr_url: None,
            project_id: Some(project_id),
            project_name: occ.project_name.clone(),
            source_repo: source_target.repo.clone(),
            source_base: source_target.base_branch.clone(),
            source_path: unit.path.clone(),
            source_top,
            moved_file: unit.files.first().cloned().unwrap_or_default(),
            source_branch: branch,
            source_pr_url: None,
            at: registry::now(),
            by: by.id.clone(),
            by_name: by.name.clone(),
            completed_at: None,
            tagged_commit: None,
        };
        let (gear_text, source_text) = extraction_texts(&organization, e, &extraction, &skipped);
        Ok((
            entry.clone(),
            ExtractPlan {
                extraction,
                gear_target,
                gear_files,
                source_target,
                source_files,
                source_deleted,
                skipped,
                gear_text,
                source_text,
                source_tenant: Some(project_id),
            },
        ))
    }

    /// Extract the registered entry `name`: plan it ([`Self::plan_extract`]),
    /// open the gear repository's pull request and then the project's, and
    /// record an `extract` decision carrying both. Whether `by` may is the
    /// caller's question.
    #[allow(clippy::too_many_arguments)]
    pub async fn extract_registry(
        &self,
        ctx: &SecurityContext,
        name: &str,
        input: &DecisionInput,
        by: &Decider,
        files: &dyn OccurrenceFiles,
        repos: &dyn ExtractionRepos,
        contributions: &dyn GearContributions,
    ) -> Result<(RegistryEntry, Vec<DecisionRecord>), ExtractFailure> {
        let (entry, mut plan) = self.plan_extract(ctx, name, by, files, repos).await?;
        // The gear repository is the organization's, written as it.
        let gear = contributions
            .contribute(
                ctx,
                &plan.gear_target,
                &plan.extraction.gear_branch,
                &plan.gear_files,
                &plan.gear_text,
            )
            .await?;
        plan.extraction.gear_pr_url = gear.pr_url;
        // The project's, through its own connection, acting in its tenant.
        let octx = match plan.source_tenant {
            Some(project) => registry::in_tenant(ctx, project)?,
            None => ctx.clone(),
        };
        let organization = self
            .organization_name(ctx, ctx.subject_tenant_id())
            .await;
        let (_, source_text) =
            extraction_texts(&organization, &entry.entry, &plan.extraction, &plan.skipped);
        let source = contributions
            .contribute_changes(
                &octx,
                &plan.source_target,
                &plan.extraction.source_branch,
                &plan.source_files,
                &plan.source_deleted,
                &source_text,
            )
            .await?;
        plan.extraction.source_pr_url = source.pr_url;
        tracing::info!(organization_id = %ctx.subject_tenant_id(), entry = %entry.entry.name, gear_repo = %plan.extraction.gear_repo, source_repo = %plan.extraction.source_repo, gear_pr = ?plan.extraction.gear_pr_url, source_pr = ?plan.extraction.source_pr_url, "components-catalog: registry: a gear's extraction was opened");

        let mut decided = input.clone();
        decided.dry_run = false;
        decided.extraction = Some(plan.extraction);
        Ok(self
            .decide_registry(ctx, &entry.entry.name, &decided, by)
            .await?)
    }

    /// Complete the open extraction of `name`: both pull requests merged (the
    /// crate's manifest on the gear repository's base branch, the moved file
    /// gone from the project's), the gear repository's tip tagged, and the
    /// entry `extracted` at that version.
    #[allow(clippy::too_many_arguments)]
    pub async fn complete_extraction(
        &self,
        ctx: &SecurityContext,
        name: &str,
        input: &DecisionInput,
        by: &Decider,
        repos: &dyn ExtractionRepos,
        contributions: &dyn GearContributions,
    ) -> Result<(RegistryEntry, Vec<DecisionRecord>), ExtractFailure> {
        let wanted = name.trim();
        let Some(entry) = self.registry_entry(ctx, wanted).await? else {
            return Err(ExtractFailure::Refused(ExtractError::NotFound(
                wanted.to_owned(),
            )));
        };
        let Some(mut x) = entry
            .entry
            .extraction
            .clone()
            .filter(|x| x.completed_at.is_none())
        else {
            return Err(ExtractFailure::Refused(ExtractError::NotExtracting));
        };
        if entry.entry.state != STATE_REGISTERED {
            return Err(ExtractFailure::Refused(ExtractError::NotRegistered {
                state: entry.entry.state.clone(),
            }));
        }
        let gear_repo = self
            .gear_repository(ctx)
            .await?
            .filter(|g| g.repo.eq_ignore_ascii_case(&x.gear_repo))
            .ok_or(ExtractFailure::Refused(ExtractError::NoGearRepository))?;
        let gear_target = RepositoryTarget {
            tenant: gear_repo.tenant,
            connection_id: Some(gear_repo.connection_id),
            repo: gear_repo.repo.clone(),
            base_branch: if x.gear_base.is_empty() {
                gear_repo.branch.clone()
            } else {
                x.gear_base.clone()
            },
        };
        let manifest = format!("{}/Cargo.toml", x.gear_path);
        let mut missing = Vec::new();
        if !repos.has_file(ctx, &gear_target, &manifest).await? {
            missing.push(format!(
                "`{manifest}` is not on {}@{} yet ({})",
                gear_target.repo,
                gear_target.base_branch,
                x.gear_pr_url.as_deref().unwrap_or("the gear repository's pull request")
            ));
        }
        // The project's side: the moved file is gone from its base branch.
        let occ = declaring_occurrence(&entry)
            .filter(|o| !o.in_organization() && o.repo.eq_ignore_ascii_case(&x.source_repo))
            .cloned();
        let source_tenant = occ.as_ref().and_then(|o| o.tenant);
        if let (Some(project_id), Some(tenant)) = (x.project_id, source_tenant)
            && !x.moved_file.is_empty()
        {
            let octx = registry::in_tenant(ctx, project_id)?;
            let source_target = RepositoryTarget {
                tenant,
                connection_id: occ.as_ref().and_then(|o| o.connection_id),
                repo: x.source_repo.clone(),
                base_branch: x.source_base.clone(),
            };
            if repos.has_file(&octx, &source_target, &x.moved_file).await? {
                missing.push(format!(
                    "`{}` is still on {}@{} ({})",
                    x.moved_file,
                    x.source_repo,
                    x.source_base,
                    x.source_pr_url.as_deref().unwrap_or("the project's pull request")
                ));
            }
        }
        if !missing.is_empty() {
            return Err(ExtractFailure::Refused(ExtractError::NotMerged {
                what: missing.join("; "),
            }));
        }
        let sha = contributions.tag(ctx, &gear_target, &x.tag).await?;
        x.completed_at = Some(registry::now());
        x.tagged_commit = Some(sha);
        let mut decided = input.clone();
        decided.dry_run = false;
        decided.extraction = Some(x);
        Ok(self
            .decide_registry(ctx, &entry.entry.name, &decided, by)
            .await?)
    }
}

#[cfg(test)]
#[path = "registry_extract_tests.rs"]
mod tests;
