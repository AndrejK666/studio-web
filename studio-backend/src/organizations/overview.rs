//! What an organization's leaders ask of it, answered once on the server.
//!
//! The organization's overview answers four questions before anything else:
//! what is on fire and waits on them, where (by workspace, then project),
//! whether money grows and who grows it, and whether work moves. The portal
//! used to compose that itself -- around ten requests across six gears -- and
//! stitched the answers together with rules of its own. Those rules are here
//! now, stated as tests, and the portal draws one answer.
//!
//! **The core knows no kit (ADR-0079).** What a kit knows -- spend, pull
//! requests, specs, the component registry -- is the kit's **block**
//! (`blocks.rs`): its gear registers it, and this module asks the blocks of
//! the kits installed for the organization and returns them in `blocks`.
//! What stays here is the organization's own: its tree, its members, its
//! background runs, and the rules that read every block's signals.
//!
//! ── The rules ──────────────────────────────────────────────────────────────
//!
//! **A refused connection is the newest run of a repository failing with
//! 401 or 403.** A repository that failed and synced since is fine; a rate
//! limit is said with a 403 too and passes by itself, so it is not one.
//!
//! **A project's health** reads its row (failing specs, findings, quiet
//! days), its refused connections, and what the blocks signal for it: spend
//! growing and stuck work.
//!
//! **Members nobody saw at work are idle**: no block that watches people saw
//! them in the period. When a block that would say could not tell (costs
//! hidden from the caller), nobody is called idle.
//!
//! **What cannot be read is unknown, never zero** -- the rollups' rule.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;

use time::{Date, Duration, Month, OffsetDateTime, UtcOffset};
use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::blocks::{
    self, Activity, BlockAnswer, BlockAt, BlockScope, Level, OverviewBlock, OverviewBlockDto,
};
use super::rollups::{ORGANIZATION_TENANT_TYPE, Rollup, RollupKind, Sources};
use super::status::Kits;
use crate::tasks::{RecentRuns, RunSummary};
use crate::user_profile::RosterMember;

/// A pull request is stuck after this many days without a move.
pub const STUCK_DAYS: u32 = 7;
/// Spend growing by this share or more is news.
pub const GROWTH_ALERT: f64 = 0.2;
/// A project is quiet after this many days without activity.
pub const QUIET_DAYS: u32 = 14;
/// Background runs read per tenant.
const RUNS_PER_TENANT: u64 = 100;
/// The account kinds a login is looked up as.
pub(super) const ACCOUNT_KINDS: [&str; 2] = ["github", "gitlab"];

// ── Periods ──────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Period {
    pub from: OffsetDateTime,
    pub to: OffsetDateTime,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Windows {
    /// The last 30 days, today included.
    pub current: Period,
    /// The same 30 days one month earlier.
    pub previous: Period,
    /// This month so far, today included.
    pub month: Period,
    pub elapsed_days: u32,
    pub month_days: u32,
}

fn midnight(d: Date) -> OffsetDateTime {
    d.midnight().assume_utc()
}

/// The periods the overview compares, in UTC days.
pub fn windows(now: OffsetDateTime) -> Windows {
    let today = now.to_offset(UtcOffset::UTC).date();
    let to = midnight(today) + Duration::days(1);
    // One month back; the 31st after a shorter month is that month's last day.
    let (year, month) = match today.month() {
        Month::January => (today.year() - 1, Month::December),
        m => (today.year(), m.previous()),
    };
    let day = today.day().min(month.length(year));
    let prev_to = Date::from_calendar_date(year, month, day)
        .map(midnight)
        .unwrap_or(to - Duration::days(30))
        + Duration::days(1);
    let first = today.replace_day(1).unwrap_or(today);
    Windows {
        current: Period {
            from: to - Duration::days(30),
            to,
        },
        previous: Period {
            from: prev_to - Duration::days(30),
            to: prev_to,
        },
        month: Period {
            from: midnight(first),
            to,
        },
        elapsed_days: u32::from(today.day()),
        month_days: u32::from(today.month().length(today.year())),
    }
}

/// How much `current` grew against `previous`, as a share; `None` when there
/// was nothing before to grow from.
pub fn growth(current: f64, previous: f64) -> Option<f64> {
    (previous > 0.0).then(|| (current - previous) / previous)
}

// ── Refused connections ──────────────────────────────────────────────────────

