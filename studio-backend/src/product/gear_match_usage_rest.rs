//! How an organization uses the gears matcher, over REST
//! (`docs/design/product-gear-match.md` §9):
//!
//! - `GET gear-match-usage?organization_id=&period_days=30` -- per project of
//!   the organization the caller reaches: the strategy its product is
//!   assembled by and why, its last gear match with that run's coverage, its
//!   runs, model calls and tokens in the period, the members' decisions and
//!   the questions still open; summed for the organization; and whether the
//!   gears-matcher service answers now (its `GET /v1/info`, asked at most
//!   every 30 s).
//!
//! The projects are the organization's tree as the caller reads it
//! (`organizations::port::ProjectsOf`), so a project the caller does not
//! reach is neither listed nor counted. The counts are the gear's own tables
//! (`gear_match::usage`).

use std::collections::BTreeMap;

use futures_util::{StreamExt, stream};

use super::assembly_rest::{AssemblyFallbackDto, available};
use super::gear_match_rest::GearMatchTotalsDto;
use super::*;
use crate::pagination::{DEFAULT_LIMIT, MAX_LIMIT, PageQuery};
use crate::product::assembly::{self, StrategyStore};
use crate::product::gear_match::usage::{ModelUsage, ProjectUsage};
use crate::product::gear_match::{GearMatches, LiveInfo};

/// The periods a person picks from; any 1 to 365 days is answered.
const DEFAULT_PERIOD_DAYS: u32 = 30;
const MAX_PERIOD_DAYS: u32 = 365;
/// How many projects' kits are read at once.
const PARALLEL_KIT_READS: usize = 8;

#[derive(Debug, Default, serde::Deserialize)]
pub struct UsageQuery {
    pub period_days: Option<u32>,
}

/// Runs by how they ended; `running` counts every run not ended yet.
#[derive(Debug, Default)]
#[toolkit_macros::api_dto(response)]
pub struct GearMatchRunCountsDto {
    pub total: u64,
    pub succeeded: u64,
    pub partial: u64,
    pub failed: u64,
    pub cancelled: u64,
    pub running: u64,
}

/// What the matcher reported spending: model calls, cache hits and tokens.
#[derive(Debug, Default)]
#[toolkit_macros::api_dto(response)]
pub struct GearMatchModelUsageDto {
    pub calls: u64,
    pub cache_hits: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// How many projects one value counts.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearMatchUsageCountDto {
    /// A strategy (`spec_mapping`, `gears_matcher`, `manual`), a source
    /// (`project`, `organization`, `studio`) or a fallback code.
    pub key: String,
    pub projects: u32,
}

/// The organization's sums.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearMatchUsageSummaryDto {
    /// The organization's projects the caller reaches.
    pub projects: u32,
    /// Of them, the ones with at least one gear match, ever.
    pub projects_matched: u32,
    /// Projects by the strategy their product is assembled by (after any
    /// fallback), in the order the strategies are offered, `manual` last.
    pub strategies: Vec<GearMatchUsageCountDto>,
    /// Projects by where their chosen strategy comes from: `project` (their
    /// own choice), `organization` (its default) or `studio` (nobody chose).
    pub sources: Vec<GearMatchUsageCountDto>,
    /// Projects whose chosen strategy is not the one used, by why
    /// (`KIT_NOT_INSTALLED`, `KIT_UNKNOWN`, `MATCHER_NOT_CONFIGURED`).
    pub fallbacks: Vec<GearMatchUsageCountDto>,
    /// Runs started in the period.
    pub runs: GearMatchRunCountsDto,
    /// What those runs spent.
    pub usage: GearMatchModelUsageDto,
    /// The members' decisions on proposed gears, kept now.
    pub accepted: u64,
    pub rejected: u64,
    /// The questions of each project's last finished match.
    pub questions_open: u64,
    pub questions_answered: u64,
    /// The median time from asking to a written report, over the runs of the
    /// period that wrote one, in milliseconds.
    pub median_run_ms: Option<u64>,
}

/// A project's last gear match.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearMatchUsageLastRunDto {
    pub match_id: String,
    /// `queued`, `running`, `cancelling`, `succeeded`, `partial`, `failed`
    /// or `cancelled`.
    pub state: String,
    /// RFC 3339.
    pub created_at: String,
    pub finished_at: Option<String>,
    /// Its report's counts: covered, partial, gap, clarification needed, not
    /// assessed.
    pub totals: Option<GearMatchTotalsDto>,
}

