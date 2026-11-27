//! A project's spec graph as MCP tools (`crate::mcp`): set it up, check it,
//! review a pull request, run the long jobs, read and decide its findings,
//! and walk the graph. The Spec graph kit claims them (ADR-0071).

use serde_json::{Value, json};

use crate::mcp::sdk::{Effect, Run, Tool, object};

const PROJECT: &str = "The project: the id in the portal's address of that project.";

fn project_only() -> Value {
    object(
        json!({ "project_id": { "type": "string", "description": PROJECT } }),
        &["project_id"],
    )
}

fn setup() -> Value {
    object(
        json!({
            "project_id": { "type": "string", "description": PROJECT },
            "source": { "type": "string", "description": "The Git source's name; the project's first when absent." },
            "branch": { "type": "string", "description": "The branch to read; the source's own when absent." },
            "scope": { "type": "string", "description": "The documents: `gears/a gears/b`, or `--docs-root docs --name LABEL .`." }
        }),
        &["project_id", "scope"],
    )
}

fn check() -> Value {
    object(
        json!({
            "project_id": { "type": "string", "description": PROJECT },
            "branch": { "type": "string", "description": "Another branch than the project's." }
        }),
        &["project_id"],
    )
}

fn findings() -> Value {
    object(
        json!({
            "project_id": { "type": "string", "description": PROJECT },
            "limit": { "type": "integer", "description": "At most this many (default 200, at most 500)." }
        }),
        &["project_id"],
    )
}

fn review() -> Value {
    object(
        json!({
            "project_id": { "type": "string", "description": PROJECT },
            "base": { "type": "string", "description": "The pull request's base branch." },
            "head": { "type": "string", "description": "Its head branch." },
            "model": { "type": "boolean", "description": "Also the model's rules: a run, minutes and model cost." }
        }),
        &["project_id", "base", "head"],
    )
}

fn run_start() -> Value {
    object(
        json!({
            "project_id": { "type": "string", "description": PROJECT },
            "job": { "type": "string", "enum": ["index", "prepare", "contradictions", "realization", "status"] },
            "params": { "type": "object", "description": "index: {facts}; contradictions: {cap, skip_judged}." }
        }),
        &["project_id", "job"],
    )
}

fn run_get() -> Value {
    object(
        json!({
            "project_id": { "type": "string", "description": PROJECT },
            "run_id": { "type": "string", "description": "The run, as spec_graph_run_start answered it." },
            "wait": { "type": "integer", "description": "Seconds to wait for it to end, at most 25." }
        }),
        &["project_id", "run_id"],
    )
}

fn run_cancel() -> Value {
    object(
        json!({
            "project_id": { "type": "string", "description": PROJECT },
            "run_id": { "type": "string", "description": "The run." }
        }),
        &["project_id", "run_id"],
    )
}

fn decide() -> Value {
    object(
        json!({
            "project_id": { "type": "string", "description": PROJECT },
            "fingerprint": { "type": "string", "description": "The finding's id (its fingerprint)." },
            "decision": { "type": "string", "enum": ["confirmed", "dismissed"] },
            "rule": { "type": "string", "description": "The finding's rule." },
            "note": { "type": "string", "description": "Why, in a sentence." }
        }),
        &["project_id", "fingerprint", "decision", "rule"],
    )
}

fn label() -> Value {
    object(
        json!({
            "project_id": { "type": "string", "description": PROJECT },
            "fingerprint": { "type": "string", "description": "The finding's id (its fingerprint)." },
            "verdict": { "type": "string", "enum": ["real", "not", "unsure"] },
            "rule": { "type": "string", "description": "The finding's rule." },
            "note": { "type": "string" }
        }),
        &["project_id", "fingerprint", "verdict", "rule"],
    )
}

fn calibration() -> Value {
    object(
        json!({
            "project_id": { "type": "string", "description": PROJECT },
            "rule": { "type": "string", "description": "One rule; every rule when absent." }
        }),
        &["project_id"],
    )
}

