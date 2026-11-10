//! The project domain model (what a project's documents say; not the Studio
//! domain model), and what the project has to decide before it builds from
//! them, as MCP tools (`crate::mcp`).
//!
//! The same reads and writes the portal's Issues and Project domain model tabs
//! use: an agent sees the queue a person sees, and accepts or rejects a fact by
//! the `fact_key` the model returns, without hashing anything itself.

use serde_json::json;

use crate::mcp::sdk::{Effect, Run, Tool, object, project_id};

pub fn tools() -> Vec<Tool> {
    vec![
        Tool {
            name: "project_domain_model_issues",
            description: "What a project has to decide before it builds from its documents \
                (its project domain model, not the Studio domain model), most blocking first: problems in the documents (dangling references, \
                contradictions), requirements left as open questions, assumptions, and buildable \
                requirements with no stated basis. Each row has its `group` (`blocks`, `look`, \
                `decided`), the passages it rests on, and the `actions` it offers: `confirm` / \
                `dismiss` are `project_domain_model_finding_decide` with the row's `fingerprint`.",
            input_schema: || {
                object(
                    json!({
                        "project_id": project_id(),
                        "group": { "type": "string", "enum": ["blocks", "look", "decided"],
                            "description": "Only that group." },
                        "offset": { "type": "integer", "minimum": 0 },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 200,
                            "description": "Rows per page. Default 50." }
                    }),
                    &["project_id"],
                )
            },
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-documents/v1/project-domain-model/issues"),
        },
        Tool {
            name: "project_domain_model_readiness",
            description: "Whether anything stops a build from a project's documents: how many \
                things wait for somebody (`open`), how many of them stop a build (`blocking`), \
                `ready` when none do, and how many requirements cite a source.",
            input_schema: || object(json!({ "project_id": project_id() }), &["project_id"]),
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-documents/v1/project-domain-model/readiness"),
        },
        Tool {
            name: "project_domain_model_facts",
            description: "The project domain model (what its documents say; not the Studio \
                domain model), as read from the documents so far: every fact (entity, \
                attribute, relation, requirement, constraint, lifecycle, decision) with the \
                passage it rests on and its `fact_key`, and where each document stands. The \
                `fact_key` is what `project_domain_model_fact_review` takes.",
            input_schema: || object(json!({ "project_id": project_id() }), &["project_id"]),
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-documents/v1/project-domain-model"),
        },
        Tool {
            name: "project_domain_model_fact_review",
            description: "Accept or reject facts the model read, or put them back as proposed: \
                an accepted fact is the project's reading, a rejected one leaves the model and \
                is not proposed again while its passage says the same. Each item is a \
                `fact_key` from `project_domain_model_facts`, a `state`, and the fact's `path` and \
                document `revision`. Shared by the whole project: say what you decide first.",
            input_schema: || {
                object(
                    json!({
                        "project_id": project_id(),
                        "items": { "type": "array", "minItems": 1, "maxItems": 500,
                            "items": { "type": "object",
                                "properties": {
                                    "fact_key": { "type": "string" },
                                    "state": { "type": "string",
                                        "enum": ["accepted", "rejected", "proposed"] },
                                    "path": { "type": "string" },
                                    "revision": { "type": "string" },
                                    "note": { "type": "string" }
                                },
                                "required": ["fact_key", "state"] } }
                    }),
                    &["project_id", "items"],
                )
            },
            effect: Effect::Write,
            experimental: true,
            run: Run::Post {
                path: "/studio-documents/v1/project-domain-model/reviews",
                query: &[],
            },
        },
        Tool {
            name: "project_domain_model_finding_decide",
            description: "Say whether a problem `project_domain_model_issues` lists is real: `confirmed` \
                keeps it as a real problem (a confirmed contradiction stops a build), \
                `dismissed` takes it off the list. Takes the row's `fingerprint`. Shared by \
                the whole project: say what you decide first.",
            input_schema: || {
                object(
                    json!({
                        "project_id": project_id(),
                        "fingerprint": { "type": "string" },
                        "decision": { "type": "string", "enum": ["confirmed", "dismissed"] },
                        "note": { "type": "string", "description": "Why, at most 2000 characters." }
                    }),
                    &["project_id", "fingerprint", "decision"],
                )
            },
            effect: Effect::Write,
            experimental: true,
            run: Run::Post {
                path: "/studio-documents/v1/project-domain-model/findings/{fingerprint}/decision",
                query: &[],
            },
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_issues_tab_and_its_actions_are_tools() {
        let all = tools();
        let names: Vec<&str> = all.iter().map(|t| t.name).collect();
        assert_eq!(
            names,
            [
                "project_domain_model_issues",
                "project_domain_model_readiness",
                "project_domain_model_facts",
                "project_domain_model_fact_review",
                "project_domain_model_finding_decide"
            ]
        );
        for t in &all {
            let schema = (t.input_schema)();
            assert_eq!(schema["required"][0], "project_id", "{}", t.name);
        }
    }
}