/// The status a failure says the provider refused the credential with, or
/// `None` when it is about something else.
pub fn refusal(error: Option<&str>) -> Option<&'static str> {
    let e = error?.to_ascii_lowercase();
    // A rate limit is said with a 403 too, and passes by itself.
    if e.contains("rate limit") {
        return None;
    }
    let word = |w: &str| {
        e.match_indices(w).any(|(i, _)| {
            let before = e[..i].chars().next_back();
            let after = e[i + w.len()..].chars().next();
            !before.is_some_and(|c| c.is_ascii_alphanumeric())
                && !after.is_some_and(|c| c.is_ascii_alphanumeric())
        })
    };
    if word("401")
        || e.contains("unauthorized")
        || e.contains("unauthorised")
        || e.contains("bad credentials")
        || e.contains("invalid token")
        || e.contains("token expired")
        || e.contains("token has expired")
        || e.contains("token has been revoked")
    {
        return Some("401");
    }
    if word("403") || e.contains("forbidden") || e.contains("resource not accessible") {
        return Some("403");
    }
    None
}

/// A connection a provider stopped accepting.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Broken {
    /// The connection's id or credential reference.
    pub key: String,
    pub provider: String,
    pub status: &'static str,
    /// The newest failure, as the provider said it.
    pub error: String,
    pub repos: Vec<String>,
    pub projects: Vec<String>,
    pub since: OffsetDateTime,
}

fn text(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// Connections whose last attempt at a repository was refused. `runs` come
/// newest first; only each repository's newest run counts.
pub fn broken_connections(runs: &[RunSummary]) -> Vec<Broken> {
    let mut seen = BTreeSet::new();
    let mut out: Vec<Broken> = Vec::new();
    for r in runs {
        let (Some(repo), Some(connection)) = (
            text(&r.payload, "repo_full_path"),
            text(&r.payload, "connection_id").or_else(|| text(&r.payload, "secret_ref")),
        ) else {
            continue;
        };
        let project = text(&r.payload, "project_id");
        if !seen.insert((
            r.task_type.clone(),
            connection.clone(),
            repo.clone(),
            project.clone(),
        )) {
            continue;
        }
        if r.state != "failed" {
            continue;
        }
        let Some(status) = refusal(r.last_error.as_deref()) else {
            continue;
        };
        let at = match out.iter().position(|b| b.key == connection) {
            Some(i) => i,
            None => {
                out.push(Broken {
                    key: connection.clone(),
                    provider: text(&r.payload, "provider").unwrap_or_else(|| "git".to_owned()),
                    status,
                    error: r.last_error.clone().unwrap_or_default().trim().to_owned(),
                    repos: Vec::new(),
                    projects: Vec::new(),
                    since: r.created_at,
                });
                out.len() - 1
            }
        };
        let b = &mut out[at];
        if !b.repos.contains(&repo) {
            b.repos.push(repo);
        }
        if let Some(p) = project
            && !b.projects.contains(&p)
        {
            b.projects.push(p);
        }
        b.since = b.since.min(r.created_at);
    }
    out
}

fn is_other_failure(run: &RunSummary) -> bool {
    run.state == "failed" && refusal(run.last_error.as_deref()).is_none()
}

/// Failed runs other than refused connections.
pub fn other_failures(runs: &[RunSummary]) -> u32 {
    let n = runs.iter().filter(|r| is_other_failure(r)).count();
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// The middle value; `None` for none.
pub fn median(values: &[u32]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut s = values.to_vec();
    s.sort_unstable();
    let mid = s.len() / 2;
    Some(if s.len() % 2 == 1 {
        f64::from(s[mid])
    } else {
        (f64::from(s[mid - 1]) + f64::from(s[mid])) / 2.0
    })
}

/// Whole days since `at` (RFC 3339); `None` when unknown.
pub fn days_since(at: Option<&str>, now: OffsetDateTime) -> Option<u32> {
    let t = OffsetDateTime::parse(at?, &time::format_description::well_known::Rfc3339).ok()?;
    let d = (now - t).whole_days().max(0);
    u32::try_from(d).ok()
}

// ── People ───────────────────────────────────────────────────────────────────

/// Active members no block saw at work in the period.
pub fn idle(members: &[RosterMember], active: &BTreeSet<String>) -> Vec<String> {
    members
        .iter()
        .map(|m| m.person.clone())
        .filter(|p| !active.contains(p))
        .collect()
}

// ── Workspaces, worst first ──────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
pub struct ProjectHealth {
    pub id: Uuid,
    pub name: String,
    pub workspace_id: Uuid,
    pub specs_failing: Option<u32>,
    pub open_findings: Option<u32>,
    pub spend: Option<f64>,
    pub previous: Option<f64>,
    pub stuck: u32,
    pub quiet_days: Option<u32>,
    pub broken: bool,
    /// What is wrong, worst first; empty when nothing is.
    pub reasons: Vec<Reason>,
    pub score: u32,
    /// The phase Project lifecycle has it in, from its rollup row.
    pub phase: Option<String>,
}

/// One thing wrong with a project, for the portal to word.
#[derive(Clone, Debug, PartialEq)]
pub enum Reason {
    Refused,
    SpecsFailing(u32),
    Stuck(u32),
    SpendGrows(f64),
    Quiet(u32),
}

#[derive(Clone, Debug, PartialEq)]
pub struct WorkspaceHealth {
    pub id: Uuid,
    pub name: String,
    pub projects: Vec<ProjectHealth>,
    pub spend: Option<f64>,
    pub previous: Option<f64>,
    pub specs_failing: u32,
    pub stuck: u32,
    /// The most recently active project's quiet days.
    pub quiet_days: Option<u32>,
    pub score: u32,
}

pub struct HealthInputs<'a> {
    pub spend: Option<&'a BTreeMap<String, f64>>,
    pub previous: Option<&'a BTreeMap<String, f64>>,
    pub stuck: &'a BTreeMap<String, u32>,
    pub broken: &'a BTreeSet<String>,
    pub now: OffsetDateTime,
}

/// What the overview reads off a rollup row.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Row {
    pub id: Uuid,
    pub name: String,
    /// The project's workspace; `None` on a workspace's own row.
    pub workspace: Option<Uuid>,
    pub specs: Option<u32>,
    pub specs_failing: Option<u32>,
    pub open_findings: Option<u32>,
    pub pulls_open: Option<u32>,
    pub pulls_merged: Option<u32>,
    /// The newest event the Activity feed lists, RFC 3339.
    pub last_at: Option<String>,
    /// The phase Project lifecycle has the project in.
    pub phase: Option<String>,
}

