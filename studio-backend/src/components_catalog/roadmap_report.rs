//! The roadmap report: every catalogued component the roadmap board plans,
//! one row each, and the summary a planning meeting reads first.
//!
//! It is what the platform team's `back_roadmap` spreadsheet answered --
//! stage, date, commitment, progress, who needs it, whether the plan holds --
//! built from the catalogue instead of a script over the board, so it carries
//! the repository's side too (lifecycle, last release, grade). The server
//! assembles it; a client renders it or writes it to a workbook (the Roadmap
//! and Summary sheets). Pure: the handler hands in the resolved values.

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use super::reference::{ReferenceReadinessDto, readiness_of};

/// One component on the board.
#[derive(Debug, Clone, PartialEq, Eq)]
#[toolkit_macros::api_dto(response)]
pub struct RoadmapRowDto {
    /// The catalogue name (`cf-gears-event-broker`).
    pub name: String,
    pub category: Option<String>,
    /// Stage, milestone, commitment, plan, demand, progress, lifecycle, last
    /// release, grade -- the same block the components reference carries.
    pub readiness: ReferenceReadinessDto,
    /// The board item's assignees (`@a, @b`).
    pub assignees: Option<String>,
    /// The board's effort estimate, as written.
    pub effort: Option<String>,
    /// The board item's title (`#2890 CORE - Events Broker`).
    pub roadmap_title: Option<String>,
}

/// A label and how many rows carry it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[toolkit_macros::api_dto(response)]
pub struct RoadmapCountDto {
    pub label: String,
    pub count: u32,
}

/// One milestone: how much is due in it, how much of that is committed, and
/// how much is at risk.
#[derive(Debug, Clone, PartialEq, Eq)]
#[toolkit_macros::api_dto(response)]
pub struct RoadmapMilestoneDto {
    pub milestone: String,
    /// `YYYY-MM-DD`; null for an undated milestone such as `Backlog`.
    pub due: Option<String>,
    pub total: u32,
    pub committed: u32,
    pub at_risk: u32,
}