fn search() -> Value {
    object(
        json!({
            "project_id": { "type": "string", "description": PROJECT },
            "query": { "type": "string" },
            "types": { "type": "array", "items": { "type": "string" },
                       "description": "Node types: section, requirement, decision, design_element, finding, …" },
            "limit": { "type": "integer" }
        }),
        &["project_id", "query"],
    )
}

fn node() -> Value {
    object(
        json!({
            "project_id": { "type": "string", "description": PROJECT },
            "key": { "type": "string", "description": "A CPT id, doc:<path>, sec:<path>#<anchor>, …" }
        }),
        &["project_id", "key"],
    )
}

fn neighbors() -> Value {
    object(
        json!({
            "project_id": { "type": "string", "description": PROJECT },
            "key": { "type": "string", "description": "The node's key." },
            "direction": { "type": "string", "enum": ["incoming", "outgoing", "either"] }
        }),
        &["project_id", "key"],
    )
}

fn subgraph() -> Value {
    object(
        json!({
            "project_id": { "type": "string", "description": PROJECT },
            "key": { "type": "string", "description": "The centre node's key." },
            "depth": { "type": "integer", "minimum": 1, "maximum": 4, "description": "Hops out (default 2)." },
            "types": { "type": "string", "description": "Node type names, comma-separated: only those on the way." },
            "limit": { "type": "integer", "description": "At most this many nodes (default 300, at most 1000)." }
        }),
        &["project_id", "key"],
    )
}

const Q: &[&str] = &["project_id"];

