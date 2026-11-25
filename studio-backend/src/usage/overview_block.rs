//! The Spend block of an organization's Overview (the Costs kit's
//! contribution through the core's Overview port, ADR-0079 §4).
//!
//! **Spend is the last 30 days against the same 30 days a month earlier**,
//! UTC days as the Costs report counts them, today included; the month-end
//! forecast is this month so far at its own pace. People's own keys are shown
//! apart and never in the organization's spend.
//!
//! **Spend is a member's when the token subject that made the call is one of
//! their sign-ins.** Anything else -- a subject no active member signs in with,
//! a session (the runtime does not say who) -- is unattributed, counted and
//! said, never dropped.
//!
//! Costs are read only for a caller holding `cost.view`; without it the tile
//! says so, every money figure is absent, and nobody can be called idle.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use async_trait::async_trait;
use serde_json::{Value, json};
use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;

use super::port::Payer;
use super::{Fact, FactKind, GroupBy, OrganizationUsage, PricedUsage};
use crate::organizations::port::{
    Activity, BlockAnswer, BlockAt, BlockNeedDto, BlockScope, BlockSource, GROWTH_ALERT, Level,
    LineDto, LinkDto, OverviewBlock, Prepared, RosterMember, Signals, TileDto, english, growth,
    words,
};

/// The kit the block is the Costs kit's.
pub const COSTS_KIT: &str = "org-costs";
/// The Costs screen.
const COSTS_ROUTE: &str = "/costs";
/// A person key for spend no active member's sign-in made.
pub const UNATTRIBUTED: &str = "unattributed";

inventory::submit! {
    OverviewBlock {
        kit: COSTS_KIT,
        gear: "studio-usage",
        id: "spend",
        order: 10,
        level: Level::Organization,
        source: &SpendBlock,
    }
}

/// Where the month ends at this month's pace so far.
pub fn forecast(month_to_date: f64, elapsed_days: u32, month_days: u32) -> f64 {
    if elapsed_days == 0 {
        return month_to_date;
    }
    month_to_date / f64::from(elapsed_days) * f64::from(month_days)
}

/// "+23%", "−5%", "±0%", or "new" when nothing was spent before.
pub fn growth_text(current: f64, previous: f64) -> String {
    if previous <= 0.0 {
        return if current > 0.0 { "new" } else { "—" }.to_owned();
    }
    let pct = ((current - previous) / previous * 100.0).round() as i64;
    match pct {
        p if p > 0 => format!("+{p}%"),
        p if p < 0 => format!("−{}%", -p),
        _ => "±0%".to_owned(),
    }
}

// ── Spend, attributed to members ─────────────────────────────────────────────

/// Every sign-in subject of the organization's active members, to the person.
pub fn subjects_of(members: &[RosterMember]) -> HashMap<String, String> {
    members
        .iter()
        .flat_map(|m| m.subjects.iter().map(|s| (s.clone(), m.person.clone())))
        .collect()
}

/// Whose a fact is: a member's person id, [`UNATTRIBUTED`] for a subject no
/// active member signs in with, `""` for a session (nobody in particular).
pub fn owner_of(fact: &Fact, subjects: &HashMap<String, String>) -> String {
    match (fact.kind, fact.person) {
        (FactKind::Session, _) | (_, None) => String::new(),
        (_, Some(subject)) => subjects
            .get(&subject.to_string())
            .cloned()
            .unwrap_or_else(|| UNATTRIBUTED.to_owned()),
    }
}

/// One row of a breakdown: now, before, and whether part had no price.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MoneyRow {
    pub key: String,
    pub cost: f64,
    pub previous: f64,
    pub unpriced: bool,
}

/// One period folded by `group`; by person through the members.
fn fold(
    usage: &PricedUsage,
    group: GroupBy,
    include_personal: bool,
    subjects: &HashMap<String, String>,
) -> BTreeMap<String, (f64, bool)> {
    if group != GroupBy::Person {
        return usage
            .report(group, include_personal)
            .rows
            .into_iter()
            .map(|r| (r.key, (r.cost, r.unpriced)))
            .collect();
    }
    let mut out: BTreeMap<String, (f64, bool)> = BTreeMap::new();
    for f in &usage.facts {
        if !include_personal && f.payer == Some(Payer::Personal) {
            continue;
        }
        let row = out.entry(owner_of(f, subjects)).or_default();
        match usage.cost_of(f) {
            Some(c) => row.0 += c,
            None => row.1 = true,
        }
    }
    out
}

/// Two periods side by side, biggest spend first. A key spent on in only one
/// of them is still a row: what stopped costing is news too.
pub fn breakdown(
    current: &PricedUsage,
    previous: &PricedUsage,
    group: GroupBy,
    include_personal: bool,
    subjects: &HashMap<String, String>,
) -> Vec<MoneyRow> {
    let mut rows: BTreeMap<String, MoneyRow> = BTreeMap::new();
    for (key, (cost, unpriced)) in fold(current, group, include_personal, subjects) {
        rows.insert(
            key.clone(),
            MoneyRow {
                key,
                cost,
                previous: 0.0,
                unpriced,
            },
        );
    }
    for (key, (cost, _)) in fold(previous, group, include_personal, subjects) {
        rows.entry(key.clone())
            .or_insert_with(|| MoneyRow {
                key,
                ..MoneyRow::default()
            })
            .previous += cost;
    }
    let mut rows: Vec<MoneyRow> = rows.into_values().collect();
    rows.sort_by(|a, b| {
        b.cost
            .total_cmp(&a.cost)
            .then(b.previous.total_cmp(&a.previous))
            .then(a.key.cmp(&b.key))
    });
    rows
}

