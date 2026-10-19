//! Who may, in which order: an organization's price list and its costs.
//!
//! **Prices** are one account-management metadata row on the organization
//! (`super::PRICES_METADATA_TYPE`). Anybody who reaches the organization may
//! read it; only its administrators — or whoever holds `cost.manage` — change
//! it, and the write is this gear's, as the service: the PDP refuses
//! anybody else's write of the row (`studio_authz_plugin::GEAR_HELD_METADATA`).
//!
//! **Costs** are read from the usage collector one tenant at a time: the
//! organization and every workspace and project in it. The collector's query
//! is scoped by the PDP to the tenant it is asked in, and the Studio PDP does
//! not expand a tenant into its subtree for it, so asking once as the
//! organization would see only the organization's own records. Each tenant is
//! asked with the caller acting in it, after the caller has been shown to
//! administer the organization (`cost.view`).
//!
//! **Budgets** are a second metadata row on the organization
//! (`super::BUDGETS_METADATA_TYPE`), read by `cost.view` and written by
//! `cost.manage` the same way as the price list. Their standing is this
//! month's costs by project, summed per budget (`super::budgets`).

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use account_management_sdk::{AccountManagementClient, UpsertMetadataRequest};
use anyhow::anyhow;
use bigdecimal::ToPrimitive;
use futures_util::{StreamExt, stream};
use gts::GtsTypeId;
use time::OffsetDateTime;
use toolkit::client_hub::{ClientHub, ClientScope};
use toolkit_canonical_errors::CanonicalError;
use toolkit_odata::ODataQuery;
use toolkit_odata::ast::{CompareOperator, Expr, Value};
use toolkit_security::SecurityContext;
use usage_collector_sdk::{
    AggregationDimension, AggregationOp, AggregationSpec, MetadataKey, UsageCollectorClientV1,
    UsageCollectorError,
};
use uuid::Uuid;

use super::budgets::{self, Budgets, Standing};
use super::costs::{self, Fact, FactKind, GroupBy, Report};
use super::port::Payer;
use super::prices::PriceList;
use super::types;
use super::{BUDGETS_METADATA_TYPE, PRICES_METADATA_TYPE};

/// Reads an organization's costs.
pub const VIEW_PRIVILEGE: &str = "cost.view";
/// Changes its price list.
pub const MANAGE_PRIVILEGE: &str = "cost.manage";

/// How many tenants are asked at once.
const PARALLEL_TENANTS: usize = 8;
/// The longest period one report covers.
const LONGEST_PERIOD_DAYS: i64 = 366;

/// The subject this gear writes the price list as. Fixed, so an audit of
/// account-management says which gear changed the row.
const SERVICE_SUBJECT_ID: Uuid = Uuid::from_u128(0x5e7d_05a9_e000_4c57_8f03_c057_5000_0781);

#[derive(Debug)]
pub enum Refusal {
    Forbidden(&'static str),
    Invalid(String),
    Unavailable(String),
    Internal(String),
}

type Result<T> = std::result::Result<T, Refusal>;

/// A tenant of the organization, and how a person recognizes it.
#[derive(Clone, Debug, PartialEq)]
pub struct Place {
    pub id: Uuid,
    pub label: String,
    /// A project's workspace; `None` for a workspace and the organization.
    pub workspace: Option<Uuid>,
}

/// This month's standing against each budget.
pub struct BudgetStatus {
    pub currency: String,
    pub warn_at_percent: u8,
    pub month: (OffsetDateTime, OffsetDateTime),
    pub as_of: OffsetDateTime,
    pub standings: Vec<Standing>,
    /// What had no price this month: the spend above leaves it out.
    pub unpriced: Vec<String>,
    pub places: Vec<Place>,
}

/// A report and what its tenant keys are called.
pub struct Costs {
    pub report: Report,
    pub currency: String,
    pub places: Vec<Place>,
}

pub struct UsageService {
    am: Arc<dyn AccountManagementClient>,
    hub: Arc<ClientHub>,
}

impl UsageService {
    pub fn new(am: Arc<dyn AccountManagementClient>, hub: Arc<ClientHub>) -> Self {
        Self { am, hub }
    }

