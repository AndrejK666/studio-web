//! How an organization uses the gears matcher (Organization › Gears matcher,
//! `GET /studio-product/v1/gear-match-usage`): per project its runs in a
//! period by state, the model calls and tokens the matcher reported, its last
//! run with that run's coverage, the members' decisions and the questions
//! still open; summed for the organization, with the median run duration.
//!
//! Counted in PostgreSQL from the gear's own tables (`store.rs`): one grouped
//! read of the matches, one `DISTINCT ON` read of each project's last match,
//! one of each project's last finished match (whose report holds its
//! questions), one grouped read of the decisions and the median by
//! `percentile_cont`. Only the questions are read in Rust, from the report,
//! the way the match view and the Inbox read them (`report::questions`).
//! PostgreSQL only (studio-backend/AGENTS.md).

use std::collections::{BTreeMap, BTreeSet};

use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, Condition, EntityTrait, FromQueryResult, Order, QueryOrder, QuerySelect,
};
use serde_json::Value;
use toolkit_db::secure::SecureEntityExt;
use toolkit_security::AccessScope;
use uuid::Uuid;

use super::report::{self, Totals};
use super::store::{self, MatchStore, matches, notes};

/// The state a match is counted under: `succeeded`, `partial`, `failed`,
/// `cancelled`, or `running` for every state that has not ended (`queued`,
/// `running`, `cancelling`).
pub fn counted_state(state: &str) -> &'static str {
    match state {
        store::SUCCEEDED => "succeeded",
        store::PARTIAL => "partial",
        store::FAILED => "failed",
        store::CANCELLED => "cancelled",
        _ => "running",
    }
}

/// What the matcher's `usage` says, summed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ModelUsage {
    pub calls: u64,
    pub cache_hits: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

impl ModelUsage {
    pub fn add(&mut self, o: ModelUsage) {
        self.calls += o.calls;
        self.cache_hits += o.cache_hits;
        self.input_tokens += o.input_tokens;
        self.output_tokens += o.output_tokens;
    }
}

/// A project's last match.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LastRun {
    pub match_id: Uuid,
    pub state: String,
    pub created_at_ms: i64,
    pub finished_at_ms: Option<i64>,
    pub totals: Option<Totals>,
}

/// One project's use of the matcher.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProjectUsage {
    /// Runs started in the period, by [`counted_state`].
    pub runs: BTreeMap<&'static str, u64>,
    /// The model use of the runs started in the period.
    pub usage: ModelUsage,
    pub last: Option<LastRun>,
    /// The members' decisions kept now, whenever taken.
    pub accepted: u64,
    pub rejected: u64,
    /// The questions of the last finished match, unanswered and answered.
    pub questions_open: u64,
    pub questions_answered: u64,
}

impl ProjectUsage {
    pub fn runs_total(&self) -> u64 {
        self.runs.values().sum()
    }
}

#[derive(Debug, FromQueryResult)]
struct RunGroup {
    project_id: Uuid,
    state: String,
    n: i64,
    calls: i64,
    cache_hits: i64,
    input_tokens: i64,
    output_tokens: i64,
}

#[derive(Debug, FromQueryResult)]
struct LastRow {
    project_id: Uuid,
    id: Uuid,
    state: String,
    created_at_ms: i64,
    finished_at_ms: Option<i64>,
    totals: Option<String>,
}

#[derive(Debug, FromQueryResult)]
struct ReportRow {
    project_id: Uuid,
    report: Option<String>,
}

#[derive(Debug, FromQueryResult)]
struct DecisionGroup {
    project_id: Uuid,
    value: String,
    n: i64,
}

#[derive(Debug, FromQueryResult)]
struct AnswerRow {
    project_id: Uuid,
    subject: String,
}

#[derive(Debug, FromQueryResult)]
struct Median {
    median_ms: Option<f64>,
}

/// One number of the `usage` JSON (kept as text), summed over a group; a
/// value that is absent, `null` or not a number counts nothing.
fn usage_sum(key: &str) -> Expr {
    Expr::cust(format!(
        "COALESCE(SUM(CASE WHEN jsonb_typeof(NULLIF(\"usage\", '')::jsonb -> '{key}') = 'number' \
         THEN (NULLIF(\"usage\", '')::jsonb ->> '{key}')::numeric END), 0)::bigint"
    ))
}

