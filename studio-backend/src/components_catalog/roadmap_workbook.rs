//! The roadmap workbook: the planning team's `back_roadmap.xlsx`, built from
//! the catalogue instead of by a script over the board.
//!
//! The same thirteen-odd sheets, laid out the same way: **Summary** (one row
//! per group, formulas over the group sheets), **Roadmap** (the groups as
//! swimlanes over the next nine months, a box per gear at its milestone),
//! **Gantt** (each team's remaining work scheduled against its people and
//! power), **People**, one sheet per group and **ALL**. The rules are the
//! script's, ported rule for rule -- how progress is read off a column, how
//! a gear is scheduled, when a cell turns red -- so the two agree on the same
//! board. What it is drawn from:
//!
//! * the board's gears as the last sync stored them (`roadmap_item` nodes,
//!   their `sheet`: every column's value as the board wrote it);
//! * the board's plan (`roadmap_plan`, the team's `gears.yaml`): teams,
//!   people and power for the Gantt and People sheets, the swimlane order,
//!   and the consumer-project columns;
//! * today, which anchors both timelines and decides what is overdue.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde_json::{Map, Value as Json};
use time::{Date, Duration, Month};

use super::roadmap_plan::{Plan, UNASSIGNED, hex};
use super::xlsx::{
    Align, Border, Cell, Font, Rule, Shape, Sheet, Side, Style, Value, col_name, workbook,
};

const MAN_DAYS_PER_WEEK: f64 = 5.0;
const MAN_DAYS_PER_MONTH: f64 = 22.0;
const SLOTS_PER_MONTH: u32 = 2;
const SLOT_DAYS: f64 = MAN_DAYS_PER_MONTH / SLOTS_PER_MONTH as f64;

// The Roadmap sheet's geometry and colours, from the team's slide template.
// Not π: the template's left margin, which happens to be as wide.
#[allow(clippy::approx_constant)]
const COL_A_WIDTH: f64 = 3.14;
const COL_B_WIDTH: f64 = 3.71;
const COL_C_WIDTH: f64 = 22.78;
const MONTH_COL_WIDTH: f64 = 13.97;
const SLIDE_SCALE: f64 = 1.3;
const RIGHT_MARGIN_WIDTH: f64 = 8.86;
const OUTSIDE: &str = "595959";
const TOP_MARGIN_HEIGHT: f64 = 17.55;
const PRE_TITLE_HEIGHT: f64 = 20.45;
const TITLE_HEIGHT: f64 = 27.0;
const POST_TITLE_HEIGHT: f64 = 15.0;
const QUARTER_HEIGHT: f64 = 24.0;
const MONTH_HEIGHT: f64 = 18.0;
const PRE_SWIMLANE_HEIGHT: f64 = 10.15;
const ITEM_ROW_HEIGHT: f64 = 22.0;
const SPACER_HEIGHT: f64 = 7.15;
const BOTTOM_MARGIN_HEIGHT: f64 = 22.15;
const MAX_ITEM_CHARS: usize = 42;
const CHAR_WIDTH: f64 = 0.85;
const FILLED: char = '\u{25C6}';
const EMPTY: char = '\u{25C7}';
const QUARTER_FILL: &str = "305496";
const MONTH_FILL: &str = "203764";
const HEADER_TEXT: &str = "FFFFFF";
const TITLE_TEXT: &str = "305496";
const COMMIT_FILL: &str = "4472C4";
const NONCOMMIT_TEXT: &str = "305496";
const GRID: &str = "FFFFFF";
/// Label, even body and odd body fills of the alternating swimlanes.
const LANES: [(&str, &str, &str); 2] = [
    ("8FAADC", "D6DCE4", "E9ECF0"),
    ("B4C7E7", "D9E2F3", "E8EDF8"),
];

// The issue sheets' colours.
const HEADER_FILL: &str = "4472C4";
const PROJECT_HEADER_FILL: &str = "C00000";
const LINK: &str = "0563C1";
const DONE_FILL: &str = "E2EFDA";
const UNKNOWN: (&str, &str) = ("FFC7CE", "9C0006");
const NO: (&str, &str) = ("D9D9D9", "666666");
const YES: (&str, &str) = ("C6EFCE", "006100");
const LATE: (&str, &str) = ("FF0000", "FFFFFF");

// ── a gear, as the sheet reads it ───────────────────────────────────────────

/// One gear as the board says it.
#[derive(Clone, Debug, Default)]
pub struct Row {
    pub board: String,
    pub ix: u64,
    pub number: Option<u64>,
    pub title: String,
    pub url: Option<String>,
    pub assignees: Vec<String>,
    pub kind: Option<String>,
    pub milestone: Option<String>,
    /// Every board and issue field, under the board's own name.
    pub fields: Map<String, Json>,
    pub card: BTreeMap<String, String>,
    pub blocked_by: Vec<u64>,
    /// `YY.MM`, from the Gantt schedule; empty for a finished gear.
    pub forecast: String,
}

