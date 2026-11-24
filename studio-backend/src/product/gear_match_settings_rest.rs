//! A strategy's service's run settings, over REST
//! ([`crate::product::gear_match::settings`],
//! `docs/design/product-gear-match.md` §10):
//!
//! - `GET gears-matcher-settings?organization_id=&strategy=gears_matcher` --
//!   the provider and models a match uses and its call bounds, as the service
//!   says them (in use, its configuration's, the override, which providers
//!   have their key there, the ceilings), whose service it is (`scope`:
//!   `organization` for the organization's own connection, `deployment` for
//!   the deployment's shared one) and whether the caller may change them.
//! - `PUT gears-matcher-settings?organization_id=&strategy=` -- replace the
//!   override, `{version, overrides}`; recorded as the caller's change. The
//!   organization's own service: an organization administrator; the
//!   deployment's, which every organization shares: a platform administrator
//!   only (403 `MATCHER_SETTINGS_ADMIN_REQUIRED`). 409
//!   `MATCHER_SETTINGS_CONFLICT` when they changed since they were read; 400
//!   `MATCHER_PROVIDER_UNAVAILABLE` or `MATCHER_BAD_SETTINGS` when the service
//!   refuses them. Claimed by the Gears matcher kit.
//!
//! Both answer 503 when there is no service (none configured, none
//! connected) or it does not answer. Keys are never settings: nothing here
//! takes or shows one.

use super::gear_match_rest::strategy_param;
use super::*;
use crate::product::gear_match::GearMatches;
use crate::product::gear_match::settings::{
    ADMIN_REQUIRED, CONFLICT, HubAuthority, SettingsRead, SettingsRefusal,
};

#[derive(Debug, Default, serde::Deserialize)]
pub struct MatcherSettingsQuery {
    /// The service strategy; `gears_matcher` when absent.
    pub strategy: Option<String>,
}

/// What a run uses: the provider, its three models and the call bounds.
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(request, response)]
pub struct MatcherSettingsValuesDto {
    /// `constructor`, `anthropic` or `openai`.
    pub provider: String,
    /// Candidates 1, candidates 2, checks.
    pub models: Vec<String>,
    /// A run's call bound.
    pub max_calls: u64,
    /// The most a run reading free-form documents may spend on reading them.
    pub max_extract_calls: u64,
}

/// What replaces the configuration's values; a null field uses its value.
#[derive(Debug, Clone, Default)]
#[toolkit_macros::api_dto(request, response)]
pub struct MatcherSettingsOverridesDto {
    pub provider: Option<String>,
    /// One model id for all three roles, or three.
    pub models: Option<Vec<String>>,
    pub max_calls: Option<u64>,
    pub max_extract_calls: Option<u64>,
}

/// A provider the service knows, and whether its key is in the service's
/// configuration.
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(request, response)]
pub struct MatcherSettingsProviderDto {
    pub id: String,
    pub available: bool,
    /// Why not; names a variable, never a value.
    pub reason: Option<String>,
}

/// The most an override may raise the bounds to.
#[derive(Debug, Clone, Default)]
#[toolkit_macros::api_dto(request, response)]
pub struct MatcherSettingsCeilingsDto {
    pub max_calls: Option<u64>,
    pub max_extract_calls: Option<u64>,
}

/// The service's settings as it answers them (`Settings` of
/// `gears-matcher/v1`).
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(request, response)]
pub struct MatcherServiceSettingsDto {
    pub version: u64,
    pub updated_at: Option<String>,
    pub updated_by: Option<String>,
    pub effective: MatcherSettingsValuesDto,
    pub config: MatcherSettingsValuesDto,
    pub overrides: MatcherSettingsOverridesDto,
    pub providers: Vec<MatcherSettingsProviderDto>,
    pub ceilings: MatcherSettingsCeilingsDto,
    pub problem: Option<String>,
}

