//! The person's Inbox, as MCP tools (`crate::mcp`): an agent works through
//! what waits on its person the way they would (ADR-0068 §6).

use serde_json::json;

use crate::mcp::sdk::{Effect, Run, Tool, object};

pub fn tools() -> Vec<Tool> {
    vec![
        Tool {
            name: "inbox",
            description: "What waits on you across your organization's workspaces, overdue \
                first: review requests waiting for your verdict and pull requests whose next \
                step is yours. Each item names its `source` and carries the source's record. \
                `view: hidden` lists what you marked done or snoozed instead.",
            input_schema: || {
                object(
                    json!({
                        "view": { "type": "string", "enum": ["open", "hidden"] },
                        "offset": { "type": "integer", "minimum": 0 },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 200,
                            "description": "Items per page. Default 50." }
                    }),
                    &[],
                )
            },
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-user/v1/me/inbox"),
        },
        Tool {
            name: "inbox_mark",
            description: "Mark one item of your Inbox by its `key`: `done` hides it until its \
                fact changes, `snoozed` hides it until `until` (RFC 3339), `open` clears the \
                mark. Ask your person before marking for them.",
            input_schema: || {
                object(
                    json!({
                        "item_key": { "type": "string", "description": "The item's `key` from `inbox`." },
                        "state": { "type": "string", "enum": ["done", "snoozed", "open"] },
                        "until": { "type": "string", "description": "RFC 3339; for `snoozed`." }
                    }),
                    &["item_key", "state"],
                )
            },
            effect: Effect::Write,
            experimental: true,
            run: Run::Put {
                path: "/studio-user/v1/me/inbox-marks",
                query: &[],
            },
        },
    ]
}