pub fn row_of(r: &Rollup) -> Row {
    let pulls = r
        .signals
        .as_ref()
        .filter(|s| s.pulls_known)
        .map(|s| &s.pulls);
    Row {
        id: r.id,
        name: r.name.clone(),
        workspace: match r.kind {
            RollupKind::Workspace => None,
            RollupKind::Project => r.parent_id,
        },
        specs: r.specs.as_ref().map(|s| s.specs),
        specs_failing: r.specs.as_ref().map(|s| s.failing),
        open_findings: r.signals.as_ref().map(|s| s.open_findings),
        pulls_open: pulls.map(|p| p.open),
        pulls_merged: pulls.map(|p| p.merged),
        last_at: r
            .signals
            .as_ref()
            .and_then(|s| s.last_event.as_ref())
            .and_then(|e| e.recorded.clone()),
        phase: r.phase.clone(),
    }
}

fn project_health(r: &Row, workspace_id: Uuid, h: &HealthInputs<'_>) -> ProjectHealth {
    let key = r.id.to_string();
    let spend = h.spend.map(|m| m.get(&key).copied().unwrap_or(0.0));
    let previous = h.previous.map(|m| m.get(&key).copied().unwrap_or(0.0));
    let stuck = h.stuck.get(&key).copied().unwrap_or(0);
    let quiet_days = days_since(r.last_at.as_deref(), h.now);
    let broken = h.broken.contains(&key);
    let failing = r.specs_failing.unwrap_or(0);
    let findings = r.open_findings;
    let grows = match (spend, previous) {
        (Some(s), Some(p)) => growth(s, p).filter(|g| *g >= GROWTH_ALERT),
        _ => None,
    };
    let quiet = quiet_days.filter(|d| *d >= QUIET_DAYS);
    let mut reasons = Vec::new();
    if broken {
        reasons.push(Reason::Refused);
    }
    if failing > 0 {
        reasons.push(Reason::SpecsFailing(failing));
    }
    if stuck > 0 {
        reasons.push(Reason::Stuck(stuck));
    }
    if let Some(g) = grows {
        reasons.push(Reason::SpendGrows(g));
    }
    if let Some(d) = quiet {
        reasons.push(Reason::Quiet(d));
    }
    ProjectHealth {
        id: r.id,
        name: r.name.clone(),
        workspace_id,
        specs_failing: r.specs_failing,
        open_findings: findings,
        spend,
        previous,
        stuck,
        quiet_days,
        broken,
        reasons,
        score: if broken { 10 } else { 0 }
            + failing * 3
            + findings.unwrap_or(0)
            + stuck * 2
            + if grows.is_some() { 2 } else { 0 }
            + u32::from(quiet.is_some()),
        phase: r.phase.clone(),
    }
}

