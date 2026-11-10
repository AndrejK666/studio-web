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

/// The kit an item comes from (ADR-0068 §6).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ItemKit {
    pub slug: String,
    pub name: String,
    pub version: String,
}

/// One item waiting on the person.
#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    /// What its mark is kept under: `review:<id>`, or `pr:<id>@<updated_at>`
    /// (a pull request marked done comes back when somebody moves it), or
    /// `kit:<slug>/<source>:<object id>@<fingerprint>` for a kit's item (it
    /// comes back when its object changes).
    pub key: String,
    /// The source it came from: `review-requests`, `pull-requests`, or a
    /// kit's, `kit:<slug>/<source id>`.
    pub source: String,
    /// The kit the source is from; `None` for the shell's own sources.
    pub kit: Option<ItemKit>,
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
        source: REVIEW_REQUESTS.to_owned(),
        kit: None,
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
        source: PULL_REQUESTS.to_owned(),
        kit: None,
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

/// The string a kit's source query names the person by.
pub const ME: &str = "$me";

/// `query` with every string `"$me"` in it the person `me`.
pub fn with_me(query: &Value, me: &str) -> Value {
    match query {
        Value::String(s) if s == ME => Value::String(me.to_owned()),
        Value::Array(items) => Value::Array(items.iter().map(|v| with_me(v, me)).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), with_me(v, me)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// A kit's title template filled from a row: `{field}` is the field's value
/// (a string as it is, anything else as JSON, nothing for a missing one).
pub fn fill(template: &str, row: &Value) -> String {
    let mut out = String::new();
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find('}') {
            Some(close) => {
                let field = &after[..close];
                match row.get(field) {
                    Some(Value::String(s)) => out.push_str(s),
                    Some(Value::Null) | None => {}
                    Some(v) => out.push_str(&v.to_string()),
                }
                rest = &after[close + 1..];
            }
            None => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// A short, stable fingerprint of a row: a kit's item marked done comes back
/// when its object changes, as a pull request does when it moves.
fn fingerprint(v: &Value) -> String {
    // FNV-1a, 64 bits: deterministic across processes, unlike the std hasher.
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in v.to_string().bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// One kit source's rows (`POST /studio-domain-model/v1/query` items:
/// `{id, value}`) as items. `source` is the source as
/// `GET /studio-kits/v1/inbox-sources` lists it; `spaces` names the
/// workspaces, `(id, name)`.
pub fn kit_items(source: &Value, rows: Vec<Value>, spaces: &[(String, String)]) -> Vec<Item> {
    let slug = source["kit_slug"].as_str().unwrap_or_default();
    let id = source["id"].as_str().unwrap_or_default();
    let label = source["label"].as_str().unwrap_or_default();
    let template = source["title"].as_str().filter(|t| !t.is_empty());
    let workspace_field = source["workspace_field"].as_str();
    let kit = ItemKit {
        slug: slug.to_owned(),
        name: source["kit_name"].as_str().unwrap_or(slug).to_owned(),
        version: source["kit_version"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
    };
    rows.into_iter()
        .map(|row| {
            let value = row.get("value").cloned().unwrap_or(Value::Null);
            let object = row["id"].as_str().unwrap_or_default();
            let workspace_id = workspace_field
                .and_then(|f| value.get(f))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let workspace_name = spaces
                .iter()
                .find(|(w, _)| *w == workspace_id)
                .map(|(_, n)| n.clone())
                .unwrap_or_default();
            Item {
                key: format!("kit:{slug}/{id}:{object}@{}", fingerprint(&value)),
                source: format!("kit:{slug}/{id}"),
                kit: Some(kit.clone()),
                workspace_id,
                workspace_name,
                title: template.map_or_else(|| label.to_owned(), |t| fill(t, &value)),
                url: None,
                due_at: None,
                overdue: false,
                record: row,
            }
        })
        .collect()
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

/// The sources the kits installed for the caller's organization bring
/// (`GET /studio-kits/v1/inbox-sources`), each run as the caller with
/// `"$me"` the caller, as items after the shell's own.
async fn kit_sources(api: &Api, me: &str, spaces: &[(String, String)]) -> Read {
    let mut unread = Vec::new();
    let sources = match api
        .get(
            "/studio-kits/v1/inbox-sources",
            &[("limit".to_string(), "200".to_string())],
        )
        .await
    {
        Ok(r) => r["items"].as_array().cloned().unwrap_or_default(),
        Err(e) => {
            unread.push(format!("kit sources: {}", e.0));
            Vec::new()
        }
    };
    let answers = futures_util::future::join_all(sources.iter().map(|source| async move {
        let query = with_me(&source["query"], me);
        let answer = api.post("/studio-domain-model/v1/query", &[], &query).await;
        (source, answer)
    }))
    .await;
    let mut items = Vec::new();
    for (source, answer) in answers {
        match answer {
            Ok(page) => items.extend(kit_items(
                source,
                page["items"].as_array().cloned().unwrap_or_default(),
                spaces,
            )),
            Err(e) => unread.push(format!(
                "{} ({}): {}",
                source["kit_name"].as_str().unwrap_or_default(),
                source["label"].as_str().unwrap_or_default(),
                e.0
            )),
        }
    }
    Read { items, unread }
}

/// Every source of every workspace of the caller's organization, read as the
/// caller (`me` is their subject id), the kits' sources among them.
pub async fn read(api: &Api, me: &str) -> Read {
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
    // What the installed kits bring (ADR-0068 §6), after the shell's own.
    let kits = kit_sources(api, me, &spaces).await;
    reviews_all.extend(kits.items);
    unread.extend(kits.unread);
    Read {
        items: reviews_all,
        unread,
    }
}

#[cfg(test)]
#[path = "inbox_tests.rs"]
mod inbox_tests;
