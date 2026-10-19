//! REST surface of `studio-usage`: an organization's price list, its costs
//! and its budgets (issue #781). The organization is named with `?organization_id=` (the
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

use super::budgets::{Budget, Budgets};
use super::costs::GroupBy;
use super::prices::{ModelPrice, PriceList, SessionPrice};
use super::service::{MANAGE_PRIVILEGE, Place, Refusal, UsageService, VIEW_PRIVILEGE};
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
pub struct PricesDto {
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
pub struct PricesRequest {
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

#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(request, response)]
pub struct BudgetDto {
    /// A workspace or project of the organization; absent for the whole
    /// organization.
    pub tenant_id: Option<String>,
    /// What may be spent in a calendar month (UTC), in the price list's
    /// currency.
    pub monthly: f64,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct BudgetPlaceDto {
    pub id: String,
    pub label: String,
    /// `organization`, `workspace` or `project`.
    pub kind: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct BudgetsDto {
    /// The price list's currency, the one budgets are in.
    pub currency: String,
    /// Percent of a budget at which it warns.
    pub warn_at_percent: u32,
    pub budgets: Vec<BudgetDto>,
    /// What a budget can be set on: the organization, its workspaces, its
    /// projects.
    pub places: Vec<BudgetPlaceDto>,
    /// Whether the caller may change them (`cost.manage`).
    pub may_manage: bool,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct BudgetsRequest {
    /// 1-99; 80 when absent.
    pub warn_at_percent: Option<u32>,
    pub budgets: Vec<BudgetDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct BudgetStandingDto {
    /// Absent for the organization.
    pub tenant_id: Option<String>,
    pub label: String,
    pub monthly: f64,
    /// Spent so far this month: the organization's total, a workspace's own
    /// and its projects', a project's own.
    pub spent: f64,
    /// The month's spend if it goes on as so far; absent in the first three
    /// days of a month.
    pub forecast: Option<f64>,
    /// `ok`, `warning` (at or past `warn_at_percent`) or `over` (at or past
    /// the budget).
    pub level: String,
    /// The level is reached only by the forecast.
    pub by_forecast: bool,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct BudgetStatusDto {
    pub currency: String,
    pub warn_at_percent: u32,
    /// The month, RFC 3339, `[from, to)`.
    pub from: String,
    pub to: String,
    /// RFC 3339: when the spend was read.
    pub measured_at: String,
    /// Whether spend on people's own keys counts against the budgets.
    pub include_personal: bool,
    /// Worst first.
    pub standings: Vec<BudgetStandingDto>,
    /// `provider/model` (or `session`) that had no price this month: the spend
    /// leaves it out, so a budget may be nearer than it shows.
    pub unpriced: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct BudgetStatusQuery {
    #[serde(default)]
    include_personal: Option<bool>,
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

fn list_dto(list: PriceList, may_manage: bool, may_view_costs: bool) -> PricesDto {
    PricesDto {
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

fn rfc3339(t: OffsetDateTime) -> String {
    t.format(&Rfc3339).unwrap_or_default()
}

fn place_kind(org: uuid::Uuid, p: &Place) -> &'static str {
    if p.id == org {
        "organization"
    } else if p.workspace.is_some() {
        "project"
    } else {
        "workspace"
    }
}

fn budgets_dto(
    org: uuid::Uuid,
    list: Budgets,
    places: &[Place],
    currency: String,
    may_manage: bool,
) -> BudgetsDto {
    BudgetsDto {
        currency,
        warn_at_percent: u32::from(list.warn_at_percent()),
        budgets: list
            .items
            .into_iter()
            .map(|b| BudgetDto {
                tenant_id: b.tenant_id.map(|id| id.to_string()),
                monthly: b.monthly,
            })
            .collect(),
        places: places
            .iter()
            .map(|p| BudgetPlaceDto {
                id: p.id.to_string(),
                label: p.label.clone(),
                kind: place_kind(org, p).to_owned(),
            })
            .collect(),
        may_manage,
    }
}

/* ── Handlers ── */

async fn get_prices(
    OrgCtx(ctx): OrgCtx,
    Extension(usage): Extension<Usage>,
) -> ApiResult<JsonBody<PricesDto>> {
    let org = ctx.subject_tenant_id();
    let (list, _) = usage.0.prices(&ctx, org).await.map_err(problem)?;
    let manage = usage.0.may(&ctx, org, MANAGE_PRIVILEGE).await;
    let view = usage.0.may(&ctx, org, VIEW_PRIVILEGE).await;
    Ok(Json(list_dto(list, manage, view)))
}

async fn update_prices(
    OrgCtx(ctx): OrgCtx,
    Extension(usage): Extension<Usage>,
    Json(body): Json<PricesRequest>,
) -> ApiResult<JsonBody<PricesDto>> {
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

async fn get_budgets(
    OrgCtx(ctx): OrgCtx,
    Extension(usage): Extension<Usage>,
) -> ApiResult<JsonBody<BudgetsDto>> {
    let org = ctx.subject_tenant_id();
    let (list, places) = usage.0.budgets(&ctx, org).await.map_err(problem)?;
    let (prices, _) = usage.0.prices(&ctx, org).await.map_err(problem)?;
    let manage = usage.0.may(&ctx, org, MANAGE_PRIVILEGE).await;
    Ok(Json(budgets_dto(
        org,
        list,
        &places,
        prices.currency().to_owned(),
        manage,
    )))
}

async fn update_budgets(
    OrgCtx(ctx): OrgCtx,
    Extension(usage): Extension<Usage>,
    Json(body): Json<BudgetsRequest>,
) -> ApiResult<JsonBody<BudgetsDto>> {
    let org = ctx.subject_tenant_id();
    let invalid = |detail: String| {
        StudioUsageError::invalid_argument()
            .with_constraint(detail)
            .create()
    };
    let warn_at_percent = match body.warn_at_percent {
        None => 0,
        Some(p) if (1..100).contains(&p) => p as u8,
        Some(p) => return Err(invalid(format!("warn_at_percent {p} is not 1-99"))),
    };
    let mut items = Vec::with_capacity(body.budgets.len());
    for b in body.budgets {
        let tenant_id = match b.tenant_id.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(raw) => Some(
                raw.parse()
                    .map_err(|_| invalid(format!("tenant_id {raw:?} is not an id")))?,
            ),
        };
        items.push(Budget {
            tenant_id,
            monthly: b.monthly,
        });
    }
    let (saved, places) = usage
        .0
        .put_budgets(
            &ctx,
            org,
            Budgets {
                warn_at_percent,
                items,
            },
        )
        .await
        .map_err(problem)?;
    let (prices, _) = usage.0.prices(&ctx, org).await.map_err(problem)?;
    Ok(Json(budgets_dto(
        org,
        saved,
        &places,
        prices.currency().to_owned(),
        true,
    )))
}

async fn get_budget_status(
    OrgCtx(ctx): OrgCtx,
    Extension(usage): Extension<Usage>,
    Query(q): Query<BudgetStatusQuery>,
) -> ApiResult<JsonBody<BudgetStatusDto>> {
    let org = ctx.subject_tenant_id();
    let include_personal = q.include_personal.unwrap_or(false);
    let status = usage
        .0
        .budget_status(&ctx, org, include_personal, OffsetDateTime::now_utc())
        .await
        .map_err(problem)?;
    let label = |id: Option<uuid::Uuid>| match id {
        None => status
            .places
            .iter()
            .find(|p| p.id == org)
            .map(|p| p.label.clone())
            .unwrap_or_else(|| "The organization".to_owned()),
        Some(id) => status
            .places
            .iter()
            .find(|p| p.id == id)
            .map(|p| p.label.clone())
            .unwrap_or_else(|| id.to_string()),
    };
    Ok(Json(BudgetStatusDto {
        currency: status.currency.clone(),
        warn_at_percent: u32::from(status.warn_at_percent),
        from: rfc3339(status.month.0),
        to: rfc3339(status.month.1),
        measured_at: rfc3339(status.as_of),
        include_personal,
        standings: status
            .standings
            .iter()
            .map(|s| BudgetStandingDto {
                tenant_id: s.tenant_id.map(|id| id.to_string()),
                label: label(s.tenant_id),
                monthly: s.monthly,
                spent: s.spent,
                forecast: s.forecast,
                level: s.level.as_str().to_owned(),
                by_forecast: s.by_forecast,
            })
            .collect(),
        unpriced: status.unpriced.clone(),
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
        .json_response_with_schema::<PricesDto>(openapi, StatusCode::OK, "The price list")
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
        .json_request::<PricesRequest>(openapi, "The price list")
        .handler(update_prices)
        .json_response_with_schema::<PricesDto>(openapi, StatusCode::OK, "Stored")
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

    router = OperationBuilder::get("/studio-usage/v1/budgets")
        .operation_id("studio_usage.get_budgets")
        .summary("An organization's monthly budgets")
        .description(
            "What the organization, a workspace or a project may spend in a calendar month \
             (UTC), in the price list's currency, and the share at which a budget warns. A \
             budget warns and stops nothing. `places` lists what a budget can be set on. \
             Organization administrators, or holders of `cost.view`, only; `may_manage` says \
             whether the caller may change them.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("organization_id", false, "The organization", "string")
        .handler(get_budgets)
        .json_response_with_schema::<BudgetsDto>(openapi, StatusCode::OK, "The budgets")
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::put("/studio-usage/v1/budgets")
        .operation_id("studio_usage.update_budgets")
        .summary("Replace an organization's monthly budgets")
        .description(
            "Organization administrators, or holders of `cost.manage`, only. The whole list \
             is sent and replaces the stored one. A budget without `tenant_id` is the \
             organization's; otherwise it names one of its workspaces or projects, each at \
             most once. Refused when an amount is not above zero, `warn_at_percent` is not \
             1-99, or a tenant is not the organization's.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("organization_id", false, "The organization", "string")
        .json_request::<BudgetsRequest>(openapi, "The budgets")
        .handler(update_budgets)
        .json_response_with_schema::<BudgetsDto>(openapi, StatusCode::OK, "Stored")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-usage/v1/budget-status")
        .operation_id("studio_usage.get_budget_status")
        .summary("Where this month's spend stands against each budget")
        .description(
            "For each budget: what was spent this calendar month (UTC) in what it covers, the \
             month's forecast at the pace so far (from the fourth day), and a level — `ok`, \
             `warning` at or past `warn_at_percent`, `over` at or past the budget — with \
             `by_forecast` when only the forecast reaches it. Worst first. Spend on people's \
             own keys counts only with `include_personal=true` (default false: a budget is \
             the organization's money). What had no price is listed in `unpriced` and not in \
             the spend. Organization administrators, or holders of `cost.view`, only.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("organization_id", false, "The organization", "string")
        .query_param_typed(
            "include_personal",
            false,
            "Count spend on people's own keys (default false)",
            "boolean",
        )
        .handler(get_budget_status)
        .json_response_with_schema::<BudgetStatusDto>(openapi, StatusCode::OK, "The standing")
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router.layer(Extension(Usage(service)))
}
