//! What the Specs kit puts in a person's Inbox (the Inbox port, ADR-0079
//! §4): the reviews somebody asked of them, read per workspace with the
//! same `waiting_on=me` the portal sent.

use serde_json::{Value, json};

use crate::user_profile::port::{
    Api, InboxScope, InboxSource, InboxToolSource, Item, RowsFuture, ToolItemsFuture,
    WorkspaceRows, list_or_none, text,
};

/// The source's id, as project-specs' `kit.json` lists it (`studio`).
pub const REVIEW_REQUESTS: &str = "review-requests";

const ROUTE: &str = "/studio-documents/v1/review-requests";

inventory::submit! {
    InboxSource {
        id: REVIEW_REQUESTS,
        gear: "studio-documents",
        order: 10,
        first_at_equal_due: true,
        read: read_reviews,
        items: review_request_items,
    }
}

inventory::submit! {
    InboxToolSource {
        kind: "review",
        order: 20,
        read: reviews,
    }
}

/// A workspace's review requests waiting on the person. A backend without
/// them (404), or one that could not answer, has none.
fn read_reviews(api: Api, workspace_id: String) -> RowsFuture {
    Box::pin(async move {
        let q = vec![
            ("workspace_id".to_string(), workspace_id),
            ("waiting_on".to_string(), "me".to_string()),
        ];
        match api.get(ROUTE, &q).await {
            Ok(r) => WorkspaceRows {
                rows: r["items"].as_array().cloned().unwrap_or_default(),
                ..WorkspaceRows::none()
            },
            Err(_) => WorkspaceRows::none(),
        }
    })
}

/// A review request is one item for as long as it lives.
pub fn review_key(r: &Value) -> String {
    format!("review:{}", r["id"].as_str().unwrap_or_default())
}

fn some_text(v: &Value) -> Option<String> {
    v.as_str().filter(|s| !s.is_empty()).map(str::to_string)
}

/// A workspace's review requests as Inbox items, in their list's order.
pub fn review_request_items(
    workspace_id: &str,
    workspace_name: &str,
    reviews: Vec<Value>,
) -> Vec<Item> {
    reviews
        .into_iter()
        .map(|r| Item {
            key: review_key(&r),
            source: REVIEW_REQUESTS.to_owned(),
            kit: None,
            workspace_id: workspace_id.to_string(),
            workspace_name: workspace_name.to_string(),
            title: some_text(&r["title"]).unwrap_or_default(),
            url: None,
            due_at: some_text(&r["due_at"]),
            overdue: r["overdue"].as_bool().unwrap_or(false),
            record: r,
            destination: None,
        })
        .collect()
}

fn reviews(api: Api, scope: InboxScope) -> ToolItemsFuture {
    Box::pin(async move {
        let mut out = Vec::new();
        for ws in &scope.workspaces {
            let list = list_or_none(
                &api,
                ROUTE,
                &[
                    ("workspace_id".to_owned(), ws.clone()),
                    ("waiting_on".to_owned(), "me".to_owned()),
                ],
            )
            .await?;
            out.extend(review_items(&list["items"]));
        }
        Ok(out)
    })
}

fn review_items(list: &Value) -> Vec<Value> {
    list.as_array()
        .into_iter()
        .flatten()
        .map(|r| {
            json!({
                "source": "review",
                "key": format!("review:{}", text(r, "id")),
                "title": format!("Review {}", text(r, "title")),
                "detail": format!("{} asked", r["requested_by_name"].as_str().unwrap_or("a colleague")),
                "project_id": r["project_id"],
                "at": r["created_at"],
                "due": r["due_at"],
                "overdue": r["overdue"].as_bool().unwrap_or(false),
                "act": {
                    "tool": "review_verdict",
                    "arguments": {
                        "request_id": r["id"],
                        "project_id": r["project_id"],
                        "verdict": "approved | changes_requested"
                    }
                }
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_review_is_keyed_as_the_portal_keys_it() {
        let r = review_items(
            &json!([{ "id": "r1", "title": "PRD", "project_id": "p", "overdue": true }]),
        );
        assert_eq!(r[0]["key"], "review:r1");
        assert_eq!(r[0]["act"]["tool"], "review_verdict");
        let items = review_request_items("w", "W", vec![json!({"id": "r1", "title": "PRD"})]);
        assert_eq!(items[0].key, "review:r1");
        assert_eq!(items[0].source, REVIEW_REQUESTS);
    }
}