impl Row {
    /// A stored `roadmap_item` node's payload as a row.
    pub fn from_node(v: &Json) -> Row {
        let sheet = v.get("sheet").cloned().unwrap_or(Json::Null);
        let s = |p: &str| v.pointer(p).and_then(Json::as_str).map(str::to_string);
        Row {
            board: s("/board").unwrap_or_default(),
            ix: v.get("ix").and_then(Json::as_u64).unwrap_or(u64::MAX),
            number: v.get("number").and_then(Json::as_u64),
            title: s("/title").unwrap_or_default(),
            url: s("/url"),
            assignees: v
                .get("assignees")
                .and_then(Json::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default(),
            kind: sheet.get("type").and_then(Json::as_str).map(str::to_string),
            milestone: sheet
                .get("milestone")
                .and_then(Json::as_str)
                .map(str::to_string),
            fields: sheet
                .get("fields")
                .and_then(Json::as_object)
                .cloned()
                .unwrap_or_default(),
            card: sheet
                .get("card")
                .and_then(Json::as_object)
                .map(|m| {
                    m.iter()
                        .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
                        .collect()
                })
                .unwrap_or_default(),
            blocked_by: sheet
                .get("blocked_by")
                .and_then(Json::as_array)
                .map(|a| a.iter().filter_map(Json::as_u64).collect())
                .unwrap_or_default(),
            forecast: String::new(),
        }
    }

    /// The first field whose name, letters and digits only, is one of these.
    fn field(&self, names: &[&str]) -> Option<&Json> {
        let wanted: Vec<String> = names.iter().map(|n| normalize(n)).collect();
        self.fields
            .iter()
            .find(|(k, _)| wanted.contains(&normalize(k)))
            .map(|(_, v)| v)
    }

    fn spec(&self) -> Option<f64> {
        progress(self.field(&["Design", "Spec", "Specification"]))
    }
    fn sdk(&self) -> Option<f64> {
        progress(self.field(&["SDK"]))
    }
    fn implemented(&self) -> Option<f64> {
        progress(self.field(&[
            "Implemenation",
            "Implementation status",
            "Implementation",
            "Impl",
            "Impl.",
        ]))
    }
    fn done(&self) -> bool {
        self.implemented() == Some(1.0)
    }
    fn status(&self) -> Option<String> {
        self.field(&["Status"]).map(json_text)
    }
    fn commitment(&self) -> Option<String> {
        self.field(&["Commitment"]).map(json_text)
    }
    fn committed(&self) -> bool {
        matches!(
            self.commitment()
                .unwrap_or_default()
                .trim()
                .to_lowercase()
                .as_str(),
            "yes" | "true" | "1" | "committed" | "commitment"
        )
    }
    fn effort(&self) -> Option<i64> {
        let (_, v) = self.fields.iter().find(|(k, _)| is_effort_field(k))?;
        match v {
            Json::Number(n) => n.as_f64().map(|f| f.trunc() as i64),
            Json::String(s) => {
                let t = s.trim();
                if t.is_empty() || t == "-" {
                    return None;
                }
                t.replace(',', ".")
                    .parse::<f64>()
                    .ok()
                    .map(|f| f.trunc() as i64)
            }
            _ => None,
        }
    }
    fn remaining(&self) -> Option<f64> {
        let effort = self.effort()? as f64;
        let p = self.implemented().unwrap_or(0.0).clamp(0.0, 1.0);
        Some((effort * (1.0 - p)).max(0.0))
    }
    fn start(&self) -> Option<Date> {
        parse_date(&json_text(self.field(&[
            "Start Date",
            "Start date",
            "Start",
        ])?))
    }
    fn backlog(&self) -> bool {
        self.milestone
            .as_deref()
            .is_some_and(|m| m.trim().eq_ignore_ascii_case("backlog"))
    }
    fn group(&self) -> String {
        let t = self.title.trim();
        if t.is_empty() {
            return "Ungrouped".to_string();
        }
        let prefix = t.split(" - ").next().unwrap_or(t).trim();
        if prefix.is_empty() {
            "Ungrouped".to_string()
        } else {
            prefix.to_string()
        }
    }

    /// The month a gear is placed in: a date the board gave it, else its
    /// milestone read as a month (`26.09`, `Q3 2026`, `Sep 2026`).
    fn month(&self) -> Option<(i32, u32)> {
        let dated = self
            .card
            .values()
            .cloned()
            .chain(self.fields.values().map(json_text))
            .find_map(|t| iso_month(t.trim()));
        if dated.is_some() {
            return dated;
        }
        milestone_month(self.milestone.as_deref().unwrap_or_default())
    }
}

fn normalize(name: &str) -> String {
    super::roadmap_plan::normalize(name)
}

fn json_text(v: &Json) -> String {
    match v {
        Json::String(s) => s.clone(),
        Json::Number(n) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 => format!("{f:.0}"),
            _ => n.to_string(),
        },
        Json::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}

/// `Done` → 1, `Todo` → 0, `80%` → 0.8, `N/A` → none.
pub fn progress(v: Option<&Json>) -> Option<f64> {
    let v = v?;
    if let Json::Number(n) = v {
        let f = n.as_f64()?;
        if f < 0.0 {
            return None;
        }
        return Some(if f > 1.0 { f / 100.0 } else { f });
    }
    let text = json_text(v).trim().to_lowercase();
    if text.is_empty() || text == "-" {
        return None;
    }
    match text.as_str() {
        "n/a" | "na" | "n\\a" => return None,
        "todo" | "to do" | "not started" | "open" | "planned" => return Some(0.0),
        "done" | "complete" | "completed" | "closed" => return Some(1.0),
        "in progress" | "in-progress" | "doing" => return Some(0.5),
        _ => {}
    }
    if let Some(pos) = text.find('%') {
        let digits: String = text[..pos]
            .trim_end()
            .chars()
            .rev()
            .take_while(|c| c.is_ascii_digit() || *c == '.' || *c == ',')
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        if let Ok(n) = digits.replace(',', ".").parse::<f64>() {
            return Some(n / 100.0);
        }
    }
    let n: f64 = text.replace(',', ".").parse().ok()?;
    Some(if n > 1.0 { n / 100.0 } else { n })
}

fn is_effort_field(name: &str) -> bool {
    let words: Vec<String> = name
        .to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect();
    let has = |w: &str| words.iter().any(|x| x == w);
    (has("estimate") || has("estimated") || has("estimation"))
        && (has("effort") || has("efforts"))
        && has("m")
        && has("d")
}

fn iso_month(t: &str) -> Option<(i32, u32)> {
    let b = t.as_bytes();
    let ok = |r: std::ops::Range<usize>| {
        b.get(r.clone())
            .is_some_and(|s| s.iter().all(u8::is_ascii_digit))
    };
    if !(b.len() == 7 || b.len() == 10) || !ok(0..4) || b[4] != b'-' || !ok(5..7) {
        return None;
    }
    if b.len() == 10 && (b[7] != b'-' || !ok(8..10)) {
        return None;
    }
    Some((t[0..4].parse().ok()?, t[5..7].parse().ok()?))
}

const MONTHS: [(&str, &str); 12] = [
    ("january", "jan"),
    ("february", "feb"),
    ("march", "mar"),
    ("april", "apr"),
    ("may", "may"),
    ("june", "jun"),
    ("july", "jul"),
    ("august", "aug"),
    ("september", "sep"),
    ("october", "oct"),
    ("november", "nov"),
    ("december", "dec"),
];

fn milestone_month(m: &str) -> Option<(i32, u32)> {
    let m = m.trim();
    let lower = m.to_lowercase();
    let words: Vec<&str> = lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    let year = |w: &str| {
        (w.len() == 4 && w.chars().all(|c| c.is_ascii_digit()))
            .then(|| w.parse::<i32>().ok())
            .flatten()
    };
    // `Q3 2026` / `2026 Q3` / `Q3'2026`.
    for (i, w) in words.iter().enumerate() {
        if w.len() == 2 && w.starts_with('q') {
            let q: u32 = w[1..].parse().unwrap_or(0);
            if (1..=4).contains(&q) {
                let next = words.get(i + 1).and_then(|n| year(n));
                let prev = i.checked_sub(1).and_then(|p| year(words[p]));
                if let Some(y) = next.or(prev) {
                    return Some((y, (q - 1) * 3 + 1));
                }
            }
        }
    }
    // `26.09`.
    if m.len() == 5 && m.as_bytes()[2] == b'.' {
        let (yy, mm) = (m[..2].parse::<i32>().ok(), m[3..].parse::<u32>().ok());
        if let (Some(yy), Some(mm)) = (yy, mm)
            && (1..=12).contains(&mm)
        {
            return Some((2000 + yy, mm));
        }
    }
    // `Sep 2026` / `2026 September`.
    for (i, w) in words.iter().enumerate() {
        if let Some(n) = MONTHS
            .iter()
            .position(|(full, abbr)| w == full || w == abbr)
        {
            let next = words.get(i + 1).and_then(|n| year(n));
            let prev = i.checked_sub(1).and_then(|p| year(words[p]));
            if let Some(y) = next.or(prev) {
                return Some((y, n as u32 + 1));
            }
        }
    }
    None
}

/// `26.09` (or `26-09`, `26/9`): two-digit year and month.
fn yy_mm(v: &str) -> Option<(i32, u32)> {
    let t = v.trim();
    let b = t.as_bytes();
    if b.len() < 4
        || !b[0].is_ascii_digit()
        || !b[1].is_ascii_digit()
        || !matches!(b[2], b'.' | b'-' | b'/')
    {
        return None;
    }
    let digits: String = t[3..]
        .chars()
        .take_while(char::is_ascii_digit)
        .take(2)
        .collect();
    let month: u32 = digits.parse().ok()?;
    if !(1..=12).contains(&month) {
        return None;
    }
    Some((t[..2].parse().ok()?, month))
}

/// `Q3'26`: the two-digit year and the quarter's last month.
fn need_quarter(v: &str) -> Option<(i32, u32)> {
    let t = v.trim();
    let b = t.as_bytes();
    if b.len() < 5 || !(b[0] == b'Q' || b[0] == b'q') {
        return None;
    }
    let q = (b[1] as char).to_digit(10)?;
    if !(1..=4).contains(&q) || b[2] != b'\'' {
        return None;
    }
    let rest = t[3..].trim_start();
    if rest.len() != 2 || !rest.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some((rest.parse().ok()?, q * 3))
}

fn parse_date(t: &str) -> Option<Date> {
    let t = t.trim();
    let num = |s: &str| s.parse::<i32>().ok();
    let make = |y: i32, m: i32, d: i32| {
        Date::from_calendar_date(
            y,
            Month::try_from(u8::try_from(m).ok()?).ok()?,
            u8::try_from(d).ok()?,
        )
        .ok()
    };
    for sep in ['-', '/'] {
        let p: Vec<&str> = t.split(sep).collect();
        if p.len() == 3 && p[0].len() == 4 {
            return make(num(p[0])?, num(p[1])?, num(p[2])?);
        }
        if p.len() == 3 && p[0].len() == 2 && p[2].len() <= 2 {
            return make(2000 + num(p[0])?, num(p[1])?, num(p[2])?);
        }
    }
    let p: Vec<&str> = t.split('.').collect();
    if p.len() == 3 && p[2].len() == 4 {
        return make(num(p[2])?, num(p[1])?, num(p[0])?);
    }
    if p.len() == 3 && p[0].len() == 2 {
        return make(2000 + num(p[0])?, num(p[1])?, num(p[2])?);
    }
    // `Sep 5, 2026`.
    let words: Vec<String> = t
        .to_lowercase()
        .split([' ', ','])
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect();
    if words.len() == 3 {
        let m = MONTHS
            .iter()
            .position(|(f, a)| words[0] == *f || words[0] == *a)?;
        return make(num(&words[2])?, m as i32 + 1, num(&words[1])?);
    }
    None
}

fn month_start(d: Date) -> Date {
    d.replace_day(1).unwrap_or(d)
}

fn next_month(d: Date) -> Date {
    let (y, m) = (d.year(), d.month());
    let (y, m) = if m == Month::December {
        (y + 1, Month::January)
    } else {
        (y, m.next())
    };
    Date::from_calendar_date(y, m, 1).unwrap_or(d)
}

fn months_from(start: Date, count: usize) -> Vec<(i32, u32)> {
    let mut out = Vec::with_capacity(count);
    let mut d = month_start(start);
    for _ in 0..count {
        out.push((d.year(), u32::from(u8::from(d.month()))));
        d = next_month(d);
    }
    out
}

fn ym_date(y: i32, m: u32) -> Option<Date> {
    Date::from_calendar_date(y, Month::try_from(u8::try_from(m).ok()?).ok()?, 1).ok()
}

fn month_abbr(m: u32) -> &'static str {
    [
        "Jan", "Feb", "Mar", "April", "May", "June", "July", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]
    .get(m.saturating_sub(1) as usize)
    .copied()
    .unwrap_or("")
}

fn quarter_label(y: i32, m: u32) -> String {
    format!("{y} Q{}", (m - 1) / 3 + 1)
}

/// The quarter runs of a month list: `(first month ix, last month ix, first
/// col, last col, quarter's year, quarter's first month)`.
fn quarter_spans(
    months: &[(i32, u32)],
    start_col: u32,
    per_month: u32,
) -> Vec<(usize, usize, u32, u32, i32, u32)> {
    let mut out = Vec::new();
    if months.is_empty() {
        return out;
    }
    let key = |(y, m): (i32, u32)| (y, (m - 1) / 3);
    let mut begin = 0usize;
    let mut current = key(months[0]);
    for i in 1..=months.len() {
        let next = months.get(i).map(|m| key(*m));
        if next != Some(current) {
            out.push((
                begin,
                i - 1,
                start_col + begin as u32 * per_month,
                start_col + i as u32 * per_month - 1,
                current.0,
                current.1 * 3 + 1,
            ));
            if let Some(n) = next {
                begin = i;
                current = n;
            }
        }
    }
    out
}

