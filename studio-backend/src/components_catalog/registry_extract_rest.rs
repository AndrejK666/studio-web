//! Extract over REST (ADR-0044 §1, phase 2): `extract` and
//! `complete_extraction` come here from the decision route, after its
//! permission check (an organization administrator's).
//!
//! - `extract` opens the gear repository's pull request and the project's,
//!   through studio-product (`product::port::GearContributions`), and records
//!   the decision; `dry_run` answers `extract_preview` and writes nothing.
//! - `complete_extraction` checks both are merged, tags the gear
//!   repository's tip `<gear>/v0.1.0`, and moves the entry to `extracted`.

use super::*;
use crate::components_catalog::registry_extract::{
    ConnectionRepos, ExtractError, ExtractFailure,
};
use crate::components_catalog::registry_publish::RepositoryFiles;

/// A refused extraction as a problem: 404 for no such entry, 400
/// `failed_precondition` for everything the rules refuse.
pub(super) fn extract_problem(e: ExtractError) -> CanonicalError {
    let message = e.to_string();
    let precondition = |subject: String, kind: &str| {
        StudioComponentsCatalogError::failed_precondition()
            .with_precondition_violation(subject, message.clone(), kind)
            .create()
    };
    match e {
        ExtractError::NotFound(name) => StudioComponentsCatalogError::not_found(message.clone())
            .with_resource(name)
            .create(),
        ExtractError::NotRegistered { state } => {
            precondition(format!("state:{state}"), "REGISTRY_TRANSITION_NOT_ALLOWED")
        }
        ExtractError::Open { .. } => precondition("extraction".to_owned(), "EXTRACTION_OPEN"),
        ExtractError::NotRust { kind } => {
            precondition(format!("kind:{kind}"), "REGISTRY_EXTRACT_RUST_ONLY")
        }
        ExtractError::NoGearRepository => precondition(
            "gear_repository".to_owned(),
            "ORGANIZATION_NO_GEAR_REPOSITORY",
        ),
        ExtractError::NoOccurrence => {
            precondition("occurrence".to_owned(), "REGISTRY_NO_OCCURRENCE")
        }
        ExtractError::NoConnection => {
            precondition("connection".to_owned(), "REGISTRY_CONNECTION_UNKNOWN")
        }
        ExtractError::NotOwnConnection { tenant } => {
            precondition(format!("connection:{tenant}"), "CONNECTION_NOT_OWNED")
        }
        ExtractError::AlreadyInOrganization => precondition(
            "occurrence".to_owned(),
            "REGISTRY_ALREADY_IN_GEAR_REPOSITORY",
        ),
        ExtractError::NotReady { .. } => precondition("readiness".to_owned(), "REGISTRY_NOT_READY"),
        ExtractError::Gone(path) => precondition(path, "REGISTRY_OCCURRENCE_GONE"),
        ExtractError::NoManifest => precondition("occurrence".to_owned(), "REGISTRY_NO_MANIFEST"),
        ExtractError::Empty { path } => precondition(path, "REGISTRY_NOTHING_TO_GIVE"),
        ExtractError::TooLarge { .. } => {
            precondition("occurrence".to_owned(), "REGISTRY_GEAR_TOO_LARGE")
        }
        ExtractError::NotExtracting => {
            precondition("extraction".to_owned(), "EXTRACTION_NOT_OPEN")
        }
        ExtractError::NotMerged { .. } => {
            precondition("extraction".to_owned(), "EXTRACTION_NOT_MERGED")
        }
    }
}

fn failure(e: ExtractFailure) -> CanonicalError {
    match e {
        ExtractFailure::Refused(e) => extract_problem(e),
        ExtractFailure::Decision(e) => decision_problem(e),
        ExtractFailure::Failed(e) => internal(e),
    }
}

/// `extract`, from the decision route.
pub(super) async fn extract(
    catalog: &Catalog,
    ctx: &SecurityContext,
    name: &str,
    input: &super::super::registry_decisions::DecisionInput,
) -> ApiResult<RegistryEntryDto> {
    let files = RepositoryFiles(catalog.service.as_ref());
    let repos = ConnectionRepos(catalog.service.as_ref());
    let by = catalog.decider(ctx).await;
    if input.dry_run {
        let (entry, plan) = catalog
            .service
            .plan_extract(ctx, name, &by, &files, &repos)
            .await
            .map_err(failure)?;
        let decisions = catalog
            .service
            .registry_entry_with_decisions(ctx, &entry.entry.name)
            .await
            .map_err(internal)?
            .map(|(_, d)| d)
            .unwrap_or_default();
        let mut dto = registry_entry_detail_dto(entry, decisions);
        dto.extract_preview = Some(extract_preview_dto(plan));
        return Ok(dto);
    }
    let contributions = catalog.contributions()?;
    let (entry, decisions) = catalog
        .service
        .extract_registry(
            ctx,
            name,
            input,
            &by,
            &files,
            &repos,
            contributions.as_ref(),
        )
        .await
        .map_err(failure)?;
    Ok(registry_entry_detail_dto(entry, decisions))
}

/// `complete_extraction`, from the decision route.
pub(super) async fn complete(
    catalog: &Catalog,
    ctx: &SecurityContext,
    name: &str,
    input: &super::super::registry_decisions::DecisionInput,
) -> ApiResult<RegistryEntryDto> {
    let repos = ConnectionRepos(catalog.service.as_ref());
    let contributions = catalog.contributions()?;
    let by = catalog.decider(ctx).await;
    let (entry, decisions) = catalog
        .service
        .complete_extraction(ctx, name, input, &by, &repos, contributions.as_ref())
        .await
        .map_err(failure)?;
    Ok(registry_entry_detail_dto(entry, decisions))
}
