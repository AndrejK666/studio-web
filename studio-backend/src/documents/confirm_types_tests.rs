//! The Specs list's bulk *Confirm*: `POST /studio-documents/v1/document-bindings/confirm`.
//!
//! What it must hold to: only a proposal (`detected` with a type) is
//! confirmed; a settled type, a binding with no proposal, another project's
//! binding and an unknown id are skipped with their reason and never fail the
//! call; and a caller who is not a member of the workspace is refused before
//! anything is read or written.
//!
//! Real PostgreSQL through [`super::repo_tests::repo`], for the reason that
//! module gives. Account management is a fake tenant tree: a caller reads a
//! tenant at or below its home tenant, as account-management answers.
#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::collections::HashMap;
use std::sync::Arc;

use account_management_sdk::{
    AccountManagementClient, CreateTenantRequest, IdpNewUser, IdpServiceAccountCredentials,
    IdpServiceAccountSummary, IdpUser, IdpUserPatch, ListUsersQuery, MetadataEntry, Tenant,
    TenantId, TenantStatus, UpdateTenantRequest, UpsertMetadataRequest,
};
use async_trait::async_trait;
use axum::Extension;
use gts::GtsTypeId;
use time::OffsetDateTime;
use toolkit::api::canonical_prelude::Json;
use toolkit_canonical_errors::CanonicalError;
use toolkit_odata::{ODataQuery, Page};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::model::BindingState;
use super::repo::DocumentsRepo;
use super::repo_tests::binding;
use super::rest::{ConfirmTypesDto, confirm_types};
use super::service::{ConfirmSkip, DocumentsService};

// ── fakes ────────────────────────────────────────────────────────────────

/// organization → workspace → { project, another project }, and a second
/// workspace beside the first. Fresh ids per test: the database is shared.
struct Tree {
    parents: HashMap<Uuid, Uuid>,
}

impl Tree {
    fn under(&self, home: Uuid, id: Uuid) -> bool {
        let mut at = Some(id);
        while let Some(t) = at {
            if t == home {
                return true;
            }
            at = self.parents.get(&t).copied();
        }
        false
    }
}

