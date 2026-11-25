//! The Delivery block of an organization's Overview (the Git kit's
//! contribution through the core's Overview port, ADR-0079 §4): pull
//! requests merged and open, and the work that does not move.
//!
//! **A pull request is stuck after [`STUCK_DAYS`] days without a move.** A
//! draft waits on nobody yet. Stuck work is queued by the person it waits on,
//! an account read as a member where it is one of the organization's people.
//!
//! What it gives the core: each project's stuck pull requests (its health),
//! and the people seen on a pull request (nobody on one is idle).

use std::collections::{BTreeMap, BTreeSet};

use async_trait::async_trait;
use serde_json::json;
use toolkit::client_hub::{ClientHub, ClientScope};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::port::{OpenPull, OpenPullRequests};
use crate::organizations::port::{
    Activity, BlockAnswer, BlockNeedDto, BlockScope, BlockSource, DetailRowDto, DetailsDto, Level,
    LineDto, LinkDto, OverviewBlock, Prepared, STUCK_DAYS, Signals, TileDto, english, median,
    words,
};
use crate::user_profile::MemberAliases;

/// The kit pull requests are.
pub const GIT_KIT: &str = "project-git";
/// The organization's Workspaces tab, where each workspace folds out its
/// projects.
const WORKSPACES_ROUTE: &str = "/organization/workspaces";
/// The account kinds a pull request's login is looked up as.
const ACCOUNT_KINDS: [&str; 2] = ["github", "gitlab"];
/// Queues said as needs, longest first.
const QUEUES_SAID: usize = 6;

inventory::submit! {
    OverviewBlock {
        kit: GIT_KIT,
        gear: "studio-artifact-ingest",
        id: "delivery",
        order: 20,
        level: Level::Organization,
        source: &DeliveryBlock,
    }
}

// ── Work that does not move ─────────────────────────────────────────────────

pub fn idle_days(p: &OpenPull) -> u32 {
    p.days_since_update.or(p.days_open).unwrap_or(0)
}

/// Open pull requests waiting on someone for `days` or more without a move.
pub fn stuck(pulls: &[OpenPull], days: u32) -> Vec<&OpenPull> {
    pulls
        .iter()
        .filter(|p| p.waiting != "draft" && idle_days(p) >= days)
        .collect()
}

/// A person a pull request waits on, as the overview names them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Queue {
    /// The member, when the account is one of the organization's people.
    pub person_id: Option<String>,
    /// Their name, else the account; `None` for "nobody asked to review".
    pub who: Option<String>,
    pub count: u32,
    pub oldest_days: u32,
}

/// A member an account is: their person id and the name their profile carries.
pub type Member = (String, Option<String>);

/// Who the stuck pull requests wait on, longest queue first. `member` reads an
/// account as `(person, name)`.
pub fn waiting_on(stuck: &[&OpenPull], member: &dyn Fn(&str) -> Option<Member>) -> Vec<Queue> {
    let mut out: Vec<Queue> = Vec::new();
    let mut add = |person_id: Option<String>, who: Option<String>, days: u32| {
        let same = |q: &&mut Queue| match (&person_id, &q.person_id) {
            (Some(a), Some(b)) => a == b,
            (None, None) => q.who == who,
            _ => false,
        };
        match out.iter_mut().find(|q| same(q)) {
            Some(q) => {
                q.count += 1;
                q.oldest_days = q.oldest_days.max(days);
            }
            None => out.push(Queue {
                person_id,
                who,
                count: 1,
                oldest_days: days,
            }),
        }
    };
    for p in stuck {
        let days = idle_days(p);
        if p.waiting == "nobody" {
            add(None, None, days);
        }
        for login in &p.waiting_on {
            match member(login) {
                Some((person, name)) => add(
                    Some(person),
                    Some(name.unwrap_or_else(|| login.clone())),
                    days,
                ),
                None => add(None, Some(login.clone()), days),
            }
        }
    }
    out.sort_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then(b.oldest_days.cmp(&a.oldest_days))
            .then(a.who.cmp(&b.who))
    });
    out
}

