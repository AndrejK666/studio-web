//! An organization's monthly budgets, and where this month's spend stands
//! against them (issue #781, step 4). Pure — `super::service` reads the facts.
//!
//! A budget **warns and never stops anything**: nothing is refused when one is
//! spent. Stopping is the platform's `quota-enforcement` gear's job once it is
//! published; until then a budget is a line an administrator draws and a
//! warning when the month's spend, or the forecast of it, crosses that line.
//!
//! Amounts are in the price list's currency, the one costs are reported in.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use time::{Date, Month, OffsetDateTime, Time};
use uuid::Uuid;

/// The share of a budget at which it warns when the list does not say.
pub const DEFAULT_WARN_AT_PERCENT: u8 = 80;

/// How much of a month has to have passed before its spend is projected to
/// the month's end: a forecast from the first hours of a month is noise.
pub const FORECAST_AFTER_DAYS: i64 = 3;

/// The organization's budgets, kept as one account-management metadata row on
/// the organization (`super::BUDGETS_METADATA_TYPE`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Budgets {
    /// Percent of a budget at which it warns; `0` means
    /// [`DEFAULT_WARN_AT_PERCENT`].
    pub warn_at_percent: u8,
    pub items: Vec<Budget>,
}

/// One monthly budget.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Budget {
    /// A workspace or a project of the organization; `None` is the whole
    /// organization.
    pub tenant_id: Option<Uuid>,
    /// What may be spent in a calendar month (UTC), in the price list's
    /// currency.
    pub monthly: f64,
}

/// Why a budget list was refused.
#[derive(Debug, PartialEq, Eq)]
pub struct Invalid(pub String);

impl Budgets {
    pub fn warn_at_percent(&self) -> u8 {
        if self.warn_at_percent == 0 {
            DEFAULT_WARN_AT_PERCENT
        } else {
            self.warn_at_percent
        }
    }

    /// A list that can be stored: a warning below the budget itself, every
    /// place budgeted once, and every amount a positive number.
    pub fn validate(&self) -> Result<(), Invalid> {
        if self.warn_at_percent >= 100 {
            return Err(Invalid(
                "a budget warns before it is spent: below 100 percent".into(),
            ));
        }
        let mut seen = HashSet::new();
        for b in &self.items {
            if !seen.insert(b.tenant_id) {
                return Err(Invalid(match b.tenant_id {
                    Some(id) => format!("{id} has two budgets"),
                    None => "the organization has two budgets".into(),
                }));
            }
            if !b.monthly.is_finite() || b.monthly <= 0.0 {
                return Err(Invalid("a budget is an amount above zero".into()));
            }
        }
        Ok(())
    }
}

/// The calendar month (UTC) `now` is in, as `[from, to)`.
pub fn month_of(now: OffsetDateTime) -> (OffsetDateTime, OffsetDateTime) {
    let now = now.to_offset(time::UtcOffset::UTC);
    let first = |year: i32, month: Month| {
        Date::from_calendar_date(year, month, 1)
            .expect("the first of a month is a date")
            .with_time(Time::MIDNIGHT)
            .assume_utc()
    };
    let from = first(now.year(), now.month());
    let to = match now.month() {
        Month::December => first(now.year() + 1, Month::January),
        m => first(now.year(), m.next()),
    };
    (from, to)
}

/// Where a budget stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Ok,
    /// At or past the warning share.
    Warning,
    /// At or past the budget.
    Over,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Warning => "warning",
            Self::Over => "over",
        }
    }
}

/// A budget against this month's spend.
#[derive(Clone, Debug, PartialEq)]
pub struct Standing {
    pub tenant_id: Option<Uuid>,
    pub monthly: f64,
    /// Spent so far this month.
    pub spent: f64,
    /// The month's spend if it goes on as it went so far; `None` before
    /// [`FORECAST_AFTER_DAYS`] have passed.
    pub forecast: Option<f64>,
    pub level: Level,
    /// The level is reached only by the forecast; the spend so far is below it.
    pub by_forecast: bool,
}

