//! What a table of projects asks its sources: once per workspace, whatever
//! the number of projects in it (studio-web#1077).
//!
//! Rollups, the organization's overview and a project's status are all
//! built from [`Sources`]. When each project asked each source for itself,
//! a workspace of 19 projects asked the domain model 19 times per type, and
//! each of those reads went through every row of the type in the
//! organization. These fakes count what is asked, so a return to reading
//! per project fails here.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use account_management_sdk::{
    AccountManagementClient, CreateTenantRequest, IdpNewUser, IdpServiceAccountCredentials,
    IdpServiceAccountSummary, IdpUser, IdpUserPatch, ListUsersQuery, MetadataEntry, Tenant,
    TenantId, TenantStatus, UpdateTenantRequest, UpsertMetadataRequest,
};
use async_trait::async_trait;
use gts::GtsTypeId;
use time::OffsetDateTime;
use toolkit_canonical_errors::CanonicalError;
use toolkit_odata::{ODataQuery, Page, PageInfo};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::{
    ORGANIZATION_TENANT_TYPE, PROJECT_TENANT_TYPE, Rollup, Sources, WORKSPACE_TENANT_TYPE,
};
use crate::artifact_ingest::port::{ArtifactCounter, ProjectSignalSource, ProjectSignals};
use crate::documents::port::{DocumentCounter, ProjectDocumentCounts, SpecSummary};

const ORG: Uuid = Uuid::from_u128(0x0a);
const WS_1: Uuid = Uuid::from_u128(0x1a);
const WS_2: Uuid = Uuid::from_u128(0x2a);

/// Five projects in the first workspace, three in the second.
fn projects_of(ws: Uuid) -> Vec<Uuid> {
    match ws {
        WS_1 => (1..=5).map(|n| Uuid::from_u128(0x100 + n)).collect(),
        WS_2 => (1..=3).map(|n| Uuid::from_u128(0x200 + n)).collect(),
        _ => Vec::new(),
    }
}

fn tenant(id: Uuid, parent: Option<Uuid>, tenant_type: &str) -> Tenant {
    let now = OffsetDateTime::now_utc();
    Tenant {
        id: TenantId(id),
        name: format!("t-{id}"),
        status: TenantStatus::Active,
        tenant_type: Some(tenant_type.to_owned()),
        parent_id: parent.map(TenantId),
        self_managed: false,
        depth: 1,
        child_count: 0,
        created_at: now,
        updated_at: now,
        deleted_at: None,
    }
}

/// The organization's tree; no tenant carries metadata.
struct Tree;

