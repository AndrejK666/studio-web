//! Delivery scopes inside a project, and the limits that may block them
//! (`docs/design/studio-documents.md`, "Delivery scopes"; issue #784).
//!
//! A scope is one outcome a project promises: who owns it, by when, which
//! requirements it delivers (the same identifiers decisions close), the gears
//! it pins and how it is accepted. A limit is what stands in its way: a
//! limitation, an open question, or a dependency on another scope or a
//! decision record. A blocking limit with no resolution blocks the scope.
//! Every change to a scope keeps the version it replaced.

/// `planned`, `in_progress`, `delivered`, `dropped`.
pub const STATES: [&str; 4] = ["planned", "in_progress", "delivered", "dropped"];
/// `limitation`, `open_question`, `dependency`.
pub const LIMIT_KINDS: [&str; 3] = ["limitation", "open_question", "dependency"];

/// What a scope is asked to be, as a request gives it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ScopeFields {
    pub title: String,
    pub outcome: String,
    pub owner: Option<String>,
    pub owner_name: Option<String>,
    /// `YYYY-MM-DD`.
    pub target_date: Option<String>,
    pub requirements: Vec<String>,
    pub gears: Vec<String>,
    pub acceptance: String,
    pub state: String,
}

fn is_date(d: &str) -> bool {
    let b = d.as_bytes();
    d.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && d.chars()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
        && (1..=12).contains(&d[5..7].parse::<u32>().unwrap_or(0))
        && (1..=31).contains(&d[8..10].parse::<u32>().unwrap_or(0))
}

/// Tidy the fields and refuse what is not a scope.
pub fn check_scope(mut f: ScopeFields) -> Result<ScopeFields, String> {
    f.title = f.title.trim().to_string();
    if f.title.is_empty() || f.title.chars().count() > 200 {
        return Err("a scope's title is 1 to 200 characters".into());
    }
    if f.outcome.chars().count() > 4_000 || f.acceptance.chars().count() > 4_000 {
        return Err("outcome and acceptance are at most 4000 characters each".into());
    }
    if f.state.is_empty() {
        f.state = "planned".into();
    }
    if !STATES.contains(&f.state.as_str()) {
        return Err(format!("state is one of {}", STATES.join(", ")));
    }
    if let Some(d) = f
        .target_date
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty())
    {
        if !is_date(d) {
            return Err("target_date is YYYY-MM-DD".into());
        }
        f.target_date = Some(d.to_string());
    } else {
        f.target_date = None;
    }
    for list in [&mut f.requirements, &mut f.gears] {
        *list = list
            .iter()
            .map(|r| r.trim().to_string())
            .filter(|r| !r.is_empty())
            .collect();
        list.sort();
        list.dedup();
    }
    f.owner = f
        .owner
        .map(|o| o.trim().to_string())
        .filter(|o| !o.is_empty());
    Ok(f)
}

/// What a limit is asked to be.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LimitFields {
    pub kind: String,
    pub text: String,
    pub blocking: bool,
    /// For a dependency: another scope's id, or a decision record (`ADR-0012`).
    pub depends_on: Option<String>,
}

pub fn check_limit(mut f: LimitFields) -> Result<LimitFields, String> {
    if !LIMIT_KINDS.contains(&f.kind.as_str()) {
        return Err(format!("kind is one of {}", LIMIT_KINDS.join(", ")));
    }
    f.text = f.text.trim().to_string();
    if f.text.is_empty() || f.text.chars().count() > 2_000 {
        return Err("a limit is 1 to 2000 characters".into());
    }
    f.depends_on = f
        .depends_on
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty());
    if f.kind == "dependency" && f.depends_on.is_none() {
        return Err("a dependency names what it depends on (`depends_on`)".into());
    }
    Ok(f)
}

/// One limit as a scope's state reads it.
pub struct LimitState<'a> {
    pub blocking: bool,
    pub resolution: Option<&'a str>,
    /// For a dependency on another scope: that scope's state.
    pub depends_on_state: Option<&'a str>,
}

/// Whether a limit still holds: unresolved, and — for a dependency on a
/// scope — that scope not delivered yet.
pub fn holds(l: &LimitState<'_>) -> bool {
    l.resolution.is_none_or(|r| r.trim().is_empty()) && l.depends_on_state != Some("delivered")
}

/// Whether a scope is blocked: a blocking limit still holds.
pub fn blocked(limits: &[LimitState<'_>]) -> bool {
    limits.iter().any(|l| l.blocking && holds(l))
}

#[cfg(test)]
#[path = "delivery_tests.rs"]
mod tests;
