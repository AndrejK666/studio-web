//! What a component's fields said before: one snapshot per component per day.
//!
//! The catalogue answers "what is true now" and nothing else. A sync rewrites
//! the scan's answers in place, so a coverage that fell from 80 % to 40 % last
//! month looks exactly like one that was always 40 %. A snapshot is the old
//! answer kept, and the only way to say "better" or "worse" at all.
//!
//! ── What is kept ─────────────────────────────────────────────────────────────
//!
//! Not the whole value. A field's `v` can be a dependency list or a README
//! excerpt, and a year of those is a lot of rows for nothing a comparison
//! reads. A snapshot keeps what a comparison CAN read: the number (`n`), the
//! grade (`s`), and the badge (`b`), cut short. That is enough to say the
//! coverage moved from 80 to 40, that the CODEOWNERS lamp went from good to
//! bad, and that the lifecycle changed from `beta` to `production`.
//!
//! ── One a day ────────────────────────────────────────────────────────────────
//!
//! Keyed on component and date, so the fourth sync of a day replaces that
//! day's snapshot instead of adding one. What a day ended on is the useful
//! answer; the minutes in between are noise, and a key per sync would grow
//! with how often someone presses the button rather than with time.

use serde_json::{Map, Value, json};

/// How much of a badge a snapshot keeps. A badge is a table cell -- a version,
/// a lifecycle, `12 / 20 ticked` -- and one longer than this is a sentence,
/// which no comparison reads.
const BADGE_MAX: usize = 80;

/// Days since 1970-01-01: the indexed, comparable form of a snapshot's date.
///
/// An integer rather than the date string, because the history reads ask for
/// a range of days, and a range over a number is the comparison graph-storage
/// is certain to answer the way it reads.
pub fn day_of(date: time::Date) -> i64 {
    i64::from(date.to_julian_day() - EPOCH_JULIAN_DAY)
}

/// The Julian day number of 1970-01-01.
const EPOCH_JULIAN_DAY: i32 = 2_440_588;

/// The parts of each field a comparison reads: `n`, `s`, and a short `b`.
/// A field with none of them -- a list, a link, a cleared value -- is left
/// out, since there is nothing in it to compare.
pub fn fields_of(values: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, value) in values {
        let Some(obj) = value.as_object() else {
            continue;
        };
        let mut kept = Map::new();
        if let Some(n) = obj.get("n").filter(|n| n.is_number()) {
            kept.insert("n".into(), n.clone());
        }
        if let Some(s) = obj
            .get("s")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            kept.insert("s".into(), json!(s));
        }
        if let Some(b) = obj
            .get("b")
            .and_then(Value::as_str)
            .filter(|b| !b.is_empty())
        {
            let short: String = b.chars().take(BADGE_MAX).collect();
            kept.insert("b".into(), json!(short));
        }
        if !kept.is_empty() {
            out.insert(key.clone(), Value::Object(kept));
        }
    }
    out
}

/// One component's snapshot payload for one day.
pub fn snapshot(component: &str, date: time::Date, values: &Map<String, Value>) -> Value {
    json!({
        "component": component,
        "day": day_of(date),
        "date": date.to_string(),
        "fields": fields_of(values),
    })
}

/// The earliest snapshot of each component among `rows`, by component name.
///
/// What a window compares against: the component as it was when the window
/// opened, or as soon after as it was first seen.
pub fn earliest_per_component(rows: Vec<Value>) -> Vec<Value> {
    let mut by_component: std::collections::BTreeMap<String, Value> =
        std::collections::BTreeMap::new();
    for row in rows {
        let Some(component) = row.get("component").and_then(Value::as_str) else {
            continue;
        };
        let day = row.get("day").and_then(Value::as_i64).unwrap_or(i64::MAX);
        let earlier = by_component
            .get(component)
            .and_then(|kept| kept.get("day").and_then(Value::as_i64))
            .is_none_or(|kept| day < kept);
        if earlier {
            by_component.insert(component.to_owned(), row);
        }
    }
    by_component.into_values().collect()
}

/// A component's snapshots, oldest first.
pub fn oldest_first(mut rows: Vec<Value>) -> Vec<Value> {
    rows.sort_by_key(|r| r.get("day").and_then(Value::as_i64).unwrap_or(i64::MAX));
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(y: i32, m: u8, d: u8) -> time::Date {
        time::Date::from_calendar_date(y, time::Month::try_from(m).unwrap(), d).unwrap()
    }

    #[test]
    fn a_day_is_counted_from_the_epoch_and_back() {
        assert_eq!(day_of(date(1970, 1, 1)), 0);
        assert_eq!(day_of(date(1970, 1, 2)), 1);
        let day = day_of(date(2026, 9, 29));
        assert_eq!(day, 20_725);
        assert_eq!(day_of(date(2026, 9, 30)) - day, 1);
    }

    #[test]
    fn a_snapshot_keeps_what_a_comparison_reads() {
        let values = json!({
            "coverage": { "v": "81.5% line coverage", "b": "81%", "n": 81.5, "s": "good" },
            "deps": { "v": ["serde", "tokio"] },
            "lifecycle": { "b": "production" },
            "readme": { "b": "x".repeat(200) },
            "owner": null,
        });
        let fields = fields_of(values.as_object().unwrap());

        assert_eq!(
            fields["coverage"],
            json!({ "n": 81.5, "s": "good", "b": "81%" })
        );
        assert_eq!(fields["lifecycle"], json!({ "b": "production" }));
        assert_eq!(fields["readme"]["b"].as_str().unwrap().len(), BADGE_MAX);
        assert!(!fields.contains_key("deps"), "a list is nothing to compare");
        assert!(!fields.contains_key("owner"));
    }

    #[test]
    fn a_snapshot_names_its_component_and_its_day() {
        let values = json!({ "grade": { "b": "B", "n": 70 } });
        let snap = snapshot(
            "studio-core",
            date(2026, 9, 29),
            values.as_object().unwrap(),
        );

        assert_eq!(snap["component"], "studio-core");
        assert_eq!(snap["date"], "2026-09-29");
        assert_eq!(snap["day"], day_of(date(2026, 9, 29)));
        assert_eq!(snap["fields"]["grade"]["n"], 70);
    }

    #[test]
    fn the_baseline_is_each_components_earliest_snapshot() {
        let row = |c: &str, day: i64| json!({ "component": c, "day": day });
        let rows = vec![
            row("b", 12),
            row("a", 11),
            row("a", 10),
            row("b", 14),
            json!({ "day": 1 }),
        ];

        let baseline = earliest_per_component(rows);

        assert_eq!(baseline, vec![row("a", 10), row("b", 12)]);
    }

    #[test]
    fn a_history_reads_oldest_first() {
        let row = |day: i64| json!({ "component": "a", "day": day });
        assert_eq!(
            oldest_first(vec![row(3), row(1), row(2)]),
            vec![row(1), row(2), row(3)]
        );
    }
}