fn sum_known(vs: impl Iterator<Item = Option<f64>>) -> Option<f64> {
    vs.fold(None, |acc, v| match (acc, v) {
        (None, None) => None,
        (a, v) => Some(a.unwrap_or(0.0) + v.unwrap_or(0.0)),
    })
}

/// The organization by workspace, the one in most trouble first; inside it,
/// its projects the same way.
pub fn workspace_health(rows: &[Row], h: &HealthInputs<'_>) -> Vec<WorkspaceHealth> {
    let mut out: Vec<WorkspaceHealth> = rows
        .iter()
        .filter(|r| r.workspace.is_none())
        .map(|ws| {
            let mut projects: Vec<ProjectHealth> = rows
                .iter()
                .filter(|r| r.workspace == Some(ws.id))
                .map(|r| project_health(r, ws.id, h))
                .collect();
            projects.sort_by(|a, b| b.score.cmp(&a.score).then(a.name.cmp(&b.name)));
            WorkspaceHealth {
                id: ws.id,
                name: ws.name.clone(),
                spend: sum_known(projects.iter().map(|p| p.spend)),
                previous: sum_known(projects.iter().map(|p| p.previous)),
                specs_failing: projects.iter().map(|p| p.specs_failing.unwrap_or(0)).sum(),
                stuck: projects.iter().map(|p| p.stuck).sum(),
                quiet_days: projects.iter().filter_map(|p| p.quiet_days).min(),
                score: projects.iter().map(|p| p.score).sum(),
                projects,
            }
        })
        .collect();
    out.sort_by(|a, b| b.score.cmp(&a.score).then(a.name.cmp(&b.name)));
    out
}

// ── What waits on the organization's leader ─────────────────────────────────

/// One thing that needs the leader and is the organization's own, for the
/// portal to word. What a kit knows waits in its block's needs.
#[derive(Clone, Debug, PartialEq)]
pub enum Need {
    Refused {
        provider: String,
        status: &'static str,
        projects: Vec<String>,
        repos: u32,
    },
    RunsFailed {
        runs: u32,
    },
}

pub struct NeedInputs<'a> {
    pub broken: &'a [Broken],
    pub project_names: &'a BTreeMap<String, String>,
    pub other_failures: u32,
}

/// Refused connections first, then failed runs.
pub fn needs(n: &NeedInputs<'_>) -> Vec<Need> {
    let mut out = Vec::new();
    for b in n.broken {
        out.push(Need::Refused {
            provider: b.provider.clone(),
            status: b.status,
            projects: b
                .projects
                .iter()
                .filter_map(|id| n.project_names.get(id).cloned())
                .collect(),
            repos: u32::try_from(b.repos.len()).unwrap_or(u32::MAX),
        });
    }
    if n.other_failures > 0 {
        out.push(Need::RunsFailed {
            runs: n.other_failures,
        });
    }
    out
}

// ── Reading it ───────────────────────────────────────────────────────────────