fn fmt_number(v: f64) -> String {
    if (v - v.round()).abs() < 0.05 {
        format!("{}", v.round() as i64)
    } else {
        let s = format!("{v:.1}");
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

fn contrast(bg: &str) -> &'static str {
    let t = hex(bg, COMMIT_FILL);
    let c = |i: usize| f64::from(u8::from_str_radix(&t[i..i + 2], 16).unwrap_or(0));
    if 0.299 * c(0) + 0.587 * c(2) + 0.114 * c(4) > 160.0 {
        "000000"
    } else {
        "FFFFFF"
    }
}

fn strip_group(title: &str) -> String {
    match title.split_once(" - ") {
        Some((_, rest)) => rest.trim().to_string(),
        None => title.to_string(),
    }
}

// ── the Gantt schedule ──────────────────────────────────────────────────────

/// The order gears claim capacity in: backlog last, the soonest milestone
/// first, then start date, then how soon and how widely the projects need it.
#[derive(Clone, Debug, PartialEq)]
struct SortKey {
    backlog: u8,
    milestone: i64,
    start: i64,
    earliest: i64,
    neg_count: i64,
    neg_score: f64,
    title: String,
}

impl Eq for SortKey {}
impl PartialOrd for SortKey {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for SortKey {
    fn cmp(&self, o: &Self) -> std::cmp::Ordering {
        (
            self.backlog,
            self.milestone,
            self.start,
            self.earliest,
            self.neg_count,
        )
            .cmp(&(o.backlog, o.milestone, o.start, o.earliest, o.neg_count))
            .then(self.neg_score.total_cmp(&o.neg_score))
            .then_with(|| self.title.cmp(&o.title))
    }
}

#[derive(Clone, Debug)]
struct GanttItem {
    row: usize,
    title: String,
    url: Option<String>,
    remaining: f64,
    duration: f64,
    key: SortKey,
    color: String,
    start: u32,
    span: u32,
    lane_row: u32,
    blocked_by: Vec<u64>,
}

#[derive(Clone, Debug)]
struct Lane {
    tag: String,
    people: u32,
    items: Vec<GanttItem>,
    slots: u32,
    intervals: Vec<(u32, u32)>,
}

struct Context<'a> {
    plan: &'a Plan,
    today: Date,
}

impl Context<'_> {
    fn needs_priority(&self, row: &Row) -> (i64, i64, f64) {
        let Some(number) = row.number else {
            return (999_999, 0, 0.0);
        };
        let Some(needs) = self.plan.needs.get(&number.to_string()) else {
            return (999_999, 0, 0.0);
        };
        let mut counts: BTreeMap<i64, i64> = BTreeMap::new();
        for v in needs.values() {
            if let Some((y, m)) = need_quarter(v) {
                *counts.entry(i64::from(y) * 12 + i64::from(m)).or_default() += 1;
            }
        }
        let Some((&earliest, &count)) = counts.iter().next() else {
            return (999_999, 0, 0.0);
        };
        let score: f64 = counts
            .iter()
            .map(|(q, c)| *c as f64 / (1.0 + ((q - earliest).max(0) as f64) / 3.0))
            .sum();
        (earliest, count, score)
    }

    fn sort_key(&self, row: &Row) -> SortKey {
        let (earliest, count, score) = self.needs_priority(row);
        let start = row.start().map_or(0, |d| {
            i64::from(d.year()) * 10_000 + i64::from(u8::from(d.month())) * 100 + i64::from(d.day())
        });
        SortKey {
            backlog: u8::from(row.backlog()),
            milestone: row
                .month()
                .map_or(999_999, |(y, m)| i64::from(y) * 12 + i64::from(m)),
            start,
            earliest,
            neg_count: -count,
            neg_score: -score,
            title: row.title.clone(),
        }
    }

    fn row_teams(&self, row: &Row) -> Vec<String> {
        let mut tags: Vec<String> = Vec::new();
        for login in &row.assignees {
            let tag = self.plan.user_team_tag(login);
            let tag = if tag.is_empty() {
                UNASSIGNED.to_string()
            } else {
                tag
            };
            if !tags.contains(&tag) {
                tags.push(tag);
            }
        }
        if tags.is_empty() {
            tags.push(UNASSIGNED.to_string());
        }
        tags
    }

    fn elapsed_slots(&self) -> u32 {
        let d = self.today;
        let days = f64::from(d.month().length(d.year()));
        let fraction = f64::from(d.day() - 1) / days;
        (fraction * f64::from(SLOTS_PER_MONTH))
            .round_ties_even()
            .max(0.0) as u32
    }

    fn slot_of(date: Option<Date>, start: Date) -> u32 {
        match date {
            Some(d) if d > start => ((d - start).whole_days() as f64 / SLOT_DAYS)
                .ceil()
                .max(0.0) as u32,
            _ => 0,
        }
    }

    /// Schedule every unfinished gear on its teams' lanes.
    fn lanes(&self, rows: &[Row]) -> Vec<Lane> {
        let mut lanes: Vec<Lane> = Vec::new();
        for (ri, row) in rows.iter().enumerate() {
            if row.implemented().is_some_and(|p| p >= 1.0) {
                continue;
            }
            let remaining = row.remaining().unwrap_or(1.0);
            if remaining <= 0.0 {
                continue;
            }
            let teams = self.row_teams(row);
            let per_team = remaining / teams.len() as f64;
            for tag in teams {
                let power = self.plan.team_power(&tag);
                let people = self.plan.team_people(&tag);
                let item = GanttItem {
                    row: ri,
                    title: strip_group(if row.title.is_empty() {
                        "Untitled"
                    } else {
                        &row.title
                    }),
                    url: row.url.clone(),
                    remaining: per_team,
                    duration: per_team / power * f64::from(people),
                    key: self.sort_key(row),
                    color: self.plan.team_color(&tag),
                    start: 0,
                    span: 1,
                    lane_row: 0,
                    blocked_by: row.blocked_by.clone(),
                };
                match lanes.iter_mut().find(|l| l.tag == tag) {
                    Some(l) => l.items.push(item),
                    None => lanes.push(Lane {
                        tag,
                        people,
                        items: vec![item],
                        slots: 0,
                        intervals: Vec::new(),
                    }),
                }
            }
        }

        // Every gear, blockers first: a topological order over `blocked by`,
        // ties broken by the sort key.
        let mut by_number: BTreeMap<u64, Vec<(usize, usize)>> = BTreeMap::new();
        let mut unnumbered: Vec<(usize, usize)> = Vec::new();
        for (li, lane) in lanes.iter().enumerate() {
            for (ii, item) in lane.items.iter().enumerate() {
                match rows[item.row].number {
                    Some(n) => by_number.entry(n).or_default().push((li, ii)),
                    None => unnumbered.push((li, ii)),
                }
            }
        }
        let key_of = |n: &u64| -> SortKey {
            by_number[n]
                .iter()
                .map(|(l, i)| lanes[*l].items[*i].key.clone())
                .min()
                .unwrap_or(SortKey {
                    backlog: 0,
                    milestone: 999_999,
                    start: 0,
                    earliest: 0,
                    neg_count: 0,
                    neg_score: 0.0,
                    title: n.to_string(),
                })
        };
        let known: BTreeSet<u64> = by_number.keys().copied().collect();
        let blockers = |n: &u64| -> Vec<u64> {
            let (l, i) = by_number[n][0];
            rows[lanes[l].items[i].row]
                .blocked_by
                .iter()
                .copied()
                .filter(|d| known.contains(d) && d != n)
                .collect::<BTreeSet<u64>>()
                .into_iter()
                .collect()
        };
        let keys: HashMap<u64, SortKey> = known.iter().map(|n| (*n, key_of(n))).collect();
        let mut indegree: HashMap<u64, usize> =
            known.iter().map(|n| (*n, blockers(n).len())).collect();
        let mut dependents: HashMap<u64, Vec<u64>> = HashMap::new();
        for n in &known {
            for d in blockers(n) {
                dependents.entry(d).or_default().push(*n);
            }
        }
        let mut ready: BTreeSet<(SortKey, u64)> = known
            .iter()
            .filter(|n| indegree[n] == 0)
            .map(|n| (keys[n].clone(), *n))
            .collect();
        let mut order: Vec<u64> = Vec::new();
        while let Some((_, n)) = ready.pop_first() {
            order.push(n);
            for d in dependents.get(&n).cloned().unwrap_or_default() {
                if let Some(c) = indegree.get_mut(&d) {
                    *c -= 1;
                    if *c == 0 {
                        ready.insert((keys[&d].clone(), d));
                    }
                }
            }
        }
        if order.len() < known.len() {
            // A cycle: no topological order, only the sort key.
            order = known.iter().copied().collect();
            order.sort_by(|a, b| keys[a].cmp(&keys[b]));
        }
        let mut sequence: Vec<(usize, usize)> = Vec::new();
        for n in &order {
            let mut items = by_number[n].clone();
            items.sort_by(|a, b| lanes[a.0].items[a.1].key.cmp(&lanes[b.0].items[b.1].key));
            sequence.extend(items);
        }
        unnumbered.sort_by(|a, b| lanes[a.0].items[a.1].key.cmp(&lanes[b.0].items[b.1].key));
        sequence.extend(unnumbered);
        // Backlog after everything else; stable otherwise.
        sequence.sort_by_key(|(l, i)| u8::from(rows[lanes[*l].items[*i].row].backlog()));

        let schedule_start = month_start(self.today);
        let elapsed = self.elapsed_slots();
        let mut finish: HashMap<u64, u32> = HashMap::new();
        let mut scheduled: BTreeSet<(usize, usize)> = BTreeSet::new();
        for (l, i) in sequence {
            let row = &rows[lanes[l].items[i].row];
            let capacity = lanes[l].people.max(1);
            let span = ((lanes[l].items[i].duration / SLOT_DAYS).ceil() as u32).max(1);
            let dep = row
                .blocked_by
                .iter()
                .map(|d| finish.get(d).copied().unwrap_or(0))
                .max()
                .unwrap_or(0);
            let earliest = elapsed
                .max(Self::slot_of(row.start(), schedule_start))
                .max(dep);
            let start = earliest_capacity_slot(&lanes[l].intervals, earliest, span, capacity);
            lanes[l].items[i].start = start;
            lanes[l].items[i].span = span;
            lanes[l].intervals.push((start, start + span));
            scheduled.insert((l, i));
            if let Some(n) = row.number {
                let all = &by_number[&n];
                if all.iter().all(|x| scheduled.contains(x)) {
                    let end = all
                        .iter()
                        .map(|(l, i)| lanes[*l].items[*i].start + lanes[*l].items[*i].span)
                        .max()
                        .unwrap_or(0);
                    finish.insert(n, end);
                }
            }
        }

        for lane in &mut lanes {
            let mut order: Vec<usize> = (0..lane.items.len()).collect();
            order.sort_by(|a, b| {
                let (x, y) = (&lane.items[*a], &lane.items[*b]);
                x.start
                    .cmp(&y.start)
                    .then(y.span.cmp(&x.span))
                    .then_with(|| x.key.cmp(&y.key))
            });
            let mut ends: Vec<u32> = Vec::new();
            for ix in order {
                let (s, e) = (
                    lane.items[ix].start,
                    lane.items[ix].start + lane.items[ix].span,
                );
                let slot = match ends.iter().position(|end| *end <= s) {
                    Some(p) => {
                        ends[p] = e;
                        p
                    }
                    None => {
                        ends.push(e);
                        ends.len() - 1
                    }
                };
                lane.items[ix].lane_row = slot as u32;
            }
            lane.items.sort_by(|x, y| {
                x.start
                    .cmp(&y.start)
                    .then(x.lane_row.cmp(&y.lane_row))
                    .then_with(|| x.key.cmp(&y.key))
            });
            lane.slots = ends.iter().copied().max().unwrap_or(0);
        }
        lanes.sort_by_key(|l| self.plan.lane_order(&l.tag));
        lanes
    }

    /// Each unfinished gear's forecast: the month its last bar ends.
    fn forecasts(&self, rows: &mut [Row]) {
        for r in rows.iter_mut() {
            r.forecast = String::new();
        }
        let start = month_start(self.today);
        let mut latest: HashMap<usize, Date> = HashMap::new();
        for lane in self.lanes(rows) {
            for item in &lane.items {
                let end = item.start + item.span;
                let date = start + Duration::days((f64::from(end) * SLOT_DAYS) as i64);
                let e = latest.entry(item.row).or_insert(date);
                if date > *e {
                    *e = date;
                }
            }
        }
        for (ix, d) in latest {
            rows[ix].forecast = format!("{:02}.{:02}", d.year() % 100, u8::from(d.month()));
        }
    }
}