/// What a period's spend says about people.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Attribution {
    /// Members who used a model in the period, own keys included.
    pub spenders: BTreeSet<String>,
    /// The organization's spend (own keys left out) that is a member's.
    pub attributed: f64,
    /// The rest of it: subjects no active member signs in with.
    pub unattributed: f64,
    /// Sessions, which name nobody.
    pub sessions: f64,
}

pub fn attribute(usage: &PricedUsage, subjects: &HashMap<String, String>) -> Attribution {
    let mut out = Attribution::default();
    for f in &usage.facts {
        let owner = owner_of(f, subjects);
        if !owner.is_empty() && owner != UNATTRIBUTED && f.kind == FactKind::Llm {
            out.spenders.insert(owner.clone());
        }
        if f.payer == Some(Payer::Personal) {
            continue;
        }
        let cost = usage.cost_of(f).unwrap_or(0.0);
        match owner.as_str() {
            "" => out.sessions += cost,
            UNATTRIBUTED => out.unattributed += cost,
            _ => out.attributed += cost,
        }
    }
    out
}

fn by_tenant(usage: &PricedUsage) -> BTreeMap<String, f64> {
    usage
        .report(GroupBy::Project, false)
        .rows
        .into_iter()
        .map(|r| (r.key, r.cost))
        .collect()
}

const GROUPS: [(GroupBy, &str); 5] = [
    (GroupBy::Project, "project"),
    (GroupBy::Person, "person"),
    (GroupBy::Model, "model"),
    (GroupBy::Source, "source"),
    (GroupBy::Payer, "payer"),
];

// ── The block ────────────────────────────────────────────────────────────────

/// The organization's spend over the three periods.
pub struct Spend {
    pub current: PricedUsage,
    pub previous: PricedUsage,
    pub month: PricedUsage,
}

/// What the block read: `None` when the caller may not see costs,
/// `Some(Err)` when they may and the read failed.
pub type SpendRead = Option<Result<Spend, String>>;

pub struct SpendBlock;

#[async_trait]
impl BlockSource for SpendBlock {
    async fn prepare(&self, hub: &ClientHub, ctx: &SecurityContext, at: &BlockAt) -> Prepared {
        // One project's health reads no spend.
        if at.health_only {
            return Box::new(None::<SpendRead>);
        }
        let Ok(usage) = hub.get::<dyn OrganizationUsage>() else {
            return Box::new(None::<SpendRead>);
        };
        let org = at.organization;
        let w = at.windows;
        let read: SpendRead = if usage.may_view(ctx, org).await {
            let (current, previous, month) = tokio::join!(
                usage.usage(ctx, org, w.current.from, w.current.to),
                usage.usage(ctx, org, w.previous.from, w.previous.to),
                usage.usage(ctx, org, w.month.from, w.month.to),
            );
            Some(match (current, previous, month) {
                (Ok(current), Ok(previous), Ok(month)) => Ok(Spend {
                    current,
                    previous,
                    month,
                }),
                (Err(e), _, _) | (_, Err(e), _) | (_, _, Err(e)) => Err(format!("{e:#}")),
            })
        } else {
            None
        };
        Box::new(Some(read))
    }

    async fn answer(
        &self,
        _hub: &ClientHub,
        _ctx: &SecurityContext,
        prepared: Prepared,
        scope: &BlockScope<'_>,
    ) -> Option<BlockAnswer> {
        // `None`: the gear is not in this assembly, or only health was asked.
        let read = (*prepared.downcast::<Option<SpendRead>>().ok()?)?;
        Some(answer(&read, scope))
    }
}