pub fn tools() -> Vec<Tool> {
    vec![
        Tool {
            name: "spec_graph_project",
            description: "Whether a project is set up for the spec graph (its source, branch and \
                documents as the spec-graph service holds them) and the service's version and \
                capabilities. Set it up with spec_graph_setup.",
            input_schema: project_only,
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-spec-graph/v1/project"),
        },
        Tool {
            name: "spec_graph_setup",
            description: "Set a project up for the spec graph: which of its Git sources, which \
                branch, and which documents (`gears/a gears/b`, or `--docs-root docs --name LABEL \
                .`). The service clones the source through Studio's Git proxy with your token; \
                its graph lives in the project's tenant. Then build it with spec_graph_run_start \
                (job index).",
            input_schema: setup,
            effect: Effect::Write,
            experimental: true,
            run: Run::Put {
                path: "/studio-spec-graph/v1/project",
                query: Q,
            },
        },
        Tool {
            name: "spec_graph_check",
            description: "Every deterministic spec finding of a project now (traceability, links \
                and anchors, supersession, the repository's rules as data), in seconds, one entry \
                per document: id (the fingerprint), rule, severity, gate, anchor, related, \
                suggestion. Dismissed findings are left out and counted.",
            input_schema: check,
            effect: Effect::Read,
            experimental: false,
            run: Run::Post {
                path: "/studio-spec-graph/v1/checks",
                query: Q,
            },
        },
        Tool {
            name: "spec_graph_findings",
            description: "The spec findings stored in a project's graph by its runs: contradictions \
                the judges confirmed, with both passages, and the other rules' findings, one entry \
                per document. Decide one with spec_graph_finding_decide.",
            input_schema: findings,
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-spec-graph/v1/findings"),
        },
        Tool {
            name: "spec_graph_review",
            description: "Review a pull request of a project: the findings it brings (head against \
                base) and the review threads to post on its head (path, line, body), as CI posts \
                them. With model, the model's rules too (contradictions): then a run to follow with \
                spec_graph_run, whose result holds the threads.",
            input_schema: review,
            effect: Effect::Write,
            experimental: true,
            run: Run::Post {
                path: "/studio-spec-graph/v1/reviews",
                query: Q,
            },
        },
        Tool {
            name: "spec_graph_run_start",
            description: "Start a long spec-graph job on a project: index (build its graph; \
                params.facts false for the structure only, no model), prepare (the facts and \
                embeddings a review with the model reads, made ahead of the first one), \
                contradictions (judge the corpus; params.cap), realization or status (those judges). Minutes and model cost; \
                follow it with spec_graph_run.",
            input_schema: run_start,
            effect: Effect::Write,
            experimental: true,
            run: Run::Post {
                path: "/studio-spec-graph/v1/runs",
                query: Q,
            },
        },
        Tool {
            name: "spec_graph_run",
            description: "A spec-graph run's state, steps and result (counts, cost, revision; for a \
                review, the threads) and its log's tail; waits up to `wait` seconds (at most 25) \
                for it to end.",
            input_schema: run_get,
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-spec-graph/v1/runs/{run_id}"),
        },
        Tool {
            name: "spec_graph_run_cancel",
            description: "Cancel a project's spec-graph run: a queued one is dropped, a running one \
                has its step's processes ended.",
            input_schema: run_cancel,
            effect: Effect::Destructive,
            experimental: true,
            run: Run::Post {
                path: "/studio-spec-graph/v1/runs/{run_id}/cancel",
                query: Q,
            },
        },
        Tool {
            name: "spec_graph_finding_decide",
            description: "Confirm or dismiss a spec-graph finding of a project: recorded in Project \
                model's decision table and with the spec-graph service (a label for the rule's \
                calibration; a dismissal also leaves the finding out of checks and reviews).",
            input_schema: decide,
            effect: Effect::Write,
            experimental: true,
            run: Run::Post {
                path: "/studio-spec-graph/v1/findings/{fingerprint}/decision",
                query: Q,
            },
        },
        Tool {
            name: "spec_graph_finding_label",
            description: "Say whether a spec-graph finding is real (real, not, unsure) to calibrate \
                its rule, without hiding it: with 10 decided labels and a 95 % lower bound of \
                precision of 0.7 a model's rule may be made blocking.",
            input_schema: label,
            effect: Effect::Write,
            experimental: true,
            run: Run::Put {
                path: "/studio-spec-graph/v1/findings/{fingerprint}/label",
                query: Q,
            },
        },
        Tool {
            name: "spec_graph_calibration",
            description: "Precision of each spec-graph rule from a project's labels, its 95 % lower \
                bound, and whether the rule may block.",
            input_schema: calibration,
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-spec-graph/v1/calibration"),
        },
        Tool {
            name: "spec_graph_search",
            description: "Search a project's spec graph (full text and vectors): sections, \
                requirements, decisions, design elements, findings, each with its key, file and \
                line. Open one with spec_graph_node, follow its edges with spec_graph_neighbors.",
            input_schema: search,
            effect: Effect::Read,
            experimental: false,
            run: Run::Post {
                path: "/studio-spec-graph/v1/graph/search",
                query: Q,
            },
        },
        Tool {
            name: "spec_graph_node",
            description: "One node of a project's spec graph by its key: its type, file, line, \
                verbatim quote and text.",
            input_schema: node,
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-spec-graph/v1/graph/node"),
        },
        Tool {
            name: "spec_graph_neighbors",
            description: "The edges at a node of a project's spec graph, grouped by type and \
                direction; a judge's edge with its verdict, quote and provenance.",
            input_schema: neighbors,
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-spec-graph/v1/graph/neighbors"),
        },
        Tool {
            name: "spec_graph_subgraph",
            description: "The graph around one node of a project's spec graph, `depth` hops out \
                (1-4) in both directions: its nodes (key, type, name, file) and the edges between \
                them, static or a judge's conclusion.",
            input_schema: subgraph,
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-spec-graph/v1/graph/subgraph"),
        },
        Tool {
            name: "spec_graph_ontology",
            description: "The spec graph's ontology: its node and edge types, what each edge \
                connects, which edges are a judge's conclusion, how keys are formed, and how many \
                nodes of each type the project's graph holds.",
            input_schema: project_only,
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-spec-graph/v1/graph/ontology"),
        },
        Tool {
            name: "spec_graph_metrics",
            description: "A project's spec quality in numbers: findings per rule and gate, p1 \
                requirements realized, build-status verdicts, and how many conflicting passages \
                do not link to each other.",
            input_schema: project_only,
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-spec-graph/v1/metrics"),
        },
    ]
}