/// What a tenant of the organization is part of: a project's workspace.
pub struct Tree<'a> {
    pub org: Uuid,
    /// Each project and its workspace.
    pub projects: &'a [(Uuid, Uuid)],
}

/// Each budget against what was spent this month in what it covers: the
/// organization's total, a workspace's own spend and its projects', a
/// project's own. `spent` is the month's cost per tenant; `total` the
/// organization's. Worst first, then the organization, then by id.
pub fn standings(
    budgets: &Budgets,
    spent: &HashMap<Uuid, f64>,
    total: f64,
    tree: &Tree<'_>,
    month: (OffsetDateTime, OffsetDateTime),
    now: OffsetDateTime,
) -> Vec<Standing> {
    let (from, to) = month;
    let elapsed = (now.min(to) - from).as_seconds_f64();
    let length = (to - from).as_seconds_f64();
    let projecting = (now - from).whole_days() >= FORECAST_AFTER_DAYS && elapsed > 0.0;
    let warn_at = f64::from(budgets.warn_at_percent()) / 100.0;
    let own = |id: &Uuid| spent.get(id).copied().unwrap_or(0.0);

    let mut out: Vec<Standing> = budgets
        .items
        .iter()
        .map(|b| {
            let used = match b.tenant_id {
                None => total,
                Some(id) if id == tree.org => total,
                Some(id) => {
                    own(&id)
                        + tree
                            .projects
                            .iter()
                            .filter(|(_, ws)| *ws == id)
                            .map(|(p, _)| own(p))
                            .sum::<f64>()
                }
            };
            let forecast = projecting.then(|| used * length / elapsed);
            let level_of = |amount: f64| {
                if amount >= b.monthly {
                    Level::Over
                } else if amount >= b.monthly * warn_at {
                    Level::Warning
                } else {
                    Level::Ok
                }
            };
            let now_level = level_of(used);
            let ahead = forecast.map_or(Level::Ok, level_of);
            Standing {
                tenant_id: b.tenant_id.filter(|id| *id != tree.org),
                monthly: b.monthly,
                spent: used,
                forecast,
                level: now_level.max(ahead),
                by_forecast: ahead > now_level,
            }
        })
        .collect();
    out.sort_by(|a, b| {
        b.level
            .cmp(&a.level)
            .then(a.by_forecast.cmp(&b.by_forecast))
            .then(a.tenant_id.is_some().cmp(&b.tenant_id.is_some()))
            .then(a.tenant_id.cmp(&b.tenant_id))
    });
    out
}

#[cfg(test)]
mod tests {
    use time::macros::datetime;

    use super::*;

    const ORG: Uuid = Uuid::from_u128(0x0A);
    const WS: Uuid = Uuid::from_u128(0xD2);
    const P1: Uuid = Uuid::from_u128(0x01);
    const P2: Uuid = Uuid::from_u128(0x02);

    fn budget(tenant_id: Option<Uuid>, monthly: f64) -> Budget {
        Budget { tenant_id, monthly }
    }

    #[test]
    fn a_month_is_its_first_day_up_to_the_next_ones() {
        assert_eq!(
            month_of(datetime!(2026-10-19 13:05 UTC)),
            (
                datetime!(2026-10-01 0:00 UTC),
                datetime!(2026-11-01 0:00 UTC)
            )
        );
        assert_eq!(
            month_of(datetime!(2026-12-31 23:59 UTC)),
            (
                datetime!(2026-12-01 0:00 UTC),
                datetime!(2027-01-01 0:00 UTC)
            )
        );
        // Read in UTC, the days the report counts in.
        assert_eq!(
            month_of(datetime!(2026-11-01 01:00 +02:00)).0,
            datetime!(2026-10-01 0:00 UTC)
        );
    }

