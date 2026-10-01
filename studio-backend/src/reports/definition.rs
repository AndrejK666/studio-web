//! A report definition: what a report's workbook holds, as data.
//!
//! The code knows five kinds of sheet and how to draw each; a definition says
//! which of them a report has, in what order, under what names, and -- for a
//! table -- which columns. A column names a value by key (`impl`,
//! `milestone`, `card.Description`, `field.Status` for any board column), or
//! is a formula over other columns written with `{id}` for a column's letter
//! and `{row}` for the row, or stands for the plan's consumer projects. So a
//! column moves, appears or goes without anything that refers to it breaking.
//!
//! The planning team's workbook is the built-in `back_roadmap`
//! (`presets/back_roadmap.yaml`); a plan names a built-in with
//! `report: <id>`, or carries a definition of its own under `report:`.

use std::collections::BTreeSet;

use serde_yaml::Value as Yaml;

/// The built-in definitions, by id.
const PRESETS: [(&str, &str); 1] = [("back_roadmap", include_str!("presets/back_roadmap.yaml"))];

#[derive(Clone, Debug, PartialEq)]
pub struct Definition {
    pub id: String,
    pub title: String,
    pub sheets: Vec<SheetDef>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum SheetDef {
    /// One row per group, formulas over the group sheets of the table.
    Summary {
        name: String,
    },
    /// The groups as swimlanes over the coming months, a box per gear.
    Timeline {
        name: String,
        title: String,
    },
    /// Each team's remaining work, scheduled against its people and power.
    Gantt {
        name: String,
        title: String,
    },
    /// The plan's people.
    People {
        name: String,
    },
    Table(TableDef),
}

#[derive(Clone, Debug, PartialEq)]
pub struct TableDef {
    /// A sheet per group, named after it.
    pub per_group: bool,
    /// A sheet with every row, under this name.
    pub all: Option<String>,
    pub sort: Sort,
    /// The first unfrozen cell, 1-based `(row, col)`.
    pub freeze: Option<(u32, u32)>,
    /// The count and progress block under the table.
    pub metrics: bool,
    pub columns: Vec<ColumnDef>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sort {
    /// The board's order.
    Board,
    /// By the priority column's text, the unprioritised last.
    Prio,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ColumnDef {
    pub id: String,
    pub header: String,
    pub source: Source,
    pub width: Option<f64>,
    pub format: Option<&'static str>,
    pub link: bool,
    /// A data bar from 0 to 1 in this colour.
    pub bar: Option<String>,
    /// A hidden number column the summary and the metrics read.
    pub helper: bool,
    pub late: Option<Late>,
    /// Write the cell only when this other column has a value.
    pub when: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Source {
    Value(Key),
    /// With `{id}` and `{row}` still in it.
    Formula(String),
    /// One column per consumer project of the plan.
    Projects,
}

/// What a value column reads off a row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Key {
    Index,
    Number,
    Title,
    Type,
    Assignees,
    Aliases,
    Teams,
    Prio,
    Spec,
    Sdk,
    Impl,
    Overall,
    Status,
    Effort,
    Commitment,
    Milestone,
    Forecast,
    /// A line of the issue's card (`card.Description`).
    Card(String),
    /// Any board column, as the board wrote it (`field.Status`).
    Field(String),
}

/// When a cell turns red.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Late {
    /// The milestone's month has passed and the gear is not done.
    MilestonePast,
    /// The forecast is later than the milestone.
    ForecastLate,
}

impl Key {
    fn parse(text: &str) -> Result<Key, String> {
        let t = text.trim();
        if let Some(f) = t.strip_prefix("card.") {
            return Ok(Key::Card(f.trim().to_string()));
        }
        if let Some(f) = t.strip_prefix("field.") {
            return Ok(Key::Field(f.trim().to_string()));
        }
        Ok(match t {
            "index" => Key::Index,
            "number" => Key::Number,
            "title" => Key::Title,
            "type" => Key::Type,
            "assignees" => Key::Assignees,
            "aliases" => Key::Aliases,
            "teams" => Key::Teams,
            "prio" => Key::Prio,
            "spec" => Key::Spec,
            "sdk" => Key::Sdk,
            "impl" => Key::Impl,
            "overall" => Key::Overall,
            "status" => Key::Status,
            "effort" => Key::Effort,
            "commitment" => Key::Commitment,
            "milestone" => Key::Milestone,
            "forecast" => Key::Forecast,
            other => {
                return Err(format!(
                    "`{other}` is not a value: use one of index, number, title, type, assignees, \
                     aliases, teams, prio, spec, sdk, impl, overall, status, effort, commitment, \
                     milestone, forecast, card.<field>, field.<board column>"
                ));
            }
        })
    }
}

fn format_code(text: &str) -> Result<&'static str, String> {
    // A closed list, because the writer interns formats as `&'static str`
    // and an arbitrary one is an injection into the styles part.
    Ok(match text.trim() {
        "0%" => "0%",
        "0" => "0",
        "0.0" => "0.0",
        "0.00" => "0.00",
        "yy.mm" => "yy.mm",
        "yyyy-mm-dd" => "yyyy-mm-dd",
        other => {
            return Err(format!(
                "`{other}` is not a format: use 0%, 0, 0.0, 0.00, yy.mm or yyyy-mm-dd"
            ));
        }
    })
}

fn is_hex_color(t: &str) -> bool {
    t.len() == 6 && t.chars().all(|c| c.is_ascii_hexdigit())
}

fn text(v: &Yaml) -> Option<String> {
    match v {
        Yaml::String(s) => Some(s.trim().to_string()).filter(|s| !s.is_empty()),
        Yaml::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn flag(v: &Yaml, key: &str) -> Result<bool, String> {
    match v.get(key) {
        None | Some(Yaml::Null) => Ok(false),
        Some(Yaml::Bool(b)) => Ok(*b),
        Some(_) => Err(format!("`{key}` is true or false")),
    }
}

/// `D2` → `(2, 4)`.
fn cell(text: &str) -> Result<(u32, u32), String> {
    let t = text.trim().to_ascii_uppercase();
    let split = t
        .find(|c: char| c.is_ascii_digit())
        .ok_or_else(|| format!("`{text}` is not a cell"))?;
    let (letters, digits) = t.split_at(split);
    if letters.is_empty() || !letters.chars().all(|c| c.is_ascii_uppercase()) {
        return Err(format!("`{text}` is not a cell"));
    }
    let col = letters
        .chars()
        .fold(0u32, |n, c| n * 26 + (c as u32 - 'A' as u32 + 1));
    let row: u32 = digits
        .parse()
        .map_err(|_| format!("`{text}` is not a cell"))?;
    if row == 0 {
        return Err(format!("`{text}` is not a cell"));
    }
    Ok((row, col))
}

fn column(v: &Yaml, at: usize) -> Result<ColumnDef, String> {
    let ctx = |e: String| format!("column {}: {e}", at + 1);
    let id = v
        .get("id")
        .and_then(text)
        .ok_or_else(|| ctx("has no `id`".into()))?;
    let ctx = |e: String| format!("column `{id}`: {e}");
    let source = match (
        v.get("value").and_then(text),
        v.get("formula").and_then(text),
        flag(v, "projects").map_err(ctx)?,
    ) {
        (Some(k), None, false) => Source::Value(Key::parse(&k).map_err(ctx)?),
        (None, Some(f), false) => Source::Formula(f),
        (None, None, true) => Source::Projects,
        (None, None, false) => {
            return Err(ctx("says neither `value`, `formula` nor `projects`".into()));
        }
        _ => {
            return Err(ctx(
                "says more than one of `value`, `formula` and `projects`".into(),
            ));
        }
    };
    let format = v
        .get("format")
        .and_then(text)
        .map(|f| format_code(&f))
        .transpose()
        .map_err(ctx)?;
    let bar = v
        .get("bar")
        .and_then(text)
        .map(|b| b.trim_start_matches('#').to_ascii_uppercase());
    if let Some(b) = &bar
        && !is_hex_color(b)
    {
        return Err(ctx(format!("`{b}` is not a colour (RRGGBB)")));
    }
    let late = match v.get("late").and_then(text).as_deref() {
        None => None,
        Some("milestone_past") => Some(Late::MilestonePast),
        Some("forecast_late") => Some(Late::ForecastLate),
        Some(other) => {
            return Err(ctx(format!(
                "`{other}` is not a rule: use milestone_past or forecast_late"
            )));
        }
    };
    let width = match v.get("width") {
        None | Some(Yaml::Null) => None,
        Some(w) => match w.as_f64() {
            Some(w) if w > 0.0 && w <= 255.0 => Some(w),
            _ => return Err(ctx("`width` is a number from 0 to 255".into())),
        },
    };
    Ok(ColumnDef {
        header: v.get("header").and_then(text).unwrap_or_default(),
        source,
        width,
        format,
        link: flag(v, "link").map_err(ctx)?,
        bar,
        helper: flag(v, "helper").map_err(ctx)?,
        late,
        when: v.get("when").and_then(text),
        id,
    })
}

fn sheet(v: &Yaml, at: usize) -> Result<SheetDef, String> {
    let kind = v
        .get("kind")
        .and_then(text)
        .ok_or_else(|| format!("sheet {}: has no `kind`", at + 1))?;
    let name = |default: &str| {
        v.get("name")
            .and_then(text)
            .unwrap_or_else(|| default.to_string())
    };
    let title = |default: &str| {
        v.get("title")
            .and_then(text)
            .unwrap_or_else(|| default.to_string())
    };
    Ok(match kind.as_str() {
        "summary" => SheetDef::Summary {
            name: name("Summary"),
        },
        "timeline" => SheetDef::Timeline {
            name: name("Roadmap"),
            title: title("Roadmap"),
        },
        "gantt" => SheetDef::Gantt {
            name: name("Gantt"),
            title: title("Gantt"),
        },
        "people" => SheetDef::People {
            name: name("People"),
        },
        "table" => {
            let ctx = |e: String| format!("sheet {} (table): {e}", at + 1);
            let columns = v
                .get("columns")
                .and_then(Yaml::as_sequence)
                .ok_or_else(|| ctx("has no `columns`".into()))?
                .iter()
                .enumerate()
                .map(|(i, c)| column(c, i))
                .collect::<Result<Vec<_>, _>>()
                .map_err(ctx)?;
            let sort = match v.get("sort").and_then(text).as_deref() {
                None | Some("board") => Sort::Board,
                Some("prio") => Sort::Prio,
                Some(other) => {
                    return Err(ctx(format!("`{other}` is not a sort: use board or prio")));
                }
            };
            let per_group = flag(v, "per_group").map_err(ctx)?;
            let all = v.get("all").and_then(text);
            if !per_group && all.is_none() {
                return Err(ctx("lists nothing: set `per_group`, `all`, or both".into()));
            }
            SheetDef::Table(TableDef {
                per_group,
                all,
                sort,
                freeze: v
                    .get("freeze")
                    .and_then(text)
                    .map(|c| cell(&c))
                    .transpose()
                    .map_err(ctx)?,
                metrics: flag(v, "metrics").map_err(ctx)?,
                columns,
            })
        }
        other => {
            return Err(format!(
                "sheet {}: `{other}` is not a kind: use summary, timeline, gantt, people or table",
                at + 1
            ));
        }
    })
}

impl Definition {
    /// A built-in definition by id.
    pub fn preset(id: &str) -> Option<Definition> {
        PRESETS
            .iter()
            .find(|(k, _)| *k == id)
            .and_then(|(_, text)| Definition::from_yaml(text).ok())
    }

    pub fn preset_ids() -> Vec<&'static str> {
        PRESETS.iter().map(|(k, _)| *k).collect()
    }

    pub fn from_yaml(text: &str) -> Result<Definition, String> {
        let v = crate::reports::roadmap::plan::parse(text)?;
        Definition::from_value(&v)
    }

    /// What a plan's `report:` says: a built-in by id, or a definition.
    pub fn from_plan(v: &Yaml) -> Result<Definition, String> {
        match v {
            Yaml::String(id) => Definition::preset(id.trim()).ok_or_else(|| {
                format!(
                    "`{id}` is not a built-in report: use one of {}",
                    Definition::preset_ids().join(", ")
                )
            }),
            Yaml::Mapping(_) => Definition::from_value(v),
            _ => Err("`report` is a built-in's id or a definition".into()),
        }
    }

    pub fn from_value(v: &Yaml) -> Result<Definition, String> {
        if let Some(g) = v.get("group_by").and_then(text)
            && g != "title_prefix"
        {
            return Err(format!("`{g}` is not a grouping: use title_prefix"));
        }
        let sheets = v
            .get("sheets")
            .and_then(Yaml::as_sequence)
            .ok_or("the definition has no `sheets`")?
            .iter()
            .enumerate()
            .map(|(i, s)| sheet(s, i))
            .collect::<Result<Vec<_>, _>>()?;
        let def = Definition {
            id: v
                .get("id")
                .and_then(text)
                .unwrap_or_else(|| "custom".into()),
            title: v
                .get("title")
                .and_then(text)
                .unwrap_or_else(|| "Report".into()),
            sheets,
        };
        def.validate()?;
        Ok(def)
    }

    /// The table sheet, if there is one.
    pub fn table(&self) -> Option<&TableDef> {
        self.sheets.iter().find_map(|s| match s {
            SheetDef::Table(t) => Some(t),
            _ => None,
        })
    }

    fn validate(&self) -> Result<(), String> {
        if self.sheets.is_empty() {
            return Err("the definition has no sheets".into());
        }
        let tables = self
            .sheets
            .iter()
            .filter(|s| matches!(s, SheetDef::Table(_)))
            .count();
        if tables > 1 {
            return Err("a definition has one table".into());
        }
        let mut names: BTreeSet<String> = BTreeSet::new();
        for s in &self.sheets {
            let name = match s {
                SheetDef::Summary { name }
                | SheetDef::Timeline { name, .. }
                | SheetDef::Gantt { name, .. }
                | SheetDef::People { name } => Some(name.clone()),
                SheetDef::Table(t) => t.all.clone(),
            };
            if let Some(n) = name
                && !names.insert(n.to_lowercase())
            {
                return Err(format!("two sheets are named `{n}`"));
            }
        }
        if self
            .sheets
            .iter()
            .any(|s| matches!(s, SheetDef::Summary { .. }))
            && !self.table().is_some_and(|t| t.per_group)
        {
            return Err(
                "a summary sums the group sheets, so it needs a table with `per_group`".into(),
            );
        }
        if let Some(t) = self.table() {
            t.validate()?;
        }
        Ok(())
    }
}

impl TableDef {
    fn validate(&self) -> Result<(), String> {
        let mut ids: BTreeSet<&str> = BTreeSet::new();
        for c in &self.columns {
            if !ids.insert(c.id.as_str()) {
                return Err(format!("two columns are `{}`", c.id));
            }
        }
        if self
            .columns
            .iter()
            .filter(|c| c.source == Source::Projects)
            .count()
            > 1
        {
            return Err("one column stands for the projects".into());
        }
        if let Some(p) = self
            .columns
            .iter()
            .position(|c| c.source == Source::Projects)
            && p + 1 != self.columns.len()
        {
            return Err("the projects column is the last one: it becomes as many columns as the plan has projects".into());
        }
        for c in &self.columns {
            if let Source::Formula(f) = &c.source {
                for r in refs(f)? {
                    if r != "row" && !ids.contains(r.as_str()) {
                        return Err(format!("column `{}`: `{{{r}}}` names no column", c.id));
                    }
                    if r == c.id {
                        return Err(format!("column `{}` refers to itself", c.id));
                    }
                }
            }
            if let Some(w) = &c.when
                && !ids.contains(w.as_str())
            {
                return Err(format!("column `{}`: `when: {w}` names no column", c.id));
            }
            if c.late == Some(Late::ForecastLate) && self.role(&Key::Milestone, false).is_none() {
                return Err(format!(
                    "column `{}`: forecast_late needs a milestone column",
                    c.id
                ));
            }
        }
        Ok(())
    }

    /// The column that holds this value: a helper first when `helper`, else
    /// a visible one first. What the summary, the metrics and the red cells
    /// find their columns by.
    pub fn role(&self, key: &Key, helper: bool) -> Option<usize> {
        let of = |h: bool| {
            self.columns
                .iter()
                .position(|c| c.helper == h && c.source == Source::Value(key.clone()))
        };
        of(helper).or_else(|| of(!helper))
    }

    pub fn by_id(&self, id: &str) -> Option<usize> {
        self.columns.iter().position(|c| c.id == id)
    }
}

/// The `{name}` references of a formula, in order.
pub fn refs(formula: &str) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let mut rest = formula;
    while let Some(open) = rest.find('{') {
        let after = &rest[open + 1..];
        let close = after
            .find('}')
            .ok_or_else(|| format!("`{formula}` has a `{{` with no `}}`"))?;
        let name = after[..close].trim();
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(format!("`{{{name}}}` is not a column id"));
        }
        out.push(name.to_string());
        rest = &after[close + 1..];
    }
    if rest.contains('}') {
        return Err(format!("`{formula}` has a `}}` with no `{{`"));
    }
    Ok(out)
}

/// The formula with every `{id}` replaced by `letter(id)` and `{row}` by the row.
pub fn resolve(formula: &str, row: u32, letter: impl Fn(&str) -> Option<String>) -> Option<String> {
    let mut out = String::with_capacity(formula.len());
    let mut rest = formula;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let close = after.find('}')?;
        let name = after[..close].trim();
        if name == "row" {
            out.push_str(&row.to_string());
        } else {
            out.push_str(&letter(name)?);
        }
        rest = &after[close + 1..];
    }
    out.push_str(rest);
    Some(out)
}

#[cfg(test)]
#[path = "definition_tests.rs"]
mod tests;
