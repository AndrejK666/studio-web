//! Declare it: a candidate becomes a gear by a pull request (ADR-0041 P3).
//!
//! `POST /registry/{name}/declare` takes a `candidate` entry and opens a pull
//! request in the repository it was detected in, adding a `gear.toml` -- and
//! the engine's `gear.gdl` when one is configured -- in the module's own
//! directory, on the branch `declare/<name>`. The files come from
//! studio-product (`product::port::GearDeclarations`), the same skeleton the
//! scaffold writes; the write goes through the repository's connection, in the
//! project's tenant (`registry::in_tenant`), as the walk reads it.
//!
//! The entry stays a `candidate`: a `declare` decision records that the pull
//! request was opened, and the walk moves the entry to `declared` once it
//! reads the merged declaration -- discovery owns both states.

use serde_json::json;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::registry::{self, OccurrenceRecord, RegistryEntry, STATE_CANDIDATE};
use super::registry_decisions::{Decider, DecisionRecord, decision_node};
use super::service::CatalogService;
use crate::product::port::{
    DeclarationFile, DeclarationSpec, GearDeclarations, PullRequestText, RepositoryTarget,
};

/// What a Declare it request says beyond the entry.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DeclareInput {
    pub description: Option<String>,
    pub capabilities: Option<Vec<String>>,
    pub category: Option<String>,
    /// Answer the files only; nothing is written or recorded.
    pub dry_run: bool,
    /// The project whose occurrence to declare, when the candidate was found
    /// in several; else its best occurrence.
    pub project_id: Option<Uuid>,
}

/// Why Declare it was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DeclareError {
    NotFound(String),
    /// Only a `candidate` is declared this way.
    NotCandidate {
        state: String,
    },
    /// The candidate has no detected occurrence (in the named project).
    NoOccurrence,
    /// The occurrence was recorded before the walk kept its connection: read
    /// the project again first.
    NoConnection,
}

impl std::fmt::Display for DeclareError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(name) => write!(f, "the registry has no component `{name}`"),
            Self::NotCandidate { state } => write!(
                f,
                "a `{state}` entry is not a candidate; only a candidate is declared by a pull request"
            ),
            Self::NoOccurrence => {
                write!(
                    f,
                    "no repository holds this candidate where it was asked for"
                )
            }
            Self::NoConnection => write!(
                f,
                "the registry does not know which connection reads this repository yet; read the project again"
            ),
        }
    }
}

/// What Declare it did.
#[derive(Clone, Debug, PartialEq)]
pub struct Declared {
    pub branch: String,
    pub pr_url: Option<String>,
    pub files: Vec<DeclarationFile>,
    /// The repository and directory written into.
    pub repo: String,
    pub path: String,
}

/// A refusal by the rules, or a write that failed.
#[derive(Debug)]
pub enum DeclareFailure {
    Refused(DeclareError),
    Failed(anyhow::Error),
}

impl From<anyhow::Error> for DeclareFailure {
    fn from(e: anyhow::Error) -> Self {
        Self::Failed(e)
    }
}

/// The branch a declaration is written on.
pub fn branch_of(name: &str) -> String {
    format!("declare/{}", super::candidates::kebab(name))
}

/// The branch the pull request goes back to: the ref the walk read, unless
/// that names no branch.
pub fn base_branch(occ: &OccurrenceRecord) -> String {
    match occ.git_ref.as_deref().map(str::trim) {
        None | Some("" | "HEAD") => "main".to_owned(),
        Some(r) => r.trim_start_matches("refs/heads/").to_owned(),
    }
}