fn non_negative(n: i64) -> u64 {
    u64::try_from(n).unwrap_or(0)
}

impl MatchStore {
    /// The use of the matcher by `projects` of the organization `tenant`:
    /// runs and model use since `since_ms`, the last run whenever it was,
    /// the decisions kept and the open questions. A project without any
    /// match is absent from the answer.
    pub async fn usage(
        &self,
        tenant: Uuid,
        projects: &[Uuid],
        since_ms: i64,
    ) -> anyhow::Result<BTreeMap<Uuid, ProjectUsage>> {
        let mut out: BTreeMap<Uuid, ProjectUsage> = BTreeMap::new();
        if projects.is_empty() {
            return Ok(out);
        }
        let conn = self.db.conn()?;
        let scope = AccessScope::for_tenant(tenant);
        let in_projects =
            || Condition::all().add(matches::Column::ProjectId.is_in(projects.iter().copied()));

        let groups: Vec<RunGroup> = matches::Entity::find()
            .secure()
            .scope_with(&scope)
            .filter(in_projects().add(matches::Column::CreatedAtMs.gte(since_ms)))
            .project_all(&conn, |s| {
                s.select_only()
                    .column(matches::Column::ProjectId)
                    .column(matches::Column::State)
                    .column_as(Expr::cust("COUNT(*)"), "n")
                    .column_as(usage_sum("calls"), "calls")
                    .column_as(usage_sum("cache_hits"), "cache_hits")
                    .column_as(usage_sum("input_tokens"), "input_tokens")
                    .column_as(usage_sum("output_tokens"), "output_tokens")
                    .group_by(matches::Column::ProjectId)
                    .group_by(matches::Column::State)
                    .into_model::<RunGroup>()
            })
            .await?;
        for g in groups {
            let p = out.entry(g.project_id).or_default();
            *p.runs.entry(counted_state(&g.state)).or_default() += non_negative(g.n);
            p.usage.add(ModelUsage {
                calls: non_negative(g.calls),
                cache_hits: non_negative(g.cache_hits),
                input_tokens: non_negative(g.input_tokens),
                output_tokens: non_negative(g.output_tokens),
            });
        }

        // Each project's last match, whenever it ran.
        let last: Vec<LastRow> = matches::Entity::find()
            .secure()
            .scope_with(&scope)
            .filter(in_projects())
            .project_all(&conn, |s| {
                s.select_only()
                    .distinct_on([matches::Column::ProjectId])
                    .column(matches::Column::ProjectId)
                    .column(matches::Column::Id)
                    .column(matches::Column::State)
                    .column(matches::Column::CreatedAtMs)
                    .column(matches::Column::FinishedAtMs)
                    .column(matches::Column::Totals)
                    .order_by(matches::Column::ProjectId, Order::Asc)
                    .order_by(matches::Column::CreatedAtMs, Order::Desc)
                    .into_model::<LastRow>()
            })
            .await?;
        for r in last {
            out.entry(r.project_id).or_default().last = Some(LastRun {
                match_id: r.id,
                state: r.state,
                created_at_ms: r.created_at_ms,
                finished_at_ms: r.finished_at_ms,
                totals: r
                    .totals
                    .as_deref()
                    .and_then(|t| serde_json::from_str(t).ok()),
            });
        }

        // The questions of each project's last finished match (the Inbox's).
        let reports: Vec<ReportRow> = matches::Entity::find()
            .secure()
            .scope_with(&scope)
            .filter(
                in_projects().add(matches::Column::State.is_in([store::SUCCEEDED, store::PARTIAL])),
            )
            .project_all(&conn, |s| {
                s.select_only()
                    .distinct_on([matches::Column::ProjectId])
                    .column(matches::Column::ProjectId)
                    .column(matches::Column::Report)
                    .order_by(matches::Column::ProjectId, Order::Asc)
                    .order_by(matches::Column::CreatedAtMs, Order::Desc)
                    .into_model::<ReportRow>()
            })
            .await?;
        let answers: Vec<AnswerRow> = notes::Entity::find()
            .secure()
            .scope_with(&scope)
            .filter(
                Condition::all()
                    .add(notes::Column::ProjectId.is_in(projects.iter().copied()))
                    .add(notes::Column::Kind.eq(store::NOTE_ANSWER)),
            )
            .project_all(&conn, |s| {
                s.select_only()
                    .column(notes::Column::ProjectId)
                    .column(notes::Column::Subject)
                    .into_model::<AnswerRow>()
            })
            .await?;
        let mut answered: BTreeMap<Uuid, BTreeSet<String>> = BTreeMap::new();
        for a in answers {
            answered.entry(a.project_id).or_default().insert(a.subject);
        }
        for r in reports {
            let ids = question_ids(r.report.as_deref());
            let given = answered.get(&r.project_id);
            let p = out.entry(r.project_id).or_default();
            for id in ids {
                if given.is_some_and(|g| g.contains(&id)) {
                    p.questions_answered += 1;
                } else {
                    p.questions_open += 1;
                }
            }
        }

        let decisions: Vec<DecisionGroup> = notes::Entity::find()
            .secure()
            .scope_with(&scope)
            .filter(
                Condition::all()
                    .add(notes::Column::ProjectId.is_in(projects.iter().copied()))
                    .add(notes::Column::Kind.eq(store::NOTE_DECISION)),
            )
            .project_all(&conn, |s| {
                s.select_only()
                    .column(notes::Column::ProjectId)
                    .column(notes::Column::Value)
                    .column_as(Expr::cust("COUNT(*)"), "n")
                    .group_by(notes::Column::ProjectId)
                    .group_by(notes::Column::Value)
                    .into_model::<DecisionGroup>()
            })
            .await?;
        for d in decisions {
            let p = out.entry(d.project_id).or_default();
            match d.value.as_str() {
                "accepted" => p.accepted += non_negative(d.n),
                "rejected" => p.rejected += non_negative(d.n),
                _ => {}
            }
        }
        Ok(out)
    }