#[async_trait]
impl AccountManagementClient for Tree {
    async fn create_tenant(
        &self,
        _: &SecurityContext,
        _: CreateTenantRequest,
    ) -> Result<Tenant, CanonicalError> {
        unimplemented!()
    }
    async fn get_tenant(&self, _: &SecurityContext, id: Uuid) -> Result<Tenant, CanonicalError> {
        Ok(match id {
            ORG => tenant(ORG, None, ORGANIZATION_TENANT_TYPE),
            WS_1 | WS_2 => tenant(id, Some(ORG), WORKSPACE_TENANT_TYPE),
            _ => {
                let ws = [WS_1, WS_2]
                    .into_iter()
                    .find(|ws| projects_of(*ws).contains(&id))
                    .ok_or_else(|| CanonicalError::internal("no such tenant").create())?;
                tenant(id, Some(ws), PROJECT_TENANT_TYPE)
            }
        })
    }
    async fn list_children(
        &self,
        _: &SecurityContext,
        parent: Uuid,
        _: &ODataQuery,
    ) -> Result<Page<Tenant>, CanonicalError> {
        let items = match parent {
            ORG => vec![
                tenant(WS_1, Some(ORG), WORKSPACE_TENANT_TYPE),
                tenant(WS_2, Some(ORG), WORKSPACE_TENANT_TYPE),
            ],
            ws => projects_of(ws)
                .into_iter()
                .map(|p| tenant(p, Some(ws), PROJECT_TENANT_TYPE))
                .collect(),
        };
        Ok(Page::new(
            items,
            PageInfo {
                next_cursor: None,
                prev_cursor: None,
                limit: 200,
            },
        ))
    }
    async fn update_tenant(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: UpdateTenantRequest,
    ) -> Result<Tenant, CanonicalError> {
        unimplemented!()
    }
    async fn suspend_tenant(&self, _: &SecurityContext, _: Uuid) -> Result<Tenant, CanonicalError> {
        unimplemented!()
    }
    async fn unsuspend_tenant(
        &self,
        _: &SecurityContext,
        _: Uuid,
    ) -> Result<Tenant, CanonicalError> {
        unimplemented!()
    }
    async fn delete_tenant(&self, _: &SecurityContext, _: Uuid) -> Result<Tenant, CanonicalError> {
        unimplemented!()
    }
    async fn create_user(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: IdpNewUser,
    ) -> Result<IdpUser, CanonicalError> {
        unimplemented!()
    }
    async fn get_user(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: Uuid,
    ) -> Result<IdpUser, CanonicalError> {
        unimplemented!()
    }
    async fn list_users(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: ListUsersQuery,
    ) -> Result<Page<IdpUser>, CanonicalError> {
        unimplemented!()
    }
    async fn delete_user(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: Uuid,
    ) -> Result<(), CanonicalError> {
        unimplemented!()
    }
    async fn update_user(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: Uuid,
        _: IdpUserPatch,
    ) -> Result<IdpUser, CanonicalError> {
        unimplemented!()
    }
    async fn create_service_account(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: String,
        _: Vec<String>,
    ) -> Result<IdpServiceAccountCredentials, CanonicalError> {
        unimplemented!()
    }
    async fn list_service_accounts(
        &self,
        _: &SecurityContext,
        _: Uuid,
    ) -> Result<Vec<IdpServiceAccountSummary>, CanonicalError> {
        unimplemented!()
    }
    async fn rotate_service_account_secret(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: &str,
    ) -> Result<IdpServiceAccountCredentials, CanonicalError> {
        unimplemented!()
    }
    async fn revoke_service_account(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: &str,
    ) -> Result<(), CanonicalError> {
        unimplemented!()
    }
    async fn get_metadata(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: GtsTypeId,
    ) -> Result<MetadataEntry, CanonicalError> {
        Err(CanonicalError::internal("no metadata here").create())
    }
    async fn resolve_metadata(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: GtsTypeId,
    ) -> Result<Option<MetadataEntry>, CanonicalError> {
        Ok(None)
    }
    async fn list_metadata(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: &ODataQuery,
    ) -> Result<Page<MetadataEntry>, CanonicalError> {
        unimplemented!()
    }
    async fn upsert_metadata(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: UpsertMetadataRequest,
    ) -> Result<MetadataEntry, CanonicalError> {
        unimplemented!()
    }
    async fn delete_metadata(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: GtsTypeId,
    ) -> Result<(), CanonicalError> {
        unimplemented!()
    }
}

/// Every source at once, counting what it is asked. A project's numbers are
/// derived from its id, so a row can be checked against its own project.
#[derive(Default)]
struct Counted {
    /// Calls that read one project.
    per_project: AtomicUsize,
    /// Calls that read many projects at once, and how many they named.
    batches: AtomicUsize,
    named: AtomicUsize,
}

fn findings_of(project: &str) -> u32 {
    u32::from(project.as_bytes()[project.len() - 1] - b'0')
}

#[async_trait]
impl DocumentCounter for Counted {
    async fn count_bindings(&self, _: &SecurityContext, _: Uuid, _: Uuid) -> anyhow::Result<u32> {
        self.per_project.fetch_add(1, Ordering::SeqCst);
        Ok(0)
    }
    async fn spec_summary(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: Uuid,
    ) -> anyhow::Result<SpecSummary> {
        self.per_project.fetch_add(1, Ordering::SeqCst);
        Ok(SpecSummary::default())
    }
    async fn project_documents(
        &self,
        _: &SecurityContext,
        _: Uuid,
        projects: &[Uuid],
    ) -> HashMap<Uuid, ProjectDocumentCounts> {
        self.batches.fetch_add(1, Ordering::SeqCst);
        self.named.fetch_add(projects.len(), Ordering::SeqCst);
        projects
            .iter()
            .map(|p| {
                (
                    *p,
                    ProjectDocumentCounts {
                        bindings: Some(findings_of(&p.to_string()) * 10),
                        specs: Some(SpecSummary {
                            specs: 1,
                            ..SpecSummary::default()
                        }),
                    },
                )
            })
            .collect()
    }
}

