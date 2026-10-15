//! REST surface of `studio-usage`: an organization's price list and its costs
//! (issue #781). The organization is named with `?organization_id=` (the
//! `OrgCtx` extractor): a scope never goes in the path (`api_contract`, rule C).

use std::sync::Arc;

use axum::extract::Query;
use axum::{Extension, Router};
use serde::Deserialize;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_canonical_errors::resource_error;

use super::costs::GroupBy;
use super::prices::{ModelPrice, PriceList, SessionPrice};
use super::service::{MANAGE_PRIVILEGE, Refusal, UsageService, VIEW_PRIVILEGE};
use crate::org_scope::OrgCtx;

/// Errors attributable to an organization's prices or costs.
#[resource_error(gts_id!("cf.studio.usage.costs.v1~"))]
pub struct StudioUsageError;

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

const TAG: &str = "StudioUsage";

#[derive(Clone)]
pub struct Usage(pub Arc<UsageService>);

fn problem(r: Refusal) -> CanonicalError {
    match r {
        Refusal::Forbidden(reason) => StudioUsageError::permission_denied()
            .with_reason(reason)
            .create(),
        Refusal::Invalid(detail) => StudioUsageError::invalid_argument()
            .with_constraint(detail)
            .create(),
        Refusal::Unavailable(detail) => CanonicalError::service_unavailable()
            .with_detail(detail)
            .create(),
        Refusal::Internal(detail) => CanonicalError::internal(detail).create(),
    }
}

/* ── DTOs ── */

#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(request, response)]
pub struct ModelPriceDto {
    /// `anthropic`, `openai`.
    pub provider: String,
    /// The model as the provider names it in its answers; a trailing `*`
    /// matches every model starting with the rest.
    pub model: String,
    /// Price per million uncached input tokens.
    pub input_per_mtok: f64,
    pub output_per_mtok: f64,
    pub cache_read_per_mtok: f64,
    pub cache_write_per_mtok: f64,
}