    /// The median time from asking to a written report, over the matches of
    /// `projects` that finished with one (`succeeded`, `partial`) since
    /// `since_ms`, in milliseconds; `None` when there is none.
    pub async fn median_run_ms(
        &self,
        tenant: Uuid,
        projects: &[Uuid],
        since_ms: i64,
    ) -> anyhow::Result<Option<u64>> {
        if projects.is_empty() {
            return Ok(None);
        }
        let conn = self.db.conn()?;
        let rows: Vec<Median> = matches::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(tenant))
            .filter(
                Condition::all()
                    .add(matches::Column::ProjectId.is_in(projects.iter().copied()))
                    .add(matches::Column::CreatedAtMs.gte(since_ms))
                    .add(matches::Column::State.is_in([store::SUCCEEDED, store::PARTIAL]))
                    .add(matches::Column::FinishedAtMs.is_not_null()),
            )
            .project_all(&conn, |s| {
                s.select_only()
                    .column_as(
                        Expr::cust(
                            "percentile_cont(0.5) WITHIN GROUP \
                             (ORDER BY finished_at_ms - created_at_ms)::float8",
                        ),
                        "median_ms",
                    )
                    .into_model::<Median>()
            })
            .await?;
        Ok(rows
            .into_iter()
            .next()
            .and_then(|r| r.median_ms)
            .filter(|m| m.is_finite() && *m >= 0.0)
            .map(|m| m.round() as u64))
    }
}

/// The ids of the questions a report asks, as the match view lists them.
pub fn question_ids(report: Option<&str>) -> Vec<String> {
    let Some(r) = report.and_then(|r| serde_json::from_str::<Value>(r).ok()) else {
        return Vec::new();
    };
    if !report::readable(&r) {
        return Vec::new();
    }
    let reqs = report::requirements(&r, &[]);
    report::questions(&r, &reqs, |_| None)
        .into_iter()
        .map(|q| q.id)
        .collect()
}

#[cfg(test)]
#[path = "usage_tests.rs"]
mod tests;
