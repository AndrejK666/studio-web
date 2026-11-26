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
//! shape changing. A kit's gear that reads a source itself registers it
//! through the Inbox port (`super::port::InboxSource`, ADR-0079 §4) --
//! today `review-requests` (project-specs) and `pull-requests` (project-git)
//! -- and declares it as a `studio` source in its `kit.json` (ADR-0070 §7):
//! it is read only while that kit applies to the organization, and an item
//! names the kit it came from. They are read through their REST routes as the
//! caller (`crate::mcp::sdk::Api`), so the Inbox shows a person exactly what
//! those routes show them.

use serde_json::Value;
use time::OffsetDateTime;

use crate::mcp::sdk::Api;

/// The person's background runs that failed in the last [`FAILED_RUN_DAYS`]
/// days (studio-tasks), an undelivered notification among them: the shell's
/// own source, as the bell is.
pub const FAILED_RUNS: &str = "failed-runs";
/// How far back a failed run waits on the person.
pub const FAILED_RUN_DAYS: i64 = 7;

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
    /// Which screen and tool answer it, as its kit's source declares
    /// (`{route?, mcp_tool?}`); `None` for the shell's own sources and a
    /// source that names none.
    pub destination: Option<Value>,
}

/// A mark the person keeps on an item.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mark {
    pub item_key: String,
    /// `done`, `snoozed` or `open`.
    pub state: String,
    pub until: Option<OffsetDateTime>,
}

fn text(v: &Value) -> Option<String> {
    v.as_str().filter(|s| !s.is_empty()).map(str::to_string)
}

/// A workspace's items of the registered sources' records, `rows` in the
/// sources' order: a test's stand-in for a read.
#[cfg(test)]
pub fn items_of(workspace_id: &str, workspace_name: &str, rows: Vec<Vec<Value>>) -> Vec<Item> {
    super::port::sources()
        .into_iter()
        .zip(rows)
        .flat_map(|(s, rows)| (s.items)(workspace_id, workspace_name, rows))
        .collect()
}

/// The failed runs (`GET /studio-tasks/v1/runs?state=failed` items) the
/// person `me` asked for that ended within [`FAILED_RUN_DAYS`] of `now`, as
/// items, newest first. A run is one item for as long as it lives; asking it
/// again is a new run.
pub fn failed_run_items(runs: Vec<Value>, me: &str, now: OffsetDateTime) -> Vec<Item> {
    let since = now - time::Duration::days(FAILED_RUN_DAYS);
    let ended = |r: &Value| {
        r["updated_at"].as_str().and_then(|t| {
            OffsetDateTime::parse(t, &time::format_description::well_known::Rfc3339).ok()
        })
    };
    let mut runs: Vec<(OffsetDateTime, Value)> = runs
        .into_iter()
        .filter(|r| r["state"] == "failed" && r["requested_by"].as_str() == Some(me))
        .filter_map(|r| ended(&r).filter(|t| *t >= since).map(|t| (t, r)))
        .collect();
    runs.sort_by_key(|r| std::cmp::Reverse(r.0));
    runs.into_iter()
        .map(|(_, r)| {
            let kind = r["task_type"]
                .as_str()
                .unwrap_or("a background run")
                .to_owned();
            let title = match text(&r["last_error"]) {
                Some(why) => format!(
                    "{kind} failed: {}",
                    why.chars().take(160).collect::<String>()
                ),
                None => format!("{kind} failed"),
            };
            Item {
                key: format!("run:{}", r["id"].as_str().unwrap_or_default()),
                source: FAILED_RUNS.to_owned(),
                kit: None,
                workspace_id: String::new(),
                workspace_name: String::new(),
                title,
                url: None,
                due_at: None,
                overdue: false,
                record: r,
                destination: None,
            }
        })
        .collect()
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
                destination: destination(source),
            }
        })
        .collect()
}

/// A source's `destination`, when it names one.
fn destination(source: &Value) -> Option<Value> {
    source.get("destination").filter(|d| d.is_object()).cloned()
}

/// The kind of a kit's source whose items a gear's route answers
/// (`docs/design/studio-kits.md` §3.11).
pub const ENDPOINT: &str = "endpoint";