fn earliest_fit_slot(intervals: &[(u32, u32)], earliest: u32, span: u32) -> u32 {
    let mut sorted = intervals.to_vec();
    sorted.sort_unstable();
    let mut candidate = earliest;
    for (s, e) in sorted {
        if e <= candidate {
            continue;
        }
        if s >= candidate && s - candidate >= span {
            return candidate;
        }
        candidate = candidate.max(e);
    }
    candidate
}

/// The earliest start at or after `earliest` where fewer than `capacity`
/// bars overlap anywhere in `[start, start + span)`.
fn earliest_capacity_slot(
    intervals: &[(u32, u32)],
    earliest: u32,
    span: u32,
    capacity: u32,
) -> u32 {
    if capacity <= 1 {
        return earliest_fit_slot(intervals, earliest, span);
    }
    let mut positions: BTreeSet<u32> = BTreeSet::from([earliest]);
    for (s, e) in intervals {
        if *e >= earliest {
            positions.insert((*e).max(earliest));
        }
        if *s >= earliest {
            positions.insert(*s);
        }
    }
    for candidate in &positions {
        let end = candidate + span;
        let mut points = vec![*candidate];
        for (s, e) in intervals {
            for b in [*s, *e] {
                if *candidate < b && b < end {
                    points.push(b);
                }
            }
        }
        let fits = points
            .iter()
            .all(|p| intervals.iter().filter(|(s, e)| s <= p && p < e).count() < capacity as usize);
        if fits {
            return *candidate;
        }
    }
    positions.iter().next_back().copied().unwrap_or(earliest)
}

// ── styles ──────────────────────────────────────────────────────────────────

fn fill(c: &Cell, rgb: &str) -> Style {
    let mut s = c.style.clone();
    s.fill = Some(rgb.to_string());
    s
}

fn header_style(fill_rgb: &str) -> Style {
    Style {
        font: Font::default().bold().color(HEADER_TEXT),
        fill: Some(fill_rgb.to_string()),
        border: Border::all(Side::thin(None)),
        align: Align {
            horizontal: Some("center"),
            ..Align::default()
        },
        num_fmt: None,
    }
}

fn paint(sheet: &mut Sheet, row: u32, col: u32, rgb: &str) {
    let c = sheet.cell(row, col);
    c.style = fill(c, rgb);
}

fn white_thin() -> Border {
    Border::all(Side::thin(Some(GRID)))
}

fn opt_num(v: Option<f64>) -> Option<Value> {
    v.map(Value::Number)
}

fn milestone_cell(v: &str) -> Option<Value> {
    if v.is_empty() {
        return None;
    }
    match yy_mm(v).and_then(|(y, m)| ym_date(2000 + y, m)) {
        Some(d) => Some(Value::Date(d)),
        None => Some(Value::Text(v.to_string())),
    }
}

fn months_index((y, m): (i32, u32)) -> i64 {
    i64::from(y) * 12 + i64::from(m)
}

// ── the workbook ────────────────────────────────────────────────────────────

/// The workbook for these gears and this plan, as of `today`: the `.xlsx`
/// file's bytes.
pub fn build(planned: &[Json], plan: &Plan, today: Date) -> Vec<u8> {
    workbook(&sheets(planned, plan, today))
}

/// The rows the workbook lists: the boards' gears, in board order.
pub fn rows_of(planned: &[Json]) -> Vec<Row> {
    // A sync before the workbook existed stored no `gear` flag; then every
    // stored item is one.
    let flagged = planned.iter().any(|v| v.get("gear").is_some());
    let mut rows: Vec<Row> = planned
        .iter()
        .filter(|v| !flagged || v.get("gear").and_then(Json::as_bool) == Some(true))
        .map(Row::from_node)
        .collect();
    rows.sort_by(|a, b| (a.board.as_str(), a.ix).cmp(&(b.board.as_str(), b.ix)));
    rows
}

pub fn sheets(planned: &[Json], plan: &Plan, today: Date) -> Vec<Sheet> {
    let mut rows = rows_of(planned);
    let cx = Context { plan, today };
    cx.forecasts(&mut rows);
    let prio = prio_field(&rows);

    // Groups in first-seen order, then the configured order first.
    let mut groups: Vec<(String, Vec<usize>)> = Vec::new();
    for (i, r) in rows.iter().enumerate() {
        let g = r.group();
        match groups.iter_mut().find(|(k, _)| *k == g) {
            Some((_, v)) => v.push(i),
            None => groups.push((g, vec![i])),
        }
    }
    if groups.is_empty() {
        groups.push(("Ungrouped".to_string(), Vec::new()));
    }
    let mut ordered: Vec<(String, Vec<usize>)> = Vec::new();
    for slug in &plan.swimlane_order {
        let slug = slug.to_uppercase();
        for (k, v) in &groups {
            if k.to_uppercase() == slug && !ordered.iter().any(|(o, _)| o == k) {
                ordered.push((k.clone(), v.clone()));
            }
        }
    }
    for (k, v) in &groups {
        if !ordered.iter().any(|(o, _)| o == k) {
            ordered.push((k.clone(), v.clone()));
        }
    }

    let mut names: Vec<String> = vec![
        "Summary".into(),
        "Roadmap".into(),
        "Gantt".into(),
        "People".into(),
    ];
    let mut out: Vec<Sheet> = Vec::new();
    let roadmap = roadmap_sheet(&cx, &rows, &ordered);
    let gantt = gantt_sheet(&cx, &rows);
    let people = people_sheet(plan);
    let mut group_sheets: Vec<(String, String, usize)> = Vec::new();
    let mut tables: Vec<Sheet> = Vec::new();
    for (group, ix) in &ordered {
        let name = unique_name(group, &names);
        names.push(name.clone());
        let picked: Vec<&Row> = ix.iter().map(|i| &rows[*i]).collect();
        let mut s = issues_sheet(&name, plan, &picked, &prio, today);
        metrics_block(&mut s, picked.len());
        group_sheets.push((group.clone(), name, picked.len()));
        tables.push(s);
    }
    let all_name = unique_name("ALL", &names);
    let every: Vec<&Row> = rows.iter().collect();
    let mut all = issues_sheet(&all_name, plan, &every, &prio, today);
    metrics_block(&mut all, every.len());
    out.push(summary_sheet(plan, &group_sheets));
    out.push(roadmap);
    out.push(gantt);
    out.push(people);
    out.extend(tables);
    out.push(all);
    out
}

fn unique_name(group: &str, taken: &[String]) -> String {
    let base: String = group
        .chars()
        .map(|c| if "\\/?*[]:".contains(c) { ' ' } else { c })
        .collect::<String>()
        .trim()
        .chars()
        .take(31)
        .collect();
    let base = if base.is_empty() {
        "Sheet".to_string()
    } else {
        base
    };
    if !taken.contains(&base) {
        return base;
    }
    for n in 2.. {
        let extra = format!("_{n}");
        let cand: String = base.chars().take(31 - extra.len()).collect::<String>() + &extra;
        if !taken.contains(&cand) {
            return cand;
        }
    }
    base
}

/// The priority column: the first field named like one, preferring the
/// combined `Prio (A.C.V)` over a single consumer's.
fn prio_field(rows: &[Row]) -> String {
    let mut found: Option<String> = None;
    for r in rows {
        for k in r.fields.keys() {
            if k.to_lowercase().contains("prio") {
                if k.contains('(') {
                    return k.clone();
                }
                found.get_or_insert_with(|| k.clone());
            }
        }
    }
    found.unwrap_or_else(|| "Prio".to_string())
}

// ── an issue table (a group sheet, or ALL) ──────────────────────────────────

const PROJECT_COL: u32 = 26;

