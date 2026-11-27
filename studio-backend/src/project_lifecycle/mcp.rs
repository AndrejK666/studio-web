//! Project lifecycle's MCP tools: a project's phase, a move, every project's
//! phase. They call the kit's routes on studio-kits, so they answer as the
//! portal does; `project_phase_set` is claimed by the kit.

use serde_json::{Value, json};

use crate::mcp::sdk::{Effect, Run, Tool, object};

fn organization_id() -> Value {
    json!({ "type": "string",
        "description": "The organization (its tenant id); the caller's own when absent." })
}

fn project_id() -> Value {
    json!({ "type": "string",
        "description": "The project (its tenant id)." })
}

pub fn tools() -> Vec<Tool> {
    vec![
        Tool {
            name: "project_phase",
            description: "A project's phase (the built-in Project lifecycle kit): the phase, who \
                moves it on and since when, the lifecycle's phases and the moves open from the \
                current one. `installed` is false where the kit does not apply.",
            input_schema: || object(json!({ "project_id": project_id() }), &["project_id"]),
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-kits/v1/project-phase"),
        },
        Tool {
            name: "project_phase_set",
            description: "Move a project to a phase along the lifecycle Project lifecycle \
                declares (idea → discovery → build → run, and back); a move it does not declare \
                is refused with `NO_SUCH_TRANSITION`. `owner` (a subject id) is who moves it on \
                from there; the project's current owner, else you, when absent.",
            input_schema: || {
                object(
                    json!({
                        "project_id": project_id(),
                        "phase": { "type": "string", "enum": ["idea", "discovery", "build", "run"] },
                        "owner": { "type": "string" }
                    }),
                    &["project_id", "phase"],
                )
            },
            effect: Effect::Write,
            experimental: true,
            run: Run::Put {
                path: "/studio-kits/v1/project-phase",
                query: &["project_id"],
            },
        },
        Tool {
            name: "project_phases",
            description: "Every project of an organization that has a phase (Project \
                lifecycle), by project id, with its owner and since when.",
            input_schema: || {
                object(
                    json!({
                        "organization_id": organization_id(),
                        "limit": { "type": "integer" },
                        "offset": { "type": "integer" }
                    }),
                    &[],
                )
            },
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-kits/v1/project-phases"),
        },
    ]
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::tools;
    use crate::mcp::sdk::{Method, request_of};

    #[test]
    fn each_tool_sends_the_route_a_person_would() {
        let all = tools();
        let r = request_of(
            &all,
            "project_phase_set",
            json!({"project_id": "p-1", "phase": "build"}),
        );
        assert_eq!(r.method, Method::Put);
        assert_eq!(r.path, "/studio-kits/v1/project-phase");
        assert_eq!(r.body, json!({"phase": "build"}));
        assert_eq!(r.query, vec![("project_id".to_owned(), "p-1".to_owned())]);
    }
}