/// Everything the overview is computed from, as read.
pub struct Read {
    pub name: String,
    pub rows: Vec<Row>,
    pub members: Option<Vec<RosterMember>>,
    pub names: BTreeMap<String, String>,
    pub runs: Option<Vec<RunSummary>>,
    pub windows: Windows,
    /// The kits that apply to the whole organization: a block of a kit not
    /// among them was not asked (ADR-0070 §7, ADR-0079).
    pub kits: Kits,
    /// The kits' blocks, in their order.
    pub blocks: Vec<(&'static OverviewBlock, BlockAnswer)>,
}

#[derive(Debug)]
pub enum Refusal {
    NotFound,
}

/// The gears an overview reads, resolved per request: several of them
/// publish in their own REST phase, after this gear's routes are built.
pub struct Overview {
    pub sources: Arc<Sources>,
    pub hub: Arc<ClientHub>,
    /// Answers kept for a minute, per organization and caller.
    pub answers: Answers,
    /// One project's health lines kept for a minute, per project and caller
    /// ([`Overview::project_health`]).
    pub project_lines: Answers<ProjectHealth>,
}

/// How long one caller's overview of one organization is reused. A leader's
/// screen asks again on every open, and the answer is a dozen gears' worth
/// of reads that move by the hour, not the second.
const ANSWER_TTL: std::time::Duration = std::time::Duration::from_secs(60);

/// Overviews kept per `(organization, caller)`. The caller is part of the
/// key because the answer is theirs: the tree is read as them, and the money
/// is there only for someone who may see costs. The organization is checked
/// for this caller before a kept answer is served ([`Overview::answer`]).
pub struct Answers<V = OrganizationOverviewDto> {
    ttl: std::time::Duration,
    kept: std::sync::Mutex<HashMap<(Uuid, Uuid), (std::time::Instant, V)>>,
}

impl<V> Default for Answers<V> {
    fn default() -> Self {
        Self::with_ttl(ANSWER_TTL)
    }
}

impl<V> Answers<V> {
    fn with_ttl(ttl: std::time::Duration) -> Self {
        Self {
            ttl,
            kept: std::sync::Mutex::new(HashMap::new()),
        }
    }
}

impl<V: Clone> Answers<V> {
    /// Answers remembered at most; past it, the cache starts over.
    const CAPACITY: usize = 256;

    fn get(&self, org: Uuid, caller: Uuid) -> Option<V> {
        let kept = self.kept.lock().ok()?;
        kept.get(&(org, caller))
            .filter(|(at, _)| at.elapsed() < self.ttl)
            .map(|(_, v)| v.clone())
    }

    fn put(&self, org: Uuid, caller: Uuid, answer: V) {
        if let Ok(mut kept) = self.kept.lock() {
            if kept.len() >= Self::CAPACITY && !kept.contains_key(&(org, caller)) {
                kept.clear();
            }
            kept.insert((org, caller), (std::time::Instant::now(), answer));
        }
    }
}

impl Overview {
    /// The kits that apply where `tenant` is (a project's effective kits, or
    /// an organization's), from studio-kits ([`KitPresence`]). An assembly
    /// without studio-kits, or an answer that could not be read, is
    /// [`Kits::All`]: nothing is hidden for a failed read.
    ///
    /// [`KitPresence`]: crate::kit_registry::port::KitPresence
    pub async fn kits(&self, ctx: &SecurityContext, tenant: Uuid) -> Kits {
        let Ok(presence) = self.hub.get::<dyn crate::kit_registry::port::KitPresence>() else {
            return Kits::All;
        };
        match presence.effective(ctx, tenant).await {
            Ok(kits) => Kits::Only(kits),
            Err(e) => {
                tracing::warn!(%tenant, error = %format!("{e:#}"), "organizations: installed kits not read");
                Kits::All
            }
        }
    }

    /// The organization's overview for this caller, from the last minute's
    /// answer when there is one. The organization is read as the caller
    /// first either way, so a caller who no longer reaches it is refused
    /// rather than served what they saw before.
    pub async fn answer(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        now: OffsetDateTime,
    ) -> Result<OrganizationOverviewDto, Refusal> {
        let tenant = self.admit(ctx, org).await?;
        let caller = ctx.subject_id();
        if let Some(kept) = self.answers.get(org, caller) {
            return Ok(kept);
        }
        let read = self.read_admitted(ctx, org, tenant.name, now).await;
        let answer = compose(org, &read, now);
        self.answers.put(org, caller, answer.clone());
        Ok(answer)
    }

