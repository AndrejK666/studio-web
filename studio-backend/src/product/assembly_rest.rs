//! How a product is assembled, over REST ([`crate::product::assembly`],
//! ADR-0072):
//!
//! - `GET  project-assembly-strategy?project_id=` -- the strategy the
//!   project's product is assembled by, where that comes from (the project,
//!   the organization's default, the kits'), and why it falls back when the
//!   chosen one cannot be used.
//! - `PUT  project-assembly-strategy?project_id=` -- the project's own
//!   choice, or back to the organization's default. A strategy whose kit does
//!   not apply to the project is refused with `KIT_NOT_INSTALLED`. Claimed by
//!   the Product kit.
//! - `GET  assembly-strategy` -- the organization's default (`?organization_id=`).
//! - `PUT  assembly-strategy` -- set it; an organization or platform
//!   administrator (`kit.manage`), 403 `ASSEMBLY_DEFAULT_ADMIN_REQUIRED`
//!   otherwise. Claimed by the Gears matcher kit.
//!
//! The strategies offered are the ones the kits that apply provide
//! (`assembly_strategy` in their manifests, ADR-0074): Spec mapping brings
//! `spec_mapping`, Gears matcher `gears_matcher`; with neither, the product is
//! assembled by hand (`strategy: "manual"`).
//!
//! The settings need the gear's database; without it every read answers the
//! kits' default (`settable: false`) and the writes answer 503.

use toolkit::client_hub::ClientScope;

use super::*;
use crate::kit_registry::port::{KitPresence, ProvidedStrategy, assembly_strategies, require_kit};
use crate::product::assembly::{self, Available, DEFAULT_PRIVILEGE, Strategy, StrategyStore};
use crate::product::gear_match::GearMatches;

/// Why the chosen strategy is not the one used.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct AssemblyFallbackDto {
    /// `KIT_NOT_INSTALLED`, `KIT_UNKNOWN` or `MATCHER_NOT_CONFIGURED`.
    pub code: String,
    pub reason: String,
}

/// Whether the `gears_matcher` strategy can be used here.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct AssemblyMatcherDto {
    /// The Gears matcher kit applies here; null when that could not be read.
    pub kit_installed: Option<bool>,
    /// The gears-matcher service can be called and its matches kept.
    pub configured: bool,
    /// What is missing when it cannot.
    pub missing: Option<String>,
    /// `gears_matcher` can be chosen and is used when chosen.
    pub offered: bool,
}

/// A strategy a kit that applies here provides (ADR-0074).
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct AssemblyStrategyKitDto {
    /// `spec_mapping` or `gears_matcher`.
    pub id: String,
    /// As its kit's manifest names it.
    pub name: String,
    pub description: String,
    /// The kit that provides it.
    pub kit: String,
    /// It can be used here now; else `reason` says why not.
    pub offered: bool,
    pub reason: Option<String>,
}

/// The strategy a product is assembled by, and why.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct AssemblyStrategyDto {
    pub organization_id: String,
    /// Absent for the organization's default.
    pub project_id: Option<String>,
    /// What is used: `spec_mapping`, `gears_matcher`, or `manual` where no
    /// strategy can be: the product is assembled by hand in the configurator.
    pub strategy: String,
    /// What the settings ask for (`manual` where nothing was chosen and no
    /// strategy kit applies); differs from `strategy` only with a `fallback`.
    pub chosen: String,
    /// Where `chosen` comes from: `project`, `organization` or `studio`
    /// (nobody chose: the only strategy kit installed, else `spec_mapping`).
    pub source: String,
    /// The project's own choice; null: it follows the organization's default.
    pub project: Option<String>,
    /// The organization's default; null: what the installed kits make it.
    pub organization_default: Option<String>,
    pub fallback: Option<AssemblyFallbackDto>,
    pub gears_matcher: AssemblyMatcherDto,
    /// The strategies the kits that apply here provide, in the order to offer
    /// them: what a choice may name. Empty: the product is assembled by hand.
    pub strategies: Vec<String>,
    /// The same strategies with their names, kits and whether each can be
    /// used now.
    pub strategy_kits: Vec<AssemblyStrategyKitDto>,
    /// Whether the settings are kept in this deployment.
    pub settable: bool,
    /// Whether the caller may change the organization's default.
    pub may_set_default: bool,
}

#[derive(Debug, serde::Deserialize)]
pub struct ProjectQuery {
    pub project_id: Uuid,
}

/// A strategy to keep.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SetAssemblyStrategyRequest {
    /// `spec_mapping` or `gears_matcher`; null or absent forgets the choice
    /// (a project follows its organization's default again, an organization
    /// what its kits make it).
    pub strategy: Option<String>,
}