/// The occurrence to declare and what to write there. Pure.
///
/// The entry must be a `candidate`. Its detected occurrence in
/// `input.project_id` when one is named, else its highest-scoring one. The
/// manifest says what the request says, else what the entry says, else what
/// its evidence says.
pub fn declaration_of<'a>(
    entry: &'a RegistryEntry,
    input: &DeclareInput,
) -> Result<(&'a OccurrenceRecord, DeclarationSpec), DeclareError> {
    if entry.entry.state != STATE_CANDIDATE {
        return Err(DeclareError::NotCandidate {
            state: entry.entry.state.clone(),
        });
    }
    let occ = entry
        .occurrences
        .iter()
        .filter(|o| o.detected())
        .filter(|o| input.project_id.is_none_or(|p| o.project_id == Some(p)))
        .max_by(|a, b| a.score.cmp(&b.score).then_with(|| b.path.cmp(&a.path)))
        .ok_or(DeclareError::NoOccurrence)?;
    let text = |s: &Option<String>| {
        s.as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let evidence: Vec<&str> = entry
        .entry
        .evidence
        .iter()
        .map(|e| e.detail.as_str())
        .collect();
    let description = text(&input.description)
        .or_else(|| text(&entry.entry.description))
        .or_else(|| text(&occ.description))
        .unwrap_or_else(|| {
            format!(
                "{} in {}{}",
                entry.entry.name,
                occ.repo,
                if evidence.is_empty() {
                    String::new()
                } else {
                    format!(": {}", evidence.join("; "))
                }
            )
        });
    let capabilities = match &input.capabilities {
        Some(caps) => caps.clone(),
        None => entry.entry.capabilities.clone(),
    };
    Ok((
        occ,
        DeclarationSpec {
            name: entry.entry.name.clone(),
            dir: occ.path.clone(),
            description,
            category: text(&input.category).or_else(|| text(&entry.entry.category)),
            capabilities,
            plugin: false,
        },
    ))
}

impl CatalogService {
    /// Declare the candidate `name` a gear: the files, and -- unless
    /// `dry_run` -- a pull request in the repository it was found in, through
    /// that repository's connection in the project's tenant, recorded as a
    /// `declare` decision by `by`. Whether `by` may is the caller's question.
    pub async fn declare_candidate(
        &self,
        ctx: &SecurityContext,
        name: &str,
        input: &DeclareInput,
        by: &Decider,
        declarations: &dyn GearDeclarations,
    ) -> Result<Declared, DeclareFailure> {
        let wanted = name.trim();
        let entry = self
            .registry_entry(ctx, wanted)
            .await?
            .ok_or_else(|| DeclareFailure::Refused(DeclareError::NotFound(wanted.to_owned())))?;
        let (occ, spec) = declaration_of(&entry, input).map_err(DeclareFailure::Refused)?;
        let files = declarations.declaration_files(&spec).await?;
        let branch = branch_of(&entry.entry.name);
        if input.dry_run {
            return Ok(Declared {
                branch,
                pr_url: None,
                files,
                repo: occ.repo.clone(),
                path: occ.path.clone(),
            });
        }
        let (Some(tenant), Some(project_id)) = (occ.tenant, occ.project_id) else {
            return Err(DeclareFailure::Refused(DeclareError::NoConnection));
        };
        // Written as the walk reads: in the project's tenant, where its
        // connection's token is readable.
        let pctx = registry::in_tenant(ctx, project_id)?;
        let target = RepositoryTarget {
            tenant,
            connection_id: occ.connection_id,
            repo: occ.repo.clone(),
            base_branch: base_branch(occ),
        };
        let evidence: Vec<String> = entry
            .entry
            .evidence
            .iter()
            .map(|e| format!("- {} (+{})", e.detail, e.weight))
            .collect();
        let text = PullRequestText {
            message: format!("declare: {} is a gear", entry.entry.name),
            title: format!("Declare {} a gear", entry.entry.name),
            body: format!(
                "Studio's component registry found `{}` at `{}` looks like a gear{}:\n\n{}\n\n\
                 This adds its declaration. Once merged, the registry reads it as declared.",
                entry.entry.name,
                occ.path,
                entry
                    .entry
                    .score
                    .map(|s| format!(" (score {s})"))
                    .unwrap_or_default(),
                if evidence.is_empty() {
                    "- (no evidence recorded)".to_owned()
                } else {
                    evidence.join("\n")
                }
            ),
        };
        let written = declarations
            .open_declaration(&pctx, &target, &branch, &files, &text)
            .await?;

        let org = ctx.subject_tenant_id();
        let entry_id = super::gts::registry_entry_instance_id(&org.to_string(), &entry.entry.name);
        let record = DecisionRecord {
            organization_id: org,
            entry: entry.entry.name.clone(),
            entry_id,
            action: "declare".to_owned(),
            from: entry.entry.state.clone(),
            to: entry.entry.state.clone(),
            by: by.id.clone(),
            by_name: by.name.clone(),
            at: registry::now(),
            reason: None,
            details: json!({
                "branch": written.branch,
                "pr_url": written.pr_url,
                "repo": occ.repo,
                "path": occ.path,
                "files": files.iter().map(|f| f.path.clone()).collect::<Vec<_>>(),
            }),
        };
        if let Some((node, edge)) = decision_node(record) {
            self.sink.register_types(ctx).await?;
            self.sink.upsert(ctx, &[node], &[edge]).await?;
        }
        tracing::info!(organization_id = %org, entry = %entry.entry.name, branch = %written.branch, pr = ?written.pr_url, "components-catalog: registry: candidate declared by a pull request");
        Ok(Declared {
            branch: written.branch,
            pr_url: written.pr_url,
            files,
            repo: occ.repo.clone(),
            path: occ.path.clone(),
        })
    }
}

#[cfg(test)]
#[path = "registry_declare_tests.rs"]
mod tests;
