//! One person's Inbox: everything whose next move is theirs, across the
//! workspaces of their organization (ADR-0068 §6).
//!
//! Moved from the portal (`waiting-on-me.ts` `inboxItems`, `reviewKey`,
//! `pullKey`; `pull-request-waits.ts` `myPullsInOrder`). The items are not
//! stored: each is read from its source every time, so an item leaves by
//! itself when its fact changes. What the person keeps is a mark — done, or
//! snoozed until a time (`me/inbox-marks`) — and the marks are applied here.
//!
//! Every item names its `source`, so a kit can add a source later without the
//! shape changing. Today's two: `review-requests` (studio-documents, a review
//! that waits on the person's verdict) and `pull-requests` (studio-artifact-
//! ingest, a pull request whose next step is theirs). They are read through
//! their REST routes as the caller (`crate::mcp::sdk::Api`), with the same
//! `waiting_on=me` the portal sent, so the Inbox shows a person exactly what
//! those routes show them.

use serde_json::Value;
use time::OffsetDateTime;

use crate::mcp::sdk::Api;

/// The sources an Inbox reads today, in the order an item of each sorts when
/// nothing else tells them apart.
pub const REVIEW_REQUESTS: &str = "review-requests";
pub const PULL_REQUESTS: &str = "pull-requests";

/// One item waiting on the person.
#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    /// What its mark is kept under: `review:<id>`, or `pr:<id>@<updated_at>`
    /// (a pull request marked done comes back when somebody moves it).
    pub key: String,
    /// The source it came from.
    pub source: &'static str,
    pub workspace_id: String,
    pub workspace_name: String,
    pub title: String,
    pub url: Option<String>,
    /// When it is due, RFC 3339.
    pub due_at: Option<String>,
    pub overdue: bool,
    /// The source's own record, as its route answers it.
    pub record: Value,
}

/// A mark the person keeps on an item.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mark {
    pub item_key: String,
    /// `done`, `snoozed` or `open`.
    pub state: String,
    pub until: Option<OffsetDateTime>,
}

/// A review request is one item for as long as it lives.
pub fn review_key(r: &Value) -> String {
    format!("review:{}", r["id"].as_str().unwrap_or_default())
}

/// A pull request is keyed with when it last changed.
pub fn pull_key(p: &Value) -> String {
    format!(
        "pr:{}@{}",
        p["id"].as_str().unwrap_or_default(),
        p["updated_at"].as_str().unwrap_or_default()
    )
}

/// A person's pull requests in the order they answer them: waiting on their
/// review first, then on them as the author, merge, nobody, a draft; within
/// one, the longest quiet first (`myPullsInOrder`).
pub fn pulls_in_order(mut items: Vec<Value>) -> Vec<Value> {
    let rank = |p: &Value| match p["waiting"].as_str() {
        Some("review") => 0,
        Some("author") => 1,
        Some("merge") => 2,
        Some("nobody") => 3,
        Some("draft") => 4,
        _ => 5,
    };
    let quiet = |p: &Value| p["days_since_update"].as_i64().unwrap_or(-1);
    items.sort_by(|a, b| rank(a).cmp(&rank(b)).then(quiet(b).cmp(&quiet(a))));
    items
}

fn text(v: &Value) -> Option<String> {
    v.as_str().filter(|s| !s.is_empty()).map(str::to_string)
}

/// A workspace's review requests and pull requests as items, reviews first,
/// each list in its own order.
pub fn items_of(
    workspace_id: &str,
    workspace_name: &str,
    reviews: Vec<Value>,
    pulls: Vec<Value>,
) -> Vec<Item> {
    let review = reviews.into_iter().map(|r| Item {
        key: review_key(&r),
        source: REVIEW_REQUESTS,
        workspace_id: workspace_id.to_string(),
        workspace_name: workspace_name.to_string(),
        title: text(&r["title"]).unwrap_or_default(),
        url: None,
        due_at: text(&r["due_at"]),
        overdue: r["overdue"].as_bool().unwrap_or(false),
        record: r,
    });
    let pull = pulls_in_order(pulls).into_iter().map(|p| Item {
        key: pull_key(&p),
        source: PULL_REQUESTS,
        workspace_id: workspace_id.to_string(),
        workspace_name: workspace_name.to_string(),
        title: text(&p["title"]).unwrap_or_default(),
        url: text(&p["url"]),
        due_at: None,
        overdue: false,
        record: p,
    });
    review.chain(pull).collect()
}

