//! `GET /registry/{name}/readiness` (ADR-0044 §1, phase 1): whether a
//! component could leave its project as a crate of its own, and what stops
//! it. The checks are `registry_readiness`'s; this is their wire shape.

use super::*;
use crate::components_catalog::registry_readiness::{
    self as readiness, Readiness, ReadinessFailure, ReadinessFiles,
};

/// One place a check fails at.
#[derive(Debug, Clone, PartialEq)]
#[toolkit_macros::api_dto(response)]
pub struct ReadinessSpotDto {
    pub path: String,
    /// 1-based.
    pub line: Option<u32>,
    /// The line, trimmed, at most 200 characters.
    pub text: Option<String>,
}

/// One check.
#[derive(Debug, Clone, PartialEq)]
#[toolkit_macros::api_dto(response)]
pub struct ReadinessCheckDto {
    /// `size`, `boundary`, `persistence`, `reaches_out`, `reached_into` or
    /// `dependencies`.
    pub key: String,
    pub ok: bool,
    /// A failure that stops Extract; a failed check that does not block is
    /// advice.
    pub blocks: bool,
    pub summary: String,
    /// At most 20.
    pub spots: Vec<ReadinessSpotDto>,
    /// Places past those listed.
    pub more: u32,
}

/// A dependency the new crate's `Cargo.toml` would carry.
#[derive(Debug, Clone, PartialEq)]
#[toolkit_macros::api_dto(response)]
pub struct ReadinessDependencyDto {
    pub name: String,
    /// The crate's manifest value for it; null when the manifest does not
    /// list it.
    pub spec: Option<String>,
}