fn issues_sheet(name: &str, plan: &Plan, rows: &[&Row], prio: &str, today: Date) -> Sheet {
    let mut s = Sheet::new(name);
    let mut headers: Vec<&str> = vec![
        "#",
        "ID",
        "Title",
        "Type",
        "Assignees",
        "Name",
        "Team",
        "Prio",
        "Spec",
        "SDK",
        "Impl.",
        "Status",
        "Effort m*d",
        "Remaining (m*d)",
        "Commitment",
        "Milestone",
        "Forecast",
        "",
        "",
        "",
        "",
        "Is Plugin",
        "Has Plugins",
        "Has Extension Point",
        "Description",
    ];
    headers.extend(plan.projects.iter().map(|(_, n)| n.as_str()));
    for (i, h) in headers.iter().enumerate() {
        let col = i as u32 + 1;
        let c = s.set(
            1,
            col,
            (!h.is_empty()).then(|| Value::Text((*h).to_string())),
        );
        c.style = header_style(if col >= PROJECT_COL {
            PROJECT_HEADER_FILL
        } else {
            HEADER_FILL
        });
    }

    let mut sorted: Vec<&Row> = rows.to_vec();
    let prio_of = |r: &Row| {
        r.fields
            .get(prio)
            .map(json_text)
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| "zzz".to_string())
    };
    sorted.sort_by_key(|r| prio_of(r));

    let pct = |v: Option<f64>| (v, Some("0%"));
    let now = i64::from(today.year() % 100) * 12 + i64::from(u8::from(today.month()));
    for (i, r) in sorted.iter().enumerate() {
        let ri = i as u32 + 2;
        let implemented = r.implemented();
        let done = implemented == Some(1.0);
        let spec = r.spec();
        let sdk = r.sdk();
        let effort = r.effort();
        let milestone = r.milestone.clone().unwrap_or_default();
        let link = |s: &mut Sheet, col: u32| {
            if let Some(url) = &r.url {
                s.link(ri, col, url);
                s.cell(ri, col).style.font = Font::default().underline().color(LINK);
            }
        };
        s.set(ri, 1, Some(Value::Number(f64::from(ri - 1))));
        s.set(ri, 2, r.number.map(|n| Value::Number(n as f64)));
        link(&mut s, 2);
        s.set(ri, 3, Some(Value::Text(r.title.clone())));
        link(&mut s, 3);
        s.set(ri, 4, r.kind.clone().map(Value::Text));
        let text_or_none = |t: String| (!t.is_empty()).then_some(Value::Text(t));
        s.set(ri, 5, text_or_none(r.assignees.join(", ")));
        let aliases: Vec<String> = r.assignees.iter().map(|l| plan.alias(l)).collect();
        s.set(ri, 6, text_or_none(aliases.join(", ")));
        let mut teams: Vec<String> = Vec::new();
        for l in &r.assignees {
            let t = plan.user_team_name(l);
            let t = if t.is_empty() { plan.user_unit(l) } else { t };
            if !t.is_empty() && !teams.contains(&t) {
                teams.push(t);
            }
        }
        s.set(ri, 7, text_or_none(teams.join(", ")));
        s.set(
            ri,
            8,
            r.fields.get(prio).map(json_text).and_then(text_or_none),
        );
        for (col, (v, fmt)) in [(9, pct(spec)), (10, pct(sdk)), (11, pct(implemented))] {
            let c = s.set(ri, col, opt_num(v));
            c.style.num_fmt = fmt;
        }
        s.set(ri, 12, r.status().and_then(text_or_none));
        s.set(ri, 13, effort.map(|e| Value::Number(e as f64)))
            .style
            .num_fmt = Some("0");
        s.set(
            ri,
            14,
            effort.map(|_| Value::Formula(format!("M{ri}*(1-K{ri})"))),
        )
        .style
        .num_fmt = Some("0.00");
        s.set(ri, 15, r.commitment().and_then(text_or_none));
        s.set(ri, 16, milestone_cell(&milestone)).style.num_fmt = Some("yy.mm");
        s.set(ri, 17, milestone_cell(&r.forecast)).style.num_fmt = Some("yy.mm");
        for col in 1..=17 {
            if done {
                paint(&mut s, ri, col, DONE_FILL);
            }
        }
        if !done {
            let late = |s: &mut Sheet, col: u32| {
                let c = s.cell(ri, col);
                c.style.fill = Some(LATE.0.to_string());
                c.style.font = Font::default().color(LATE.1);
            };
            if milestone_past(&milestone, now) {
                late(&mut s, 16);
            }
            if later(&r.forecast, &milestone) {
                late(&mut s, 17);
            }
        }
        let helpers = [spec, sdk, implemented];
        for (k, v) in helpers.iter().enumerate() {
            s.set(ri, 18 + k as u32, opt_num(*v)).style.num_fmt = Some("0%");
        }
        let known: Vec<f64> = helpers.iter().flatten().copied().collect();
        let overall = (!known.is_empty()).then(|| known.iter().sum::<f64>() / known.len() as f64);
        s.set(ri, 21, opt_num(overall)).style.num_fmt = Some("0%");
        for (k, field) in [
            "Is Plugin",
            "Has Plugins",
            "Has Extension Point",
            "Description",
        ]
        .iter()
        .enumerate()
        {
            let col = 22 + k as u32;
            s.set(ri, col, r.card.get(*field).cloned().map(Value::Text));
            if done {
                paint(&mut s, ri, col, DONE_FILL);
            }
        }
        for (k, (key, _)) in plan.projects.iter().enumerate() {
            let col = PROJECT_COL + k as u32;
            let need = plan.need(r.number, key);
            let c = s.set(ri, col, need.clone().map(Value::Text));
            c.style.align.horizontal = Some("center");
            c.style.border = Border::all(Side::thin(None));
            let t = need.unwrap_or_default();
            let (f, font) = if !done && need_late(&t, &milestone) {
                (Some(LATE.0), Some(LATE.1))
            } else if t == "?" {
                (Some(UNKNOWN.0), Some(UNKNOWN.1))
            } else if t.eq_ignore_ascii_case("no") {
                (Some(NO.0), Some(NO.1))
            } else if !t.is_empty() {
                (Some(YES.0), Some(YES.1))
            } else {
                (None, None)
            };
            if let (Some(f), Some(font)) = (f, font) {
                c.style.fill = Some(f.to_string());
                c.style.font = Font::default().color(font);
            }
        }
    }

    let last = rows.len() as u32 + 1;
    if last >= 2 {
        for (col, color) in [("I", "63C384"), ("J", "5B9BD5"), ("K", "ED7D31")] {
            s.rule(
                format!("{col}2:{col}{last}"),
                Rule::DataBar {
                    color: color.into(),
                },
            );
        }
        s.rule(
            format!("P2:P{last}"),
            Rule::Formula {
                formula: "AND($K2<>1,$P2<>\"\",IFERROR(IF(ISNUMBER($P2),DATE(YEAR($P2),MONTH($P2),1),DATE(2000+VALUE(LEFT($P2,2)),VALUE(RIGHT($P2,2)),1))<DATE(YEAR(TODAY()),MONTH(TODAY()),1),FALSE))".into(),
                fill: LATE.0.into(),
                font: LATE.1.into(),
                stop: false,
            },
        );
        s.rule(
            format!("Q2:Q{last}"),
            Rule::Formula {
                formula: "AND($K2<>1,$Q2<>\"\",$P2<>\"\",IFERROR((IF(ISNUMBER($Q2),YEAR($Q2)-2000,VALUE(LEFT($Q2,2)))*12+IF(ISNUMBER($Q2),MONTH($Q2),VALUE(RIGHT($Q2,2))))>(IF(ISNUMBER($P2),YEAR($P2)-2000,VALUE(LEFT($P2,2)))*12+IF(ISNUMBER($P2),MONTH($P2),VALUE(RIGHT($P2,2)))),FALSE))".into(),
                fill: LATE.0.into(),
                font: LATE.1.into(),
                stop: false,
            },
        );
    }
    for col in 18..=21 {
        s.hide(col);
    }
    for (col, w) in [
        (1, 4.0),
        (2, 7.0),
        (3, 40.0),
        (4, 14.0),
        (5, 18.0),
        (6, 24.0),
        (7, 16.0),
        (8, 14.0),
        (9, 14.0),
        (10, 12.0),
        (11, 12.0),
        (12, 14.0),
        (13, 14.0),
        (14, 18.0),
        (15, 14.0),
        (16, 14.0),
        (17, 14.0),
        (22, 14.0),
        (23, 14.0),
        (24, 22.0),
        (25, 60.0),
    ] {
        s.width(col, w);
    }
    for k in 0..plan.projects.len() as u32 {
        s.width(PROJECT_COL + k, 14.0);
    }
    let last_project = if plan.projects.is_empty() {
        25
    } else {
        PROJECT_COL + plan.projects.len() as u32 - 1
    };
    if !plan.projects.is_empty() && last >= 2 {
        let first = format!("{}2", col_name(PROJECT_COL));
        let range = format!("{first}:{}{last}", col_name(last_project));
        let m = "$P2";
        s.rule(
            range.clone(),
            Rule::Formula {
                formula: format!(
                    "AND($K2<>1,LEFT({first},1)=\"Q\",IFERROR((IF(ISNUMBER({m}),YEAR({m})-2000,VALUE(LEFT({m},2)))*12+IF(ISNUMBER({m}),MONTH({m}),VALUE(RIGHT({m},2))))>(VALUE(RIGHT({first},2))*12+VALUE(MID({first},2,1))*3),FALSE))"
                ),
                fill: LATE.0.into(),
                font: LATE.1.into(),
                stop: true,
            },
        );
        for (formula, (f, font)) in [
            (format!("{first}=\"?\""), UNKNOWN),
            (format!("LOWER({first})=\"no\""), NO),
            (
                format!("AND({first}<>\"?\",LOWER({first})<>\"no\",{first}<>\"\")"),
                YES,
            ),
        ] {
            s.rule(
                range.clone(),
                Rule::Formula {
                    formula,
                    fill: f.into(),
                    font: font.into(),
                    stop: false,
                },
            );
        }
    }
    s.freeze(2, 4);
    s.filter(format!("A1:{}{last}", col_name(last_project.max(25))));
    s
}

fn milestone_past(milestone: &str, now: i64) -> bool {
    yy_mm(milestone).is_some_and(|(y, m)| i64::from(y) * 12 + i64::from(m) < now)
}

fn later(forecast: &str, milestone: &str) -> bool {
    match (yy_mm(forecast), yy_mm(milestone)) {
        (Some(f), Some(m)) => months_index(f) > months_index(m),
        _ => false,
    }
}

fn need_late(need: &str, milestone: &str) -> bool {
    match (need_quarter(need), yy_mm(milestone)) {
        (Some(q), Some(m)) => months_index(m) > months_index(q),
        _ => false,
    }
}