/// Whether a mark hides its item now: done, or snoozed until later.
fn hides(mark: Option<&Mark>, now: OffsetDateTime) -> bool {
    match mark {
        Some(m) if m.state == "done" => true,
        Some(m) if m.state == "snoozed" => m.until.is_some_and(|u| u > now),
        _ => false,
    }
}

/// The open items in the order a person works through them — overdue first,
/// then by due date, then reviews before pull requests, then as their lists
/// gave them — and the items the marks hide, in the list's own order.
/// `items` are every workspace's, reviews of all of them before the pull
/// requests of all of them, as the portal concatenated them.
pub fn inbox(items: Vec<Item>, marks: &[Mark], now: OffsetDateTime) -> (Vec<Item>, Vec<Item>) {
    let mark_of = |key: &str| marks.iter().find(|m| m.item_key == key);
    let (hidden, mut open): (Vec<Item>, Vec<Item>) =
        items.into_iter().partition(|i| hides(mark_of(&i.key), now));
    let due = |i: &Item| {
        i.due_at
            .as_deref()
            .and_then(|d| {
                OffsetDateTime::parse(d, &time::format_description::well_known::Rfc3339).ok()
            })
            .map_or(i128::MAX, |t| t.unix_timestamp_nanos())
    };
    // Stable: equal items keep the order they came in.
    open.sort_by_key(|i| (!i.overdue, due(i), i.source != REVIEW_REQUESTS));
    (open, hidden)
}

/// The workspaces of the caller's organization, `(id, name)`.
fn workspaces(rollups: &Value) -> Vec<(String, String)> {
    rollups["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| r["kind"] == "workspace")
        .filter_map(|r| Some((text(&r["id"])?, text(&r["name"]).unwrap_or_default())))
        .collect()
}

/// The most pull requests read for one workspace: pages of 200.
const PULL_PAGES: usize = 10;

/// What a read could not reach, by source and workspace, for the answer to
/// name rather than show as nothing waiting.
pub struct Read {
    pub items: Vec<Item>,
    pub unread: Vec<String>,
}

/// Every source of every workspace of the caller's organization, read as the
/// caller.
pub async fn read(api: &Api) -> Read {
    let mut unread = Vec::new();
    let spaces = match api.get("/studio-organizations/v1/rollups", &[]).await {
        Ok(r) => workspaces(&r),
        Err(e) => {
            unread.push(format!("workspaces: {}", e.0));
            Vec::new()
        }
    };
    let per = futures_util::future::join_all(spaces.iter().map(|(id, name)| async move {
        let q = vec![
            ("workspace_id".to_string(), id.clone()),
            ("waiting_on".to_string(), "me".to_string()),
        ];
        let reviews = api.get("/studio-documents/v1/review-requests", &q).await;
        let mut pulls: Vec<Value> = Vec::new();
        let mut pulls_failed = None;
        let mut offset = 0usize;
        for _ in 0..PULL_PAGES {
            let mut pq = q.clone();
            pq.push(("limit".to_string(), "200".to_string()));
            pq.push(("offset".to_string(), offset.to_string()));
            match api
                .get("/studio-artifact-ingest/v1/open-pull-requests", &pq)
                .await
            {
                Ok(page) => {
                    let got = page["items"].as_array().cloned().unwrap_or_default();
                    let total = page["total"].as_u64().unwrap_or(0);
                    offset += got.len();
                    let done = got.is_empty() || offset as u64 >= total;
                    pulls.extend(got);
                    if done {
                        break;
                    }
                }
                Err(e) => {
                    pulls_failed = Some(e.0);
                    break;
                }
            }
        }
        (id, name, reviews, pulls, pulls_failed)
    }))
    .await;
    let mut reviews_all = Vec::new();
    let mut pulls_all = Vec::new();
    for (id, name, reviews, pulls, failed) in per {
        // A backend without review requests answers 404: there are none.
        let reviews = match reviews {
            Ok(r) => r["items"].as_array().cloned().unwrap_or_default(),
            Err(_) => Vec::new(),
        };
        if let Some(why) = failed {
            unread.push(format!("{PULL_REQUESTS} in {name}: {why}"));
        }
        reviews_all.extend(items_of(id, name, reviews, Vec::new()));
        pulls_all.extend(items_of(id, name, Vec::new(), pulls));
    }
    reviews_all.extend(pulls_all);
    Read {
        items: reviews_all,
        unread,
    }
}

#[cfg(test)]
#[path = "inbox_tests.rs"]
mod inbox_tests;