#[async_trait]
impl AccountManagementClient for Tree {
    async fn create_tenant(
        &self,
        _: &SecurityContext,
        _: CreateTenantRequest,
    ) -> Result<Tenant, CanonicalError> {
        unimplemented!()
    }
    async fn get_tenant(&self, ctx: &SecurityContext, id: Uuid) -> Result<Tenant, CanonicalError> {
        if !self.under(ctx.subject_tenant_id(), id) {
            return Err(CanonicalError::internal("no such tenant").create());
        }
        let now = OffsetDateTime::now_utc();
        Ok(Tenant {
            id: TenantId(id),
            name: "tenant".to_owned(),
            status: TenantStatus::Active,
            tenant_type: None,
            parent_id: self.parents.get(&id).copied().map(TenantId),
            self_managed: false,
            depth: 1,
            child_count: 0,
            created_at: now,
            updated_at: now,
            deleted_at: None,
        })
    }
    async fn list_children(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: &ODataQuery,
    ) -> Result<Page<Tenant>, CanonicalError> {
        unimplemented!()
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
        unimplemented!()
    }
    async fn resolve_metadata(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: GtsTypeId,
    ) -> Result<Option<MetadataEntry>, CanonicalError> {
        unimplemented!()
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

// ── rig ──────────────────────────────────────────────────────────────────

struct Rig {
    service: Arc<DocumentsService>,
    repo: Arc<DocumentsRepo>,
    workspace: Uuid,
    project: Uuid,
    other_project: Uuid,
    other_workspace: Uuid,
}

impl Rig {
    async fn new() -> Self {
        let org = Uuid::new_v4();
        let workspace = Uuid::new_v4();
        let project = Uuid::new_v4();
        let other_project = Uuid::new_v4();
        let other_workspace = Uuid::new_v4();
        let parents = HashMap::from([
            (workspace, org),
            (other_workspace, org),
            (project, workspace),
            (other_project, workspace),
        ]);
        let repo = Arc::new(super::repo_tests::repo().await);
        let service = Arc::new(DocumentsService::new(
            Arc::clone(&repo),
            Arc::new(Tree { parents }),
        ));
        Self {
            service,
            repo,
            workspace,
            project,
            other_project,
            other_workspace,
        }
    }

    /// A caller whose home is `tenant`: it reads that tenant and below.
    fn ctx(&self, tenant: Uuid) -> SecurityContext {
        SecurityContext::builder()
            .subject_id(Uuid::new_v4())
            .subject_type("user")
            .subject_tenant_id(tenant)
            .build()
            .expect("security context")
    }

    /// A binding in `project` (`None`: the workspace's) at `path`, in `state`.
    async fn bind(
        &self,
        project: Option<Uuid>,
        path: &str,
        type_key: Option<&str>,
        state: &str,
    ) -> Uuid {
        let row = binding(
            self.workspace,
            project,
            &format!("node:{path}"),
            path,
            type_key,
            state,
        );
        let id = row.id;
        self.repo.upsert_binding(row).await.expect("seed binding");
        id
    }

    async fn state(&self, id: Uuid) -> String {
        self.repo
            .get_binding(self.workspace, id)
            .await
            .unwrap()
            .expect("binding")
            .state
    }
}

// ── tests ────────────────────────────────────────────────────────────────

/// Proposals are confirmed -- the project's own and the workspace's it
/// inherits; everything else is skipped with its reason, and left as it was.
#[tokio::test]
async fn only_proposed_types_are_confirmed_and_the_rest_are_skipped_with_a_reason() {
    let rig = Rig::new().await;
    let own = rig
        .bind(Some(rig.project), "docs/prd.md", Some("prd"), "detected")
        .await;
    let inherited = rig
        .bind(None, "docs/design.md", Some("design"), "detected")
        .await;
    let settled = rig
        .bind(Some(rig.project), "docs/adr.md", Some("adr"), "manual")
        .await;
    let confirmed = rig
        .bind(Some(rig.project), "docs/old.md", Some("prd"), "confirmed")
        .await;
    let untyped = rig
        .bind(Some(rig.project), "docs/notes.md", None, "unknown")
        .await;
    let rejected = rig
        .bind(Some(rig.project), "docs/todo.md", None, "not_a_document")
        .await;
    let elsewhere = rig
        .bind(
            Some(rig.other_project),
            "docs/x.md",
            Some("prd"),
            "detected",
        )
        .await;
    let missing = Uuid::new_v4();

    let ctx = rig.ctx(rig.workspace);
    let outcome = rig
        .service
        .confirm_proposed_types(
            &ctx,
            rig.workspace,
            rig.project,
            &[
                own, inherited, settled, confirmed, untyped, rejected, elsewhere, missing,
                // A repeat is confirmed once and reported once.
                own,
            ],
        )
        .await
        .expect("confirm");

    let ids: Vec<Uuid> = outcome.confirmed.iter().map(|b| b.id).collect();
    assert_eq!(ids, [own, inherited]);
    assert!(
        outcome
            .confirmed
            .iter()
            .all(|b| b.state == BindingState::Confirmed)
    );
    assert_eq!(
        outcome.skipped,
        [
            (settled, ConfirmSkip::NotProposed),
            (confirmed, ConfirmSkip::NotProposed),
            (untyped, ConfirmSkip::NotProposed),
            (rejected, ConfirmSkip::NotProposed),
            (elsewhere, ConfirmSkip::OtherProject),
            (missing, ConfirmSkip::NotFound),
        ]
    );

    assert_eq!(rig.state(own).await, "confirmed");
    assert_eq!(rig.state(inherited).await, "confirmed");
    assert_eq!(rig.state(settled).await, "manual");
    assert_eq!(rig.state(untyped).await, "unknown");
    assert_eq!(rig.state(rejected).await, "not_a_document");
    assert_eq!(
        rig.state(elsewhere).await,
        "detected",
        "another project's proposal waits"
    );
}

/// Nothing to confirm is an empty answer, not a failure.
#[tokio::test]
async fn nothing_proposed_writes_nothing() {
    let rig = Rig::new().await;
    let settled = rig
        .bind(Some(rig.project), "docs/adr.md", Some("adr"), "confirmed")
        .await;
    let ctx = rig.ctx(rig.workspace);
    let outcome = rig
        .service
        .confirm_proposed_types(&ctx, rig.workspace, rig.project, &[settled])
        .await
        .expect("confirm");
    assert!(outcome.confirmed.is_empty());
    assert_eq!(outcome.skipped, [(settled, ConfirmSkip::NotProposed)]);
}

/// The route answers per binding, through the same DTOs the portal reads.
#[tokio::test]
async fn the_route_confirms_for_a_member_and_names_what_it_skipped() {
    let rig = Rig::new().await;
    let proposed = rig
        .bind(Some(rig.project), "docs/prd.md", Some("prd"), "detected")
        .await;
    let settled = rig
        .bind(Some(rig.project), "docs/adr.md", Some("adr"), "manual")
        .await;

    let Json(answer) = confirm_types(
        Extension(rig.ctx(rig.workspace)),
        Extension(Arc::clone(&rig.service)),
        Json(ConfirmTypesDto {
            project_id: rig.project,
            binding_ids: vec![proposed, settled],
        }),
    )
    .await
    .expect("a member confirms");

    let confirmed: Vec<Uuid> = answer.confirmed.iter().map(|b| b.id).collect();
    assert_eq!(confirmed, [proposed]);
    assert_eq!(answer.confirmed[0].state, BindingState::Confirmed);
    assert_eq!(answer.skipped.len(), 1);
    assert_eq!(answer.skipped[0].id, settled);
    assert_eq!(answer.skipped[0].reason, "not_proposed");
}

/// A caller from another workspace is refused before anything is written:
/// the workspace reads as not found, and the proposal still waits.
#[tokio::test]
async fn a_non_member_is_refused_and_nothing_is_confirmed() {
    let rig = Rig::new().await;
    let proposed = rig
        .bind(Some(rig.project), "docs/prd.md", Some("prd"), "detected")
        .await;

    let refused = confirm_types(
        Extension(rig.ctx(rig.other_workspace)),
        Extension(Arc::clone(&rig.service)),
        Json(ConfirmTypesDto {
            project_id: rig.project,
            binding_ids: vec![proposed],
        }),
    )
    .await;

    assert!(refused.is_err(), "a non-member must not confirm");
    assert_eq!(rig.state(proposed).await, "detected");
}

/// A project of the workspace is not a way into another workspace's
/// bindings: the project must be one the caller can read.
#[tokio::test]
async fn a_member_of_one_project_cannot_confirm_through_another() {
    let rig = Rig::new().await;
    let proposed = rig
        .bind(Some(rig.project), "docs/prd.md", Some("prd"), "detected")
        .await;

    // Home is the other project: the workspace above it is out of reach.
    let refused = confirm_types(
        Extension(rig.ctx(rig.other_project)),
        Extension(Arc::clone(&rig.service)),
        Json(ConfirmTypesDto {
            project_id: rig.project,
            binding_ids: vec![proposed],
        }),
    )
    .await;

    assert!(refused.is_err());
    assert_eq!(rig.state(proposed).await, "detected");
}

/// More ids than one call takes is the caller's mistake, refused whole.
#[tokio::test]
async fn too_many_ids_are_refused() {
    let rig = Rig::new().await;
    let refused = confirm_types(
        Extension(rig.ctx(rig.workspace)),
        Extension(Arc::clone(&rig.service)),
        Json(ConfirmTypesDto {
            project_id: rig.project,
            binding_ids: (0..1001).map(|_| Uuid::new_v4()).collect(),
        }),
    )
    .await;
    assert!(refused.is_err());
}