    #[test]
    fn a_list_that_is_not_one_is_refused() {
        let ok = Budgets {
            warn_at_percent: 0,
            items: vec![budget(None, 100.0), budget(Some(WS), 10.0)],
        };
        assert!(ok.validate().is_ok());
        assert_eq!(ok.warn_at_percent(), 80);
        let mut twice = ok.clone();
        twice.items.push(budget(Some(WS), 5.0));
        assert!(twice.validate().is_err());
        let mut zero = ok.clone();
        zero.items[0].monthly = 0.0;
        assert!(zero.validate().is_err());
        let mut nan = ok.clone();
        nan.items[0].monthly = f64::NAN;
        assert!(nan.validate().is_err());
        let mut late = ok;
        late.warn_at_percent = 100;
        assert!(late.validate().is_err());
    }

    /// On the 16th of a 30-day month, half way through: the organization has
    /// spent 60 of 100 (no warning yet, but on course for 120 — over by
    /// forecast); the workspace 9 of 10 with its projects (a warning now, over
    /// by the month's end); a project 1 of 50, fine.
    #[test]
    fn a_budget_warns_on_what_was_spent_or_what_will_be() {
        let budgets = Budgets {
            warn_at_percent: 0,
            items: vec![
                budget(Some(P2), 50.0),
                budget(None, 100.0),
                budget(Some(WS), 10.0),
            ],
        };
        let spent = HashMap::from([(WS, 2.0), (P1, 6.0), (P2, 1.0), (ORG, 51.0)]);
        let projects = [(P1, WS), (P2, WS)];
        let tree = Tree {
            org: ORG,
            projects: &projects,
        };
        let s = standings(
            &budgets,
            &spent,
            60.0,
            &tree,
            month_of(datetime!(2026-11-16 0:00 UTC)),
            datetime!(2026-11-16 0:00 UTC),
        );
        let of = |id: Option<Uuid>| s.iter().find(|x| x.tenant_id == id).unwrap();

        let org = of(None);
        assert_eq!(org.spent, 60.0);
        assert!((org.forecast.unwrap() - 120.0).abs() < 1e-9);
        assert_eq!((org.level, org.by_forecast), (Level::Over, true));

        let ws = of(Some(WS));
        assert_eq!(ws.spent, 9.0, "the workspace's own spend and its projects'");
        assert_eq!((ws.level, ws.by_forecast), (Level::Over, true));

        let p2 = of(Some(P2));
        assert_eq!((p2.spent, p2.level), (1.0, Level::Ok));

        // Over by forecast both; the organization first, the fine one last.
        assert_eq!(
            s.iter().map(|x| x.tenant_id).collect::<Vec<_>>(),
            vec![None, Some(WS), Some(P2)]
        );
    }

    #[test]
    fn spend_past_the_budget_is_over_and_the_first_days_are_not_projected() {
        let budgets = Budgets {
            warn_at_percent: 50,
            items: vec![budget(None, 10.0), budget(Some(WS), 100.0)],
        };
        let spent = HashMap::from([(WS, 60.0)]);
        let tree = Tree {
            org: ORG,
            projects: &[],
        };
        let now = datetime!(2026-11-02 12:00 UTC);
        let s = standings(&budgets, &spent, 60.0, &tree, month_of(now), now);
        assert_eq!(s[0].tenant_id, None);
        assert_eq!((s[0].level, s[0].by_forecast), (Level::Over, false));
        assert_eq!(s[0].forecast, None, "two days in is too early to project");
        // 60 of 100 against a 50 percent line.
        assert_eq!((s[1].level, s[1].by_forecast), (Level::Warning, false));
    }

    /// The organization named by its own id is the organization.
    #[test]
    fn the_organization_by_id_is_the_whole_organization() {
        let budgets = Budgets {
            warn_at_percent: 0,
            items: vec![budget(Some(ORG), 100.0)],
        };
        let tree = Tree {
            org: ORG,
            projects: &[],
        };
        let now = datetime!(2026-11-20 0:00 UTC);
        let s = standings(&budgets, &HashMap::new(), 7.0, &tree, month_of(now), now);
        assert_eq!((s[0].tenant_id, s[0].spent), (None, 7.0));
    }
}