    /// One project's health line, as the organization's overview would show
    /// it, without reading the organization: `project-status` used to build
    /// the whole overview (every project's rollup, every tenant's runs) to
    /// find this one line (`overview read rows=15 elapsed_ms=5551` on Dev).
    ///
    /// From the overview the caller already has when there is one; otherwise
    /// from the project's rollup row, the runs of the organization, the
    /// project's workspace and the project (where its repositories' runs are
    /// recorded), and the signals the kits' blocks give for it alone
    /// ([`BlockAt::health_only`]). Kept a minute per (project, caller), as
    /// the overview is. Spend plays no part in the line `project-status`
    /// reads, so it is not read.
    pub async fn project_health(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        project: &Rollup,
        now: OffsetDateTime,
    ) -> Result<ProjectHealth, Refusal> {
        self.admit(ctx, org).await?;
        let caller = ctx.subject_id();
        let workspace = project.parent_id.unwrap_or(org);
        if let Some(kept) = self.answers.get(org, caller)
            && let Some(line) = kept
                .workspaces
                .iter()
                .flat_map(|w| w.projects.iter())
                .find(|p| p.id == project.id.to_string())
        {
            return Ok(health_of_line(project.id, workspace, line));
        }
        if let Some(kept) = self.project_lines.get(project.id, caller) {
            return Ok(kept);
        }
        let started = std::time::Instant::now();
        let runs = async {
            let Ok(source) = self.hub.get::<dyn RecentRuns>() else {
                return Vec::new();
            };
            let mut tenants = vec![org, project.id];
            if workspace != org {
                tenants.push(workspace);
            }
            let reads = futures_util::future::join_all(
                tenants
                    .iter()
                    .map(|t| source.recent_runs(*t, RUNS_PER_TENANT)),
            )
            .await;
            let mut all: Vec<RunSummary> =
                reads.into_iter().filter_map(Result::ok).flatten().collect();
            all.sort_by_key(|r| std::cmp::Reverse(r.created_at));
            all
        };
        let row = row_of(project);
        let rows = [row.clone()];
        let at = BlockAt {
            organization: org,
            windows: windows(now),
            now,
            health_only: true,
        };
        let signals = async {
            let kits = self.kits(ctx, org).await;
            let applicable = blocks::applicable(Level::Organization, &kits);
            let prepared = blocks::prepare_all(&applicable, &self.hub, ctx, &at).await;
            let (places, names) = (BTreeMap::new(), BTreeMap::new());
            let scope = BlockScope {
                at: &at,
                organization_name: "",
                rows: &rows,
                places: &places,
                members: None,
                names: &names,
            };
            let answers = blocks::answer_all(&applicable, prepared, &self.hub, ctx, &scope).await;
            blocks::merge(answers.into_iter().map(|(_, a)| a.signals))
        };
        let (runs, signals) = tokio::join!(runs, signals);
        let key = project.id.to_string();
        let broken: BTreeSet<String> = broken_connections(&runs)
            .into_iter()
            .flat_map(|b| b.projects)
            .filter(|p| *p == key)
            .collect();
        let stuck_by: BTreeMap<String, u32> = signals
            .stuck
            .unwrap_or_default()
            .into_iter()
            .filter(|(k, _)| *k == key)
            .collect();
        let line = project_health(
            &row,
            workspace,
            &HealthInputs {
                spend: None,
                previous: None,
                stuck: &stuck_by,
                broken: &broken,
                now,
            },
        );
        tracing::info!(
            %org,
            project = %project.id,
            elapsed_ms = started.elapsed().as_millis(),
            "organizations: one project's health read"
        );
        self.project_lines.put(project.id, caller, line.clone());
        Ok(line)
    }
}

/// A project's line of an overview already composed, back as the health
/// [`Overview::project_health`] answers.
fn health_of_line(id: Uuid, workspace_id: Uuid, line: &OverviewProjectDto) -> ProjectHealth {
    let mut reasons = Vec::new();
    for r in &line.reasons {
        let n = r.value.map_or(0, |v| v.round() as u32);
        reasons.push(match r.kind.as_str() {
            "refused" => Reason::Refused,
            "specs_failing" => Reason::SpecsFailing(n),
            "stuck" => Reason::Stuck(n),
            "spend_grows" => Reason::SpendGrows(r.value.unwrap_or(0.0)),
            "quiet" => Reason::Quiet(n),
            _ => continue,
        });
    }
    ProjectHealth {
        id,
        name: line.name.clone(),
        workspace_id,
        specs_failing: line.specs_failing,
        open_findings: line.open_findings,
        spend: line.spend,
        previous: line.previous,
        stuck: line.stuck,
        quiet_days: line.quiet_days,
        broken: line.broken,
        reasons,
        score: line.score,
        phase: line.phase.clone(),
    }
}

impl Overview {
    /// The organization as the caller reads it, or [`Refusal::NotFound`] when
    /// they do not reach it or it is not an organization.
    pub(super) async fn admit(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
    ) -> Result<account_management_sdk::Tenant, Refusal> {
        let tenant = self
            .sources
            .am
            .get_tenant(ctx, org)
            .await
            .map_err(|_| Refusal::NotFound)?;
        if tenant.tenant_type.as_deref() != Some(ORGANIZATION_TENANT_TYPE) {
            return Err(Refusal::NotFound);
        }
        Ok(tenant)
    }