/// The metrics under a table: count, the three progress averages, overall,
/// how much is estimated, and the estimate in person-months.
fn metrics_block(s: &mut Sheet, count: usize) {
    let last = if count > 0 { count as u32 + 1 } else { 2 };
    let sr = last + 2;
    let label = Font::default().bold().sized(11.0);
    for (k, h) in ["Metric", "Value"].iter().enumerate() {
        let c = s.text(sr, 3 + k as u32, *h);
        c.style.font = Font::default().bold().sized(11.0).color("FFFFFF");
        c.style.fill = Some("5B9BD5".into());
        c.style.align.horizontal = Some("center");
    }
    let lines: [(&str, String, Option<&'static str>); 7] = [
        ("Items Count", format!("COUNTA(C2:C{last})"), None),
        (
            "Spec progress",
            format!("IF(COUNT(R2:R{last})=0,0,SUM(R2:R{last})/COUNT(R2:R{last}))"),
            Some("0%"),
        ),
        (
            "Estimation progress",
            format!("IF(COUNTA(C2:C{last})=0,0,COUNT(M2:M{last})/COUNTA(C2:C{last}))"),
            Some("0%"),
        ),
        (
            "SDK progress",
            format!("IF(COUNT(S2:S{last})=0,0,SUM(S2:S{last})/COUNT(S2:S{last}))"),
            Some("0%"),
        ),
        (
            "Impl. Progress",
            format!("IF(COUNT(T2:T{last})=0,0,SUM(T2:T{last})/COUNT(T2:T{last}))"),
            Some("0%"),
        ),
        (
            "Overall progress",
            format!("IF(COUNT(U2:U{last})=0,0,SUM(U2:U{last})/COUNT(U2:U{last}))"),
            Some("0%"),
        ),
        (
            "Estimates total (m*m)",
            format!("SUM(M2:M{last})/{MAN_DAYS_PER_MONTH}"),
            Some("0.00"),
        ),
    ];
    for (k, (name, formula, fmt)) in lines.into_iter().enumerate() {
        let r = sr + 1 + k as u32;
        s.text(r, 3, name).style.font = label.clone();
        let c = s.set(r, 4, Some(Value::Formula(formula)));
        c.style.font = Font::default().bold().sized(11.0);
        c.style.num_fmt = fmt;
    }
    s.rule(
        format!("D{}:D{}", sr + 2, sr + 6),
        Rule::DataBar {
            color: "63C384".into(),
        },
    );
}

// ── Summary ─────────────────────────────────────────────────────────────────

fn summary_sheet(plan: &Plan, groups: &[(String, String, usize)]) -> Sheet {
    let mut s = Sheet::new("Summary");
    let headers = [
        "#",
        "Subsystem",
        "Items Count",
        "Items Done",
        "Items Done %",
        "Spec Readiness %",
        "SDK Readiness %",
        "Impl. Progress %",
        "Estimation progress",
        "Estimate total (m*m)",
        "Remaining Estimate (m*d)",
    ];
    for (i, h) in headers.iter().enumerate() {
        s.text(1, i as u32 + 1, *h).style = header_style(HEADER_FILL);
    }
    for (i, (group, sheet, count)) in groups.iter().enumerate() {
        let r = i as u32 + 2;
        let last = if *count > 0 { *count as u32 + 1 } else { 2 };
        let sn = format!("'{sheet}'");
        s.set(r, 1, Some(Value::Number(f64::from(r - 1))))
            .style
            .font = Font::default().sized(11.0);
        s.text(r, 2, plan.swimlane_label(group)).style.font = Font::default().bold().sized(11.0);
        let avg = |col: &str| {
            format!(
                "IF(COUNT({sn}!{col}2:{col}{last})=0,0,SUM({sn}!{col}2:{col}{last})/COUNT({sn}!{col}2:{col}{last}))"
            )
        };
        let cells: [(u32, String, Option<&'static str>); 9] = [
            (3, format!("COUNTA({sn}!C2:C{last})"), None),
            (4, format!("COUNTIF({sn}!T2:T{last},1)"), None),
            (5, format!("IF(C{r}=0,0,D{r}/C{r})"), Some("0%")),
            (6, avg("R"), Some("0%")),
            (7, avg("S"), Some("0%")),
            (8, avg("T"), Some("0%")),
            (
                9,
                format!("IF(C{r}=0,0,COUNT({sn}!M2:M{last})/C{r})"),
                Some("0%"),
            ),
            (
                10,
                format!("SUM({sn}!M2:M{last})/{MAN_DAYS_PER_MONTH}"),
                Some("0.00"),
            ),
            (11, format!("SUM({sn}!N2:N{last})"), Some("0.00")),
        ];
        for (col, f, fmt) in cells {
            let c = s.set(r, col, Some(Value::Formula(f)));
            c.style.num_fmt = fmt;
            c.style.font = Font::default().sized(11.0);
        }
    }
    let last = groups.len() as u32 + 1;
    if last >= 2 {
        for (col, color) in [
            ("E", "4472C4"),
            ("F", "63C384"),
            ("G", "5B9BD5"),
            ("H", "ED7D31"),
            ("I", "63C384"),
        ] {
            s.rule(
                format!("{col}2:{col}{last}"),
                Rule::DataBar {
                    color: color.into(),
                },
            );
        }
    }
    for (col, w) in [
        (1, 5.0),
        (2, 22.0),
        (3, 14.0),
        (4, 14.0),
        (5, 16.0),
        (6, 20.0),
        (7, 20.0),
        (8, 20.0),
        (9, 20.0),
        (10, 20.0),
        (11, 24.0),
    ] {
        s.width(col, w);
    }
    s.freeze(2, 1);
    s
}

// ── People ──────────────────────────────────────────────────────────────────

fn people_sheet(plan: &Plan) -> Sheet {
    let mut s = Sheet::new("People");
    for (i, h) in [
        "github person",
        "unit",
        "team tag",
        "team",
        "team color",
        "alias",
        "power",
        "email",
    ]
    .iter()
    .enumerate()
    {
        s.text(1, i as u32 + 1, *h).style = header_style(HEADER_FILL);
    }
    let t = |v: String| (!v.is_empty()).then_some(Value::Text(v));
    for (i, u) in plan.users.iter().enumerate() {
        let r = i as u32 + 2;
        s.text(r, 1, u.login.clone());
        s.set(r, 2, t(plan.user_unit(&u.login)));
        s.set(r, 3, t(plan.user_team_tag(&u.login)));
        s.set(r, 4, t(plan.user_team_name(&u.login)));
        s.set(r, 5, t(plan.user_team_color(&u.login)));
        s.set(r, 6, u.alias.clone().map(Value::Text));
        s.set(r, 7, u.power.map(Value::Number));
        s.set(r, 8, u.email.clone().map(Value::Text));
    }
    for (col, w) in [
        (1, 24.0),
        (2, 18.0),
        (3, 16.0),
        (4, 22.0),
        (5, 14.0),
        (6, 24.0),
        (7, 12.0),
        (8, 36.0),
    ] {
        s.width(col, w);
    }
    s.freeze(2, 1);
    s.filter(format!("A1:H{}", plan.users.len() + 1));
    s
}

// ── the frame both timeline sheets share ────────────────────────────────────

struct Frame {
    /// The last column inside the dashboard.
    right: u32,
    /// Margins of the Roadmap sheet differ from the Gantt's in two details.
    roadmap: bool,
}

impl Frame {
    fn gray(&self, s: &mut Sheet, row: u32) {
        let c = s.cell(row, 1);
        c.style.fill = Some(OUTSIDE.into());
        if self.roadmap {
            c.style.border = Border {
                right: Side::medium(OUTSIDE),
                ..Border::default()
            };
        }
        let from = if self.roadmap {
            self.right + 1
        } else {
            self.right
        };
        for col in from..self.right + 15 {
            s.cell(row, col).style.fill = Some(OUTSIDE.into());
        }
    }
    fn full(&self, s: &mut Sheet, row: u32, through: u32) {
        for col in 1..through {
            s.cell(row, col).style.fill = Some(OUTSIDE.into());
        }
    }
}

fn title(s: &mut Sheet, row: u32, text: &str) {
    let c = s.text(row, 3, text);
    c.style.font = Font::default().bold().sized(22.0).color(TITLE_TEXT);
    c.style.align.vertical = Some("center");
}

fn header_cell(
    s: &mut Sheet,
    row: u32,
    col: u32,
    text: Option<&str>,
    fill_rgb: &str,
    size: f64,
    bold: bool,
) {
    let c = s.set(row, col, text.map(|t| Value::Text(t.to_string())));
    let mut font = Font::default().sized(size).color(HEADER_TEXT);
    if bold {
        font = font.bold();
    }
    c.style.fill = Some(fill_rgb.into());
    c.style.font = font;
    c.style.align = Align {
        horizontal: Some("center"),
        vertical: Some("center"),
        wrap: false,
    };
    c.style.border = white_thin();
}

// ── Roadmap ─────────────────────────────────────────────────────────────────

const BACKLOG_COL: u32 = 13;
const BACKLOG_END: u32 = 15;
const RIGHT_COL: u32 = 16;

struct Placement {
    col: u32,
    sub_row: u32,
    span: u32,
    text: String,
    url: Option<String>,
    color: String,
}

fn item_color(plan: &Plan, row: &Row) -> String {
    match row.assignees.first() {
        Some(login) => plan.user_team_color(login),
        None => plan.no_unit_color.clone(),
    }
}

fn place(
    plan: &Plan,
    rows: &[&Row],
    month_col: &HashMap<(i32, u32), u32>,
    widths: &HashMap<u32, f64>,
    backlog: u32,
) -> Vec<Placement> {
    let target = |r: &Row| {
        r.month()
            .and_then(|m| month_col.get(&m).copied())
            .unwrap_or(backlog)
    };
    let mut sorted: Vec<&Row> = rows.to_vec();
    sorted.sort_by_key(|r| target(r));
    let mut occupied: BTreeMap<u32, BTreeSet<u32>> = BTreeMap::new();
    let mut out = Vec::new();
    for r in sorted {
        let title = if r.title.is_empty() {
            "Untitled".to_string()
        } else {
            r.title.clone()
        };
        let col = target(r);
        let diamond = if r.committed() { FILLED } else { EMPTY };
        let mut text = format!("{diamond} {title}");
        if text.chars().count() > MAX_ITEM_CHARS {
            let cut: String = text.chars().take(MAX_ITEM_CHARS - 3).collect();
            text = format!("{}...", cut.trim_end());
        }
        let span = if col == backlog {
            3
        } else {
            let want = text.chars().count() as f64 * CHAR_WIDTH;
            let (mut acc, mut span, mut c) = (0.0, 0u32, col);
            while acc < want && c < backlog {
                acc += widths.get(&c).copied().unwrap_or(MONTH_COL_WIDTH);
                span += 1;
                c += 1;
            }
            span.max(1).min(backlog - col)
        };
        let needed: BTreeSet<u32> = (col..col + span).collect();
        let free = occupied
            .iter()
            .find(|(_, used)| used.is_disjoint(&needed))
            .map(|(k, _)| *k);
        let sub_row = match free {
            Some(k) => {
                occupied.entry(k).or_default().extend(needed);
                k
            }
            None => {
                let k = occupied.keys().next_back().map_or(0, |k| k + 1);
                occupied.insert(k, needed);
                k
            }
        };
        out.push(Placement {
            col,
            sub_row,
            span,
            text,
            url: r.url.clone(),
            color: item_color(plan, r),
        });
    }
    out
}

fn grid_borders(s: &mut Sheet, row: u32, even: &str, odd: &str) {
    for col in 4..16 {
        let left = match col {
            4 | 10 => Side::thin(Some(even)),
            7 | 13 => Side::thin(Some(odd)),
            _ => Side::default(),
        };
        s.cell(row, col).style.border = Border {
            left,
            right: Side::thin(Some(GRID)),
            ..Border::default()
        };
    }
}

fn outer_borders(s: &mut Sheet, row: u32) {
    s.cell(row, 2).style.border = Border {
        left: Side::medium(GRID),
        ..Border::default()
    };
    s.cell(row, RIGHT_COL).style.border = Border {
        right: Side::medium(GRID),
        ..Border::default()
    };
}

/// What every swimlane of the Roadmap sheet is drawn against.
struct LaneFrame<'a> {
    plan: &'a Plan,
    widths: &'a HashMap<u32, f64>,
    even_cols: &'a BTreeSet<u32>,
    frame: &'a Frame,
}

impl LaneFrame<'_> {
    /// One group's swimlane: as many rows as its boxes need, the label merged
    /// down them, a box per gear, and a thin spacer row after.
    #[allow(clippy::too_many_arguments)]
    fn swimlane(
        &self,
        s: &mut Sheet,
        cur: &mut u32,
        label: &str,
        items: &[&Row],
        style: (&str, &str, &str),
        month_col: &HashMap<(i32, u32), u32>,
        backlog: u32,
    ) {
        let placements = place(self.plan, items, month_col, self.widths, backlog);
        if placements.is_empty() {
            return;
        }
        let rows_needed = placements.iter().map(|p| p.sub_row).max().unwrap_or(0) + 1;
        let start = *cur;
        for _ in 0..rows_needed {
            s.height(*cur, ITEM_ROW_HEIGHT);
            for col in 4..16 {
                let f = if self.even_cols.contains(&col) {
                    style.1
                } else {
                    style.2
                };
                s.cell(*cur, col).style.fill = Some(f.into());
            }
            grid_borders(s, *cur, style.1, style.2);
            outer_borders(s, *cur);
            self.frame.gray(s, *cur);
            *cur += 1;
        }
        if rows_needed > 1 {
            s.merge(start, 3, start + rows_needed - 1, 3);
        }
        let c = s.text(start, 3, label);
        c.style.font = Font::default().bold().sized(11.0);
        c.style.fill = Some(style.0.into());
        c.style.align = Align {
            horizontal: Some("center"),
            vertical: Some("center"),
            wrap: false,
        };
        for p in placements {
            let r0 = start + p.sub_row - 1;
            s.shape(Shape {
                from_col: p.col - 1,
                from_row: r0,
                to_col: p.col - 1 + p.span,
                to_row: r0,
                row_height: ITEM_ROW_HEIGHT,
                fill: None,
                border: None,
                text: p.text,
                text_color: p.color,
                link: p.url,
            });
        }
        s.height(*cur, SPACER_HEIGHT);
        grid_borders(s, *cur, GRID, GRID);
        outer_borders(s, *cur);
        self.frame.gray(s, *cur);
        *cur += 1;
    }
}