/// Whether an `endpoint` source's `path` is one the Inbox calls: a gear's own
/// literal route. studio-kits checked it when it read the kit's manifest;
/// checked again here, since this is where it is called with the person's
/// token.
pub fn endpoint_path_allowed(path: &str) -> bool {
    path.starts_with("/studio-")
        && path.contains("/v1/")
        && !path.contains(['?', '#', '{', '}', '\\', ' '])
        && !path.contains("..")
        && !path.contains("//")
}

/// One `endpoint` source's answer (`{items: [{id, title?, workspace_id?,
/// url?, due_at?, overdue?, …}]}`) as items. An item with no `id` is left
/// out: its done mark would have nothing to hold on to. Its title is the
/// source's template filled from the item, else the item's own `title`, else
/// the source's label.
pub fn endpoint_items(
    source: &Value,
    answered: Vec<Value>,
    spaces: &[(String, String)],
) -> Vec<Item> {
    let slug = source["kit_slug"].as_str().unwrap_or_default();
    let id = source["id"].as_str().unwrap_or_default();
    let label = source["label"].as_str().unwrap_or_default();
    let template = source["title"].as_str().filter(|t| !t.is_empty());
    let kit = ItemKit {
        slug: slug.to_owned(),
        name: source["kit_name"].as_str().unwrap_or(slug).to_owned(),
        version: source["kit_version"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
    };
    answered
        .into_iter()
        .filter_map(|item| {
            let object = match &item["id"] {
                Value::String(s) if !s.is_empty() => s.clone(),
                Value::Number(n) => n.to_string(),
                _ => return None,
            };
            let workspace_id = text(&item["workspace_id"]).unwrap_or_default();
            let workspace_name = spaces
                .iter()
                .find(|(w, _)| *w == workspace_id)
                .map(|(_, n)| n.clone())
                .unwrap_or_default();
            let title = match template {
                Some(t) => fill(t, &item),
                None => text(&item["title"]).unwrap_or_else(|| label.to_owned()),
            };
            Some(Item {
                key: format!("kit:{slug}/{id}:{object}@{}", fingerprint(&item)),
                source: format!("kit:{slug}/{id}"),
                kit: Some(kit.clone()),
                workspace_id,
                workspace_name,
                title,
                url: text(&item["url"]),
                due_at: text(&item["due_at"]),
                overdue: item["overdue"].as_bool().unwrap_or(false),
                record: item,
                destination: destination(source),
            })
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
/// then by due date, then a source that comes first at an equal due date
/// (reviews) before the rest, then as their lists gave them — and the items
/// the marks hide, in the list's own order. `items` are every workspace's,
/// one source of all of them before the next source's, as the portal
/// concatenated them.
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
    open.sort_by_key(|i| {
        (
            !i.overdue,
            due(i),
            !super::port::first_at_equal_due(&i.source),
        )
    });
    (open, hidden)
}

/// How many workspaces' sources are read at once, and how many kit sources:
/// each is a request through the gateway that takes pooled connections, and
/// an organization with many workspaces queued every one of them together.
const PARALLEL_READS: usize = 4;

/// What a read could not reach, by source and workspace, for the answer to
/// name rather than show as nothing waiting.
pub struct Read {
    pub items: Vec<Item>,
    pub unread: Vec<String>,
    /// Whether every pull request's accounts were matched to the
    /// organization's members (`open-pull-requests`' `members_known`): when
    /// not, "nothing waits on you" may mean "your account is not known".
    pub members_known: bool,
    /// How many workspaces were read.
    pub workspaces: usize,
}

/// `?organization_id=` for a read about `org`, nothing for the caller's home.
fn scope(org: Option<&str>) -> Vec<(String, String)> {
    org.map(|o| vec![("organization_id".to_string(), o.to_string())])
        .unwrap_or_default()
}

/// The kind of source a kit's gear reads itself (`super::port::InboxSource`),
/// which its kit lists to turn it on (`review-requests` with project-specs,
/// `pull-requests` with project-git; ADR-0070 §7).
pub const STUDIO: &str = "studio";

/// Whether the organization's kits turn on the registered source `id`: as
/// its kit lists it, or `None` for one no installed kit brings. `listed` is
/// `None` when the kits' sources could not be read: then every source is
/// read, with no kit, as they were before kits owned them, rather than an
/// Inbox emptied by a failed read.
pub fn owner(listed: Option<&[Value]>, id: &str) -> Option<Option<Value>> {
    let Some(listed) = listed else {
        return Some(None);
    };
    listed
        .iter()
        .find(|s| s["kind"] == STUDIO && s["id"] == id)
        .cloned()
        .map(Some)
}

/// `items` as the source `owner` lists it: its kit and destination. `None`
/// leaves them the shell's.
pub fn owned_by(items: Vec<Item>, owner: Option<&Value>) -> Vec<Item> {
    let Some(source) = owner else {
        return items;
    };
    let slug = source["kit_slug"].as_str().unwrap_or_default();
    let kit = ItemKit {
        slug: slug.to_owned(),
        name: source["kit_name"].as_str().unwrap_or(slug).to_owned(),
        version: source["kit_version"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
    };
    items
        .into_iter()
        .map(|mut i| {
            i.kit = Some(kit.clone());
            i.destination = destination(source);
            i
        })
        .collect()
}

/// The organization's kits' Inbox sources
/// (`GET /studio-kits/v1/inbox-sources`), or why they could not be read.
async fn listed_sources(api: &Api, org: Option<&str>) -> Result<Vec<Value>, String> {
    let mut q = scope(org);
    q.push(("limit".to_string(), "200".to_string()));
    api.get("/studio-kits/v1/inbox-sources", &q)
        .await
        .map(|r| r["items"].as_array().cloned().unwrap_or_default())
        .map_err(|e| e.0)
}

/// The sources the kits installed for the organization bring, Studio's own
/// aside, each run as the caller with `"$me"` the caller, as items after the
/// shell's own.
async fn kit_sources(
    api: &Api,
    me: &str,
    org: Option<&str>,
    spaces: &[(String, String)],
    sources: &[Value],
) -> Read {
    let mut unread = Vec::new();
    use futures_util::StreamExt;
    let sources: Vec<&Value> = sources.iter().filter(|s| s["kind"] != STUDIO).collect();
    // A few at once, in the order the kits list them. By index: a closure
    // over `&Value` items is not `Send` for every lifetime the handler needs.
    let sources = &sources;
    let answers: Vec<_> = futures_util::stream::iter(
        (0..sources.len())
            .map(|i| {
                let source: &Value = sources[i];
                async move {
                    let answer = if source["kind"] == ENDPOINT {
                        // A gear's route, called as the person: it answers their items,
                        // in the organization the Inbox is read for.
                        match source["path"].as_str().filter(|p| endpoint_path_allowed(p)) {
                            Some(path) => api.get(path, &scope(org)).await,
                            None => Err(crate::mcp::sdk::ToolError(
                                "the source names no route of Studio's own".into(),
                            )),
                        }
                    } else {
                        let query = with_me(&source["query"], me);
                        api.post("/studio-domain-model/v1/query", &scope(org), &query)
                            .await
                    };
                    (i, answer)
                }
            })
            .collect::<Vec<_>>(),
    )
    .buffered(PARALLEL_READS)
    .collect()
    .await;
    let mut items = Vec::new();
    for (i, answer) in answers {
        let source: &Value = sources[i];
        match answer {
            Ok(page) => {
                let rows = page["items"].as_array().cloned().unwrap_or_default();
                items.extend(if source["kind"] == ENDPOINT {
                    endpoint_items(source, rows, spaces)
                } else {
                    kit_items(source, rows, spaces)
                });
            }
            Err(e) => unread.push(format!(
                "{} ({}): {}",
                source["kit_name"].as_str().unwrap_or_default(),
                source["label"].as_str().unwrap_or_default(),
                e.0
            )),
        }
    }
    Read {
        items,
        unread,
        members_known: true,
        workspaces: spaces.len(),
    }
}

/// Every source of every workspace of the organization, read as the caller
/// (`me` is their subject id), the kits' sources among them. `org` is the
/// organization on screen; `None` is the caller's home.
///
/// `workspaces` answers the organization's workspaces, `(id, name)`, or why
/// they could not be listed: the tenant tree alone
/// (`organizations::sdk::portfolio_workspaces`), never `GET /rollups`, which
/// computes every project's counts the Inbox has no use for (#1077).
pub async fn read(
    api: &Api,
    me: &str,
    org: Option<&str>,
    workspaces: impl std::future::Future<Output = Result<Vec<(String, String)>, String>>,
) -> Read {
    use futures_util::StreamExt;
    let mut unread = Vec::new();
    let (spaces, listed) = tokio::join!(workspaces, listed_sources(api, org));
    let spaces = match spaces {
        Ok(spaces) => spaces,
        Err(e) => {
            unread.push(format!("workspaces: {e}"));
            Vec::new()
        }
    };
    let listed = match listed {
        Ok(listed) => Some(listed),
        Err(e) => {
            unread.push(format!("kit sources: {e}"));
            None
        }
    };
    // Each registered source is read only while its kit applies to the
    // organization.
    let sources = super::port::sources();
    let owners: Vec<Option<Option<Value>>> = sources
        .iter()
        .map(|s| owner(listed.as_deref(), s.id))
        .collect();
    // A few workspaces at once, in the order they were listed; in each, its
    // sources side by side.
    let spaces_ref = &spaces;
    let (sources_ref, owners_ref) = (&sources, &owners);
    let per = futures_util::stream::iter(
        (0..spaces.len())
            .map(|i| {
                let (id, name) = &spaces_ref[i];
                async move {
                    let reads = sources_ref.iter().zip(owners_ref).map(|(s, o)| {
                        let read = o.is_some().then(|| (s.read)(api.clone(), id.clone()));
                        async move {
                            match read {
                                Some(read) => read.await,
                                None => super::port::WorkspaceRows::none(),
                            }
                        }
                    });
                    let rows = futures_util::future::join_all(reads).await;
                    (id.clone(), name.clone(), rows)
                }
            })
            .collect::<Vec<_>>(),
    )
    .buffered(PARALLEL_READS)
    .collect::<Vec<_>>();
    // The person's failed runs, in the organization's tenant, and what the
    // installed kits bring (ADR-0068 §6): beside the workspaces, not after.
    let mut rq = vec![
        ("state".to_string(), "failed".to_string()),
        ("limit".to_string(), "200".to_string()),
    ];
    if let Some(org) = org {
        rq.push(("tenant".to_string(), org.to_string()));
    }
    let runs = api.get("/studio-tasks/v1/runs", &rq);
    let kits = kit_sources(api, me, org, &spaces, listed.as_deref().unwrap_or_default());
    let (per, runs, kits) = tokio::join!(per, runs, kits);
    let mut members_known = true;
    let mut by_source: Vec<Vec<Item>> = sources.iter().map(|_| Vec::new()).collect();
    for (id, name, rows) in per {
        for (j, read) in rows.into_iter().enumerate() {
            members_known &= read.members_known;
            if let Some(why) = read.failed {
                unread.push(format!("{} in {name}: {why}", sources[j].id));
            }
            by_source[j].extend(owned_by(
                (sources[j].items)(&id, &name, read.rows),
                owners[j].as_ref().and_then(Option::as_ref),
            ));
        }
    }
    let mut items: Vec<Item> = by_source.into_iter().flatten().collect();
    match runs {
        Ok(page) => items.extend(failed_run_items(
            page["items"].as_array().cloned().unwrap_or_default(),
            me,
            OffsetDateTime::now_utc(),
        )),
        Err(e) => unread.push(format!("{FAILED_RUNS}: {}", e.0)),
    }
    // The kits' items after the shell's own.
    items.extend(kits.items);
    unread.extend(kits.unread);
    Read {
        items,
        unread,
        members_known,
        workspaces: spaces.len(),
    }
}

#[cfg(test)]
#[path = "inbox_tests.rs"]
mod inbox_tests;