/// A strategy's service's run settings, for the organization.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct MatcherSettingsDto {
    pub strategy: String,
    /// Whose service it is: `organization` (its own connection) or
    /// `deployment` (the deployment's, which every organization without one
    /// shares).
    pub scope: String,
    /// The caller may change them: an administrator of the organization for
    /// its own service, a platform administrator for the deployment's.
    pub may_change: bool,
    /// 0 when they were never changed; a change names it.
    pub version: u64,
    /// When they were last changed (RFC 3339), and by whom (a user id).
    pub updated_at: Option<String>,
    pub updated_by: Option<String>,
    /// What a run submitted now uses.
    pub effective: MatcherSettingsValuesDto,
    /// The service's configuration's values.
    pub config: MatcherSettingsValuesDto,
    /// What replaces them; null uses the configuration's.
    pub overrides: MatcherSettingsOverridesDto,
    pub providers: Vec<MatcherSettingsProviderDto>,
    pub ceilings: MatcherSettingsCeilingsDto,
    /// Why the stored override is set aside (its provider's key was removed);
    /// absent when it is in use.
    pub problem: Option<String>,
}

/// The override as it is to be, against the version read.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SetMatcherSettingsRequest {
    /// `version` from the read this change was made on.
    pub version: u64,
    pub overrides: MatcherSettingsOverridesDto,
}

fn problem(r: SettingsRefusal) -> CanonicalError {
    match r {
        SettingsRefusal::Unavailable(m) => CanonicalError::service_unavailable()
            .with_detail(m)
            .create(),
        SettingsRefusal::Forbidden => StudioProductError::permission_denied()
            .with_reason(ADMIN_REQUIRED)
            .create(),
        SettingsRefusal::Conflict(m) => StudioProductError::aborted(m)
            .with_reason(CONFLICT)
            .create(),
        SettingsRefusal::Invalid { code, why } => StudioProductError::invalid_argument()
            .with_field_violation("overrides", why, code)
            .create(),
        SettingsRefusal::Internal(m) => CanonicalError::internal(m).create(),
    }
}

fn dto(strategy: String, read: SettingsRead) -> ApiResult<MatcherSettingsDto> {
    let s: MatcherServiceSettingsDto = serde_json::from_value(read.settings).map_err(|e| {
        CanonicalError::internal(format!(
            "the gears-matcher service answered settings this server cannot read: {e}"
        ))
        .create()
    })?;
    Ok(MatcherSettingsDto {
        strategy,
        scope: read.scope.as_str().to_owned(),
        may_change: read.may_change,
        version: s.version,
        updated_at: s.updated_at,
        updated_by: s.updated_by,
        effective: s.effective,
        config: s.config,
        overrides: s.overrides,
        providers: s.providers,
        ceilings: s.ceilings,
        problem: s.problem,
    })
}

async fn get_matcher_settings(
    OrgCtx(ctx): OrgCtx,
    Extension(product): Extension<Product>,
    Extension(matches): Extension<Arc<GearMatches>>,
    Query(MatcherSettingsQuery { strategy }): Query<MatcherSettingsQuery>,
) -> ApiResult<JsonBody<MatcherSettingsDto>> {
    let strategy = strategy_param(strategy)?;
    let org = ctx.subject_tenant_id();
    let authority = HubAuthority(Arc::clone(&product.hub));
    let read = matches
        .read_settings(&authority, &ctx, org, &strategy)
        .await
        .map_err(problem)?;
    Ok(Json(dto(strategy, read)?))
}

async fn upsert_matcher_settings(
    OrgCtx(ctx): OrgCtx,
    Extension(product): Extension<Product>,
    Extension(matches): Extension<Arc<GearMatches>>,
    Query(MatcherSettingsQuery { strategy }): Query<MatcherSettingsQuery>,
    Json(body): Json<SetMatcherSettingsRequest>,
) -> ApiResult<JsonBody<MatcherSettingsDto>> {
    let strategy = strategy_param(strategy)?;
    let org = ctx.subject_tenant_id();
    let authority = HubAuthority(Arc::clone(&product.hub));
    // The four fields the contract has, and nothing else a client sent.
    let o = body.overrides;
    let overrides = serde_json::json!({
        "provider": o.provider,
        "models": o.models,
        "max_calls": o.max_calls,
        "max_extract_calls": o.max_extract_calls,
    });
    let read = matches
        .change_settings(&authority, &ctx, org, &strategy, body.version, overrides)
        .await
        .map_err(problem)?;
    Ok(Json(dto(strategy, read)?))
}