fn roadmap_sheet(cx: &Context<'_>, rows: &[Row], groups: &[(String, Vec<usize>)]) -> Sheet {
    let plan = cx.plan;
    let today = cx.today;
    let mut s = Sheet::new("Roadmap");
    let frame = Frame {
        right: RIGHT_COL,
        roadmap: true,
    };
    let nine = months_from(today, 9);
    let month_col: HashMap<(i32, u32), u32> = nine
        .iter()
        .enumerate()
        .map(|(i, m)| (*m, 4 + i as u32))
        .collect();
    let wide = MONTH_COL_WIDTH * SLIDE_SCALE;
    let widths: HashMap<u32, f64> = (4..16).map(|c| (c, wide)).collect();
    let even_cols: BTreeSet<u32> = (4..7).chain(10..13).collect();

    s.width(1, COL_A_WIDTH);
    s.width(2, COL_B_WIDTH);
    s.width(3, COL_C_WIDTH);
    for c in 4..16 {
        s.width(c, wide);
    }
    s.width(RIGHT_COL, RIGHT_MARGIN_WIDTH);

    let mut cur = 1;
    s.height(cur, TOP_MARGIN_HEIGHT);
    frame.full(&mut s, cur, RIGHT_COL + 15);
    cur += 1;
    s.height(cur, PRE_TITLE_HEIGHT);
    frame.gray(&mut s, cur);
    cur += 1;
    s.height(cur, TITLE_HEIGHT);
    title(&mut s, cur, "Cyber Fabric Roadmap");
    frame.gray(&mut s, cur);
    cur += 1;
    s.height(cur, POST_TITLE_HEIGHT);
    frame.gray(&mut s, cur);
    cur += 1;

    let fills = [MONTH_FILL, QUARTER_FILL];
    s.height(cur, QUARTER_HEIGHT);
    let mut month_fill: HashMap<usize, usize> = HashMap::new();
    for (qi, (m0, m1, sc, ec, y, qm)) in quarter_spans(&nine, 4, 1).into_iter().enumerate() {
        let f = qi % 2;
        for m in m0..=m1 {
            month_fill.insert(m, f);
        }
        header_cell(
            &mut s,
            cur,
            sc,
            Some(&quarter_label(y, qm)),
            fills[f],
            14.0,
            true,
        );
        if ec > sc {
            s.merge(cur, sc, cur, ec);
        }
        for c in sc + 1..=ec {
            let cell = s.cell(cur, c);
            cell.style.fill = Some(fills[f].into());
            cell.style.border = white_thin();
        }
    }
    header_cell(
        &mut s,
        cur,
        BACKLOG_COL,
        Some("Backlog"),
        fills[1],
        14.0,
        true,
    );
    s.merge(cur, BACKLOG_COL, cur, BACKLOG_END);
    for c in BACKLOG_COL + 1..=BACKLOG_END {
        let cell = s.cell(cur, c);
        cell.style.fill = Some(fills[1].into());
        cell.style.border = white_thin();
    }
    outer_borders(&mut s, cur);
    frame.gray(&mut s, cur);
    cur += 1;

    s.height(cur, MONTH_HEIGHT);
    for (i, (_, m)) in nine.iter().enumerate() {
        let f = fills[month_fill.get(&i).copied().unwrap_or(0)];
        header_cell(
            &mut s,
            cur,
            4 + i as u32,
            Some(month_abbr(*m)),
            f,
            9.0,
            false,
        );
    }
    header_cell(
        &mut s,
        cur,
        BACKLOG_COL,
        Some("Future plans"),
        fills[1],
        9.0,
        false,
    );
    s.merge(cur, BACKLOG_COL, cur, BACKLOG_END);
    for c in BACKLOG_COL + 1..=BACKLOG_END {
        let cell = s.cell(cur, c);
        cell.style.fill = Some(fills[1].into());
        cell.style.border = white_thin();
    }
    outer_borders(&mut s, cur);
    frame.gray(&mut s, cur);
    cur += 1;

    s.height(cur, PRE_SWIMLANE_HEIGHT);
    grid_borders(&mut s, cur, GRID, GRID);
    outer_borders(&mut s, cur);
    frame.gray(&mut s, cur);
    cur += 1;

    let lane_frame = LaneFrame {
        plan,
        widths: &widths,
        even_cols: &even_cols,
        frame: &frame,
    };
    let now = (today.year(), u32::from(u8::from(today.month())));
    let past = past_months(today);
    let past_set: BTreeSet<(i32, u32)> = past.iter().copied().collect();
    let mut done_past: Vec<(String, Vec<&Row>)> = Vec::new();
    for (i, (group, ix)) in groups.iter().enumerate() {
        let items: Vec<&Row> = ix.iter().map(|k| &rows[*k]).collect();
        let past_milestone = |r: &Row| !r.backlog() && r.month().is_some_and(|m| m < now);
        let active: Vec<&Row> = items
            .iter()
            .copied()
            .filter(|r| !(r.done() && past_milestone(r)))
            .collect();
        let finished: Vec<&Row> = items
            .iter()
            .copied()
            .filter(|r| r.done() && r.month().is_some_and(|m| past_set.contains(&m)))
            .collect();
        if !finished.is_empty() {
            done_past.push((group.clone(), finished));
        }
        lane_frame.swimlane(
            &mut s,
            &mut cur,
            &plan.swimlane_label(group),
            &active,
            LANES[i % 2],
            &month_col,
            BACKLOG_COL,
        );
    }

    s.height(cur, MONTH_HEIGHT);
    let c = s.text(cur, 4, format!("{FILLED}  Commitment"));
    c.style.font = Font::default().sized(9.0).bold().color(COMMIT_FILL);
    let c = s.text(cur, 8, format!("{EMPTY}  No commitment, but yet planned"));
    c.style.font = Font::default().sized(9.0).color(NONCOMMIT_TEXT);
    frame.gray(&mut s, cur);
    cur += 1;
    s.height(cur, BOTTOM_MARGIN_HEIGHT);
    frame.gray(&mut s, cur);
    cur += 1;

    if !done_past.is_empty() {
        for r in cur..cur + 3 {
            s.height(r, TOP_MARGIN_HEIGHT);
            frame.full(&mut s, r, RIGHT_COL + 15);
        }
        cur += 3;
        s.height(cur, PRE_TITLE_HEIGHT);
        frame.gray(&mut s, cur);
        cur += 1;
        s.height(cur, TITLE_HEIGHT);
        title(&mut s, cur, "Completed Roadmap \u{2014} Past 4 Quarters");
        frame.gray(&mut s, cur);
        cur += 1;
        s.height(cur, POST_TITLE_HEIGHT);
        frame.gray(&mut s, cur);
        cur += 1;

        let past_col: HashMap<(i32, u32), u32> = past
            .iter()
            .enumerate()
            .map(|(i, m)| (*m, 4 + i as u32))
            .collect();
        s.height(cur, QUARTER_HEIGHT);
        for (qi, (sc, ec)) in [(4, 6), (7, 9), (10, 12), (13, 15)].into_iter().enumerate() {
            let (y, m) = past[qi * 3];
            header_cell(
                &mut s,
                cur,
                sc,
                Some(&quarter_label(y, m)),
                fills[qi % 2],
                14.0,
                true,
            );
            s.merge(cur, sc, cur, ec);
            for c in sc + 1..=ec {
                let cell = s.cell(cur, c);
                cell.style.fill = Some(fills[qi % 2].into());
                cell.style.border = white_thin();
            }
        }
        outer_borders(&mut s, cur);
        frame.gray(&mut s, cur);
        cur += 1;
        s.height(cur, MONTH_HEIGHT);
        for (i, (_, m)) in past.iter().enumerate() {
            header_cell(
                &mut s,
                cur,
                4 + i as u32,
                Some(month_abbr(*m)),
                fills[(i / 3) % 2],
                9.0,
                false,
            );
        }
        outer_borders(&mut s, cur);
        frame.gray(&mut s, cur);
        cur += 1;
        s.height(cur, PRE_SWIMLANE_HEIGHT);
        grid_borders(&mut s, cur, GRID, GRID);
        outer_borders(&mut s, cur);
        frame.gray(&mut s, cur);
        cur += 1;
        for (i, (group, items)) in done_past.iter().enumerate() {
            lane_frame.swimlane(
                &mut s,
                &mut cur,
                &plan.swimlane_label(group),
                items,
                LANES[i % 2],
                &past_col,
                RIGHT_COL,
            );
        }
        s.height(cur, BOTTOM_MARGIN_HEIGHT);
        frame.gray(&mut s, cur);
        cur += 1;
    }
    for r in cur..cur + 8 {
        s.height(r, MONTH_HEIGHT);
        frame.full(&mut s, r, RIGHT_COL + 16);
    }
    s.hide_grid = true;
    s
}

