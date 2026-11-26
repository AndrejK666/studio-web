//! `GET /nodes` and `GET /runs` read what `POST /studio-domain-model/v1/query`
//! would show the same caller (ADR-0035): `domain.view` from the
//! domain-object policy, narrowed to the projects it admits; no grant is a
//! 403 and a policy that cannot be asked a 503.
//!
//! The policy here answers as the PDP does on the `roles` model: an owner of
//! the organization reads all of it, a member with a grant on one project
//! reads that project, anyone else (a platform administrator who is no
//! member, among them) is refused.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use axum::extract::Query;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::{Extension, Json};
use credstore_sdk::{
    CredStoreClientV1, CredStoreError, GetSecretResponse, SecretRef, SecretValue, SharingMode,
    WriteOptions, WritePrecondition,
};
use serde_json::json;
use toolkit::client_hub::ClientHub;
use toolkit_canonical_errors::CanonicalError;
use toolkit_security::{
    AccessScope, InTenantSubtreeScopeFilter, ScopeConstraint, ScopeFilter, ScopeValue,
    SecurityContext, pep_properties,
};
use uuid::Uuid;

use super::{CiRunListDto, CiRunQuery, Ingest, NodesQuery, list_ci_runs, list_nodes};
use crate::artifact_ingest::graph::{GraphStore, GtsNode, InMemoryGraphStore};
use crate::artifact_ingest::gts;
use crate::artifact_ingest::service::IngestService;
use crate::domain_model::port::{
    Access, AccessError, DomainObjects, ObjectPolicy, TenantParents, in_memory_with_policy,
};

const ROOT: Uuid = Uuid::from_u128(1);
const ORG: Uuid = Uuid::from_u128(0x0a);
const MINE: Uuid = Uuid::from_u128(0x101);
const THEIRS: Uuid = Uuid::from_u128(0x102);

const OWNER: u128 = 0x0e;
const MEMBER: u128 = 0x0f;
const ADMIN: u128 = 0xad;

fn caller(home: Uuid, subject: u128) -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(subject))
        .subject_type("user")
        .subject_tenant_id(home)
        .token_scopes(vec!["studio".into()])
        .build()
        .unwrap()
}

/// Both projects sit in the organization.
struct Tree;
#[async_trait]
impl TenantParents for Tree {
    async fn parent_of(&self, _ctx: &SecurityContext, t: Uuid) -> Option<Uuid> {
        (t == MINE || t == THEIRS).then_some(ORG)
    }
}

fn subtree(root: Uuid) -> ScopeFilter {
    ScopeFilter::InTenantSubtree(InTenantSubtreeScopeFilter::new(
        pep_properties::OWNER_TENANT_ID,
        ScopeValue::Uuid(root),
    ))
}

/// What the PDP answers each caller.
struct Roles {
    down: bool,
}

#[async_trait]
impl ObjectPolicy for Roles {
    async fn access(
        &self,
        ctx: &SecurityContext,
        _action: &str,
        _entity: Option<&str>,
    ) -> Result<Access, AccessError> {
        if self.down {
            return Err(AccessError::Unavailable("the PDP did not answer".into()));
        }
        let scope = match ctx.subject_id() {
            s if s == Uuid::from_u128(OWNER) => AccessScope::from_constraints(vec![
                ScopeConstraint::new(vec![ScopeFilter::in_uuids(
                    pep_properties::OWNER_TENANT_ID,
                    vec![ORG],
                )]),
                ScopeConstraint::new(vec![subtree(ORG)]),
            ]),
            s if s == Uuid::from_u128(MEMBER) => {
                AccessScope::from_constraints(vec![ScopeConstraint::new(vec![
                    subtree(ORG),
                    ScopeFilter::in_uuids(pep_properties::OWNER_TENANT_ID, vec![MINE]),
                ])])
            }
            _ => return Err(AccessError::Denied),
        };
        Ok(Access::for_tests(ctx, scope, Some(Arc::new(Tree))))
    }
}

struct NoSecrets;

#[async_trait]
impl CredStoreClientV1 for NoSecrets {
    async fn get(
        &self,
        _ctx: &SecurityContext,
        _key: &SecretRef,
    ) -> Result<Option<GetSecretResponse>, CredStoreError> {
        Ok(None)
    }

    async fn put_opts(
        &self,
        _ctx: &SecurityContext,
        _key: &SecretRef,
        _value: SecretValue,
        _sharing: SharingMode,
        _precondition: WritePrecondition,
        _opts: WriteOptions,
    ) -> Result<(), CredStoreError> {
        Ok(())
    }

    async fn create_opts(
        &self,
        _ctx: &SecurityContext,
        _key: &SecretRef,
        _value: SecretValue,
        _sharing: SharingMode,
        _opts: WriteOptions,
    ) -> Result<(), CredStoreError> {
        Ok(())
    }
}

fn repo(project: Uuid) -> GtsNode {
    GtsNode {
        type_id: gts::REPO_TYPE,
        instance_id: format!("repo-{project}"),
        value: json!({"full_path": format!("acme/{project}"), "project_id": project.to_string()}),
    }
}

fn run(project: Uuid) -> GtsNode {
    GtsNode {
        type_id: gts::WORKFLOW_RUN_TYPE,
        instance_id: format!("run-{project}"),
        value: json!({
            "workflow": "ci",
            "sha": "abc1234",
            "branch": "main",
            "status": "completed",
            "conclusion": "success",
            "project_id": project.to_string(),
        }),
    }
}