/// The repository a pull request's address names (`acme/shop`), GitHub's
/// `/pull/` or GitLab's `/-/merge_requests/`.
pub fn repository_of(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let (_, path) = rest.split_once('/')?;
    let end = path
        .find("/-/merge_requests/")
        .or_else(|| path.find("/pull/"))?;
    Some(path[..end].to_owned()).filter(|r| !r.is_empty())
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

fn sum(vs: impl Iterator<Item = Option<u32>>) -> Option<u32> {
    vs.fold(None, |acc, v| match (acc, v) {
        (None, None) => None,
        (a, v) => Some(a.unwrap_or(0) + v.unwrap_or(0)),
    })
}

fn plural(n: u32, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

// ── The block ────────────────────────────────────────────────────────────────

pub struct DeliveryBlock;

#[async_trait]
impl BlockSource for DeliveryBlock {
    async fn answer(
        &self,
        hub: &ClientHub,
        ctx: &SecurityContext,
        _prepared: Prepared,
        scope: &BlockScope<'_>,
    ) -> Option<BlockAnswer> {
        let pulls = match hub.get::<dyn OpenPullRequests>() {
            Ok(source) => {
                // One read for every project, not one per project.
                let projects: Vec<String> = scope.projects().map(|r| r.id.to_string()).collect();
                Some(source.open_pulls_in(ctx, &projects).await)
            }
            Err(_) => None,
        };
        if scope.at.health_only {
            return Some(BlockAnswer {
                signals: Signals {
                    stuck: Some(stuck_by_project(pulls.as_deref().unwrap_or_default())),
                    ..Signals::default()
                },
                ..BlockAnswer::default()
            });
        }
        let accounts = accounts(hub, scope.at.organization, pulls.as_deref().unwrap_or_default()).await;
        Some(answer(pulls.as_deref(), &accounts, scope))
    }
}

fn stuck_by_project(pulls: &[OpenPull]) -> BTreeMap<String, u32> {
    let mut out: BTreeMap<String, u32> = BTreeMap::new();
    for p in stuck(pulls, STUCK_DAYS) {
        if let Some(id) = &p.project_id {
            *out.entry(id.clone()).or_default() += 1;
        }
    }
    out
}

/// The pull requests' accounts that are the organization's people, by
/// lowercased login.
async fn accounts(hub: &ClientHub, org: Uuid, pulls: &[OpenPull]) -> BTreeMap<String, Member> {
    let mut out = BTreeMap::new();
    let Ok(directory) = hub.get_scoped::<dyn MemberAliases>(&ClientScope::gts_id(
        crate::user_profile::IDENTITY_INSTANCE_ID,
    )) else {
        return out;
    };
    let logins: Vec<String> = pulls
        .iter()
        .flat_map(|p| p.author.iter().chain(&p.waiting_on).chain(&p.reviewers))
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    if logins.is_empty() {
        return out;
    }
    // One lookup per kind, asked together; merged in the kinds' order, so a
    // login known under both is still the first kind's.
    let found = futures_util::future::join_all(
        ACCOUNT_KINDS
            .iter()
            .map(|kind| directory.members_by_alias(org, kind, &logins)),
    )
    .await;
    for found in found.into_iter().filter_map(Result::ok) {
        for (login, m) in found {
            out.entry(login).or_insert((m.person, m.display_name));
        }
    }
    out
}

/// The block, from the open pull requests (`None`: they could not be read)
/// and the accounts that are members.
pub fn answer(
    pulls: Option<&[OpenPull]>,
    accounts: &BTreeMap<String, Member>,
    scope: &BlockScope<'_>,
) -> BlockAnswer {
    let all = pulls.unwrap_or_default();
    let stuck_pulls = stuck(all, STUCK_DAYS);
    let member_of = |login: &str| accounts.get(&login.to_ascii_lowercase()).cloned();
    let queues = waiting_on(&stuck_pulls, &member_of);
    let open_ages: Vec<u32> = all
        .iter()
        .filter(|p| p.waiting != "draft")
        .filter_map(|p| p.days_open)
        .collect();
    let merged = sum(scope.projects().map(|r| r.pulls_merged));
    let open = sum(scope.projects().map(|r| r.pulls_open));
    let wait = median(&open_ages);
    let to_workspaces = || {
        LinkDto::to(
            WORKSPACES_ROUTE,
            words("Workspaces →", "Рабочие пространства →"),
        )
    };

    let mut without_reviewers: Vec<&OpenPull> =
        stuck_pulls.iter().copied().filter(|p| p.waiting == "nobody").collect();
    without_reviewers.sort_by_key(|p| std::cmp::Reverse(idle_days(p)));
    let place = |p: &OpenPull| {
        p.project_id
            .as_ref()
            .and_then(|id| scope.places.get(id))
            .cloned()
    };

    let needs: Vec<BlockNeedDto> = queues
        .iter()
        .take(QUEUES_SAID)
        .map(|q| {
            let who = q
                .who
                .clone()
                .unwrap_or_else(|| "nobody (no reviewer asked)".to_owned());
            let details = q.who.is_none().then(|| DetailsDto {
                label: words("View PRs without reviewers", "Открыть PR без ревьюера"),
                rows: without_reviewers
                    .iter()
                    .map(|&p| {
                        let url = p
                            .url
                            .clone()
                            .filter(|u| u.starts_with("https://") || u.starts_with("http://"));
                        let mut note = Vec::new();
                        if let Some(project) = place(p) {
                            note.push(LineDto::new(english("{project}")).text("project", project));
                        }
                        if let Some(repo) = url.as_deref().and_then(repository_of) {
                            note.push(LineDto::new(english("{repo}")).text("repo", repo));
                        }
                        note.push(
                            LineDto::new(words(
                                "{days} days without an update",
                                "Дней без обновлений: {days}",
                            ))
                            .count("days", Some(f64::from(idle_days(p)))),
                        );
                        DetailRowDto {
                            text: format!("#{} {}", p.number, p.title),
                            href: url,
                            note,
                        }
                    })
                    .collect(),
            });
            BlockNeedDto {
                key: format!(
                    "queue:{}",
                    q.person_id.as_deref().or(q.who.as_deref()).unwrap_or("nobody")
                ),
                tone: "warn".into(),
                sentence: LineDto::new(english("{pulls} on {who}"))
                    .text(
                        "pulls",
                        plural(q.count, "pull request waits", "pull requests wait"),
                    )
                    .text("who", who),
                detail: Some(
                    LineDto::new(english("the oldest {days} days without a move"))
                        .count("days", Some(f64::from(q.oldest_days))),
                ),
                action: Some(LinkDto::to(WORKSPACES_ROUTE, english("Open workspaces"))),
                details,
            }
        })
        .collect();

    let on_pulls: BTreeSet<String> = all
        .iter()
        .flat_map(|p| p.author.iter().chain(&p.waiting_on).chain(&p.reviewers))
        .filter_map(|login| member_of(login).map(|(person, _)| person))
        .collect();

    BlockAnswer {
        tile: Some(TileDto {
            title: words("Delivery", "Поставка"),
            value: Some(
                LineDto::new(words("{merged} merged", "смёрджено: {merged}"))
                    .count("merged", merged.map(f64::from)),
            ),
            lines: vec![
                LineDto::new(words(
                    "{open} open · median wait {wait} d",
                    "открыто: {open} · медиана ожидания {wait} дн.",
                ))
                .count("open", open.map(f64::from))
                .count("wait", wait),
            ],
            link: Some(to_workspaces()),
            items: None,
        }),
        needs,
        signals: Signals {
            stuck: pulls.map(stuck_by_project),
            activity: if pulls.is_some() {
                Activity::Seen(on_pulls)
            } else {
                Activity::Silent
            },
            ..Signals::default()
        },
        data: json!({
            "merged": merged,
            "window_days": crate::organizations::port::ACTIVITY_DAYS,
            "open": open,
            "median_wait_days": wait,
            "stuck": count(stuck_pulls.len()),
            "waiting_on": pulls.map(|_| queues.iter().map(|q| json!({
                "person_id": q.person_id,
                "who": q.who,
                "count": q.count,
                "oldest_days": q.oldest_days,
            })).collect::<Vec<_>>()),
            "pulls_without_reviewers": pulls.map(|_| without_reviewers.iter().map(|&p| json!({
                "id": p.id,
                "number": p.number,
                "title": p.title,
                "url": p.url,
                "project": place(p),
                "quiet_days": idle_days(p),
            })).collect::<Vec<_>>()),
        }),
    }
}

#[cfg(test)]
#[path = "overview_block_tests.rs"]
mod tests;