    /// May the caller do what `privilege` names in `org`? An organization
    /// administrator, a platform administrator, or a holder of the privilege.
    pub async fn may(&self, ctx: &SecurityContext, org: Uuid, privilege: &str) -> bool {
        match self
            .hub
            .get_scoped::<dyn crate::user_profile::OrgAuthority>(&ClientScope::gts_id(
                crate::user_profile::IDENTITY_INSTANCE_ID,
            )) {
            Ok(authority) => authority.may_administer(ctx, org, privilege).await,
            // Without studio-user nobody can be shown to hold it.
            Err(_) => false,
        }
    }

    /// One of this gear's metadata rows on the organization, and its version;
    /// the default and version 0 when it was never written.
    async fn row<T: serde::de::DeserializeOwned + Default>(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        type_id: &str,
        what: &str,
    ) -> Result<(T, i64)> {
        match self
            .am
            .get_metadata(ctx, org, GtsTypeId::new(type_id))
            .await
        {
            Ok(entry) => Ok((
                serde_json::from_value(entry.value).map_err(|e| {
                    Refusal::Internal(format!("the stored {what} is unreadable: {e}"))
                })?,
                entry.version,
            )),
            Err(CanonicalError::NotFound { .. }) => Ok((T::default(), 0)),
            Err(e) => Err(Refusal::Unavailable(format!(
                "the {what} cannot be read: {e}"
            ))),
        }
    }

    /// Replace one of this gear's rows, as the service, over `version`.
    async fn write_row<T: serde::Serialize>(
        &self,
        org: Uuid,
        type_id: &str,
        what: &str,
        value: &T,
        version: i64,
    ) -> Result<()> {
        let service = SecurityContext::builder()
            .subject_id(SERVICE_SUBJECT_ID)
            .subject_type("service")
            .subject_tenant_id(org)
            .token_scopes(vec!["*".to_owned()])
            .build()
            .map_err(|e| Refusal::Internal(format!("cannot build a service context: {e}")))?;
        let value = serde_json::to_value(value).map_err(|e| Refusal::Internal(e.to_string()))?;
        let mut request = UpsertMetadataRequest::new(GtsTypeId::new(type_id), value);
        if version > 0 {
            request = request.with_expected_version(version);
        }
        self.am
            .upsert_metadata(&service, org, request)
            .await
            .map_err(|e| Refusal::Unavailable(format!("the {what} cannot be written: {e}")))?;
        Ok(())
    }

    pub async fn prices(&self, ctx: &SecurityContext, org: Uuid) -> Result<(PriceList, i64)> {
        self.row(ctx, org, PRICES_METADATA_TYPE, "price list").await
    }

    /// Replace the organization's price list.
    pub async fn put_prices(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        list: PriceList,
    ) -> Result<PriceList> {
        if !self.may(ctx, org, MANAGE_PRIVILEGE).await {
            return Err(Refusal::Forbidden("COST_ADMIN_REQUIRED"));
        }
        list.validate().map_err(|e| Refusal::Invalid(e.0))?;
        let (_, version) = self.prices(ctx, org).await?;
        self.write_row(org, PRICES_METADATA_TYPE, "price list", &list, version)
            .await?;
        Ok(list)
    }

    /// The organization's budgets and the places one can be set on
    /// (`cost.view`).
    pub async fn budgets(&self, ctx: &SecurityContext, org: Uuid) -> Result<(Budgets, Vec<Place>)> {
        if !self.may(ctx, org, VIEW_PRIVILEGE).await {
            return Err(Refusal::Forbidden("COST_ADMIN_REQUIRED"));
        }
        let (list, _) = self.row(ctx, org, BUDGETS_METADATA_TYPE, "budgets").await?;
        Ok((list, self.places(ctx, org).await?))
    }

