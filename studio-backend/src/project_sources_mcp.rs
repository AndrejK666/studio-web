//! A project's repositories, as MCP tools (`crate::mcp`).
//!
//! The sources are the `sources` field of the project's config, account
//! management's tenant metadata `project.config` on the project's tenant,
//! which the portal reads and writes whole. Setting them reads the config,
//! replaces `sources` alone and writes it back, so the config's other fields
//! (its build, its settings) are kept as they are.

use serde_json::{Map, Value, json};

use super::PROJECT_CONFIG_TYPE;
use crate::mcp::sdk::{
    Api, Effect, Run, Tool, ToolError, ToolFuture, object, project_id, required_text,
};

/// The config's entry: `/account-management/v1/tenants/{project}/metadata/{type}`.
fn config_path(project: &str) -> Result<String, ToolError> {
    let (path, _) = crate::mcp::sdk::fill_path(
        "/account-management/v1/tenants/{project}/metadata/{type}",
        json!({ "project": project, "type": PROJECT_CONFIG_TYPE })
            .as_object()
            .cloned()
            .unwrap_or_default(),
    )?;
    Ok(path)
}

pub fn tools() -> Vec<Tool> {
    vec![
        Tool {
            name: "project_sources",
            description: "The repositories the project is made of, in order: each with \
                `connection_id` (the connection it is read through), `full_path` \
                (owner/repo), `clone_url`, `branch` (the repository's default when absent), \
                `share_mode`, `gears_here` (new gears go here) and `publish_here` (a \
                published product.gdl goes here). Empty for a project with none. Each also \
                carries `clone`, the last clone or fetch of it: `state` (`cloned`, `failed` \
                or `never`), `at`, `by` (`desktop` or `ide_session`), and when it failed its \
                `cause`, `cause_text`, `action` and `action_text` (what fixes it). `clone` is \
                absent when the clone status cannot be read.",
            input_schema: || object(json!({ "project_id": project_id() }), &["project_id"]),
            effect: Effect::Read,
            experimental: false,
            run: Run::Custom(project_sources),
        },
        Tool {
            name: "project_sources_set",
            description: "Set the repositories the project is made of: `sources` is the WHOLE \
                list and replaces the current one (read it with `project_sources` and send it \
                back changed). Take `connection_id` from `project_connections` and \
                `full_path`/`clone_url` from `connection_repositories`. Only the sources \
                change; the project's other settings are kept. At most one source should be \
                `gears_here` and one `publish_here`. Ask your person first: sessions, builds \
                and the product read their code from these.",
            input_schema: || {
                object(
                    json!({
                        "project_id": project_id(),
                        "sources": { "type": "array", "items": {
                            "type": "object",
                            "properties": {
                                "connection_id": { "type": "string" },
                                "full_path": { "type": "string", "description": "owner/repo on the provider." },
                                "clone_url": { "type": "string" },
                                "branch": { "type": "string" },
                                "share_mode": { "type": "string", "enum": ["branch", "pull_request"] },
                                "gears_here": { "type": "boolean" },
                                "publish_here": { "type": "boolean" }
                            },
                            "required": ["connection_id", "full_path", "clone_url"],
                            "additionalProperties": false
                        } }
                    }),
                    &["project_id", "sources"],
                )
            },
            effect: Effect::Destructive,
            experimental: true,
            run: Run::Custom(project_sources_set),
        },
        Tool {
            name: "project_source_detach",
            description: "Detach one repository from the project: it leaves the project's \
                sources and everything synced from it (issues, pull requests, files, specs' \
                bindings) is forgotten, as one durable run. `clone_url` is the source's, from \
                `project_sources`. Answers `run_id`; read the outcome with `task_run`. Ask \
                your person first: it cannot be undone except by attaching and syncing the \
                repository again.",
            input_schema: || {
                object(
                    json!({
                        "project_id": project_id(),
                        "clone_url": { "type": "string", "description": "The source's clone URL." }
                    }),
                    &["project_id", "clone_url"],
                )
            },
            effect: Effect::Destructive,
            experimental: true,
            run: Run::Post {
                path: "/studio-artifact-ingest/v1/sources/detach",
                query: &["project_id"],
            },
        },
    ]
}

/// The project's config, `{}` when it has none yet.
async fn read_config(api: &Api, project: &str) -> Result<Value, ToolError> {
    let answer = api.get_answer(&config_path(project)?, &[]).await?;
    match answer.status {
        404 => Ok(json!({})),
        _ if answer.ok() => Ok(answer.body["value"].clone()),
        _ => Err(answer.refusal()),
    }
}

fn sources_of(config: &Value) -> Value {
    let sources = config
        .get("sources")
        .cloned()
        .filter(Value::is_array)
        .unwrap_or_else(|| json!([]));
    json!({ "sources": sources })
}

/// Where the last clone of each source is read (`artifact_ingest::clone_status`).
const CLONE_STATUS_PATH: &str = "/studio-artifact-ingest/v1/sources/clone-status";