/// One project's use of the matcher.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearMatchUsageItemDto {
    pub project_id: String,
    pub project_name: String,
    pub workspace_id: String,
    pub workspace_name: String,
    /// What its product is assembled by: `spec_mapping`, `gears_matcher` or
    /// `manual`.
    pub strategy: String,
    /// What its settings ask for.
    pub chosen: String,
    /// `project`, `organization` or `studio`.
    pub source: String,
    pub fallback: Option<AssemblyFallbackDto>,
    pub last_run: Option<GearMatchUsageLastRunDto>,
    /// Runs started in the period.
    pub runs: GearMatchRunCountsDto,
    pub usage: GearMatchModelUsageDto,
    pub accepted: u64,
    pub rejected: u64,
    pub questions_open: u64,
    pub questions_answered: u64,
}

/// The matcher's limits, as `GET /v1/info` says them.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearMatcherLimitsDto {
    pub max_documents: Option<u64>,
    pub max_document_bytes: Option<u64>,
    pub max_request_bytes: Option<u64>,
}

/// Whether the gears-matcher service can be used now.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearMatcherServiceDto {
    /// Its address and secret are set.
    pub configured: bool,
    /// What is missing when it is not.
    pub missing: Option<String>,
    /// It answered `GET /v1/info` when last asked; null when it is not
    /// configured, so nothing was asked.
    pub answers: Option<bool>,
    /// When it was last asked, RFC 3339 (kept 30 s).
    pub checked_at: Option<String>,
    /// Why it did not answer.
    pub error: Option<String>,
    pub service_version: Option<String>,
    pub matcher_version: Option<String>,
    /// The catalogue it reads: its source and commit.
    pub catalogue_source: Option<String>,
    pub catalogue_commit: Option<String>,
    pub models: Vec<String>,
    pub limits: Option<GearMatcherLimitsDto>,
}

/// The organization's use of the gears matcher.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearMatchUsageDto {
    pub organization_id: String,
    pub period_days: u32,
    /// The period's start, RFC 3339.
    pub since: String,
    pub summary: GearMatchUsageSummaryDto,
    pub service: GearMatcherServiceDto,
    /// A page of the projects, by workspace then name.
    pub items: Vec<GearMatchUsageItemDto>,
    pub total: u32,
}

fn rfc3339(ms: i64) -> String {
    crate::product::descriptions::rfc3339(ms)
}

fn runs_dto(p: &ProjectUsage) -> GearMatchRunCountsDto {
    let n = |s: &str| p.runs.get(s).copied().unwrap_or(0);
    GearMatchRunCountsDto {
        total: p.runs_total(),
        succeeded: n("succeeded"),
        partial: n("partial"),
        failed: n("failed"),
        cancelled: n("cancelled"),
        running: n("running"),
    }
}

fn usage_dto(u: ModelUsage) -> GearMatchModelUsageDto {
    GearMatchModelUsageDto {
        calls: u.calls,
        cache_hits: u.cache_hits,
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
    }
}

fn str_of(v: &Value, path: &[&str]) -> Option<String> {
    let mut at = v;
    for k in path {
        at = at.get(*k)?;
    }
    at.as_str().map(str::to_owned)
}

/// The service block from what was last asked.
pub(crate) fn service_dto(
    missing: Option<String>,
    live: Option<LiveInfo>,
) -> GearMatcherServiceDto {
    let mut dto = GearMatcherServiceDto {
        configured: missing.is_none(),
        missing,
        answers: None,
        checked_at: None,
        error: None,
        service_version: None,
        matcher_version: None,
        catalogue_source: None,
        catalogue_commit: None,
        models: Vec::new(),
        limits: None,
    };
    let Some(live) = live else {
        return dto;
    };
    dto.checked_at = Some(rfc3339(live.checked_at_ms));
    match live.answer {
        Err(why) => {
            dto.answers = Some(false);
            dto.error = Some(why);
        }
        Ok(info) => {
            dto.answers = Some(true);
            dto.service_version = str_of(&info, &["service_version"]);
            dto.matcher_version = str_of(&info, &["matcher_version"]);
            dto.catalogue_source = str_of(&info, &["catalogue", "source"]);
            dto.catalogue_commit = str_of(&info, &["catalogue", "gear_gdl_commit"])
                .or_else(|| str_of(&info, &["catalogue", "gears_md_commit"]));
            dto.models = info["models"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|m| m.as_str().map(str::to_owned))
                .collect();
            let limits = &info["limits"];
            if limits.is_object() {
                dto.limits = Some(GearMatcherLimitsDto {
                    max_documents: limits["max_documents"].as_u64(),
                    max_document_bytes: limits["max_document_bytes"].as_u64(),
                    max_request_bytes: limits["max_request_bytes"].as_u64(),
                });
            }
        }
    }
    dto
}