fn strategy_of(s: Option<&str>) -> ApiResult<Option<Strategy>> {
    match s.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(s) => Strategy::parse(s).map(Some).ok_or_else(|| {
            StudioProductError::invalid_argument()
                .with_field_violation(
                    "strategy",
                    "`spec_mapping`, `gears_matcher`, or null for the default",
                    "INVALID",
                )
                .create()
        }),
    }
}

fn no_store() -> CanonicalError {
    CanonicalError::service_unavailable()
        .with_detail(
            "the assembly strategy is not kept in this deployment: studio-product has no \
             database",
        )
        .create()
}

fn internal(e: anyhow::Error) -> CanonicalError {
    CanonicalError::internal(format!("{e:#}")).create()
}

/// May the caller set `org`'s default?
async fn may_set_default(hub: &ClientHub, ctx: &SecurityContext, org: Uuid) -> bool {
    match hub
        .get_scoped::<dyn crate::user_profile::OrgAuthority>(&ClientScope::gts_id(
            crate::user_profile::IDENTITY_INSTANCE_ID,
        ))
        .ok()
    {
        Some(authority) => authority.may_administer(ctx, org, DEFAULT_PRIVILEGE).await,
        None => false,
    }
}

/// The strategies studio-product runs among `provided`, in [`Strategy::ALL`]
/// order: a kit's strategy this gear does not know is not offered.
pub(crate) fn known(provided: &[ProvidedStrategy]) -> Vec<Strategy> {
    Strategy::ALL
        .into_iter()
        .filter(|s| provided.iter().any(|p| p.id == s.as_str()))
        .collect()
}

/// What can be used where `tenant` is (a project or an organization the
/// caller was shown to reach): the strategies its kits provide, and whether
/// the matcher can be called. Without studio-kits in the assembly there is
/// nothing to install, and both strategies apply.
pub(crate) async fn available(
    hub: &ClientHub,
    matches: Option<&GearMatches>,
    ctx: &SecurityContext,
    tenant: Uuid,
) -> (Available, Vec<ProvidedStrategy>) {
    let provided = match hub.get::<dyn KitPresence>() {
        Err(_) => Some(assembly_strategies(
            &Strategy::ALL.map(|s| s.kit().to_owned()),
        )),
        Ok(presence) => match presence.effective(ctx, tenant).await {
            Ok(slugs) => Some(assembly_strategies(&slugs)),
            Err(e) => {
                tracing::warn!(%tenant, "studio-product: the assembly strategy: {e:#}");
                None
            }
        },
    };
    let matcher_missing = match matches {
        None => Some("gear matches are not part of this deployment".to_owned()),
        Some(m) => m.available().err().map(|r| r.to_string()),
    };
    (
        Available {
            kits: provided.as_deref().map(known),
            matcher_missing,
        },
        provided.unwrap_or_default(),
    )
}

async fn read(
    product: &Product,
    matches: Option<&GearMatches>,
    store: Option<&StrategyStore>,
    ctx: &SecurityContext,
    org: Uuid,
    project: Option<Uuid>,
) -> ApiResult<AssemblyStrategyDto> {
    let (project_choice, default) = match store {
        None => (None, None),
        Some(store) => {
            let default = store.get(org, org).await.map_err(internal)?;
            let choice = match project {
                Some(p) => store.get(org, p).await.map_err(internal)?,
                None => None,
            };
            (choice, default)
        }
    };
    let ((available, provided), may) = tokio::join!(
        available(&product.hub, matches, ctx, project.unwrap_or(org)),
        may_set_default(&product.hub, ctx, org),
    );
    let e = assembly::resolve(project_choice, default, available);
    let matcher_refusal = e.available.refusal(Strategy::GearsMatcher);
    // What the kits provide; while they cannot be read, `spec_mapping` only.
    let offered_kits: Vec<Strategy> = e.available.provided();
    let strategy_kits = offered_kits
        .iter()
        .filter_map(|s| {
            // Named as its kit's manifest names it; from the built-in manifest
            // when the kits could not be read.
            let p = provided
                .iter()
                .find(|p| p.id == s.as_str())
                .cloned()
                .or_else(|| {
                    assembly_strategies(&[s.kit().to_owned()])
                        .into_iter()
                        .next()
                })?;
            let refusal = e.available.refusal(*s);
            Some(AssemblyStrategyKitDto {
                id: p.id,
                name: p.name,
                description: p.description,
                kit: p.kit,
                offered: refusal.is_none(),
                reason: refusal.map(|(_, why)| why),
            })
        })
        .collect();
    Ok(AssemblyStrategyDto {
        organization_id: org.to_string(),
        project_id: project.map(|p| p.to_string()),
        strategy: assembly::wire(e.strategy).to_owned(),
        chosen: assembly::wire(e.chosen).to_owned(),
        source: e.source.as_str().to_owned(),
        project: e.project.map(|s| s.as_str().to_owned()),
        organization_default: e.organization_default.map(|s| s.as_str().to_owned()),
        fallback: e.fallback.map(|(code, reason)| AssemblyFallbackDto {
            code: code.to_owned(),
            reason,
        }),
        gears_matcher: AssemblyMatcherDto {
            kit_installed: e.available.installed(Strategy::GearsMatcher),
            configured: e.available.matcher_missing.is_none(),
            missing: e.available.matcher_missing.clone(),
            offered: matcher_refusal.is_none(),
        },
        strategies: offered_kits.iter().map(|s| s.as_str().to_owned()).collect(),
        strategy_kits,
        settable: store.is_some(),
        may_set_default: may,
    })
}