fn project_sources(api: Api, args: Map<String, Value>) -> ToolFuture {
    Box::pin(async move {
        let project = required_text(&args, "project_id")?;
        let sources = sources_of(&read_config(&api, &project).await?);
        // The clone status is extra: a deployment that keeps none still
        // lists the sources.
        let clones = api
            .get_answer(CLONE_STATUS_PATH, &[("project_id".to_owned(), project)])
            .await
            .ok()
            .filter(|answer| answer.ok())
            .map(|answer| answer.body);
        Ok(with_clones(sources, clones.as_ref()))
    })
}

/// `listed` (`{"sources": [...]}`) with each source's `clone` from the clone
/// status' items, matched by `clone_url`. Unchanged without them.
fn with_clones(mut listed: Value, clones: Option<&Value>) -> Value {
    let Some(items) = clones
        .and_then(|c| c.get("items"))
        .and_then(Value::as_array)
    else {
        return listed;
    };
    let Some(sources) = listed.get_mut("sources").and_then(Value::as_array_mut) else {
        return listed;
    };
    for source in sources.iter_mut() {
        let Some(url) = source.get("clone_url").and_then(Value::as_str) else {
            continue;
        };
        let Some(item) = items
            .iter()
            .find(|i| i.get("clone_url").and_then(Value::as_str) == Some(url))
        else {
            continue;
        };
        let mut clone = item.as_object().cloned().unwrap_or_default();
        clone.remove("clone_url");
        clone.remove("full_path");
        clone.retain(|_, v| !v.is_null());
        if let Some(entry) = source.as_object_mut() {
            entry.insert("clone".into(), Value::Object(clone));
        }
    }
    listed
}

/// `config` with `sources` replaced and nothing else touched.
fn with_sources(mut config: Value, sources: Value) -> Result<Value, ToolError> {
    if !sources.is_array() {
        return Err(ToolError::new("`sources` is a list"));
    }
    if !config.is_object() {
        config = json!({});
    }
    config["sources"] = sources;
    Ok(config)
}

fn project_sources_set(api: Api, args: Map<String, Value>) -> ToolFuture {
    Box::pin(async move {
        let project = required_text(&args, "project_id")?;
        let sources = args.get("sources").cloned().unwrap_or(Value::Null);
        let config = with_sources(read_config(&api, &project).await?, sources)?;
        api.put(&config_path(&project)?, &[], &config).await?;
        Ok(sources_of(&config))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_config_is_the_project_tenant_s_metadata() {
        assert_eq!(
            config_path("p-1").unwrap(),
            "/account-management/v1/tenants/p-1/metadata/\
             gts.cf.core.am.tenant_metadata.v1~cf.studio.project.config.v1~"
        );
    }

    #[test]
    fn setting_the_sources_keeps_every_other_field() {
        let config = json!({
            "build": {"repo": "acme/api", "workflow": "b.yml"},
            "sources": [{"clone_url": "old"}],
            "description": "kept"
        });
        let next = json!([{"connection_id": "c", "full_path": "acme/web", "clone_url": "u", "gears_here": true}]);
        let out = with_sources(config, next.clone()).unwrap();
        assert_eq!(out["sources"], next);
        assert_eq!(out["build"]["workflow"], "b.yml");
        assert_eq!(out["description"], "kept");
        assert_eq!(
            with_sources(json!(null), json!([])).unwrap(),
            json!({"sources": []})
        );
        assert!(with_sources(json!({}), json!({"x": 1})).is_err());
    }

    /// #1071: an agent reads the same clone status as the Sources tab.
    #[test]
    fn each_source_carries_its_last_clone() {
        let listed = json!({ "sources": [
            { "full_path": "acme/api", "clone_url": "https://github.com/acme/api.git" },
            { "full_path": "acme/web", "clone_url": "https://github.com/acme/web.git" }
        ]});
        let clones = json!({ "total": 2, "items": [
            { "clone_url": "https://github.com/acme/api.git", "full_path": "acme/api",
              "state": "failed", "at": "2026-11-12T10:00:00Z", "by": "ide_session",
              "cause": "connection_not_found", "cause_text": "…", "action": "reconnect",
              "action_text": "…", "upstream_status": null, "detail": null },
            { "clone_url": "https://github.com/acme/web.git", "full_path": "acme/web",
              "state": "never" }
        ]});
        let out = with_clones(listed.clone(), Some(&clones));
        let api = &out["sources"][0]["clone"];
        assert_eq!(api["state"], "failed");
        assert_eq!(api["cause"], "connection_not_found");
        assert_eq!(api["action"], "reconnect");
        assert!(api.get("upstream_status").is_none());
        assert!(api.get("clone_url").is_none());
        assert_eq!(out["sources"][1]["clone"], json!({ "state": "never" }));
        assert_eq!(out["sources"][1]["full_path"], "acme/web");
        // No clone status, no `clone`.
        assert_eq!(with_clones(listed.clone(), None), listed);
    }

    #[test]
    fn a_config_without_sources_has_none() {
        assert_eq!(sources_of(&json!({})), json!({"sources": []}));
        assert_eq!(
            sources_of(&json!({"sources": [1]})),
            json!({"sources": [1]})
        );
    }
}
