//! Team capacity: each person's available hours per week and their
//! allocation across projects (`docs/design/studio-user.md`, "Capacity";
//! issue #785).
//!
//! What is stored is what a person or a planner set: weekly availability and
//! hours allocated to a project in a week. A person nobody set availability
//! for falls back to the roadmap plan: their `power` there (the share of a
//! full week they work, as the plan's memberships mirror it into the domain
//! model) times [`WEEK_HOURS`]. A person is keyed the way the plan keys them,
//! `github:<login>`, or by their Studio id.

use std::collections::BTreeMap;

use time::{Date, Duration, Month};

/// A full week, in hours: what `power` 1.0 means.
pub const WEEK_HOURS: f64 = 40.0;
/// The most hours a week can hold.
pub const MAX_WEEK_HOURS: f64 = 80.0;

/// The Monday of the week `date` (`YYYY-MM-DD`) falls in, as `YYYY-MM-DD`.
pub fn monday_of(date: &str) -> Result<String, String> {
    let bad = || format!("`{date}` is not a date (YYYY-MM-DD)");
    let mut parts = date.trim().split('-');
    let (Some(y), Some(m), Some(d), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(bad());
    };
    let year: i32 = y.parse().map_err(|_| bad())?;
    let month: u8 = m.parse().map_err(|_| bad())?;
    let day: u8 = d.parse().map_err(|_| bad())?;
    let month = Month::try_from(month).map_err(|_| bad())?;
    let date = Date::from_calendar_date(year, month, day).map_err(|_| bad())?;
    let monday = date - Duration::days(i64::from(date.weekday().number_days_from_monday()));
    Ok(format!(
        "{:04}-{:02}-{:02}",
        monday.year(),
        u8::from(monday.month()),
        monday.day()
    ))
}

/// Hours must be a number between 0 and [`MAX_WEEK_HOURS`].
pub fn check_hours(hours: f64) -> Result<f64, String> {
    if hours.is_finite() && (0.0..=MAX_WEEK_HOURS).contains(&hours) {
        Ok((hours * 100.0).round() / 100.0)
    } else {
        Err(format!("hours are between 0 and {MAX_WEEK_HOURS}"))
    }
}

/// A person the roadmap plan names.
#[derive(Clone, Debug, PartialEq)]
pub struct PlanPerson {
    pub key: String,
    pub name: String,
    pub team: Option<String>,
    pub power: Option<f64>,
}

/// Availability set for one person in the week.
#[derive(Clone, Debug, PartialEq)]
pub struct Availability {
    pub person: String,
    pub hours: f64,
}

/// Hours of one person given to one project in the week.
#[derive(Clone, Debug, PartialEq)]
pub struct Allocation {
    pub person: String,
    pub project_id: String,
    pub hours: f64,
}

/// One person's week.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub person: String,
    pub name: Option<String>,
    pub team: Option<String>,
    /// `set` (someone set it), `plan` (from power) or `none`.
    pub source: &'static str,
    pub available_hours: f64,
    pub allocations: Vec<(String, f64)>,
    pub allocated_hours: f64,
    /// Available minus allocated; negative when over-allocated.
    pub free_hours: f64,
}

/// What the plan says of a person: their name, team and power.
type Known = (Option<String>, Option<String>, Option<f64>);

/// Everybody's week: the plan's people, anyone with availability set, and
/// anyone allocated; narrowed to the people allocated to `project` when given.
/// Ordered by team, then name.
pub fn rows(
    plan: &[PlanPerson],
    set: &[Availability],
    allocations: &[Allocation],
    project: Option<&str>,
) -> Vec<Row> {
    let mut people: BTreeMap<String, Known> = BTreeMap::new();
    for p in plan {
        people.insert(
            p.key.clone(),
            (Some(p.name.clone()), p.team.clone(), p.power),
        );
    }
    for a in set {
        people.entry(a.person.clone()).or_default();
    }
    for a in allocations {
        people.entry(a.person.clone()).or_default();
    }
    let mut out: Vec<Row> = people
        .into_iter()
        .map(|(person, (name, team, power))| {
            let explicit = set.iter().find(|a| a.person == person).map(|a| a.hours);
            let (source, available) = match (explicit, power) {
                (Some(h), _) => ("set", h),
                (None, Some(p)) => ("plan", (p * WEEK_HOURS * 100.0).round() / 100.0),
                (None, None) => ("none", 0.0),
            };
            let mut mine: BTreeMap<String, f64> = BTreeMap::new();
            for a in allocations.iter().filter(|a| a.person == person) {
                *mine.entry(a.project_id.clone()).or_default() += a.hours;
            }
            let allocated: f64 = mine.values().sum();
            Row {
                person,
                name,
                team,
                source,
                available_hours: available,
                allocations: mine.into_iter().collect(),
                allocated_hours: allocated,
                free_hours: ((available - allocated) * 100.0).round() / 100.0,
            }
        })
        .filter(|r| project.is_none_or(|p| r.allocations.iter().any(|(id, h)| id == p && *h > 0.0)))
        .collect();
    out.sort_by(|a, b| {
        a.team.cmp(&b.team).then(
            a.name
                .as_deref()
                .unwrap_or(&a.person)
                .cmp(b.name.as_deref().unwrap_or(&b.person)),
        )
    });
    out
}

#[cfg(test)]
#[path = "capacity_tests.rs"]
mod tests;