/// The organization the project hangs under, as the caller reads the tree.
async fn organization_of(
    product: &Product,
    ctx: &SecurityContext,
    project: Uuid,
) -> ApiResult<Uuid> {
    product
        .service
        .organization_of_project(ctx, project)
        .await
        .ok_or_else(|| {
            StudioProductError::not_found(format!("there is no project {project} for this caller"))
                .with_resource("project")
                .create()
        })
}

async fn get_project_assembly_strategy(
    OrgCtx(ctx): OrgCtx,
    Extension(product): Extension<Product>,
    matches: Option<Extension<Arc<GearMatches>>>,
    store: Option<Extension<Arc<StrategyStore>>>,
    Query(ProjectQuery { project_id }): Query<ProjectQuery>,
) -> ApiResult<JsonBody<AssemblyStrategyDto>> {
    let org = organization_of(&product, &ctx, project_id).await?;
    let dto = read(
        &product,
        matches.as_ref().map(|m| m.0.as_ref()),
        store.as_ref().map(|s| s.0.as_ref()),
        &ctx,
        org,
        Some(project_id),
    )
    .await?;
    Ok(Json(dto))
}

async fn upsert_project_assembly_strategy(
    OrgCtx(ctx): OrgCtx,
    Extension(product): Extension<Product>,
    matches: Option<Extension<Arc<GearMatches>>>,
    store: Option<Extension<Arc<StrategyStore>>>,
    Query(ProjectQuery { project_id }): Query<ProjectQuery>,
    Json(body): Json<SetAssemblyStrategyRequest>,
) -> ApiResult<JsonBody<AssemblyStrategyDto>> {
    let strategy = strategy_of(body.strategy.as_deref())?;
    let org = organization_of(&product, &ctx, project_id).await?;
    let Some(Extension(kept)) = store.as_ref() else {
        return Err(no_store());
    };
    // A strategy is its kit's (ADR-0074): refused where that kit does not
    // apply, as its own writes are. Whether the matcher answers is not asked
    // here: the read says so, and the choice stands for when it does.
    if let Some(s) = strategy {
        require_kit(&product.hub, &ctx, project_id, s.kit())
            .await
            .map_err(|r| r.problem())?;
    }
    kept.put(org, project_id, strategy, &ctx.subject_id().to_string())
        .await
        .map_err(internal)?;
    tracing::info!(
        organization_id = %org, %project_id,
        strategy = strategy.map_or("organization default", Strategy::as_str),
        "studio-product: a project's assembly strategy was set"
    );
    let dto = read(
        &product,
        matches.as_ref().map(|m| m.0.as_ref()),
        Some(kept.as_ref()),
        &ctx,
        org,
        Some(project_id),
    )
    .await?;
    Ok(Json(dto))
}

async fn get_assembly_strategy(
    OrgCtx(ctx): OrgCtx,
    Extension(product): Extension<Product>,
    matches: Option<Extension<Arc<GearMatches>>>,
    store: Option<Extension<Arc<StrategyStore>>>,
) -> ApiResult<JsonBody<AssemblyStrategyDto>> {
    let org = ctx.subject_tenant_id();
    let dto = read(
        &product,
        matches.as_ref().map(|m| m.0.as_ref()),
        store.as_ref().map(|s| s.0.as_ref()),
        &ctx,
        org,
        None,
    )
    .await?;
    Ok(Json(dto))
}