/// Whether a component could leave its project.
#[derive(Debug, Clone, PartialEq)]
#[toolkit_macros::api_dto(response)]
pub struct RegistryReadinessDto {
    pub name: String,
    /// No check blocks.
    pub ready: bool,
    /// `module` or `crate`.
    pub kind: String,
    /// The repository (`owner/name`) and ref it was read at.
    pub repo: String,
    pub git_ref: Option<String>,
    pub project_name: Option<String>,
    /// The directory that would move.
    pub path: String,
    /// For a module, its path in its crate (`connectors::plugin`).
    pub module_path: Option<String>,
    /// The files that would move.
    pub files: u32,
    pub checks: Vec<ReadinessCheckDto>,
    pub dependencies: Vec<ReadinessDependencyDto>,
    /// Other gears it uses through their `sdk` or `port`, by module path.
    pub gears: Vec<String>,
    /// The crate's other `.rs` files read to find who reaches into it, of
    /// how many: fewer when it was read over the API rather than a checkout.
    pub outside_read: u32,
    pub outside_total: u32,
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

fn readiness_dto(
    name: &str,
    occ: &super::super::registry::OccurrenceRecord,
    r: Readiness,
) -> RegistryReadinessDto {
    RegistryReadinessDto {
        name: name.to_owned(),
        ready: r.ready,
        kind: r.unit.kind.clone(),
        repo: occ.repo.clone(),
        git_ref: occ.git_ref.clone(),
        project_name: occ.project_name.clone(),
        path: r.unit.path.clone(),
        module_path: (!r.unit.module_path.is_empty()).then(|| r.unit.module_path.join("::")),
        files: count(r.unit.files.len()),
        checks: r
            .checks
            .into_iter()
            .map(|c| ReadinessCheckDto {
                key: c.key,
                ok: c.ok,
                blocks: c.blocks,
                summary: c.summary,
                spots: c
                    .spots
                    .into_iter()
                    .map(|s| ReadinessSpotDto {
                        path: s.path,
                        line: s.line,
                        text: s.text,
                    })
                    .collect(),
                more: count(c.more),
            })
            .collect(),
        dependencies: r
            .dependencies
            .into_iter()
            .map(|d| ReadinessDependencyDto {
                name: d.name,
                spec: d.spec,
            })
            .collect(),
        gears: r.gears,
        outside_read: count(r.read.outside_read),
        outside_total: count(r.read.outside_total),
    }
}

fn readiness_problem(e: ReadinessFailure) -> CanonicalError {
    let precondition = |subject: String, message: String, kind: &str| {
        StudioComponentsCatalogError::failed_precondition()
            .with_precondition_violation(subject, message, kind)
            .create()
    };
    match e {
        ReadinessFailure::NotFound(name) => StudioComponentsCatalogError::not_found(format!(
            "the registry has no component `{name}`"
        ))
        .with_resource(name)
        .create(),
        ReadinessFailure::NoOccurrence => precondition(
            "occurrence".to_owned(),
            "nothing says where the component is".to_owned(),
            "REGISTRY_NO_OCCURRENCE",
        ),
        ReadinessFailure::NoConnection => precondition(
            "connection".to_owned(),
            "the component's repository is read through no known connection".to_owned(),
            "REGISTRY_CONNECTION_UNKNOWN",
        ),
        ReadinessFailure::NotOwnConnection(tenant) => precondition(
            format!("connection:{tenant}"),
            "the component is read through a connection the organization only inherits; \
             its code is not the organization's to read"
                .to_owned(),
            "CONNECTION_NOT_OWNED",
        ),
        ReadinessFailure::Gone(path) => precondition(
            path.clone(),
            format!("nothing is at `{path}` in the repository any more; read the projects again"),
            "REGISTRY_OCCURRENCE_GONE",
        ),
        ReadinessFailure::Read(e) => internal(e),
    }
}

async fn registry_entry_readiness(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    Path(name): Path<String>,
) -> ApiResult<JsonBody<RegistryReadinessDto>> {
    // It quotes lines of a project's code: the registry's administrators,
    // who decide Extract, read it.
    catalog.require_registry_admin(&ctx).await?;
    let service = &catalog.service;
    let occ = service
        .readiness_target(&ctx, &name)
        .await
        .map_err(readiness_problem)?;
    let octx = readiness::occurrence_ctx(&ctx, &occ).map_err(readiness_problem)?;
    let files = ReadinessFiles {
        service,
        checkout: service.checkout_of(&octx, &occ).await,
    };
    let budget = files.budget();
    service
        .registry_readiness(&ctx, &occ, &files, budget)
        .await
        .map(|r| Json(readiness_dto(&name, &occ, r)))
        .map_err(readiness_problem)
}

pub(super) fn register(router: Router, openapi: &dyn OpenApiRegistry) -> Router {
    OperationBuilder::get("/studio-components-catalog/v1/registry/{name}/readiness")
        .operation_id("studio_components_catalog.get_registry_entry_readiness")
        .summary("Whether a registry component could leave its project as a crate of its own")
        .description(
            "Reads the directory the component lives in (the occurrence that \
             declares it, else a candidate's best finding) and the rest of its \
             crate, and checks what would stop it building alone (ADR-0044 \
             §1): `size` (one pull request: 200 files, 2 MiB), `boundary` (a \
             `port` and an `sdk`), `persistence` (its tables made by its own \
             migrations), `reaches_out` (`crate::` paths outside it, `super::` \
             past its top, `path` dependencies outside a crate), \
             `reached_into` (code elsewhere in the crate using its private \
             modules) and `dependencies` (what its own `Cargo.toml` would \
             list). Each failure names its files and lines. Read from the \
             Gearbox engine's checkout when there is one; over the API the \
             crate's other files are read up to 150, and `outside_read` says \
             how many were. Nothing is written. 403 for anyone but an \
             organization administrator (`component.registry`); 404 for no \
             such entry; 400 `failed_precondition` when nothing says where it \
             is or the repository no longer has it.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("name", "Component name")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(registry_entry_readiness)
        .json_response_with_schema::<RegistryReadinessDto>(openapi, StatusCode::OK, "The checks")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi)
}