#[async_trait]
impl ArtifactCounter for Counted {
    async fn count_nodes(&self, _: &SecurityContext, _: &str, _: &str) -> anyhow::Result<u32> {
        self.per_project.fetch_add(1, Ordering::SeqCst);
        Ok(0)
    }
    async fn count_nodes_in_projects(
        &self,
        _: &SecurityContext,
        _: &str,
        projects: &[String],
    ) -> HashMap<String, u32> {
        self.batches.fetch_add(1, Ordering::SeqCst);
        self.named.fetch_add(projects.len(), Ordering::SeqCst);
        // The last project's count is unknown: it stays unknown in its row.
        projects
            .iter()
            .filter(|p| !p.ends_with('5'))
            .map(|p| (p.clone(), findings_of(p)))
            .collect()
    }
}

#[async_trait]
impl ProjectSignalSource for Counted {
    async fn project_signals(
        &self,
        _: &SecurityContext,
        _: &str,
        _: usize,
    ) -> anyhow::Result<ProjectSignals> {
        self.per_project.fetch_add(1, Ordering::SeqCst);
        anyhow::bail!("not per project")
    }
    async fn project_signals_in(
        &self,
        _: &SecurityContext,
        projects: &[String],
        _: usize,
    ) -> HashMap<String, ProjectSignals> {
        self.batches.fetch_add(1, Ordering::SeqCst);
        self.named.fetch_add(projects.len(), Ordering::SeqCst);
        HashMap::new()
    }
}

fn ctx() -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(1))
        .subject_tenant_id(ORG)
        .build()
        .unwrap()
}

fn sources(counted: &Arc<Counted>) -> Sources {
    Sources {
        am: Arc::new(Tree),
        documents: Some(counted.clone()),
        artifacts: Some(counted.clone()),
        signals: Some(counted.clone()),
        roster: None,
    }
}

fn projects(rows: &[Rollup]) -> Vec<&Rollup> {
    rows.iter().filter(|r| r.parent_id.is_some()).collect()
}

#[tokio::test]
async fn an_organization_is_counted_once_per_workspace_not_once_per_project() {
    let counted = Arc::new(Counted::default());
    let rows = sources(&counted).organization_with(&ctx(), ORG, None).await;

    assert_eq!(projects(&rows).len(), 8);
    assert_eq!(
        counted.per_project.load(Ordering::SeqCst),
        0,
        "no source is asked about one project at a time"
    );
    assert_eq!(
        counted.batches.load(Ordering::SeqCst),
        2 * 3,
        "three sources, asked once for each of the two workspaces"
    );
    assert_eq!(
        counted.named.load(Ordering::SeqCst),
        3 * 8,
        "and each project is named once to each of them"
    );
}

#[tokio::test]
async fn every_row_carries_its_own_projects_numbers() {
    let counted = Arc::new(Counted::default());
    let rows = sources(&counted).portfolio(&ctx()).await;
    for row in projects(&rows) {
        let id = row.id.to_string();
        assert_eq!(row.documents, Some(findings_of(&id) * 10), "{id}");
        assert_eq!(row.specs.map(|s| s.specs), Some(1), "{id}");
        if id.ends_with('5') {
            assert_eq!(row.findings, None, "unknown stays unknown, never 0");
        } else {
            assert_eq!(row.findings, Some(findings_of(&id)), "{id}");
        }
        assert!(row.signals.is_none(), "a source that could not say");
    }
}

#[tokio::test]
async fn one_project_is_counted_by_the_same_reads() {
    let counted = Arc::new(Counted::default());
    let project = projects_of(WS_2)[0];
    let row = sources(&counted)
        .one_project(&ctx(), project)
        .await
        .expect("the project");
    assert_eq!(row.id, project);
    assert_eq!(row.parent_id, Some(WS_2));
    assert_eq!(row.findings, Some(findings_of(&project.to_string())));
    assert_eq!(counted.per_project.load(Ordering::SeqCst), 0);
    assert_eq!(counted.batches.load(Ordering::SeqCst), 3);
    assert_eq!(counted.named.load(Ordering::SeqCst), 3, "only this project");
}