    /// Replace the organization's budgets (`cost.manage`). A budget names the
    /// organization, or one of its workspaces or projects.
    pub async fn put_budgets(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        mut list: Budgets,
    ) -> Result<(Budgets, Vec<Place>)> {
        if !self.may(ctx, org, MANAGE_PRIVILEGE).await {
            return Err(Refusal::Forbidden("COST_ADMIN_REQUIRED"));
        }
        for b in &mut list.items {
            if b.tenant_id == Some(org) {
                b.tenant_id = None;
            }
        }
        list.validate().map_err(|e| Refusal::Invalid(e.0))?;
        let places = self.places(ctx, org).await?;
        if let Some(stranger) = list
            .items
            .iter()
            .filter_map(|b| b.tenant_id)
            .find(|id| !places.iter().any(|p| p.id == *id))
        {
            return Err(Refusal::Invalid(format!(
                "{stranger} is not a workspace or project of this organization"
            )));
        }
        let (_, version) = self
            .row::<Budgets>(ctx, org, BUDGETS_METADATA_TYPE, "budgets")
            .await?;
        self.write_row(org, BUDGETS_METADATA_TYPE, "budgets", &list, version)
            .await?;
        Ok((list, places))
    }

    /// Where this month's spend stands against each budget (`cost.view`).
    /// Without a budget nothing is read from the collector.
    pub async fn budget_status(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        include_personal: bool,
        now: OffsetDateTime,
    ) -> Result<BudgetStatus> {
        if !self.may(ctx, org, VIEW_PRIVILEGE).await {
            return Err(Refusal::Forbidden("COST_ADMIN_REQUIRED"));
        }
        let (list, _) = self
            .row::<Budgets>(ctx, org, BUDGETS_METADATA_TYPE, "budgets")
            .await?;
        let month = budgets::month_of(now);
        let warn_at_percent = list.warn_at_percent();
        if list.items.is_empty() {
            let (prices, _) = self.prices(ctx, org).await?;
            return Ok(BudgetStatus {
                currency: prices.currency().to_owned(),
                warn_at_percent,
                month,
                as_of: now,
                standings: Vec::new(),
                unpriced: Vec::new(),
                places: Vec::new(),
            });
        }
        let costs = self
            .costs(
                ctx,
                org,
                month.0,
                month.1,
                GroupBy::Project,
                include_personal,
            )
            .await?;
        let spent: HashMap<Uuid, f64> = costs
            .report
            .rows
            .iter()
            .filter_map(|r| Some((r.key.parse().ok()?, r.cost)))
            .collect();
        let projects: Vec<(Uuid, Uuid)> = costs
            .places
            .iter()
            .filter_map(|p| Some((p.id, p.workspace?)))
            .collect();
        let tree = budgets::Tree {
            org,
            projects: &projects,
        };
        Ok(BudgetStatus {
            standings: budgets::standings(&list, &spent, costs.report.total, &tree, month, now),
            currency: costs.currency,
            warn_at_percent,
            month,
            as_of: now,
            unpriced: costs.report.unpriced,
            places: costs.places,
        })
    }

