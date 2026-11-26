//! What the Git kit puts in a person's Inbox (the Inbox port, ADR-0079 §4):
//! the open pull requests whose next move is theirs, read per workspace with
//! the same `waiting_on=me` the portal sent (`pull-request-waits.ts`
//! `myPullsInOrder`).

use serde_json::{Value, json};

use crate::user_profile::port::{
    Api, InboxScope, InboxSource, InboxToolSource, Item, RowsFuture, ToolItemsFuture,
    WorkspaceRows, list_or_none, text,
};

/// The source's id, as project-git's `kit.json` lists it (`studio`).
pub const PULL_REQUESTS: &str = "pull-requests";

const ROUTE: &str = "/studio-artifact-ingest/v1/open-pull-requests";

/// The most pull requests read for one workspace: pages of 200.
const PULL_PAGES: usize = 10;

/// Pages read at most by the MCP tool, so a listing that never ends cannot
/// hang a tool call.
const MAX_PAGES: usize = 20;

inventory::submit! {
    InboxSource {
        id: PULL_REQUESTS,
        gear: "studio-artifact-ingest",
        order: 20,
        first_at_equal_due: false,
        read: read_pulls,
        items: pull_request_items,
    }
}

inventory::submit! {
    InboxToolSource {
        kind: "pull",
        order: 30,
        read: pulls,
    }
}

/// A workspace's open pull requests waiting on the person, page by page; a
/// page that fails names why and keeps what was read.
fn read_pulls(api: Api, workspace_id: String) -> RowsFuture {
    Box::pin(async move {
        let q = vec![
            ("workspace_id".to_string(), workspace_id),
            ("waiting_on".to_string(), "me".to_string()),
        ];
        let mut out = WorkspaceRows::none();
        let mut offset = 0usize;
        for _ in 0..PULL_PAGES {
            let mut pq = q.clone();
            pq.push(("limit".to_string(), "200".to_string()));
            pq.push(("offset".to_string(), offset.to_string()));
            match api.get(ROUTE, &pq).await {
                Ok(page) => {
                    let got = page["items"].as_array().cloned().unwrap_or_default();
                    out.members_known &= page["members_known"].as_bool().unwrap_or(true);
                    let total = page["total"].as_u64().unwrap_or(0);
                    offset += got.len();
                    let done = got.is_empty() || offset as u64 >= total;
                    out.rows.extend(got);
                    if done {
                        break;
                    }
                }
                Err(e) => {
                    out.failed = Some(e.0);
                    break;
                }
            }
        }
        out
    })
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

fn some_text(v: &Value) -> Option<String> {
    v.as_str().filter(|s| !s.is_empty()).map(str::to_string)
}

/// A workspace's pull requests as Inbox items, in the order the person
/// answers them.
pub fn pull_request_items(
    workspace_id: &str,
    workspace_name: &str,
    pulls: Vec<Value>,
) -> Vec<Item> {
    pulls_in_order(pulls)
        .into_iter()
        .map(|p| Item {
            key: pull_key(&p),
            source: PULL_REQUESTS.to_owned(),
            kit: None,
            workspace_id: workspace_id.to_string(),
            workspace_name: workspace_name.to_string(),
            title: some_text(&p["title"]).unwrap_or_default(),
            url: some_text(&p["url"]),
            due_at: None,
            overdue: false,
            record: p,
            destination: None,
        })
        .collect()
}

fn pulls(api: Api, scope: InboxScope) -> ToolItemsFuture {
    Box::pin(async move {
        let mut out = Vec::new();
        for ws in &scope.workspaces {
            let mut offset = 0usize;
            for _ in 0..MAX_PAGES {
                let page = list_or_none(
                    &api,
                    ROUTE,
                    &[
                        ("workspace_id".to_owned(), ws.clone()),
                        ("waiting_on".to_owned(), "me".to_owned()),
                        ("limit".to_owned(), "200".to_owned()),
                        ("offset".to_owned(), offset.to_string()),
                    ],
                )
                .await?;
                let items = page["items"].as_array().cloned().unwrap_or_default();
                out.extend(pull_items(&Value::Array(items.clone())));
                offset += items.len();
                let total = page["total"].as_u64().unwrap_or(0);
                if items.is_empty() || offset as u64 >= total {
                    break;
                }
            }
        }
        Ok(out)
    })
}

fn pull_items(list: &Value) -> Vec<Value> {
    list.as_array()
        .into_iter()
        .flatten()
        .map(|p| {
            json!({
                "source": "pull",
                "key": format!("pr:{}@{}", text(p, "id"), text(p, "updated_at")),
                "title": p["title"],
                "detail": format!("{}#{} · {}", text(p, "repo"), p["number"], text(p, "reason")),
                "project_id": p["project_id"],
                "at": p["updated_at"],
                "waiting": p["waiting"],
                "act": { "open": p["url"] }
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pull_request_is_keyed_as_the_portal_keys_it() {
        let p = pull_items(
            &json!([{ "id": "x", "updated_at": "2026-11-05T00:00:00Z", "title": "Fix",
            "repo": "o/r", "number": 7, "reason": "asked", "url": "https://g/7" }]),
        );
        assert_eq!(p[0]["key"], "pr:x@2026-11-05T00:00:00Z");
        assert_eq!(p[0]["act"]["open"], "https://g/7");
    }

    #[test]
    fn a_person_s_pull_requests_wait_on_their_review_first_then_longest_quiet() {
        let ordered = pulls_in_order(vec![
            json!({"id": "a", "waiting": "author", "days_since_update": 9}),
            json!({"id": "r1", "waiting": "review", "days_since_update": 1}),
            json!({"id": "r2", "waiting": "review", "days_since_update": 5}),
        ]);
        let ids: Vec<&str> = ordered.iter().map(|p| p["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["r2", "r1", "a"]);
    }
}