/// The block, from what was read.
pub fn answer(read: &SpendRead, scope: &BlockScope<'_>) -> BlockAnswer {
    let title = words("Spend, 30 days", "Расходы за 30 дней");
    let link = Some(LinkDto::to(COSTS_ROUTE, words("Costs →", "Затраты →")));
    let say = |en: &str, ru: &str| LineDto::new(words(en, ru));
    let spend = match read {
        None => {
            return BlockAnswer {
                tile: Some(TileDto {
                    title,
                    lines: vec![say("Costs are hidden for you", "Расходы от вас скрыты")],
                    link,
                    ..TileDto::default()
                }),
                signals: Signals {
                    activity: Activity::Unknown,
                    ..Signals::default()
                },
                data: json!({ "costs": "hidden" }),
                ..BlockAnswer::default()
            };
        }
        Some(Err(_)) => {
            return BlockAnswer {
                tile: Some(TileDto {
                    title,
                    lines: vec![say(
                        "Costs could not be read",
                        "Расходы не удалось прочитать",
                    )],
                    link,
                    ..TileDto::default()
                }),
                signals: Signals {
                    activity: Activity::Unknown,
                    ..Signals::default()
                },
                data: json!({ "costs": "unreadable" }),
                ..BlockAnswer::default()
            };
        }
        Some(Ok(s)) => s,
    };

    let w = scope.at.windows;
    let subjects = scope.members.map(subjects_of).unwrap_or_default();
    let currency = spend.current.currency.clone();
    let current = spend.current.report(GroupBy::Payer, false);
    let with_own = spend.current.report(GroupBy::Payer, true);
    let previous = spend.previous.report(GroupBy::Payer, false).total;
    let month = spend.month.report(GroupBy::Payer, false).total;
    let total = current.total;
    let ahead = forecast(month, w.elapsed_days, w.month_days);
    let who = attribute(&spend.current, &subjects);
    let has_prices = spend.current.has_prices();
    let unpriced = with_own.unpriced.clone();

    let current_by = by_tenant(&spend.current);
    let previous_by = by_tenant(&spend.previous);
    let grower = current_by
        .iter()
        .map(|(k, c)| (k, c - previous_by.get(k).copied().unwrap_or(0.0)))
        .filter(|(_, d)| *d > 0.0)
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(k, _)| scope.places.get(k).cloned().unwrap_or_else(|| k.clone()));

    // The tile, as the Costs report would say it.
    let unpriced_line = say("Some usage has no price", "Часть использования без тарифа");
    let (value, lines) = if !has_prices {
        (None, vec![say("Price list missing", "Тарифы не настроены")])
    } else if !unpriced.is_empty() && total == 0.0 {
        (None, vec![unpriced_line])
    } else {
        let mut lines = vec![
            say(
                "{growth} against the days before · month ends near {forecast}",
                "{growth} к прошлому периоду · к концу месяца около {forecast}",
            )
            .text("growth", growth_text(total, previous))
            .money("forecast", ahead, &currency),
        ];
        if !unpriced.is_empty() {
            lines.push(unpriced_line);
        }
        (
            Some(LineDto::new(english("{current}")).money("current", total, &currency)),
            lines,
        )
    };

    // Spend growing past the alert waits on the organization's leaders.
    let mut needs = Vec::new();
    if growth(total, previous).is_some_and(|g| g >= GROWTH_ALERT) {
        let detail = match &grower {
            Some(_) => "{current} in 30 days; the month ends near {forecast}. Grows most: {grower}",
            None => "{current} in 30 days; the month ends near {forecast}",
        };
        let mut detail = LineDto::new(english(detail))
            .money("current", total, &currency)
            .money("forecast", ahead, &currency);
        if let Some(g) = &grower {
            detail = detail.text("grower", g.clone());
        }
        needs.push(BlockNeedDto {
            key: "spend".into(),
            tone: "warn".into(),
            sentence: LineDto::new(english("Spend {growth} against the same days last month"))
                .text("growth", growth_text(total, previous)),
            detail: Some(detail),
            action: Some(LinkDto::to(COSTS_ROUTE, english("Open Costs"))),
            details: None,
        });
    }

    let mut money = Vec::new();
    for (group, name) in GROUPS {
        for include_personal in [false, true] {
            let rows: Vec<Value> = breakdown(
                &spend.current,
                &spend.previous,
                group,
                include_personal,
                &subjects,
            )
            .into_iter()
            .map(|r| {
                let label = match group {
                    GroupBy::Project => scope.places.get(&r.key).cloned(),
                    GroupBy::Person => scope.names.get(&r.key).cloned(),
                    _ => None,
                };
                json!({
                    "key": r.key,
                    "label": label,
                    "cost": r.cost,
                    "previous": r.previous,
                    "unpriced": r.unpriced,
                })
            })
            .collect();
            money.push(json!({
                "group_by": name,
                "include_personal": include_personal,
                "rows": rows,
            }));
        }
    }
    let with_spend = u32::try_from(who.spenders.len()).unwrap_or(u32::MAX);

    BlockAnswer {
        tile: Some(TileDto {
            title,
            value,
            lines,
            link,
            items: None,
        }),
        needs,
        signals: Signals {
            spend: Some(current_by),
            previous: Some(previous_by),
            currency: Some(currency.clone()),
            stuck: None,
            activity: Activity::Seen(who.spenders.clone()),
        },
        data: json!({
            "costs": "shown",
            "spend": {
                "currency": currency,
                "has_prices": has_prices,
                "current": total,
                "previous": previous,
                "forecast": ahead,
                "own_keys": (with_own.total - total).max(0.0),
                "attributed": who.attributed,
                "unattributed": who.unattributed,
                "sessions": who.sessions,
                "unpriced": unpriced,
            },
            "grower": grower,
            "with_spend": with_spend,
            "per_person": (with_spend > 0).then(|| who.attributed / f64::from(with_spend)),
            "money": money,
        }),
    }
}

#[cfg(test)]
#[path = "overview_block_tests.rs"]
mod tests;