    /// The organization's costs from `from` up to (not including) `to`.
    pub async fn costs(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        from: OffsetDateTime,
        to: OffsetDateTime,
        group: GroupBy,
        include_personal: bool,
    ) -> Result<Costs> {
        if !self.may(ctx, org, VIEW_PRIVILEGE).await {
            return Err(Refusal::Forbidden("COST_ADMIN_REQUIRED"));
        }
        if to <= from || (to - from).whole_days() > LONGEST_PERIOD_DAYS {
            return Err(Refusal::Invalid(format!(
                "a period runs forwards and covers at most {LONGEST_PERIOD_DAYS} days"
            )));
        }
        let (prices, _) = self.prices(ctx, org).await?;
        let collector = self
            .hub
            .get::<dyn UsageCollectorClientV1>()
            .map_err(|_| Refusal::Unavailable("usage is not recorded in this deployment".into()))?;
        let places = self.places(ctx, org).await?;

        let lookups = places.clone().into_iter().map(|place| {
            let collector = Arc::clone(&collector);
            async move {
                let acting = crate::org_scope::acting_in(ctx, place.id)
                    .map_err(|e| Refusal::Internal(format!("cannot act in {}: {e}", place.id)))?;
                facts_of(collector.as_ref(), &acting, place.id, from, to)
                    .await
                    .map_err(|e| {
                        Refusal::Unavailable(format!(
                            "usage of {} cannot be read: {e}",
                            place.label
                        ))
                    })
            }
        });
        let mut facts = Vec::new();
        {
            let mut answers = stream::iter(lookups).buffer_unordered(PARALLEL_TENANTS);
            while let Some(answer) = answers.next().await {
                facts.extend(answer?);
            }
        }
        Ok(Costs {
            report: costs::report(&facts, &prices, group, include_personal),
            currency: prices.currency().to_owned(),
            places,
        })
    }

