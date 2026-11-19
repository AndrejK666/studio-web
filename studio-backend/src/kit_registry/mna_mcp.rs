//! M&A due diligence as MCP tools (studio-web#1024): an agent reads and
//! writes a deal the way a person does, through the same routes and so as
//! the person, under the same checks (the deal lead's sign-off included).
//! The kit claims them, so they answer `KIT_NOT_INSTALLED` where it does not
//! apply to the project.

use serde_json::{Map, Value, json};

use crate::mcp::sdk::{
    Api, Effect, Run, Tool, ToolError, ToolFuture, object, project_id, required_text,
};

const DEAL: &str = "/studio-kits/v1/mna/deal";
const EVIDENCE: &str = "/studio-kits/v1/mna/evidence";
const FINDINGS: &str = "/studio-kits/v1/mna/findings";
const RISKS: &str = "/studio-kits/v1/mna/risks";

/// `?project_id=` for a project id that is a uuid.
fn by_project(args: &Map<String, Value>) -> Result<(String, Vec<(String, String)>), ToolError> {
    let project = required_text(args, "project_id")?;
    uuid::Uuid::parse_str(&project)
        .map_err(|_| ToolError::new("`project_id` is a project's tenant id, a uuid"))?;
    let q = vec![("project_id".to_owned(), project.clone())];
    Ok((project, q))
}

/// `args` without the ones that are not the body.
fn body_of(args: &Map<String, Value>, except: &[&str]) -> Value {
    Value::Object(
        args.iter()
            .filter(|(k, _)| !except.contains(&k.as_str()))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
    )
}

fn deal(api: Api, args: Map<String, Value>) -> ToolFuture {
    Box::pin(async move {
        let (_, q) = by_project(&args)?;
        let deal = api.get(DEAL, &q).await?;
        let evidence = if deal["installed"].as_bool().unwrap_or(false) {
            api.get(EVIDENCE, &q).await?
        } else {
            Value::Null
        };
        Ok(json!({ "deal": deal, "evidence": evidence }))
    })
}

fn deal_update(api: Api, args: Map<String, Value>) -> ToolFuture {
    Box::pin(async move {
        let (project, q) = by_project(&args)?;
        let body = body_of(&args, &["project_id", "sign_off"]);
        let mut answer = if body.as_object().is_some_and(|b| !b.is_empty()) {
            api.patch(&format!("{DEAL}?project_id={project}"), &body)
                .await?
        } else {
            api.get(DEAL, &q).await?
        };
        if args.get("sign_off").and_then(Value::as_bool) == Some(true) {
            answer = api
                .post(&format!("{DEAL}/sign-off"), &q, &json!({}))
                .await?;
        }
        Ok(answer)
    })
}

fn upsert(api: Api, args: Map<String, Value>, path: &'static str, id: &'static str) -> ToolFuture {
    Box::pin(async move {
        let (_, q) = by_project(&args)?;
        let body = body_of(&args, &["project_id", id]);
        match args
            .get(id)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            Some(item) => api.put(&format!("{path}/{item}"), &q, &body).await,
            None => api.post(path, &q, &body).await,
        }
    })
}

fn finding_upsert(api: Api, args: Map<String, Value>) -> ToolFuture {
    upsert(api, args, FINDINGS, "finding_id")
}

fn risk_upsert(api: Api, args: Map<String, Value>) -> ToolFuture {
    upsert(api, args, RISKS, "risk_id")
}

fn text() -> Value {
    json!({ "type": "string" })
}