/// The twelve months of the four quarters before this one.
fn past_months(today: Date) -> Vec<(i32, u32)> {
    let m = u32::from(u8::from(today.month()));
    let q_month = ((m - 1) / 3) * 3 + 1;
    let (mut y, mut mm) = (today.year(), q_month as i32 - 12);
    while mm <= 0 {
        mm += 12;
        y -= 1;
    }
    let start = ym_date(y, mm as u32).unwrap_or(today);
    months_from(start, 12)
}

// ── Gantt ───────────────────────────────────────────────────────────────────

/// A bar drawn on the Gantt: first and last column, row, and what blocks it.
type Bar = (u32, u32, u32, Vec<u64>);

fn gantt_sheet(cx: &Context<'_>, rows: &[Row]) -> Sheet {
    let plan = cx.plan;
    let mut s = Sheet::new("Gantt");
    let lanes = cx.lanes(rows);
    let max_slots = if lanes.is_empty() {
        18
    } else {
        lanes.iter().map(|l| l.slots).max().unwrap_or(0)
    };
    let mut months = (f64::from(max_slots) / f64::from(SLOTS_PER_MONTH))
        .ceil()
        .max(9.0) as u32;
    if !months.is_multiple_of(3) {
        months += 3 - months % 3;
    }
    let slots = months * SLOTS_PER_MONTH;
    let timeline = months_from(cx.today, months as usize);
    let first = 4u32;
    let last = first + slots - 1;
    let right = last + 1;
    let frame = Frame {
        right,
        roadmap: false,
    };
    let fills = [MONTH_FILL, QUARTER_FILL];

    s.width(1, COL_A_WIDTH);
    s.width(2, COL_B_WIDTH);
    s.width(3, COL_C_WIDTH);
    for c in first..=last {
        s.width(c, MONTH_COL_WIDTH);
    }
    s.width(right, RIGHT_MARGIN_WIDTH);

    let mut cur = 1;
    s.height(cur, TOP_MARGIN_HEIGHT);
    frame.full(&mut s, cur, right + 15);
    cur += 1;
    s.height(cur, PRE_TITLE_HEIGHT);
    frame.gray(&mut s, cur);
    cur += 1;
    s.height(cur, TITLE_HEIGHT);
    title(&mut s, cur, "Gear Delivery Gantt");
    s.merge(cur, 3, cur, last.min(10));
    frame.gray(&mut s, cur);
    cur += 1;
    s.height(cur, POST_TITLE_HEIGHT);
    frame.gray(&mut s, cur);
    cur += 1;

    s.height(cur, QUARTER_HEIGHT);
    let mut month_fill: HashMap<usize, usize> = HashMap::new();
    for (qi, (m0, m1, sc, ec, y, qm)) in quarter_spans(&timeline, first, SLOTS_PER_MONTH)
        .into_iter()
        .enumerate()
    {
        let f = qi % 2;
        for m in m0..=m1 {
            month_fill.insert(m, f);
        }
        header_cell(
            &mut s,
            cur,
            sc,
            Some(&quarter_label(y, qm)),
            fills[f],
            14.0,
            true,
        );
        if ec > sc {
            s.merge(cur, sc, cur, ec);
        }
        for c in sc + 1..=ec {
            let cell = s.cell(cur, c);
            cell.style.fill = Some(fills[f].into());
            cell.style.border = white_thin();
        }
    }
    frame.gray(&mut s, cur);
    cur += 1;

    s.height(cur, MONTH_HEIGHT);
    for (i, (_, m)) in timeline.iter().enumerate() {
        let sc = first + i as u32 * SLOTS_PER_MONTH;
        let ec = sc + SLOTS_PER_MONTH - 1;
        let f = fills[month_fill.get(&i).copied().unwrap_or(0)];
        header_cell(&mut s, cur, sc, Some(month_abbr(*m)), f, 9.0, false);
        s.merge(cur, sc, cur, ec);
        let cell = s.cell(cur, ec);
        cell.style.fill = Some(f.into());
        cell.style.border = white_thin();
    }
    frame.gray(&mut s, cur);
    cur += 1;

    s.height(cur, PRE_SWIMLANE_HEIGHT);
    for c in first..=last {
        s.cell(cur, c).style.border = white_thin();
    }
    frame.gray(&mut s, cur);
    cur += 1;

    let mut bars: HashMap<u64, Vec<Bar>> = HashMap::new();
    let mut order: Vec<u64> = Vec::new();
    for (li, lane) in lanes.iter().enumerate() {
        let (label_fill, even, odd) = LANES[li % 2];
        let count = lane.people.max(1);
        let start = cur;
        let end = cur + count - 1;
        let name = if lane.tag == UNASSIGNED {
            "Unassigned".to_string()
        } else {
            let n = plan.team_name(&lane.tag);
            if n.is_empty() { lane.tag.clone() } else { n }
        };
        let label = format!(
            "{name}\npeople: {}, power: {}",
            plan.team_people(&lane.tag),
            fmt_number(plan.team_power(&lane.tag))
        );
        for k in 0..count {
            let r = start + k;
            s.height(r, 28.0);
            let c = s.cell(r, 3);
            c.style.fill = Some(label_fill.into());
            c.style.border = white_thin();
            for slot in 0..slots {
                let c = s.cell(r, first + slot);
                c.style.fill = Some(if (slot / 6) % 2 == 0 { even } else { odd }.into());
                c.style.border = white_thin();
            }
            frame.gray(&mut s, r);
        }
        let c = s.text(start, 3, label);
        c.style.font = Font::default().bold().sized(12.0);
        c.style.align = Align {
            horizontal: Some("center"),
            vertical: Some("center"),
            wrap: true,
        };
        if end > start {
            s.merge(start, 3, end, 3);
        }
        for item in &lane.items {
            let r = start + item.lane_row;
            let sc = first + item.start;
            let ec = last.min(sc + item.span - 1);
            let color = hex(&item.color, COMMIT_FILL);
            let text = format!(
                "{} ({} m*w)",
                item.title,
                fmt_number(item.remaining / MAN_DAYS_PER_WEEK)
            );
            // Text in the cell too, one point high: so a search finds the bar.
            let bg = s
                .cell(r, sc)
                .style
                .fill
                .clone()
                .unwrap_or_else(|| "FFFFFF".into());
            let c = s.text(r, sc, text.clone());
            c.style.font = Font::default().sized(1.0).color(contrast(&bg));
            s.shape(Shape {
                from_col: sc - 1,
                from_row: r - 1,
                to_col: ec,
                to_row: r - 1,
                row_height: ITEM_ROW_HEIGHT,
                fill: Some(color.clone()),
                border: None,
                text,
                text_color: contrast(&color).to_string(),
                link: item.url.clone(),
            });
            if let Some(n) = rows[item.row].number {
                if !bars.contains_key(&n) {
                    order.push(n);
                }
                bars.entry(n)
                    .or_default()
                    .push((sc, ec, r, item.blocked_by.clone()));
            }
        }
        cur += count;
    }
    for n in &order {
        for (sc, _, r, deps) in &bars[n] {
            for d in deps {
                let Some(theirs) = bars.get(d) else {
                    continue;
                };
                let Some(dep) = theirs.iter().max_by_key(|(_, ec, r, _)| (*ec, *r)) else {
                    continue;
                };
                let arrow = (*sc - 1).clamp(first, last);
                let text = if dep.1 <= *sc { "\u{2192}" } else { "\u{2198}" };
                s.shape(Shape {
                    from_col: arrow - 1,
                    from_row: r - 1,
                    to_col: arrow,
                    to_row: r - 1,
                    row_height: ITEM_ROW_HEIGHT,
                    fill: None,
                    border: None,
                    text: text.to_string(),
                    text_color: TITLE_TEXT.to_string(),
                    link: None,
                });
            }
        }
    }
    cur += 1;
    let c = s.text(
        cur,
        3,
        format!(
            "Scale: 1 slot \u{2248} {} m*d; duration = remaining m*d / team power \u{d7} team people",
            fmt_number(SLOT_DAYS)
        ),
    );
    c.style.font = Font::default().italic().sized(9.0).color(TITLE_TEXT);
    frame.gray(&mut s, cur);
    s.freeze(8, 4);
    s.hide_grid = true;
    s
}

#[cfg(test)]
#[path = "roadmap_workbook_tests.rs"]
mod tests;
