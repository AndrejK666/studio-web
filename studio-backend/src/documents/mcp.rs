//! The project domain model (what a project's documents say; not the Studio
//! domain model), what the project has to decide before it builds from them,
//! and reviews of its documents, as MCP tools (`crate::mcp`).
//!
//! The same reads and writes the portal's Issues and Project domain model tabs
//! use: an agent sees the queue a person sees, and accepts or rejects a fact by
//! the `fact_key` the model returns, without hashing anything itself. The
//! review tools act on the requests the inbox (`user_profile/mcp.rs`) lists
//! beside everything else that waits.

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
            name: "project_domain_model_build",
            description: "Start reading a project's documents into its project domain model, on \
                your own model key (a build calls a model and costs tokens): every document not \
                read at its revision, or only the one `path` names, which is read again \
                whatever its state and whose facts replace only its own. Answers at once with the build's state; follow it with \
                `project_domain_model_build_status`. A build already running is answered, not \
                started twice. Say what you will read first.",
            input_schema: || {
                object(
                    json!({
                        "project_id": project_id(),
                        "path": { "type": "string",
                            "description": "One document to read again, as `project_domain_model_coverage` lists it." }
                    }),
                    &["project_id"],
                )
            },
            effect: Effect::Write,
            experimental: true,
            run: Run::Post {
                path: "/studio-documents/v1/project-domain-model/builds",
                query: &[],
            },
        },
        Tool {
            name: "project_domain_model_build_status",
            description: "Where a project's running or last build of its project domain model \
                stands: `running`, the `documents` it reads and how many are `done`, the one \
                being read (`current`), why it stopped (`error`, most often no model key), and \
                when it started and finished.",
            input_schema: || object(json!({ "project_id": project_id() }), &["project_id"]),
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-documents/v1/project-domain-model/build"),
        },
        Tool {
            name: "project_domain_model_coverage",
            description: "What a project's domain model has read and what is missing to \
                interpret it: every document with its `state` (`extracted`, `failed` with its \
                `error`, `stale`, `pending`, `kept`), its facts and the facts `dropped` because \
                the text did not bear them out; the typed documents this server could not read \
                (`unread_paths`) and why (`unread_because`); and the requirements the documents \
                leave as `open_questions`.",
            input_schema: || object(json!({ "project_id": project_id() }), &["project_id"]),
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-documents/v1/project-domain-model/coverage"),
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
        Tool {
            name: "review_requests",
            description: "A project's or a workspace's review requests, newest first: each \
                with its document (`title`, `version`), its reviewers and where each stands, \
                the required reviewers still awaited (`outstanding`) and whether it is past \
                its due date (`overdue`). `waiting_on: \"me\"` keeps the open requests that \
                still wait for your verdict. Give `project_id` or `workspace_id`.",
            input_schema: || {
                object(
                    json!({
                        "project_id": project_id(),
                        "workspace_id": { "type": "string", "description": "Every project of this workspace instead of one project." },
                        "subject_id": { "type": "string", "description": "Only this document's requests." },
                        "waiting_on": { "type": "string", "enum": ["me"] }
                    }),
                    &[],
                )
            },
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-documents/v1/review-requests"),
        },
        Tool {
            name: "review_verdict",
            description: "Give your verdict on a review request you were asked to review: \
                `approved` or `changes_requested`, with an optional `note`; `security: true` \
                marks the changes asked for as a security concern, which holds the stage at \
                any maturity. A verdict is never edited: a later one is another record and the \
                latest counts. You must be one of the request's reviewers. Ask your person \
                first: the verdict is theirs and is kept on the record.",
            input_schema: || {
                object(
                    json!({
                        "request_id": { "type": "string", "description": "The review request's id (an `inbox` item's `act`, or `review_requests`)." },
                        "project_id": project_id(),
                        "verdict": { "type": "string", "enum": ["approved", "changes_requested"] },
                        "security": { "type": "boolean" },
                        "note": { "type": "string" }
                    }),
                    &["request_id", "project_id", "verdict"],
                )
            },
            effect: Effect::Write,
            experimental: true,
            run: Run::Post {
                path: "/studio-documents/v1/review-requests/{request_id}/approvals",
                query: &[],
            },
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::sdk::{Method, request_of};

    #[test]
    fn the_issues_tab_and_its_actions_are_tools() {
        let all = tools();
        let all: Vec<_> = all
            .into_iter()
            .filter(|t| t.name.starts_with("project_domain_model_"))
            .collect();
        let names: Vec<&str> = all.iter().map(|t| t.name).collect();
        assert_eq!(
            names,
            [
                "project_domain_model_issues",
                "project_domain_model_readiness",
                "project_domain_model_facts",
                "project_domain_model_build",
                "project_domain_model_build_status",
                "project_domain_model_coverage",
                "project_domain_model_fact_review",
                "project_domain_model_finding_decide"
            ]
        );
        for t in &all {
            let schema = (t.input_schema)();
            assert_eq!(schema["required"][0], "project_id", "{}", t.name);
        }
    }

    #[test]
    fn a_build_is_the_route_the_portal_starts_and_marked_as_changing() {
        let all = tools();
        let build = all
            .iter()
            .find(|t| t.name == "project_domain_model_build")
            .expect("the build tool");
        assert_eq!(build.effect, Effect::Write, "a build costs tokens");
        assert!(build.experimental);
        let r = request_of(
            &all,
            "project_domain_model_build",
            json!({ "project_id": "p", "path": "docs/a.md" }),
        );
        assert_eq!(r.method, Method::Post);
        assert_eq!(r.path, "/studio-documents/v1/project-domain-model/builds");
        assert_eq!(r.body, json!({ "project_id": "p", "path": "docs/a.md" }));
    }

    #[test]
    fn status_and_coverage_are_reads_of_the_project() {
        for (tool, path) in [
            (
                "project_domain_model_build_status",
                "/studio-documents/v1/project-domain-model/build",
            ),
            (
                "project_domain_model_coverage",
                "/studio-documents/v1/project-domain-model/coverage",
            ),
        ] {
            let all = tools();
            let t = all.iter().find(|t| t.name == tool).expect(tool);
            assert_eq!(t.effect, Effect::Read, "{tool}");
            let r = request_of(&all, tool, json!({ "project_id": "p" }));
            assert_eq!(r.method, Method::Get, "{tool}");
            assert_eq!(r.path, path);
            assert_eq!(r.query, vec![("project_id".to_owned(), "p".to_owned())]);
        }
    }

    #[test]
    fn the_requests_waiting_on_the_caller_are_read_with_the_query() {
        let r = request_of(
            &tools(),
            "review_requests",
            json!({ "workspace_id": "w", "waiting_on": "me" }),
        );
        assert_eq!(r.method, Method::Get);
        assert_eq!(r.path, "/studio-documents/v1/review-requests");
        assert_eq!(
            r.query,
            vec![
                ("waiting_on".to_owned(), "me".to_owned()),
                ("workspace_id".to_owned(), "w".to_owned()),
            ]
        );
    }

    #[test]
    fn a_verdict_names_the_request_in_the_path_and_the_rest_in_the_body() {
        let r = request_of(
            &tools(),
            "review_verdict",
            json!({ "request_id": "r1", "project_id": "p", "verdict": "approved" }),
        );
        assert_eq!(r.method, Method::Post);
        assert_eq!(r.path, "/studio-documents/v1/review-requests/r1/approvals");
        assert_eq!(r.body, json!({ "project_id": "p", "verdict": "approved" }));
    }
}