#[derive(Debug, Clone, Copy)]
#[toolkit_macros::api_dto(request, response)]
pub struct SessionPriceDto {
    /// Per hour of one requested CPU core.
    pub cpu_core_hour: f64,
    /// Per hour of one requested GiB of memory.
    pub memory_gib_hour: f64,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct PriceListDto {
    /// ISO 4217 code every price is in.
    pub currency: String,
    pub models: Vec<ModelPriceDto>,
    /// Absent: sessions are unpriced.
    pub session: Option<SessionPriceDto>,
    /// Whether the caller may change the list (`cost.manage`).
    pub may_manage: bool,
    /// Whether the caller may read the costs (`cost.view`).
    pub may_view_costs: bool,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct PriceListRequest {
    /// ISO 4217; `USD` when absent.
    pub currency: Option<String>,
    pub models: Vec<ModelPriceDto>,
    pub session: Option<SessionPriceDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct CostRowDto {
    /// What the row is: a person's id, a tenant's id, `provider/model` or
    /// `ide-session`, `llm` or `session`, a payer. Empty for sessions in a
    /// by-person report: nobody is recorded against a session.
    pub key: String,
    /// The tenant's name in a by-project report.
    pub label: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    /// Seconds IDE sessions ran.
    pub session_seconds: u64,
    /// What the priced part cost, in the report's currency.
    pub cost: f64,
    /// Part of this row had no price: its quantity is counted, its cost not.
    pub unpriced: bool,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct CostsDto {
    pub currency: String,
    /// RFC 3339; the period is `[from, to)`.
    pub from: String,
    pub to: String,
    pub group_by: String,
    /// Whether spend on people's own keys is in the rows and the total.
    pub include_personal: bool,
    pub total: f64,
    pub rows: Vec<CostRowDto>,
    /// `provider/model` (or `session`) for what had no price.
    pub unpriced: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct CostsQuery {
    from: String,
    to: String,
    #[serde(default)]
    group_by: Option<String>,
    #[serde(default)]
    include_personal: Option<bool>,
}

fn model_dto(m: ModelPrice) -> ModelPriceDto {
    ModelPriceDto {
        provider: m.provider,
        model: m.model,
        input_per_mtok: m.input_per_mtok,
        output_per_mtok: m.output_per_mtok,
        cache_read_per_mtok: m.cache_read_per_mtok,
        cache_write_per_mtok: m.cache_write_per_mtok,
    }
}

fn session_dto(s: SessionPrice) -> SessionPriceDto {
    SessionPriceDto {
        cpu_core_hour: s.cpu_core_hour,
        memory_gib_hour: s.memory_gib_hour,
    }
}

fn list_dto(list: PriceList, may_manage: bool, may_view_costs: bool) -> PriceListDto {
    PriceListDto {
        currency: list.currency().to_owned(),
        models: list.models.into_iter().map(model_dto).collect(),
        session: list.session.map(session_dto),
        may_manage,
        may_view_costs,
    }
}

fn instant(field: &str, raw: &str) -> Result<OffsetDateTime, CanonicalError> {
    OffsetDateTime::parse(raw, &Rfc3339).map_err(|_| {
        StudioUsageError::invalid_argument()
            .with_constraint(format!("{field} {raw:?} is not an RFC 3339 time"))
            .create()
    })
}

/* ── Handlers ── */

async fn get_prices(
    OrgCtx(ctx): OrgCtx,
    Extension(usage): Extension<Usage>,
) -> ApiResult<JsonBody<PriceListDto>> {
    let org = ctx.subject_tenant_id();
    let (list, _) = usage.0.prices(&ctx, org).await.map_err(problem)?;
    let manage = usage.0.may(&ctx, org, MANAGE_PRIVILEGE).await;
    let view = usage.0.may(&ctx, org, VIEW_PRIVILEGE).await;
    Ok(Json(list_dto(list, manage, view)))
}

async fn update_prices(
    OrgCtx(ctx): OrgCtx,
    Extension(usage): Extension<Usage>,
    Json(body): Json<PriceListRequest>,
) -> ApiResult<JsonBody<PriceListDto>> {
    let org = ctx.subject_tenant_id();
    let list = PriceList {
        currency: body.currency.unwrap_or_default(),
        models: body
            .models
            .into_iter()
            .map(|m| ModelPrice {
                provider: m.provider.trim().to_owned(),
                model: m.model.trim().to_owned(),
                input_per_mtok: m.input_per_mtok,
                output_per_mtok: m.output_per_mtok,
                cache_read_per_mtok: m.cache_read_per_mtok,
                cache_write_per_mtok: m.cache_write_per_mtok,
            })
            .collect(),
        session: body.session.map(|s| SessionPrice {
            cpu_core_hour: s.cpu_core_hour,
            memory_gib_hour: s.memory_gib_hour,
        }),
    };
    let saved = usage.0.put_prices(&ctx, org, list).await.map_err(problem)?;
    let view = usage.0.may(&ctx, org, VIEW_PRIVILEGE).await;
    Ok(Json(list_dto(saved, true, view)))
}

async fn get_costs(
    OrgCtx(ctx): OrgCtx,
    Extension(usage): Extension<Usage>,
    Query(q): Query<CostsQuery>,
) -> ApiResult<JsonBody<CostsDto>> {
    let from = instant("from", &q.from)?;
    let to = instant("to", &q.to)?;
    let group_name = q.group_by.unwrap_or_else(|| "project".to_owned());
    let group = GroupBy::parse(&group_name).ok_or_else(|| {
        StudioUsageError::invalid_argument()
            .with_constraint(format!(
                "group_by {group_name:?} is none of person, project, model, source, payer"
            ))
            .create()
    })?;
    let include_personal = q.include_personal.unwrap_or(true);
    let org = ctx.subject_tenant_id();
    let costs = usage
        .0
        .costs(&ctx, org, from, to, group, include_personal)
        .await
        .map_err(problem)?;
    let label = |key: &str| {
        costs
            .places
            .iter()
            .find(|p| p.id.to_string() == key)
            .map(|p| p.label.clone())
    };
    Ok(Json(CostsDto {
        currency: costs.currency.clone(),
        from: q.from,
        to: q.to,
        group_by: group_name,
        include_personal,
        total: costs.report.total,
        rows: costs
            .report
            .rows
            .iter()
            .map(|r| CostRowDto {
                key: r.key.clone(),
                label: if group == GroupBy::Project {
                    label(&r.key)
                } else {
                    None
                },
                input_tokens: r.tokens.input,
                output_tokens: r.tokens.output,
                cache_read_tokens: r.tokens.cache_read,
                cache_write_tokens: r.tokens.cache_write,
                session_seconds: r.session_seconds,
                cost: r.cost,
                unpriced: r.unpriced,
            })
            .collect(),
        unpriced: costs.report.unpriced.clone(),
    }))
}

/* ── Routes ── */

pub fn register_routes(
    router: Router,
    openapi: &dyn OpenApiRegistry,
    service: Arc<UsageService>,
) -> Router {
    let mut router = router;
    router = OperationBuilder::get("/studio-usage/v1/prices")
        .operation_id("studio_usage.get_prices")
        .summary("An organization's price list for model tokens and IDE sessions")
        .description(
            "What the organization says its usage costs: per model, the price of a million \
             input, output, cache-read and cache-write tokens; per hour, the price of a \
             requested CPU core and GiB of memory for IDE sessions. Anybody who reaches the \
             organization may read it; `may_manage` says whether the caller may change it and \
             `may_view_costs` whether they may read the costs. Name the organization with \
             `?organization_id=`.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("organization_id", false, "The organization", "string")
        .handler(get_prices)
        .json_response_with_schema::<PriceListDto>(openapi, StatusCode::OK, "The price list")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::put("/studio-usage/v1/prices")
        .operation_id("studio_usage.update_prices")
        .summary("Replace an organization's price list")
        .description(
            "Organization administrators, or holders of `cost.manage`, only. The whole list is \
             sent and replaces the stored one; costs are derived from it when they are read, \
             so a change reprices past usage too. Refused when a model is priced twice, a \
             price is negative, or the currency is not an ISO 4217 code.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("organization_id", false, "The organization", "string")
        .json_request::<PriceListRequest>(openapi, "The price list")
        .handler(update_prices)
        .json_response_with_schema::<PriceListDto>(openapi, StatusCode::OK, "Stored")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-usage/v1/costs")
        .operation_id("studio_usage.get_costs")
        .summary("An organization's costs over a period, grouped")
        .description(
            "What the organization's model calls and IDE sessions used from `from` up to `to` \
             (RFC 3339, at most a year), read from the platform's usage collector across the \
             organization, its workspaces and its projects, priced with the organization's \
             price list and grouped by `group_by`: person, project (default), model, source \
             or payer. `include_personal=false` leaves out what people spent on their own \
             keys. What has no price is counted, marked `unpriced`, and listed. Organization \
             administrators, or holders of `cost.view`, only.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("organization_id", false, "The organization", "string")
        .query_param_typed("from", true, "Start of the period, RFC 3339", "string")
        .query_param_typed(
            "to",
            true,
            "End of the period (excluded), RFC 3339",
            "string",
        )
        .query_param_typed(
            "group_by",
            false,
            "person | project | model | source | payer",
            "string",
        )
        .query_param_typed(
            "include_personal",
            false,
            "Count spend on people's own keys (default true)",
            "boolean",
        )
        .handler(get_costs)
        .json_response_with_schema::<CostsDto>(openapi, StatusCode::OK, "The costs")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router.layer(Extension(Usage(service)))
}