async fn upsert_assembly_strategy(
    OrgCtx(ctx): OrgCtx,
    Extension(product): Extension<Product>,
    matches: Option<Extension<Arc<GearMatches>>>,
    store: Option<Extension<Arc<StrategyStore>>>,
    Json(body): Json<SetAssemblyStrategyRequest>,
) -> ApiResult<JsonBody<AssemblyStrategyDto>> {
    let strategy = strategy_of(body.strategy.as_deref())?;
    let org = ctx.subject_tenant_id();
    if !may_set_default(&product.hub, &ctx, org).await {
        return Err(StudioProductError::permission_denied()
            .with_reason("ASSEMBLY_DEFAULT_ADMIN_REQUIRED")
            .create());
    }
    let Some(Extension(kept)) = store.as_ref() else {
        return Err(no_store());
    };
    // The default is one of the strategies the organization's kits provide.
    if let Some(s) = strategy {
        require_kit(&product.hub, &ctx, org, s.kit())
            .await
            .map_err(|r| r.problem())?;
    }
    kept.put(org, org, strategy, &ctx.subject_id().to_string())
        .await
        .map_err(internal)?;
    tracing::info!(
        organization_id = %org,
        strategy = strategy.map_or("the kits' default", Strategy::as_str),
        "studio-product: an organization's default assembly strategy was set"
    );
    let dto = read(
        &product,
        matches.as_ref().map(|m| m.0.as_ref()),
        Some(kept.as_ref()),
        &ctx,
        org,
        None,
    )
    .await?;
    Ok(Json(dto))
}

pub(super) fn register(router: Router, openapi: &dyn OpenApiRegistry) -> Router {
    let router =
        OperationBuilder::get("/studio-product/v1/project-assembly-strategy")
            .operation_id("studio_product.get_project_assembly_strategy")
            .summary("How the project's product is assembled")
            .description(
                "When to call: before proposing gears for the project's product, or to show                  how it is assembled. `strategy` is what is used: one of the strategies the                  kits that apply provide (`strategies`, `strategy_kits`: `spec_mapping`, the                  gears studio-spec-mapping's plan offers, instant, free, deterministic;                  `gears_matcher`, the gears the latest gear match proposes, minutes, paid,                  varies between runs), or `manual` where none can be used and the product is                  assembled by hand. `chosen` and `source` say what the settings ask for and                  where that comes from (`project`, `organization`, `studio`); `fallback` says                  why `chosen` is not used (`KIT_NOT_INSTALLED`, `KIT_UNKNOWN`,                  `MATCHER_NOT_CONFIGURED`). A strategy only proposes picks: the engine's                  completion and a person's confirmation come after.",
            )
            .tag("StudioProduct")
            .authenticated()
            .require_license_features::<License>([])
            .query_param("project_id", true, "The project (its tenant id)")
            .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
            .handler(get_project_assembly_strategy)
            .json_response_with_schema::<AssemblyStrategyDto>(
                openapi,
                StatusCode::OK,
                "The strategy",
            )
            .error_401(openapi)
            .error_404(openapi)
            .error_500(openapi)
            .register(router, openapi);

    let router = OperationBuilder::put("/studio-product/v1/project-assembly-strategy")
        .operation_id("studio_product.upsert_project_assembly_strategy")
        .summary("Choose how the project's product is assembled")
        .description(
            "The project's own strategy over its organization's default: one the kits \
                 that apply to it provide (`spec_mapping`, `gears_matcher`); null follows the \
                 organization's default again. A strategy whose kit does not apply is refused \
                 with `KIT_NOT_INSTALLED`. Answers the strategy as `GET` does. 503 without the \
                 gear's database.",
        )
        .tag("StudioProduct")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project (its tenant id)")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(upsert_project_assembly_strategy)
        .json_request::<SetAssemblyStrategyRequest>(openapi, "The strategy")
        .json_response_with_schema::<AssemblyStrategyDto>(openapi, StatusCode::OK, "Kept")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-product/v1/assembly-strategy")
        .operation_id("studio_product.get_assembly_strategy")
        .summary("How the organization's products are assembled by default")
        .description(
            "When to call: to show or change the organization's default way of assembling              its projects' products (Organization › Gears matcher). The same answer as the              project's read, for the organization alone: the strategies its kits provide,              `organization_default`, the strategy a project that follows it gets, its              `fallback`, and whether the caller may change it (`may_set_default`).",
        )
        .tag("StudioProduct")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(get_assembly_strategy)
        .json_response_with_schema::<AssemblyStrategyDto>(openapi, StatusCode::OK, "The default")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    OperationBuilder::put("/studio-product/v1/assembly-strategy")
        .operation_id("studio_product.upsert_assembly_strategy")
        .summary("Set how the organization's products are assembled by default")
        .description(
            "The organization's default strategy, which every project without its own \
             choice follows: one the organization's kits provide (`spec_mapping`, \
             `gears_matcher`; `KIT_NOT_INSTALLED` for another); null goes back to what the \
             kits make it (the only one, else `spec_mapping`). An organization or platform \
             administrator only (403 `ASSEMBLY_DEFAULT_ADMIN_REQUIRED`). The Gears matcher \
             kit's: `KIT_NOT_INSTALLED` where it does not apply. 503 without the gear's \
             database.",
        )
        .tag("StudioProduct")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(upsert_assembly_strategy)
        .json_request::<SetAssemblyStrategyRequest>(openapi, "The default")
        .json_response_with_schema::<AssemblyStrategyDto>(openapi, StatusCode::OK, "Kept")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi)
}