/// Both projects synced; the policy behind the domain model's port.
async fn ingest(policy: Option<Roles>) -> Ingest {
    let graph = Arc::new(InMemoryGraphStore::default());
    let gear = caller(ORG, 0x5e);
    graph
        .upsert_nodes(&gear, &[repo(MINE), repo(THEIRS), run(MINE), run(THEIRS)])
        .await
        .unwrap();
    let svc = IngestService::new(Arc::new(NoSecrets), HashMap::new(), graph, None, None, None);
    let hub = Arc::new(ClientHub::new());
    if let Some(policy) = policy {
        hub.register::<dyn DomainObjects>(in_memory_with_policy(Arc::new(policy)));
    }
    Ingest::new(Some(Arc::new(svc)), hub)
}

async fn nodes(
    ingest: &Ingest,
    ctx: SecurityContext,
    scope: Option<Uuid>,
) -> Result<(Vec<String>, u32), CanonicalError> {
    let mut q = json!({"type": "repo"});
    if let Some(s) = scope {
        q["scope"] = json!(s.to_string());
    }
    let q: NodesQuery = serde_json::from_value(q).unwrap();
    let Json(page) = list_nodes(Extension(ctx), Extension(ingest.clone()), Query(q)).await?;
    let mut ids: Vec<String> = page.nodes.into_iter().map(|n| n.instance_id).collect();
    ids.sort();
    Ok((ids, page.total))
}

async fn runs(
    ingest: &Ingest,
    ctx: SecurityContext,
    project: Uuid,
) -> Result<CiRunListDto, CanonicalError> {
    let q: CiRunQuery = serde_json::from_value(json!({"project_id": project.to_string()})).unwrap();
    let Json(list) = list_ci_runs(Extension(ctx), Extension(ingest.clone()), Query(q)).await?;
    Ok(list)
}

fn status(e: CanonicalError) -> StatusCode {
    e.into_response().status()
}

#[tokio::test]
async fn an_owner_of_the_organization_reads_every_project() {
    let ingest = ingest(Some(Roles { down: false })).await;
    let owner = caller(ORG, OWNER);
    let (ids, total) = nodes(&ingest, owner.clone(), None).await.unwrap();
    assert_eq!(ids, vec![format!("repo-{MINE}"), format!("repo-{THEIRS}")]);
    assert_eq!(total, 2);
    let (ids, _) = nodes(&ingest, owner.clone(), Some(THEIRS)).await.unwrap();
    assert_eq!(ids, vec![format!("repo-{THEIRS}")]);
    assert_eq!(runs(&ingest, owner, THEIRS).await.unwrap().total, 1);
}

#[tokio::test]
async fn a_member_with_project_grants_only_reads_those_projects() {
    let ingest = ingest(Some(Roles { down: false })).await;
    let member = caller(ORG, MEMBER);
    // Unscoped: narrowed before it is paged, so the count is only theirs.
    let (ids, total) = nodes(&ingest, member.clone(), None).await.unwrap();
    assert_eq!(ids, vec![format!("repo-{MINE}")]);
    assert_eq!(total, 1);
    let (ids, total) = nodes(&ingest, member.clone(), Some(MINE)).await.unwrap();
    assert_eq!(ids, vec![format!("repo-{MINE}")]);
    assert_eq!(total, 1);
    let list = runs(&ingest, member, MINE).await.unwrap();
    assert_eq!(list.total, 1);
    assert_eq!(list.items[0].id, format!("run-{MINE}"));
    assert_eq!(list.latest_completed, Some(format!("run-{MINE}")));
}

#[tokio::test]
async fn a_project_outside_the_grants_reads_as_empty() {
    // As the query narrows `project_id`: the member reaches the tenant, the
    // grant does not name it, and nothing of it is listed or counted.
    let ingest = ingest(Some(Roles { down: false })).await;
    let member = caller(ORG, MEMBER);
    let (ids, total) = nodes(&ingest, member.clone(), Some(THEIRS)).await.unwrap();
    assert!(ids.is_empty(), "{ids:?}");
    assert_eq!(total, 0);
    let list = runs(&ingest, member, THEIRS).await.unwrap();
    assert!(list.items.is_empty());
    assert_eq!(list.total, 0);
    assert_eq!(list.latest_completed, None);
}

#[tokio::test]
async fn a_platform_administrator_who_is_no_member_is_refused() {
    let ingest = ingest(Some(Roles { down: false })).await;
    let admin = caller(ROOT, ADMIN);
    let e = nodes(&ingest, admin.clone(), Some(MINE)).await.unwrap_err();
    assert_eq!(status(e), StatusCode::FORBIDDEN);
    let e = nodes(&ingest, admin.clone(), None).await.unwrap_err();
    assert_eq!(status(e), StatusCode::FORBIDDEN);
    let e = runs(&ingest, admin, MINE).await.unwrap_err();
    assert_eq!(status(e), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_policy_that_cannot_be_asked_is_a_503_not_everything() {
    let ingest = ingest(Some(Roles { down: true })).await;
    let owner = caller(ORG, OWNER);
    let e = nodes(&ingest, owner.clone(), Some(MINE)).await.unwrap_err();
    assert_eq!(status(e), StatusCode::SERVICE_UNAVAILABLE);
    let e = runs(&ingest, owner, MINE).await.unwrap_err();
    assert_eq!(status(e), StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn without_the_domain_model_there_is_no_answer_to_read_by() {
    let ingest = ingest(None).await;
    let owner = caller(ORG, OWNER);
    let e = nodes(&ingest, owner.clone(), Some(MINE)).await.unwrap_err();
    assert_eq!(status(e), StatusCode::SERVICE_UNAVAILABLE);
    let e = runs(&ingest, owner, MINE).await.unwrap_err();
    assert_eq!(status(e), StatusCode::SERVICE_UNAVAILABLE);
}