pub fn tools() -> Vec<Tool> {
    vec![
        Tool {
            name: "mna_deal",
            description: "A deal of the M&A due diligence kit — a project of the M&A type — \
                with its evidence: `deal` (target, thesis, `deal_phase`, `ic_date`, \
                `recommendation` with its `conditions`, who signed it off and when, the \
                `deal_lead` and whether you may sign off) and `evidence` (the target's \
                repositories with their sync, contributors and truck factor, and facts each \
                with its `source`: CI pass rate, mainline build, specs checked and failing, \
                open findings, risks and questions). A fact with `available: false` has no \
                number, only the reason in `detail`: do not guess one.",
            input_schema: || object(json!({ "project_id": project_id() }), &["project_id"]),
            effect: Effect::Read,
            experimental: false,
            run: Run::Custom(deal),
        },
        Tool {
            name: "mna_deal_update",
            description: "Change a deal: any of `target`, `thesis`, `deal_phase` (screening, \
                confirmatory_dd, signing, integration), `ic_date` (YYYY-MM-DD), \
                `recommendation` (proceed, proceed_with_conditions, stop) and `conditions` \
                (replaces the list); an empty string clears a field. Changing the \
                recommendation or its conditions takes an earlier sign-off back. \
                `sign_off: true` then signs the recommendation off, which only the deal lead \
                (the project's owner) may do (`DEAL_LEAD_REQUIRED`). Answers the deal.",
            input_schema: || {
                object(
                    json!({
                        "project_id": project_id(),
                        "target": text(),
                        "thesis": text(),
                        "deal_phase": { "type": "string",
                            "enum": ["screening", "confirmatory_dd", "signing", "integration", ""] },
                        "ic_date": text(),
                        "recommendation": { "type": "string",
                            "enum": ["proceed", "proceed_with_conditions", "stop", ""] },
                        "conditions": { "type": "array", "items": { "type": "string" } },
                        "sign_off": { "type": "boolean",
                            "description": "Sign the recommendation off, as the deal lead." }
                    }),
                    &["project_id"],
                )
            },
            effect: Effect::Write,
            experimental: true,
            run: Run::Custom(deal_update),
        },
        Tool {
            name: "mna_findings",
            description: "A deal's findings, newest first: `title`, `severity`, the `source` \
                (repository or part of the target) it is about, its `evidence`, its `origin` \
                and `status` (open, accepted, resolved).",
            input_schema: || {
                object(
                    json!({
                        "project_id": project_id(),
                        "limit": { "type": "integer" },
                        "offset": { "type": "integer" }
                    }),
                    &["project_id"],
                )
            },
            effect: Effect::Read,
            experimental: false,
            run: Run::Get(FINDINGS),
        },
        Tool {
            name: "mna_finding_upsert",
            description: "Record a finding of a deal, or replace one by `finding_id` (whole: \
                send every field you keep). `title` and `severity` (critical, high, medium, \
                low, info) are needed; `origin` says where it came from (manual, spec_check, \
                ci, git, interview), `manual` by default; `status` open, accepted or \
                resolved, `open` by default. Answers the finding with its id.",
            input_schema: || {
                object(
                    json!({
                        "project_id": project_id(),
                        "finding_id": { "type": "string",
                            "description": "Replace this finding; absent: record a new one." },
                        "title": text(),
                        "severity": { "type": "string",
                            "enum": ["critical", "high", "medium", "low", "info"] },
                        "source": text(),
                        "evidence": text(),
                        "origin": text(),
                        "status": { "type": "string", "enum": ["open", "accepted", "resolved"] }
                    }),
                    &["project_id", "title", "severity"],
                )
            },
            effect: Effect::Write,
            experimental: true,
            run: Run::Custom(finding_upsert),
        },
        Tool {
            name: "mna_risks",
            description: "A deal's risk ledger, newest first: `title`, `likelihood`, `impact`, \
                `owner`, `mitigation`, the `finding_id` it comes from and `status` (open, \
                mitigating, accepted, closed).",
            input_schema: || {
                object(
                    json!({
                        "project_id": project_id(),
                        "limit": { "type": "integer" },
                        "offset": { "type": "integer" }
                    }),
                    &["project_id"],
                )
            },
            effect: Effect::Read,
            experimental: false,
            run: Run::Get(RISKS),
        },
        Tool {
            name: "mna_risk_upsert",
            description: "Record a risk of a deal, or replace one by `risk_id` (whole). \
                `title`, `likelihood` (low, medium, high) and `impact` (low, medium, high, \
                critical) are needed; `finding_id` names one of the deal's findings \
                (`mna_findings`); `status` open by default.",
            input_schema: || {
                object(
                    json!({
                        "project_id": project_id(),
                        "risk_id": { "type": "string",
                            "description": "Replace this risk; absent: record a new one." },
                        "title": text(),
                        "likelihood": { "type": "string", "enum": ["low", "medium", "high"] },
                        "impact": { "type": "string",
                            "enum": ["low", "medium", "high", "critical"] },
                        "owner": text(),
                        "mitigation": text(),
                        "finding_id": text(),
                        "status": { "type": "string",
                            "enum": ["open", "mitigating", "accepted", "closed"] }
                    }),
                    &["project_id", "title", "likelihood", "impact"],
                )
            },
            effect: Effect::Write,
            experimental: true,
            run: Run::Custom(risk_upsert),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_body_leaves_out_what_goes_in_the_path_or_the_query() {
        let mut args = Map::new();
        args.insert("project_id".into(), json!("p"));
        args.insert("finding_id".into(), json!("f"));
        args.insert("title".into(), json!("No tests"));
        assert_eq!(
            body_of(&args, &["project_id", "finding_id"]),
            json!({ "title": "No tests" })
        );
    }

    #[test]
    fn a_project_id_is_a_uuid() {
        let mut args = Map::new();
        args.insert("project_id".into(), json!("p?x=1"));
        assert!(by_project(&args).is_err());
        let id = uuid::Uuid::new_v4().to_string();
        args.insert("project_id".into(), json!(id));
        assert_eq!(by_project(&args).unwrap().0, id);
    }

    #[test]
    fn every_write_tool_is_experimental() {
        for t in tools() {
            assert_eq!(
                t.experimental,
                matches!(t.effect, Effect::Write),
                "{}",
                t.name
            );
        }
    }
}