/// `(key, n)` pairs in `order`, with the keys not in it after, by name.
fn counts(map: &BTreeMap<String, u32>, order: &[&str]) -> Vec<GearMatchUsageCountDto> {
    let mut out: Vec<GearMatchUsageCountDto> = order
        .iter()
        .filter_map(|k| {
            map.get(*k).map(|n| GearMatchUsageCountDto {
                key: (*k).to_owned(),
                projects: *n,
            })
        })
        .collect();
    for (k, n) in map {
        if !order.contains(&k.as_str()) {
            out.push(GearMatchUsageCountDto {
                key: k.clone(),
                projects: *n,
            });
        }
    }
    out
}

fn bad_period() -> CanonicalError {
    StudioProductError::invalid_argument()
        .with_field_violation(
            "period_days",
            format!("a number of days from 1 to {MAX_PERIOD_DAYS}"),
            "INVALID",
        )
        .create()
}

fn unavailable(why: impl Into<String>) -> CanonicalError {
    CanonicalError::service_unavailable()
        .with_detail(why.into())
        .create()
}

async fn get_gear_match_usage(
    OrgCtx(ctx): OrgCtx,
    Extension(product): Extension<Product>,
    Extension(matches): Extension<Arc<GearMatches>>,
    strategies: Option<Extension<Arc<StrategyStore>>>,
    Query(UsageQuery { period_days }): Query<UsageQuery>,
    Query(page): Query<PageQuery>,
) -> ApiResult<JsonBody<GearMatchUsageDto>> {
    let days = period_days.unwrap_or(DEFAULT_PERIOD_DAYS);
    if days == 0 || days > MAX_PERIOD_DAYS {
        return Err(bad_period());
    }
    let org = ctx.subject_tenant_id();
    let store = matches.store().map_err(|r| unavailable(r.to_string()))?;
    let projects = product
        .hub
        .get::<dyn crate::organizations::port::ProjectsOf>()
        .map_err(|_| unavailable("the organization's projects cannot be listed here"))?
        .projects_of(&ctx, org)
        .await
        .map_err(|e| {
            unavailable(format!(
                "the organization's projects cannot be listed: {e:#}"
            ))
        })?;
    let ids: Vec<Uuid> = projects.iter().map(|p| p.id).collect();
    let now = crate::product::gear_match::store::now_ms();
    let since = now.saturating_sub(i64::from(days) * 86_400_000);

    let (counted, median, settings, live) = tokio::join!(
        store.usage(org, &ids, since),
        store.median_run_ms(org, &ids, since),
        async {
            match strategies.as_ref() {
                Some(Extension(s)) => s.all(org).await.map(Some),
                None => Ok(None),
            }
        },
        matches.live_info(),
    );
    let internal = |e: anyhow::Error| CanonicalError::internal(format!("{e:#}")).create();
    let counted = counted.map_err(internal)?;
    let median = median.map_err(internal)?;
    let settings: BTreeMap<Uuid, assembly::Strategy> = settings
        .map_err(internal)?
        .unwrap_or_default()
        .into_iter()
        .collect();
    let default = settings.get(&org).copied();

    // Each project's effective strategy, from its own kits.
    let hub = Arc::clone(&product.hub);
    let resolved: BTreeMap<Uuid, assembly::Effective> = stream::iter(ids.iter().copied())
        .map(|project| {
            let (hub, ctx, matches) = (Arc::clone(&hub), ctx.clone(), Arc::clone(&matches));
            let choice = settings.get(&project).copied();
            async move {
                let (avail, _) = available(&hub, Some(matches.as_ref()), &ctx, project).await;
                (project, assembly::resolve(choice, default, avail))
            }
        })
        .buffer_unordered(PARALLEL_KIT_READS)
        .collect()
        .await;

    let mut by_strategy: BTreeMap<String, u32> = BTreeMap::new();
    let mut by_source: BTreeMap<String, u32> = BTreeMap::new();
    let mut by_fallback: BTreeMap<String, u32> = BTreeMap::new();
    let mut total_usage = ModelUsage::default();
    let mut all = ProjectUsage::default();
    let mut items = Vec::with_capacity(projects.len());
    for p in &projects {
        let u = counted.get(&p.id).cloned().unwrap_or_default();
        let e = resolved.get(&p.id);
        let strategy = assembly::wire(e.and_then(|e| e.strategy)).to_owned();
        let chosen = assembly::wire(e.and_then(|e| e.chosen)).to_owned();
        let source = e
            .map_or(assembly::Source::Studio, |e| e.source)
            .as_str()
            .to_owned();
        let fallback = e.and_then(|e| e.fallback.clone());
        *by_strategy.entry(strategy.clone()).or_default() += 1;
        *by_source.entry(source.clone()).or_default() += 1;
        if let Some((code, _)) = &fallback {
            *by_fallback.entry((*code).to_owned()).or_default() += 1;
        }
        total_usage.add(u.usage);
        for (state, n) in &u.runs {
            *all.runs.entry(state).or_default() += n;
        }
        all.accepted += u.accepted;
        all.rejected += u.rejected;
        all.questions_open += u.questions_open;
        all.questions_answered += u.questions_answered;
        items.push(GearMatchUsageItemDto {
            project_id: p.id.to_string(),
            project_name: p.name.clone(),
            workspace_id: p.workspace_id.to_string(),
            workspace_name: p.workspace_name.clone(),
            strategy,
            chosen,
            source,
            fallback: fallback.map(|(code, reason)| AssemblyFallbackDto {
                code: code.to_owned(),
                reason,
            }),
            last_run: u.last.as_ref().map(|l| GearMatchUsageLastRunDto {
                match_id: l.match_id.to_string(),
                state: l.state.clone(),
                created_at: rfc3339(l.created_at_ms),
                finished_at: l.finished_at_ms.map(rfc3339),
                totals: l.totals.as_ref().map(|t| GearMatchTotalsDto {
                    requirements: t.requirements,
                    covered: t.covered,
                    partial: t.partial,
                    gap: t.gap,
                    clarification_needed: t.clarification_needed,
                    not_assessed: t.not_assessed,
                }),
            }),
            runs: runs_dto(&u),
            usage: usage_dto(u.usage),
            accepted: u.accepted,
            rejected: u.rejected,
            questions_open: u.questions_open,
            questions_answered: u.questions_answered,
        });
    }
    items.sort_by(|a, b| {
        (
            a.workspace_name.to_lowercase(),
            a.project_name.to_lowercase(),
        )
            .cmp(&(
                b.workspace_name.to_lowercase(),
                b.project_name.to_lowercase(),
            ))
    });
    let to_u32 = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    let total = to_u32(items.len());
    let offset = page.offset.unwrap_or(0);
    let limit = page.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let projects_matched = to_u32(counted.values().filter(|u| u.last.is_some()).count());
    let strategy_order: Vec<&str> = assembly::Strategy::ALL
        .iter()
        .map(|s| s.as_str())
        .chain([assembly::MANUAL])
        .collect();
    let summary = GearMatchUsageSummaryDto {
        projects: total,
        projects_matched,
        strategies: counts(&by_strategy, &strategy_order),
        sources: counts(&by_source, &["project", "organization", "studio"]),
        fallbacks: counts(&by_fallback, &[]),
        runs: runs_dto(&all),
        usage: usage_dto(total_usage),
        accepted: all.accepted,
        rejected: all.rejected,
        questions_open: all.questions_open,
        questions_answered: all.questions_answered,
        median_run_ms: median,
    };
    let service = service_dto(matches.matcher.missing(), live);
    Ok(Json(GearMatchUsageDto {
        organization_id: org.to_string(),
        period_days: days,
        since: rfc3339(since),
        summary,
        service,
        items: items.into_iter().skip(offset).take(limit).collect(),
        total,
    }))
}

