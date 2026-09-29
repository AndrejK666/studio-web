//! The quality grade: one letter per component, from rules it meets or does
//! not.
//!
//! The rules are the gears-catalog playground's (24 criteria in six areas,
//! `A` ≥ 90% … `E`), carried as data in the field schema's `quality` block so
//! an organization can change them without a release. What this module owns
//! is how a rule is *read* against a component's resolved values.
//!
//! Two properties hold by construction, both from the playground:
//!
//! * **Every criterion is absolute.** A rule compares this component with a
//!   threshold, never with another component, so a grade cannot move because
//!   somebody else shipped something.
//! * **Unknown fails.** A field with no answer does not meet the rule it
//!   feeds. The grade then says what to do -- publish the coverage, name the
//!   support route -- rather than pretend the gap is not there.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

/// A schema's quality block.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quality {
    /// Highest threshold first: `{ min: 90, g: "A" }`.
    pub grades: Vec<GradeStep>,
    /// The best a component not yet in production may grade.
    #[serde(default)]
    pub cap_until_prod: Option<String>,
    #[serde(default)]
    pub cap_note: Option<String>,
    pub areas: Vec<Area>,
    pub criteria: Vec<Criterion>,
    /// What each derived input (`@testratio`) means, for the page to say.
    #[serde(default)]
    pub derived: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GradeStep {
    pub min: u32,
    pub g: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Area {
    pub id: String,
    pub title: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Criterion {
    /// The area it belongs to.
    pub a: String,
    pub label: String,
    /// A field key, or a derived input (`@testratio`).
    pub field: String,
    /// `filled` · `notnone` · `b==X` · `s==X` · `s!=X` · `n>=N` · `ratio==1`
    /// · `==ok` / `==fresh` for derived inputs.
    pub test: String,
    /// What to do when it fails.
    pub fix: String,
}

/// Put the grade into a component's resolved values, when its schema grades.
///
/// Computed on every read rather than stored: a person's correction to any
/// field it reads moves the grade at once, and nothing can go stale.
pub fn attach(
    values: &mut Map<String, Value>,
    schema: Option<&super::field_schema::TypeFieldSchema>,
) {
    if let Some(q) = schema.and_then(|s| s.quality.as_ref()) {
        let g = grade(q, values);
        values.insert("grade".into(), g);
    }
}

/// The grade as a profile field: `b` the letter, `n` the share met, `s` the
/// lamp, and `parts` every criterion with whether it passed.
pub fn grade(q: &Quality, values: &Map<String, Value>) -> Value {
    let parts: Vec<(&Criterion, bool)> =
        q.criteria.iter().map(|c| (c, passes(c, values))).collect();
    let met = parts.iter().filter(|(_, ok)| *ok).count();
    let total = parts.len();
    let pct = u32::try_from(met * 100 / total.max(1)).unwrap_or(0);
    let mut letter = q
        .grades
        .iter()
        .find(|s| pct >= s.min)
        .map_or_else(|| "E".to_string(), |s| s.g.clone());
    // Not in production yet: no better than the cap, however complete.
    let lifecycle = brief(values, "lifecycle").unwrap_or_default();
    let in_prod = lifecycle.contains("prod") || lifecycle.contains("mature");
    let mut capped = false;
    if let Some(cap) = &q.cap_until_prod
        && !in_prod
        && letter.as_str() < cap.as_str()
    {
        letter = cap.clone();
        capped = true;
    }
    let lamp = match letter.as_str() {
        "A" | "B" => "good",
        "C" => "watch",
        _ => "bad",
    };
    let title = |id: &str| {
        q.areas
            .iter()
            .find(|a| a.id == id)
            .map_or_else(|| id.to_string(), |a| a.title.clone())
    };
    json!({
        "b": letter,
        "v": format!("{letter} — {met} of {total} criteria{}", if capped { ", capped until it is in production" } else { "" }),
        "n": pct,
        "s": lamp,
        "capped": capped,
        "parts": parts.iter().map(|(c, ok)| json!({
            "area": title(&c.a),
            "label": c.label,
            "pass": ok,
            "fix": c.fix,
        })).collect::<Vec<_>>(),
    })
}

fn brief(values: &Map<String, Value>, key: &str) -> Option<String> {
    values
        .get(key)
        .filter(|v| !v.is_null())
        .and_then(|v| v.get("b").or_else(|| v.get("v")))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn number(values: &Map<String, Value>, key: &str) -> Option<f64> {
    values
        .get(key)
        .and_then(|v| v.get("n"))
        .and_then(Value::as_f64)
}

/// Whether one criterion holds for these values.
fn passes(c: &Criterion, values: &Map<String, Value>) -> bool {
    if let Some(derived) = c.field.strip_prefix('@') {
        let expected = c.test.trim_start_matches("==");
        return derive(derived, values).is_some_and(|got| got == expected);
    }
    let field = values.get(&c.field).filter(|v| !v.is_null());
    let lamp = field.and_then(|v| v.get("s")).and_then(Value::as_str);
    let b = brief(values, &c.field);
    let t = c.test.as_str();
    if t == "filled" {
        return field.is_some();
    }
    if t == "notnone" {
        return b.is_some_and(|b| !matches!(b.trim(), "" | "none" | "no" | "0"));
    }
    if let Some(x) = t.strip_prefix("b==") {
        return b.as_deref() == Some(x);
    }
    if let Some(x) = t.strip_prefix("s==") {
        return lamp == Some(x);
    }
    if let Some(x) = t.strip_prefix("s!=") {
        return field.is_some() && lamp != Some(x);
    }
    if let Some(x) = t.strip_prefix("n>=") {
        let want: f64 = x.trim().parse().unwrap_or(f64::INFINITY);
        return number(values, &c.field).is_some_and(|n| n >= want);
    }
    if t == "ratio==1" {
        // `56/74`: every one of them.
        return b
            .as_deref()
            .and_then(|b| b.split_once('/'))
            .and_then(|(a, d)| Some((a.trim().parse::<u64>().ok()?, d.trim().parse::<u64>().ok()?)))
            .is_some_and(|(a, d)| d > 0 && a == d);
    }
    false
}

/// A derived input's value, or `None` when what it needs is unknown.
///
/// `specfresh` needs when the specs and the code last moved, which the scan
/// does not record per artifact yet, so it is unknown -- and fails, saying
/// what would answer it.
fn derive(name: &str, values: &Map<String, Value>) -> Option<&'static str> {
    match name {
        "testratio" => {
            let code = number(values, "codeloc").filter(|n| *n > 0.0)?;
            let tests: f64 = ["unitloc", "integloc", "e2eloc"]
                .iter()
                .filter_map(|k| number(values, k))
                .sum();
            Some(if tests >= code * 0.3 { "ok" } else { "thin" })
        }
        _ => None,
    }
}

#[cfg(test)]
#[path = "quality_tests.rs"]
mod tests;
