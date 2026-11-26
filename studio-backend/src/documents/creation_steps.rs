//! The documents kit's part of a project's creation (the core's project
//! creation port, ADR-0079 §4): the PRD written from the brief, and the
//! stages the workspace's catalogue marks required, which the project's
//! configuration starts with.

use async_trait::async_trait;
use axum::http::HeaderValue;
use serde_json::Value;
use toolkit::client_hub::ClientHub;
use uuid::Uuid;

use super::port::ProjectDocuments;
use crate::organizations::port::{
    CreationField, CreationFieldSource, CreationStep, CreationStepRun, MadeRepo, Plan, StepDone,
    StepError, creation_retry as retry, creation_service_ctx as service_ctx,
};

inventory::submit! {
    CreationStep {
        gear: "studio-documents",
        key: "prd",
        step: &PrdStep,
    }
}

inventory::submit! {
    CreationField {
        gear: "studio-documents",
        field: "stages",
        source: &RequiredStages,
    }
}

struct PrdStep;

#[async_trait]
impl CreationStepRun for PrdStep {
    async fn run(
        &self,
        hub: &ClientHub,
        plan: &Plan,
        _repo: Option<&MadeRepo>,
    ) -> Result<StepDone, StepError> {
        let Some(p) = plan.prd.as_ref() else {
            return Err(StepError::Fail("the plan names no PRD".to_string()));
        };
        let documents = hub.get::<dyn ProjectDocuments>().map_err(|_| {
            StepError::Fail("studio-documents is not in this deployment".to_string())
        })?;
        // The workspace's document types are read too: the organization's scope.
        let ctx = service_ctx(plan.organization_id)?;
        if documents
            .has_document(&ctx, plan.workspace_id, plan.project_id, "prd")
            .await
            .map_err(|e| retry("the project's documents cannot be read", e))?
        {
            return Ok(StepDone::Line("the project has a PRD already".to_string()));
        }
        documents
            .create_answered(
                &ctx,
                plan.workspace_id,
                plan.project_id,
                "prd",
                &p.title,
                &[("product".to_string(), p.answer.clone())],
                &plan.asked_by.to_string(),
            )
            .await
            .map(|id| StepDone::Line(format!("document {id}")))
            .map_err(|e| retry("the PRD could not be written", e))
    }
}

/// The stages the workspace's catalogue marks required, read as the caller;
/// none when they cannot be read (creation does not fail on it).
struct RequiredStages;

#[async_trait]
impl CreationFieldSource for RequiredStages {
    async fn value(&self, authorization: Option<HeaderValue>, workspace: Uuid) -> Value {
        Value::Array(required_stages(authorization, workspace).await)
    }
}

async fn required_stages(authorization: Option<HeaderValue>, workspace: Uuid) -> Vec<Value> {
    let Some(api) = crate::mcp::api_as(authorization) else {
        return Vec::new();
    };
    let Ok(page) = api
        .get(
            &format!("/studio-documents/v1/workspaces/{workspace}/stages"),
            &[],
        )
        .await
    else {
        return Vec::new();
    };
    page.get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|s| s.get("required").and_then(Value::as_bool) == Some(true))
                .filter_map(|s| s.get("key").cloned())
                .collect()
        })
        .unwrap_or_default()
}