const STRATEGY_DOC: &str = "The assembly strategy whose service it is: `gears_matcher` when absent, \
     or an organization kit's service strategy (ADR-0074)";

pub(super) fn register(router: Router, openapi: &dyn OpenApiRegistry) -> Router {
    let router = OperationBuilder::get("/studio-product/v1/gears-matcher-settings")
        .operation_id("studio_product.get_gears_matcher_settings")
        .summary("The gears-matcher service's run settings")
        .description(
            "When to call: to show which provider and models the organization's gear matches \
             use and their call bounds (Organization › Gears matcher). The service's own \
             answer: `effective` (what a run submitted now uses), `config` (its \
             configuration's values), `overrides` (what replaces them; null uses the \
             configuration's), `providers` (which have their key in its configuration), \
             `ceilings`, `problem` when a stored override is set aside. `scope` says whose \
             service it is (`organization`: its own connection; `deployment`: the \
             deployment's, shared by every organization without one) and `may_change` \
             whether the caller may change them. Keys are never settings and never here. \
             503 when there is no service or it does not answer.",
        )
        .tag("StudioProduct")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("strategy", false, STRATEGY_DOC)
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(get_matcher_settings)
        .json_response_with_schema::<MatcherSettingsDto>(openapi, StatusCode::OK, "The settings")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    OperationBuilder::put("/studio-product/v1/gears-matcher-settings")
        .operation_id("studio_product.upsert_gears_matcher_settings")
        .summary("Change the gears-matcher service's run settings")
        .description(
            "Replaces the override of the service's configuration as a whole: `overrides` \
             with `provider`, `models` (one id for all three roles, or three), `max_calls`, \
             `max_extract_calls`; a null field uses the configuration's value. `version` is \
             the one read: if the settings changed since, 409 `MATCHER_SETTINGS_CONFLICT` \
             and nothing changes. A provider without its key in the service's configuration \
             is 400 `MATCHER_PROVIDER_UNAVAILABLE`; a bad model id or a bound over its \
             ceiling 400 `MATCHER_BAD_SETTINGS`. The organization's own service: an \
             organization administrator; the deployment's, which every organization shares: \
             a platform administrator only (403 `MATCHER_SETTINGS_ADMIN_REQUIRED`). Recorded \
             as the caller's change; a run already started keeps its settings. Answers the \
             settings as `GET` does. The Gears matcher kit's. 503 when there is no service \
             or it does not answer.",
        )
        .tag("StudioProduct")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("strategy", false, STRATEGY_DOC)
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(upsert_matcher_settings)
        .json_request::<SetMatcherSettingsRequest>(openapi, "The override")
        .json_response_with_schema::<MatcherSettingsDto>(openapi, StatusCode::OK, "Kept")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_409(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::product::gear_match::settings::ServiceScope;
    use serde_json::json;

    #[test]
    fn the_service_s_settings_read_into_the_answer() {
        let read = SettingsRead {
            settings: json!({
                "version": 2,
                "updated_at": "2026-11-23T10:00:00Z",
                "updated_by": "u-1",
                "effective": {"provider": "openai", "models": ["a", "b", "c"],
                              "max_calls": 400, "max_extract_calls": 60},
                "config": {"provider": "constructor", "models": ["x", "x", "x"],
                           "max_calls": 400, "max_extract_calls": 60},
                "overrides": {"provider": "openai", "models": ["a", "b", "c"],
                              "max_calls": null, "max_extract_calls": null},
                "providers": [{"id": "constructor", "available": true},
                              {"id": "anthropic", "available": false,
                               "reason": "ANTHROPIC_API_KEY is not set"}],
                "ceilings": {"max_calls": 2000, "max_extract_calls": 500},
                "something_new": true
            }),
            scope: ServiceScope::Deployment,
            may_change: false,
        };
        let d = dto("gears_matcher".into(), read).unwrap();
        assert_eq!(d.scope, "deployment");
        assert_eq!(d.version, 2);
        assert_eq!(d.effective.provider, "openai");
        assert_eq!(d.overrides.max_calls, None);
        assert_eq!(
            d.providers[1].reason.as_deref(),
            Some("ANTHROPIC_API_KEY is not set")
        );
        assert_eq!(d.ceilings.max_calls, Some(2000));
        assert!(d.problem.is_none());
    }
}
