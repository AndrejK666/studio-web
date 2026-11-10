//! A project's status, as an MCP tool (`crate::mcp`).

use serde_json::json;

use crate::mcp::sdk::{Effect, Run, Tool, object, project_id};

pub fn tools() -> Vec<Tool> {
    vec![Tool {
        name: "project_status",
        description: "Where a project stands, as its Overview says: a verdict (`blocked`, \
            `at_risk`, `on_track`) with its reason, the signals behind it worst first (a \
            refused repository connection, a failed build or deploy, a product that does not \
            resolve, high findings, failing specs, stuck pull requests), each with where to act \
            on it, and the path from connecting a repository to a build with the step to do \
            next. `unread` names the sources that could not be read.",
        input_schema: || object(json!({ "project_id": project_id() }), &["project_id"]),
        effect: Effect::Read,
        experimental: false,
        run: Run::Get("/studio-organizations/v1/project-status"),
    }]
}
