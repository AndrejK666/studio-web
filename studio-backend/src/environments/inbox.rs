//! What the delivery kit puts in a person's Inbox (the Inbox port,
//! ADR-0079 §4): deploys waiting for an approval, as items of the MCP
//! `inbox` tool.

use serde_json::{Value, json};

use crate::user_profile::port::{
    Api, InboxScope, InboxToolSource, ToolItemsFuture, list_or_none, text,
};

inventory::submit! {
    InboxToolSource {
        kind: "deploy",
        order: 10,
        read: deploys,
    }
}

fn deploys(api: Api, scope: InboxScope) -> ToolItemsFuture {
    Box::pin(async move {
        let list = list_or_none(
            &api,
            "/studio-environments/v1/deployments",
            &[("organization_id".to_owned(), scope.organization_id.clone())],
        )
        .await?;
        Ok(deploy_items(&list["items"], &scope.organization_id))
    })
}

fn deploy_items(list: &Value, organization_id: &str) -> Vec<Value> {
    list.as_array()
        .into_iter()
        .flatten()
        .filter(|d| text(d, "state") == "awaiting_approval")
        .map(|d| {
            json!({
                "source": "deploy",
                "key": format!("deploy:{}", text(d, "id")),
                "title": format!(
                    "Approve the deploy of {} to {}",
                    text(d, "project_name"),
                    text(d, "environment_name")
                ),
                "detail": format!("{} asked", text(d, "requested_by_name")),
                "project_id": d["project_id"],
                "at": d["requested_at"],
                "act": {
                    "tool": "deployment_decide",
                    "arguments": {
                        "deployment_id": d["id"],
                        "organization_id": organization_id,
                        "action": "approve | decline (decline needs a reason)"
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
    fn a_deploy_waiting_for_approval_says_how_to_decide_it() {
        let items = deploy_items(
            &json!([
                { "id": "d1", "state": "awaiting_approval", "project_id": "p", "project_name": "Shop",
                  "environment_name": "prod", "requested_by_name": "Ann", "requested_at": "2026-11-06T10:00:00Z" },
                { "id": "d2", "state": "succeeded" }
            ]),
            "org",
        );
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["key"], "deploy:d1");
        assert_eq!(items[0]["title"], "Approve the deploy of Shop to prod");
        assert_eq!(items[0]["act"]["tool"], "deployment_decide");
        assert_eq!(items[0]["act"]["arguments"]["organization_id"], "org");
    }
}