pub(super) fn register(router: Router, openapi: &dyn OpenApiRegistry) -> Router {
    OperationBuilder::get("/studio-product/v1/gear-match-usage")
        .operation_id("studio_product.list_gear_match_usage")
        .summary("How the organization's projects use the gears matcher")
        .description(
            "When to call: to see how much the organization relies on the gears matcher and \
             what it costs (Organization › Gears matcher). Per project of the organization the \
             caller reaches (`items`, a page; `total` all of them): the strategy its product is \
             assembled by, where that comes from and why it falls back; its last gear match \
             with that run's coverage; its runs in the last `period_days` (default 30, at most \
             365) by state, with the model calls and tokens the matcher reported; the gears \
             members accepted and rejected; the questions of its last finished match still \
             open. `summary` sums them, with the median time to a report. `service` says \
             whether the gears-matcher service answers now (its `/v1/info`: versions, \
             catalogue commit, limits), asked at most every 30 s. Reads only.",
        )
        .tag("StudioProduct")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(
            "period_days",
            false,
            "Days back from now, 1 to 365; 30 when absent",
        )
        .query_param("offset", false, "Projects to skip")
        .query_param(
            "limit",
            false,
            "Projects in the page, at most 200; 50 when absent",
        )
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(get_gear_match_usage)
        .json_response_with_schema::<GearMatchUsageDto>(openapi, StatusCode::OK, "The usage")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi)
}