    /// The organization, its workspaces and its projects.
    async fn places(&self, ctx: &SecurityContext, org: Uuid) -> Result<Vec<Place>> {
        let name = self
            .am
            .get_tenant(ctx, org)
            .await
            .map(|t| t.name)
            .unwrap_or_default();
        let mut places = vec![Place {
            id: org,
            label: name,
            workspace: None,
        }];
        let projects = self
            .hub
            .get::<dyn crate::organizations::port::ProjectsOf>()
            .map_err(|_| Refusal::Unavailable("the organization's tree cannot be read".into()))?
            .projects_of(ctx, org)
            .await
            .map_err(|e| {
                Refusal::Unavailable(format!("the organization's tree cannot be read: {e:#}"))
            })?;
        for p in projects {
            if !places.iter().any(|place| place.id == p.workspace_id) {
                places.push(Place {
                    id: p.workspace_id,
                    label: p.workspace_name.clone(),
                    workspace: None,
                });
            }
            places.push(Place {
                id: p.id,
                label: format!("{} / {}", p.workspace_name, p.name),
                workspace: Some(p.workspace_id),
            });
        }
        Ok(places)
    }
}

fn period_filter(from: OffsetDateTime, to: OffsetDateTime) -> anyhow::Result<ODataQuery> {
    let at = |t: OffsetDateTime| -> anyhow::Result<Expr> {
        let utc =
            chrono::DateTime::<chrono::Utc>::from_timestamp(t.unix_timestamp(), t.nanosecond())
                .ok_or_else(|| anyhow!("{t} is not a time"))?;
        Ok(Expr::Value(Value::DateTime(utc)))
    };
    let created = || Box::new(Expr::Identifier("created_at".to_owned()));
    let since = Expr::Compare(created(), CompareOperator::Ge, Box::new(at(from)?));
    let before = Expr::Compare(created(), CompareOperator::Lt, Box::new(at(to)?));
    Ok(ODataQuery::new().with_filter(since.and(before)))
}

fn whole(v: Option<&bigdecimal::BigDecimal>) -> u64 {
    v.and_then(ToPrimitive::to_u64).unwrap_or(0)
}

/// Sums of one usage type in one tenant, grouped by `dims`: each bucket's key
/// and value. A type nothing was ever recorded under is no usage.
async fn sums(
    collector: &dyn UsageCollectorClientV1,
    ctx: &SecurityContext,
    name: &str,
    query: &ODataQuery,
    dims: &[AggregationDimension],
) -> anyhow::Result<Vec<(Vec<String>, u64)>> {
    let spec = AggregationSpec {
        op: AggregationOp::Sum,
        group_by: dims.to_vec(),
    };
    match collector
        .query_aggregated_usage_records(ctx, types::gts_id(name)?, query, &[], spec)
        .await
    {
        Ok(result) => Ok(result
            .buckets
            .into_iter()
            .map(|b| (b.key, whole(b.value.as_ref())))
            .collect()),
        Err(UsageCollectorError::NotFound { .. }) => Ok(Vec::new()),
        Err(e) => Err(anyhow!("{e}")),
    }
}

fn payer(s: &str) -> Option<Payer> {
    match s {
        "personal" => Some(Payer::Personal),
        "workspace" => Some(Payer::Workspace),
        "organization" => Some(Payer::Organization),
        _ => None,
    }
}

/// Everything recorded in `tenant` over the period, as facts.
async fn facts_of(
    collector: &dyn UsageCollectorClientV1,
    ctx: &SecurityContext,
    tenant: Uuid,
    from: OffsetDateTime,
    to: OffsetDateTime,
) -> anyhow::Result<Vec<Fact>> {
    let query = period_filter(from, to)?;
    let meta = |k: &str| -> anyhow::Result<AggregationDimension> {
        Ok(AggregationDimension::Metadata(MetadataKey::new(k)?))
    };

    let llm_dims = [
        AggregationDimension::SubjectId,
        meta("provider")?,
        meta("model")?,
        meta("payer")?,
    ];
    let mut calls: BTreeMap<Vec<String>, Fact> = BTreeMap::new();
    for name in [
        types::LLM_INPUT,
        types::LLM_OUTPUT,
        types::LLM_CACHE_READ,
        types::LLM_CACHE_WRITE,
    ] {
        for (key, value) in sums(collector, ctx, name, &query, &llm_dims).await? {
            let fact = calls.entry(key.clone()).or_insert_with(|| Fact {
                tenant,
                person: key.first().and_then(|s| s.parse().ok()),
                kind: FactKind::Llm,
                provider: key.get(1).cloned().unwrap_or_default(),
                item: key.get(2).cloned().unwrap_or_default(),
                payer: key.get(3).and_then(|s| payer(s)),
                ..Fact::default()
            });
            match name {
                types::LLM_INPUT => fact.tokens.input += value,
                types::LLM_OUTPUT => fact.tokens.output += value,
                types::LLM_CACHE_READ => fact.tokens.cache_read += value,
                _ => fact.tokens.cache_write += value,
            }
        }
    }

    let session_dims = [meta("driver")?, meta("payer")?];
    let mut sessions: HashMap<Vec<String>, Fact> = HashMap::new();
    for name in [
        types::SESSION_SECONDS,
        types::SESSION_CPU,
        types::SESSION_MEMORY,
    ] {
        for (key, value) in sums(collector, ctx, name, &query, &session_dims).await? {
            let fact = sessions.entry(key.clone()).or_insert_with(|| Fact {
                tenant,
                kind: FactKind::Session,
                provider: key.first().cloned().unwrap_or_default(),
                item: super::port::SESSION_ITEM.to_owned(),
                payer: key.get(1).and_then(|s| payer(s)),
                ..Fact::default()
            });
            match name {
                types::SESSION_SECONDS => fact.session_seconds += value,
                types::SESSION_CPU => fact.cpu_millicore_seconds += value,
                _ => fact.memory_mib_seconds += value,
            }
        }
    }
    Ok(calls.into_values().chain(sessions.into_values()).collect())
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use async_trait::async_trait;
    use bigdecimal::BigDecimal;
    use time::macros::datetime;
    use toolkit_odata::Page;
    use usage_collector_sdk::{
        AggregationBucket, AggregationResult, CreateUsageRecord, MetadataFilter, UsageRecord,
        UsageType, UsageTypeGtsId,
    };

    use super::*;
    use crate::usage::prices::{ModelPrice, SessionPrice};

    const WS: Uuid = Uuid::from_u128(0xD2);
    const ADA: Uuid = Uuid::from_u128(0xADA);

    /// A collector that answers each usage type's sum with canned buckets, and
    /// a type nobody recorded under with `NotFound`, as the real one does.
    struct Sums(Vec<(&'static str, Vec<String>, u64)>);

    #[async_trait]
    impl UsageCollectorClientV1 for Sums {
        async fn create_usage_record(
            &self,
            _: &SecurityContext,
            _: CreateUsageRecord,
        ) -> std::result::Result<UsageRecord, UsageCollectorError> {
            unimplemented!()
        }
        async fn create_usage_records(
            &self,
            _: &SecurityContext,
            _: Vec<CreateUsageRecord>,
        ) -> std::result::Result<
            Vec<std::result::Result<UsageRecord, UsageCollectorError>>,
            UsageCollectorError,
        > {
            unimplemented!()
        }
        async fn get_usage_record(
            &self,
            _: &SecurityContext,
            _: Uuid,
        ) -> std::result::Result<UsageRecord, UsageCollectorError> {
            unimplemented!()
        }
        async fn query_aggregated_usage_records(
            &self,
            _: &SecurityContext,
            gts_id: UsageTypeGtsId,
            _: &ODataQuery,
            _: &[MetadataFilter],
            spec: AggregationSpec,
        ) -> std::result::Result<AggregationResult, UsageCollectorError> {
            assert_eq!(spec.op, AggregationOp::Sum);
            let buckets: Vec<AggregationBucket> = self
                .0
                .iter()
                .filter(|(name, _, _)| types::gts_id(name).unwrap() == gts_id)
                .map(|(_, key, value)| {
                    assert_eq!(key.len(), spec.group_by.len());
                    AggregationBucket {
                        key: key.clone(),
                        value: Some(BigDecimal::from_str(&value.to_string()).unwrap()),
                    }
                })
                .collect();
            if buckets.is_empty() {
                return Err(UsageCollectorError::usage_type_not_found(&gts_id));
            }
            Ok(AggregationResult { buckets })
        }
        async fn list_usage_records(
            &self,
            _: &SecurityContext,
            _: UsageTypeGtsId,
            _: &ODataQuery,
            _: &[MetadataFilter],
        ) -> std::result::Result<Page<UsageRecord>, UsageCollectorError> {
            unimplemented!()
        }
        async fn deactivate_usage_record(
            &self,
            _: &SecurityContext,
            _: Uuid,
        ) -> std::result::Result<(), UsageCollectorError> {
            unimplemented!()
        }
        async fn create_usage_type(
            &self,
            _: &SecurityContext,
            _: UsageType,
        ) -> std::result::Result<UsageType, UsageCollectorError> {
            unimplemented!()
        }
        async fn get_usage_type(
            &self,
            _: &SecurityContext,
            _: UsageTypeGtsId,
        ) -> std::result::Result<UsageType, UsageCollectorError> {
            unimplemented!()
        }
        async fn list_usage_types(
            &self,
            _: &SecurityContext,
            _: &ODataQuery,
        ) -> std::result::Result<Page<UsageType>, UsageCollectorError> {
            unimplemented!()
        }
        async fn delete_usage_type(
            &self,
            _: &SecurityContext,
            _: UsageTypeGtsId,
        ) -> std::result::Result<(), UsageCollectorError> {
            unimplemented!()
        }
    }

    fn key(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| (*s).to_owned()).collect()
    }

    /// The four token sums of one call land on one fact, the three session
    /// sums on another, each keyed as the collector grouped them; a type
    /// nothing was recorded under (cache writes here) is no usage, not an
    /// error. Priced, the personal-key switch moves the total.
    #[tokio::test]
    async fn the_collector_sums_become_one_fact_per_slice_and_price_into_a_report() {
        let ada = ADA.to_string();
        let org_call = key(&[&ada, "anthropic", "claude-sonnet-5-5", "organization"]);
        let own_call = key(&[&ada, "anthropic", "claude-sonnet-5-5", "personal"]);
        let pod = key(&["kubernetes", "workspace"]);
        let collector = Sums(vec![
            (types::LLM_INPUT, org_call.clone(), 1_000_000),
            (types::LLM_OUTPUT, org_call.clone(), 100_000),
            (types::LLM_CACHE_READ, org_call, 10),
            (types::LLM_INPUT, own_call, 2_000_000),
            (types::SESSION_SECONDS, pod.clone(), 3600),
            (types::SESSION_CPU, pod.clone(), 500 * 3600),
            (types::SESSION_MEMORY, pod, 1024 * 3600),
        ]);
        let ctx = SecurityContext::builder()
            .subject_id(ADA)
            .subject_tenant_id(WS)
            .build()
            .unwrap();
        let mut facts = facts_of(
            &collector,
            &ctx,
            WS,
            datetime!(2026-10-01 0:00 UTC),
            datetime!(2026-11-01 0:00 UTC),
        )
        .await
        .unwrap();
        facts.sort_by_key(|f| (f.kind == FactKind::Session, f.payer.map(Payer::as_str)));
        assert_eq!(facts.len(), 3, "{facts:#?}");

        let org = &facts[0];
        assert_eq!(org.payer, Some(Payer::Organization));
        assert_eq!((org.person, org.tenant), (Some(ADA), WS));
        assert_eq!(
            (org.provider.as_str(), org.item.as_str()),
            ("anthropic", "claude-sonnet-5-5")
        );
        assert_eq!(
            (
                org.tokens.input,
                org.tokens.output,
                org.tokens.cache_read,
                org.tokens.cache_write
            ),
            (1_000_000, 100_000, 10, 0)
        );
        assert_eq!(facts[1].payer, Some(Payer::Personal));
        assert_eq!(facts[1].tokens.input, 2_000_000);

        let session = &facts[2];
        assert_eq!(session.kind, FactKind::Session);
        assert_eq!(session.person, None);
        assert_eq!(session.item, crate::usage::port::SESSION_ITEM);
        assert_eq!(
            (
                session.session_seconds,
                session.cpu_millicore_seconds,
                session.memory_mib_seconds
            ),
            (3600, 500 * 3600, 1024 * 3600)
        );

        let prices = PriceList {
            models: vec![ModelPrice {
                provider: "anthropic".into(),
                model: "claude-sonnet-5-5*".into(),
                input_per_mtok: 3.0,
                output_per_mtok: 15.0,
                ..ModelPrice::default()
            }],
            session: Some(SessionPrice {
                cpu_core_hour: 0.04,
                memory_gib_hour: 0.01,
            }),
            ..PriceList::default()
        };
        // 3.00 + 1.50 for the organization's call, 0.02 + 0.01 for the hour
        // of a 500m / 1Gi pod, 6.00 more on Ada's own key.
        let with = costs::report(&facts, &prices, GroupBy::Payer, true);
        let without = costs::report(&facts, &prices, GroupBy::Payer, false);
        assert!((without.total - 4.53).abs() < 1e-9, "{}", without.total);
        assert!((with.total - 10.53).abs() < 1e-9, "{}", with.total);
        assert_eq!(with.rows[0].key, "personal");
        assert!(with.unpriced.is_empty());
    }

    #[test]
    fn a_payer_is_read_back_as_it_was_written() {
        for p in [Payer::Personal, Payer::Workspace, Payer::Organization] {
            assert_eq!(payer(p.as_str()), Some(p));
        }
        assert_eq!(payer(""), None);
    }

    #[test]
    fn a_period_is_two_bounds_on_created_at() {
        let q = period_filter(
            datetime!(2026-10-01 0:00 UTC),
            datetime!(2026-11-01 0:00 UTC),
        )
        .unwrap();
        let text = format!("{:?}", q.filter().unwrap());
        assert!(
            text.contains("created_at") && text.contains("Ge") && text.contains("Lt"),
            "{text}"
        );
        assert!(
            text.contains("2026-10-01") && text.contains("2026-11-01"),
            "{text}"
        );
    }
}