    /// Everything the overview is computed from, for an organization
    /// [`Self::admit`] let the caller into.
    async fn read_admitted(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        name: String,
        now: OffsetDateTime,
    ) -> Read {
        let windows = windows(now);
        let kits = self.kits(ctx, org).await;
        let applicable = blocks::applicable(Level::Organization, &kits);
        let at = BlockAt {
            organization: org,
            windows,
            now,
            health_only: false,
        };
        let started = std::time::Instant::now();

        // The blocks' own reads start beside the tree's. Within the tree, each
        // read starts as soon as what it needs is in: the roster feeds both
        // the rows and the names; the rows feed the runs and the blocks'
        // answers, read side by side.
        let tree = async {
            let members = match &self.sources.roster {
                Some(roster) => roster.active_members(org).await.ok(),
                None => None,
            };
            let names = async {
                match (&self.sources.roster, &members) {
                    (Some(roster), Some(members)) => {
                        let people: Vec<String> =
                            members.iter().map(|m| m.person.clone()).collect();
                        roster.display_names(&people).await.unwrap_or_default()
                    }
                    _ => BTreeMap::new(),
                }
            };
            let rows = async {
                self.sources
                    .organization_with(ctx, org, members.clone())
                    .await
                    .iter()
                    .map(row_of)
                    .collect::<Vec<Row>>()
            };
            let (names, rows) = tokio::join!(names, rows);
            (members, names, rows)
        };
        let (prepared, (members, names, rows)) =
            tokio::join!(blocks::prepare_all(&applicable, &self.hub, ctx, &at), tree);
        let places = places_of(org, &name, &rows);
        let runs = async {
            let source = self.hub.get::<dyn RecentRuns>().ok()?;
            let mut tenants = vec![org];
            tenants.extend(rows.iter().map(|r| r.id));
            let reads = futures_util::future::join_all(
                tenants
                    .iter()
                    .map(|t| source.recent_runs(*t, RUNS_PER_TENANT)),
            )
            .await;
            let mut all: Vec<RunSummary> =
                reads.into_iter().filter_map(Result::ok).flatten().collect();
            all.sort_by_key(|r| std::cmp::Reverse(r.created_at));
            Some(all)
        };
        let answers = async {
            let scope = BlockScope {
                at: &at,
                organization_name: &name,
                rows: &rows,
                places: &places,
                members: members.as_deref(),
                names: &names,
            };
            blocks::answer_all(&applicable, prepared, &self.hub, ctx, &scope).await
        };
        let (runs, blocks) = tokio::join!(runs, answers);
        tracing::info!(
            %org,
            rows = rows.len(),
            blocks = blocks.len(),
            elapsed_ms = started.elapsed().as_millis(),
            "organizations: overview read"
        );
        Read {
            name,
            rows,
            members,
            names,
            runs,
            windows,
            kits,
            blocks,
        }
    }
}

/// Names of every tenant a figure can be keyed by.
fn places_of(org: Uuid, name: &str, rows: &[Row]) -> BTreeMap<String, String> {
    let mut places: BTreeMap<String, String> = rows
        .iter()
        .map(|r| (r.id.to_string(), r.name.clone()))
        .collect();
    places.insert(org.to_string(), name.to_owned());
    places
}

// ── The answer ───────────────────────────────────────────────────────────────

use super::rest::{
    OrganizationOverviewDto, OverviewNeedDto, OverviewPeopleDto, OverviewPersonDto,
    OverviewProjectDto, OverviewReasonDto, OverviewRunFailureDto, OverviewWorkspaceDto,
};

fn rfc3339(t: OffsetDateTime) -> String {
    t.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

fn need_dto(need: Need) -> OverviewNeedDto {
    match need {
        Need::Refused {
            provider,
            status,
            projects,
            repos,
        } => OverviewNeedDto {
            kind: "connection".into(),
            tone: "danger".into(),
            provider: Some(provider),
            status: Some(status.into()),
            projects,
            repos: Some(repos),
            ..OverviewNeedDto::default()
        },
        Need::RunsFailed { runs } => OverviewNeedDto {
            kind: "runs".into(),
            tone: "warn".into(),
            runs: Some(runs),
            ..OverviewNeedDto::default()
        },
    }
}

fn reason_dto(r: &Reason) -> OverviewReasonDto {
    let (kind, value) = match r {
        Reason::Refused => ("refused", None),
        Reason::SpecsFailing(n) => ("specs_failing", Some(f64::from(*n))),
        Reason::Stuck(n) => ("stuck", Some(f64::from(*n))),
        Reason::SpendGrows(g) => ("spend_grows", Some(*g)),
        Reason::Quiet(d) => ("quiet", Some(f64::from(*d))),
    };
    OverviewReasonDto {
        kind: kind.into(),
        value,
    }
}

/// Everything read, folded into the answer by the rules above.
pub fn compose(org: Uuid, read: &Read, now: OffsetDateTime) -> OrganizationOverviewDto {
    let w = read.windows;
    let places = places_of(org, &read.name, &read.rows);

    let runs = read.runs.as_deref().unwrap_or_default();
    let broken = broken_connections(runs);
    let broken_projects: BTreeSet<String> = broken
        .iter()
        .flat_map(|b| b.projects.iter().cloned())
        .collect();

    let signals = blocks::merge(read.blocks.iter().map(|(_, a)| a.signals.clone()));
    let stuck_by = signals.stuck.clone().unwrap_or_default();
    let health = workspace_health(
        &read.rows,
        &HealthInputs {
            spend: signals.spend.as_ref(),
            previous: signals.previous.as_ref(),
            stuck: &stuck_by,
            broken: &broken_projects,
            now,
        },
    );
    let needs = needs(&NeedInputs {
        broken: &broken,
        project_names: &places,
        other_failures: other_failures(runs),
    });
    let people = OverviewPeopleDto {
        active: read.members.as_ref().map(|m| count(m.len())),
        idle: match (&signals.activity, read.members.as_deref()) {
            (Activity::Seen(active), Some(members)) => Some(
                idle(members, active)
                    .into_iter()
                    .map(|person| OverviewPersonDto {
                        name: read.names.get(&person).cloned(),
                        person_id: person,
                    })
                    .collect(),
            ),
            _ => None,
        },
    };

    OrganizationOverviewDto {
        organization_id: org.to_string(),
        name: read.name.clone(),
        period_from: rfc3339(w.current.from),
        period_to: rfc3339(w.current.to),
        previous_from: rfc3339(w.previous.from),
        previous_to: rfc3339(w.previous.to),
        stuck_days: STUCK_DAYS,
        growth_alert: GROWTH_ALERT,
        quiet_days: QUIET_DAYS,
        needs: needs.into_iter().map(need_dto).collect(),
        blocks: read
            .blocks
            .iter()
            .map(|(b, a)| OverviewBlockDto::of(b, a.clone()))
            .collect(),
        kits: match &read.kits {
            Kits::All => None,
            Kits::Only(kits) => Some(kits.clone()),
        },
        people,
        currency: signals.currency.clone(),
        workspaces: health
            .into_iter()
            .map(|ws| OverviewWorkspaceDto {
                id: ws.id.to_string(),
                name: ws.name,
                spend: ws.spend,
                previous: ws.previous,
                specs_failing: ws.specs_failing,
                stuck: ws.stuck,
                quiet_days: ws.quiet_days,
                score: ws.score,
                projects: ws
                    .projects
                    .into_iter()
                    .map(|p| OverviewProjectDto {
                        reasons: p.reasons.iter().map(reason_dto).collect(),
                        id: p.id.to_string(),
                        name: p.name,
                        spend: p.spend,
                        previous: p.previous,
                        specs_failing: p.specs_failing,
                        open_findings: p.open_findings,
                        stuck: p.stuck,
                        quiet_days: p.quiet_days,
                        broken: p.broken,
                        score: p.score,
                        phase: p.phase,
                    })
                    .collect(),
            })
            .collect(),
        recent_failures: read.runs.as_ref().map(|runs| {
            let mut recent: Vec<_> = runs.iter().filter(|r| is_other_failure(r)).collect();
            recent.sort_by_key(|r| std::cmp::Reverse(r.created_at));
            recent
                .into_iter()
                .map(|r| OverviewRunFailureDto {
                    id: r.id.to_string(),
                    tenant_id: r.tenant_id.to_string(),
                    task_type: r.task_type.clone(),
                    created_at: rfc3339(r.created_at),
                })
                .collect()
        }),
    }
}

#[cfg(test)]
#[path = "overview_tests.rs"]
mod tests;
