//! The kit library and its installer, as MCP tools (`crate::mcp`): an agent
//! installs a kit the way a person does (ADR-0068 §5), through the same REST
//! routes and so under the same checks.

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

fn kit_slug() -> Value {
    json!({ "type": "string",
        "description": "The kit's slug, from `kits_catalog`." })
}

fn version() -> Value {
    json!({ "type": "string",
        "description": "A Git ref for an official kit; the kit's default when absent. A built-in kit takes Studio's version only." })
}

pub fn tools() -> Vec<Tool> {
    vec![
        Tool {
            name: "kits_catalog",
            description: "The kit library: every kit a person may install, each with its \
                `shelf` (`builtin`: shipped in Studio; `official`: Constructor's, from its own \
                repository; `organization`: an organization's own), the `levels` it may be \
                installed on, and its `default_version`. Optionally one shelf.",
            input_schema: || {
                object(
                    json!({
                        "shelf": { "type": "string", "enum": ["builtin", "official", "organization"] },
                        "limit": { "type": "integer" },
                        "offset": { "type": "integer" }
                    }),
                    &[],
                )
            },
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-kits/v1/catalog"),
        },
        Tool {
            name: "kits_describe",
            description: "What is inside one kit, before anyone installs it: the catalogue \
                entry and its `contents` by the sections of a kit manifest (`screens`, `types`, \
                `rules`, `functions`, `services`, `inbox`, `mcp_tools`, `permissions`, the \
                `material` cfs writes into a checkout, artifact `kinds`, `docs`), and \
                `manifest`, where that came from (`built-in`, `.cf-studio-kit.toml`, or null \
                when nothing reliable describes it).",
            input_schema: || object(json!({ "kit_slug": kit_slug() }), &["kit_slug"]),
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-kits/v1/catalog/{kit_slug}"),
        },
        Tool {
            name: "kits_installed",
            description: "The kits that apply to an organization, or to a project with \
                `project_id`: `base` (installed by the platform for every organization; the \
                organization cannot uninstall these), `organization` (installed by the \
                organization for itself), `project` (installed for that project alone; empty \
                without `project_id`) and `effective` (all together, one entry per kit at the \
                newest version).",
            input_schema: || {
                object(
                    json!({ "organization_id": organization_id(), "project_id": project_id() }),
                    &[],
                )
            },
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-kits/v1/installed-kits"),
        },
        Tool {
            name: "kit_base_install",
            description: "Install a kit for EVERY organization, as a base kit. Platform \
                administrators only. Installing it again changes its version. Ask your person \
                first: every organization's people see what the kit brings.",
            input_schema: || {
                object(
                    json!({ "kit_slug": kit_slug(), "version": version() }),
                    &["kit_slug"],
                )
            },
            effect: Effect::Write,
            experimental: true,
            run: Run::Put {
                path: "/studio-kits/v1/base-kits/{kit_slug}",
                query: &[],
            },
        },
        Tool {
            name: "kit_base_uninstall",
            description: "Stop a kit being installed for every organization. Platform \
                administrators only. A built-in kit stays removed until it is installed again; \
                organizations that installed the kit themselves keep it. Ask your person first.",
            input_schema: || object(json!({ "kit_slug": kit_slug() }), &["kit_slug"]),
            effect: Effect::Destructive,
            experimental: true,
            run: Run::Delete("/studio-kits/v1/base-kits/{kit_slug}"),
        },
        Tool {
            name: "kit_organization_install",
            description: "Install a kit for one organization only. Its administrators (or a \
                platform administrator) only. Installing it again changes its version; a kit \
                that is also a base kit applies at the newer of the two versions.",
            input_schema: || {
                object(
                    json!({
                        "organization_id": organization_id(),
                        "kit_slug": kit_slug(),
                        "version": version()
                    }),
                    &["kit_slug"],
                )
            },
            effect: Effect::Write,
            experimental: true,
            run: Run::Put {
                path: "/studio-kits/v1/organization-kits/{kit_slug}",
                query: &["organization_id"],
            },
        },
        Tool {
            name: "kit_organization_uninstall",
            description: "Uninstall a kit the organization installed for itself. Its \
                administrators only. A base kit cannot be uninstalled by an organization \
                (refused with `BASE_KIT`). Ask your person first.",
            input_schema: || {
                object(
                    json!({ "organization_id": organization_id(), "kit_slug": kit_slug() }),
                    &["kit_slug"],
                )
            },
            effect: Effect::Destructive,
            experimental: true,
            run: Run::Delete("/studio-kits/v1/organization-kits/{kit_slug}"),
        },
        Tool {
            name: "kit_project_install",
            description: "Install a kit for one project only. Whoever may install kits for the \
                project's organization (its administrators, or a platform administrator). Only \
                a kit whose `levels` include `project` (refused with `NOT_A_PROJECT_KIT`). \
                Installing it again changes its version; a kit the organization or the \
                platform also installed applies at the newest version.",
            input_schema: || {
                object(
                    json!({
                        "project_id": project_id(),
                        "kit_slug": kit_slug(),
                        "version": version()
                    }),
                    &["project_id", "kit_slug"],
                )
            },
            effect: Effect::Write,
            experimental: true,
            run: Run::Put {
                path: "/studio-kits/v1/project-kits/{kit_slug}",
                query: &["project_id"],
            },
        },
        Tool {
            name: "kit_project_uninstall",
            description: "Uninstall a kit installed for one project. Whoever may install kits \
                for the project's organization. A kit the project has from its organization \
                (`ORGANIZATION_KIT`) or the platform (`BASE_KIT`) is refused. Ask your person \
                first.",
            input_schema: || {
                object(
                    json!({ "project_id": project_id(), "kit_slug": kit_slug() }),
                    &["project_id", "kit_slug"],
                )
            },
            effect: Effect::Destructive,
            experimental: true,
            run: Run::Delete("/studio-kits/v1/project-kits/{kit_slug}"),
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
        let r = request_of(&all, "kits_describe", json!({"kit_slug": "sdlc"}));
        assert_eq!(r.method, Method::Get);
        assert_eq!(r.path, "/studio-kits/v1/catalog/sdlc");
        assert!(r.query.is_empty());

        let r = request_of(&all, "kits_installed", json!({"organization_id": "o-1"}));
        assert_eq!(r.method, Method::Get);
        assert_eq!(r.path, "/studio-kits/v1/installed-kits");
        assert_eq!(
            r.query,
            vec![("organization_id".to_owned(), "o-1".to_owned())]
        );

        let r = request_of(
            &all,
            "kit_organization_install",
            json!({"organization_id": "o-1", "kit_slug": "sdlc", "version": "v1"}),
        );
        assert_eq!(r.method, Method::Put);
        assert_eq!(r.path, "/studio-kits/v1/organization-kits/sdlc");
        assert_eq!(
            r.query,
            vec![("organization_id".to_owned(), "o-1".to_owned())]
        );
        assert_eq!(r.body, json!({"version": "v1"}));

        let r = request_of(
            &all,
            "kit_base_install",
            json!({"kit_slug": "project-issues"}),
        );
        assert_eq!(r.path, "/studio-kits/v1/base-kits/project-issues");
        assert_eq!(r.body, json!({}));

        let r = request_of(
            &all,
            "kit_project_install",
            json!({"project_id": "p-1", "kit_slug": "sdlc", "version": "v2"}),
        );
        assert_eq!(r.method, Method::Put);
        assert_eq!(r.path, "/studio-kits/v1/project-kits/sdlc");
        assert_eq!(r.query, vec![("project_id".to_owned(), "p-1".to_owned())]);
        assert_eq!(r.body, json!({"version": "v2"}));

        let r = request_of(
            &all,
            "kit_project_uninstall",
            json!({"project_id": "p-1", "kit_slug": "sdlc"}),
        );
        assert_eq!(r.method, Method::Delete);
        assert_eq!(r.path, "/studio-kits/v1/project-kits/sdlc");
        assert_eq!(r.query, vec![("project_id".to_owned(), "p-1".to_owned())]);

        let r = request_of(&all, "kits_installed", json!({"project_id": "p-1"}));
        assert_eq!(r.path, "/studio-kits/v1/installed-kits");
        assert_eq!(r.query, vec![("project_id".to_owned(), "p-1".to_owned())]);

        let r = request_of(
            &all,
            "kit_organization_uninstall",
            json!({"organization_id": "o-1", "kit_slug": "sdlc"}),
        );
        assert_eq!(r.method, Method::Delete);
        assert_eq!(r.path, "/studio-kits/v1/organization-kits/sdlc");
        assert_eq!(
            r.query,
            vec![("organization_id".to_owned(), "o-1".to_owned())]
        );
    }
}