/// One consumer: what it asked for, by priority, and how much of its P1
/// demand the plan does not meet.
#[derive(Debug, Clone, PartialEq, Eq)]
#[toolkit_macros::api_dto(response)]
pub struct RoadmapConsumerDto {
    pub consumer: String,
    pub p1: u32,
    pub p2: u32,
    pub p3: u32,
    /// P1 rows whose plan is `at risk` or `check`.
    pub p1_not_on_track: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[toolkit_macros::api_dto(response)]
pub struct RoadmapSummaryDto {
    /// In pipeline order (`Todo` … `In Prod`).
    pub by_stage: Vec<RoadmapCountDto>,
    /// Dated milestones by due date, then undated ones.
    pub by_milestone: Vec<RoadmapMilestoneDto>,
    pub by_consumer: Vec<RoadmapConsumerDto>,
    /// `on track`, `check`, `at risk`, `delivered`, `unplanned`.
    pub by_plan: Vec<RoadmapCountDto>,
    /// Names of the rows whose milestone passed before their last stage.
    pub overdue: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[toolkit_macros::api_dto(response)]
pub struct RoadmapReportDto {
    /// Components the board plans, soonest due first.
    pub items: Vec<RoadmapRowDto>,
    pub total: u32,
    /// Catalogued components with no board item -- unplanned, or not matched;
    /// a person pins those through the component's `roadmap_item` field.
    pub not_on_board: u32,
    pub summary: RoadmapSummaryDto,
}

/// One component's resolved values, with its name and category.
pub struct ComponentValues<'a> {
    pub name: &'a str,
    pub category: &'a str,
    pub values: &'a Map<String, Value>,
}

fn brief(values: &Map<String, Value>, key: &str) -> Option<String> {
    values
        .get(key)
        .filter(|v| !v.is_null())
        .and_then(|v| v.get("b").or_else(|| v.get("v")))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// Assemble the report.
pub fn build(components: &[ComponentValues<'_>]) -> RoadmapReportDto {
    let mut items: Vec<RoadmapRowDto> = Vec::new();
    let mut not_on_board = 0usize;
    for c in components {
        let on_board = c.values.get("roadmap_item").is_some_and(|v| !v.is_null());
        let readiness = on_board.then(|| readiness_of(c.values)).flatten();
        let Some(readiness) = readiness else {
            not_on_board += 1;
            continue;
        };
        items.push(RoadmapRowDto {
            name: c.name.to_string(),
            category: (!c.category.is_empty()).then(|| c.category.to_string()),
            readiness,
            assignees: brief(c.values, "roadmap_owner"),
            effort: brief(c.values, "effort"),
            roadmap_title: brief(c.values, "roadmap_item"),
        });
    }
    // Soonest due first; undated after dated; then by name.
    items.sort_by(|a, b| {
        let key = |r: &RoadmapRowDto| {
            (
                r.readiness.due.is_none(),
                r.readiness.due.clone(),
                r.name.clone(),
            )
        };
        key(a).cmp(&key(b))
    });
    let summary = summarize(&items);
    RoadmapReportDto {
        total: count(items.len()),
        not_on_board: count(not_on_board),
        summary,
        items,
    }
}

fn not_on_track(r: &ReferenceReadinessDto) -> bool {
    matches!(r.plan_lamp.as_deref(), Some("bad" | "watch"))
}

fn summarize(items: &[RoadmapRowDto]) -> RoadmapSummaryDto {
    // Stages in pipeline order: by position, then by name for a stage the
    // board did not place.
    let mut stages: BTreeMap<(u32, String), usize> = BTreeMap::new();
    // Dated milestones by due date, then undated ones.
    let mut milestones: BTreeMap<(bool, Option<String>, String), RoadmapMilestoneDto> =
        BTreeMap::new();
    let mut consumers: BTreeMap<String, RoadmapConsumerDto> = BTreeMap::new();
    let mut plans: BTreeMap<String, usize> = BTreeMap::new();
    let mut overdue: Vec<String> = Vec::new();

    for row in items {
        let r = &row.readiness;
        if let Some(stage) = &r.stage {
            *stages
                .entry((r.stage_at.unwrap_or(u32::MAX), stage.clone()))
                .or_default() += 1;
        }
        if let Some(m) = &r.milestone {
            let e = milestones
                .entry((r.due.is_none(), r.due.clone(), m.clone()))
                .or_insert_with(|| RoadmapMilestoneDto {
                    milestone: m.clone(),
                    due: r.due.clone(),
                    total: 0,
                    committed: 0,
                    at_risk: 0,
                });
            e.total += 1;
            if r.committed == Some(true) {
                e.committed += 1;
            }
            if r.plan.as_deref() == Some("at risk") {
                e.at_risk += 1;
            }
        }
        for d in &r.demand {
            let e = consumers
                .entry(d.consumer.clone())
                .or_insert_with(|| RoadmapConsumerDto {
                    consumer: d.consumer.clone(),
                    p1: 0,
                    p2: 0,
                    p3: 0,
                    p1_not_on_track: 0,
                });
            match d.priority {
                1 => {
                    e.p1 += 1;
                    if not_on_track(r) {
                        e.p1_not_on_track += 1;
                    }
                }
                2 => e.p2 += 1,
                _ => e.p3 += 1,
            }
        }
        if let Some(p) = &r.plan {
            *plans.entry(p.clone()).or_default() += 1;
        }
        if r.plan_reasons.iter().any(|x| x.starts_with("overdue")) {
            overdue.push(row.name.clone());
        }
    }

    RoadmapSummaryDto {
        by_stage: stages
            .into_iter()
            .map(|((_, label), n)| RoadmapCountDto {
                label,
                count: count(n),
            })
            .collect(),
        by_milestone: milestones.into_values().collect(),
        by_consumer: consumers.into_values().collect(),
        by_plan: plans
            .into_iter()
            .map(|(label, n)| RoadmapCountDto {
                label,
                count: count(n),
            })
            .collect(),
        overdue,
    }
}

#[cfg(test)]
#[path = "roadmap_report_tests.rs"]
mod tests;
