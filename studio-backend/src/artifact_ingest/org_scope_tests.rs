//! A project's artifacts live in its organization's model, whoever syncs or
//! reads them.
//!
//! On the stand (2026-11-24) a platform administrator's sync of Studioweb
//! wrote its objects into the platform root, the administrator's home; the
//! start-up sweep (`studio-domain-model rehome`) moved 19 439 of them into
//! the organization and marked the root's copies deleted, and every read in
//! the root then found deleted copies or nothing. Here the same caller syncs
//! an organization's project: every write lands in the organization, none in
//! the root, the reads find it (as the administrator and as a member), the
//! run is filed under the organization, and a caller who does not reach the
//! project gets nothing of it.
//!
//! The artifact index is the real one, on Postgres ([`crate::test_pg`]): it
//! keys its rows by the context's tenant, so the rows a sync leaves say
//! where it wrote. The graph behind it is kept per tenant in memory.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use account_management_sdk::{
    AccountManagementClient, CreateTenantRequest, IdpNewUser, IdpServiceAccountCredentials,
    IdpServiceAccountSummary, IdpUser, IdpUserPatch, ListUsersQuery, MetadataEntry, Tenant,
    TenantId, TenantStatus, UpdateTenantRequest, UpsertMetadataRequest,
};
use async_trait::async_trait;
use credstore_sdk::{
    CredStoreClientV1, CredStoreError, GetSecretResponse, SecretRef, SecretValue, SharingMode,
    WriteOptions, WritePrecondition,
};
use ::gts::GtsTypeId;
use sea_orm::EntityTrait;
use time::OffsetDateTime;
use toolkit_canonical_errors::CanonicalError;
use toolkit_db::migration_runner::run_migrations_for_testing;
use toolkit_db::sea_orm_migration::MigratorTrait;
use toolkit_db::secure::SecureEntityExt;
use toolkit_db::{ConnectOpts, DBProvider, Db, connect_db};
use toolkit_odata::{ODataQuery, Page, PageInfo};
use toolkit_security::{AccessScope, SecurityContext};
use uuid::Uuid;

use super::IngestService;
use crate::artifact_ingest::entity::node;
use crate::artifact_ingest::graph::{
    GraphStore, GtsEdge, GtsEdgeView, GtsNode, InMemoryGraphStore,
};
use crate::artifact_ingest::gts;
use crate::artifact_ingest::index::{ArtifactIndex, IndexedGraphStore};
use crate::artifact_ingest::migrations::Migrator;
use crate::connectors::sdk::{
    ConnectionAuth, ConnectorCategory, ConnectorDriver, DriverIdentity, RemoteFile,
    RemoteFileList, RemoteIssue, RemotePullRequest,
};
use crate::org_scope::ScopeOrgs;
use crate::organizations::sdk::ORGANIZATION_TENANT_TYPE;
use crate::tasks::sdk::SyncReporter;

const ROOT: Uuid = Uuid::from_u128(1);
const ORG: Uuid = Uuid::from_u128(0x0a);
const WS: Uuid = Uuid::from_u128(0x1a);
const PROJECT: Uuid = Uuid::from_u128(0x101);
/// Another organization, whose members reach none of the above.
const OTHER_ORG: Uuid = Uuid::from_u128(0x0b);

fn caller(home: Uuid, subject: u128) -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(subject))
        .subject_type("user")
        .subject_tenant_id(home)
        .token_scopes(vec!["studio".into()])
        .build()
        .expect("security context")
}

/// The stand's `admin`: home is the platform root.
fn admin() -> SecurityContext {
    caller(ROOT, 0xad)
}

fn member() -> SecurityContext {
    caller(ORG, 0x3e)
}

fn stranger() -> SecurityContext {
    caller(OTHER_ORG, 0x57)
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

/// root → organization → workspace → project; another organization beside
/// it. A caller reads a tenant at or below its home, as account-management
/// answers.
struct Tree;

impl Tree {
    fn parent(id: Uuid) -> Option<Uuid> {
        match id {
            ORG | OTHER_ORG => Some(ROOT),
            WS => Some(ORG),
            PROJECT => Some(WS),
            _ => None,
        }
    }

    fn under(home: Uuid, id: Uuid) -> bool {
        let mut at = Some(id);
        while let Some(t) = at {
            if t == home {
                return true;
            }
            at = Self::parent(t);
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
        if !Self::under(ctx.subject_tenant_id(), id) {
            return Err(CanonicalError::internal("no such tenant").create());
        }
        Ok(match id {
            ROOT => tenant(ROOT, None, "platform"),
            ORG | OTHER_ORG => tenant(id, Some(ROOT), ORGANIZATION_TENANT_TYPE),
            WS => tenant(WS, Some(ORG), "workspace"),
            PROJECT => tenant(PROJECT, Some(WS), "project"),
            _ => return Err(CanonicalError::internal("no such tenant").create()),
        })
    }
    async fn list_children(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: &ODataQuery,
    ) -> Result<Page<Tenant>, CanonicalError> {
        Ok(Page::new(
            Vec::new(),
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

/// The graph, one store per tenant (as graph-storage scopes it), with every
/// tenant a write went to.
#[derive(Default)]
struct ByTenant {
    stores: Mutex<HashMap<Uuid, Arc<InMemoryGraphStore>>>,
    written_in: Mutex<Vec<Uuid>>,
}

impl ByTenant {
    fn of(&self, ctx: &SecurityContext) -> Arc<InMemoryGraphStore> {
        self.stores
            .lock()
            .unwrap()
            .entry(ctx.subject_tenant_id())
            .or_default()
            .clone()
    }

    fn wrote(&self, ctx: &SecurityContext) -> Arc<InMemoryGraphStore> {
        self.written_in.lock().unwrap().push(ctx.subject_tenant_id());
        self.of(ctx)
    }

    fn tenants_written(&self) -> Vec<Uuid> {
        let mut t = self.written_in.lock().unwrap().clone();
        t.sort();
        t.dedup();
        t
    }
}

#[async_trait]
impl GraphStore for ByTenant {
    async fn upsert_nodes(&self, ctx: &SecurityContext, nodes: &[GtsNode]) -> anyhow::Result<()> {
        self.wrote(ctx).upsert_nodes(ctx, nodes).await
    }
    async fn upsert_edges(&self, ctx: &SecurityContext, edges: &[GtsEdge]) -> anyhow::Result<()> {
        self.wrote(ctx).upsert_edges(ctx, edges).await
    }
    async fn delete_nodes(
        &self,
        ctx: &SecurityContext,
        nodes: &[GtsNode],
    ) -> anyhow::Result<usize> {
        self.wrote(ctx).delete_nodes(ctx, nodes).await
    }
    async fn list(
        &self,
        ctx: &SecurityContext,
        type_filter: Option<&str>,
    ) -> anyhow::Result<Arc<Vec<GtsNode>>> {
        self.of(ctx).list(ctx, type_filter).await
    }
    async fn list_relations(&self, ctx: &SecurityContext) -> anyhow::Result<Vec<GtsEdgeView>> {
        self.of(ctx).list_relations(ctx).await
    }
}

/// A provider with one issue and one file.
struct OneIssue;

#[async_trait]
impl ConnectorDriver for OneIssue {
    fn provider(&self) -> &'static str {
        "fake"
    }
    fn display_name(&self) -> &'static str {
        "Fake"
    }
    fn default_base_url(&self) -> &'static str {
        "https://fake.example.com"
    }
    fn category(&self) -> ConnectorCategory {
        ConnectorCategory::SourceCode
    }
    async fn test(&self, _: &ConnectionAuth) -> anyhow::Result<DriverIdentity> {
        anyhow::bail!("not asked")
    }
    async fn list_issues(
        &self,
        _: &ConnectionAuth,
        _: &str,
        _: Option<&str>,
        page: u32,
        _: u32,
    ) -> anyhow::Result<Vec<RemoteIssue>> {
        if page > 1 {
            return Ok(Vec::new());
        }
        Ok(vec![RemoteIssue {
            id: "i-1".into(),
            number: 1,
            title: "Build records vanish".into(),
            state: "open".into(),
            author: Some("andrej".into()),
            body: None,
            url: None,
            created_at: Some("2026-11-24T09:00:00Z".into()),
            updated_at: Some("2026-11-24T09:00:00Z".into()),
            labels: Vec::new(),
            parent: None,
            iteration: None,
        }])
    }
    async fn list_pull_requests(
        &self,
        _: &ConnectionAuth,
        _: &str,
        _: Option<&str>,
        _: u32,
        _: u32,
    ) -> anyhow::Result<Vec<RemotePullRequest>> {
        Ok(Vec::new())
    }
    async fn list_files(
        &self,
        _: &ConnectionAuth,
        _: &str,
        _: Option<&str>,
    ) -> anyhow::Result<RemoteFileList> {
        Ok(RemoteFileList {
            files: vec![RemoteFile {
                path: "README.md".into(),
                sha: "abc".into(),
                is_dir: false,
                size: Some(10),
            }],
            truncated: false,
        })
    }
}

/// A database of the test's own, migrated: every test here uses the same
/// tenants, and the index keys its rows (and its fill) by tenant alone.
async fn db(name: &str) -> Db {
    let dsn = crate::test_pg::fresh_database(name).await;
    let conn = connect_db(&dsn, ConnectOpts::default())
        .await
        .unwrap_or_else(|e| panic!("connect to {dsn} failed: {e}"));
    run_migrations_for_testing(&conn, Migrator::migrations())
        .await
        .expect("run migrations");
    DBProvider::<anyhow::Error>::new(conn).db()
}

/// The index rows of `tenant`: where the writes went, as Postgres keeps them.
async fn rows_in(db: &Db, tenant: Uuid) -> Vec<node::Model> {
    let conn = db.conn().expect("conn");
    node::Entity::find()
        .secure()
        .scope_with(&AccessScope::for_tenant(tenant))
        .all(&conn)
        .await
        .expect("index rows")
}

/// The index rows of `tenant` once one of them is the project's issue. A
/// read during the sync starts a fill of the tenant in the background, which
/// clears its rows and writes them again: give it a moment.
async fn issue_row_in(db: &Db, tenant: Uuid) -> bool {
    for _ in 0..50 {
        let rows = rows_in(db, tenant).await;
        if rows
            .iter()
            .any(|r| r.type_id == gts::ISSUE_TYPE && r.project_id == PROJECT.to_string())
        {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    false
}

async fn service(db: &Db) -> (IngestService, Arc<ByTenant>) {
    let graph = Arc::new(ByTenant::default());
    let index = Arc::new(ArtifactIndex::new(db.clone()));
    let mut drivers: HashMap<String, Arc<dyn ConnectorDriver>> = HashMap::new();
    drivers.insert("fake".into(), Arc::new(OneIssue));
    let svc = IngestService::new(
        Arc::new(NoSecrets),
        drivers,
        Arc::new(IndexedGraphStore::new(graph.clone(), index)),
        None,
        None,
        None,
    )
    .with_orgs(Some(Arc::new(ScopeOrgs::new(Arc::new(Tree)))));
    (svc, graph)
}

async fn sync_as(svc: &IngestService, ctx: &SecurityContext) -> anyhow::Result<()> {
    svc.run_sync(
        ctx,
        "fake",
        None,
        "conn",
        "acme/app",
        None,
        "",
        None,
        Some(WS.to_string().as_str()),
        Some(PROJECT.to_string().as_str()),
        None,
        &SyncReporter::detached(),
    )
    .await
    .map(|_| ())
}

#[tokio::test]
async fn a_platform_administrators_sync_of_an_organizations_project_lands_in_the_organization() {
    let db = db("artifact_org_admin_sync").await;
    let (svc, graph) = service(&db).await;

    sync_as(&svc, &admin()).await.expect("the sync runs");

    assert_eq!(
        graph.tenants_written(),
        vec![ORG],
        "every write in the organization, none in the root"
    );
    assert!(
        issue_row_in(&db, ORG).await,
        "the issue's index row is the organization's"
    );
    assert!(
        rows_in(&db, ROOT).await.is_empty(),
        "nothing in the root's index"
    );

    // Read back: by the administrator who synced, and by a member.
    let project = PROJECT.to_string();
    for (who, ctx) in [("the administrator", admin()), ("a member", member())] {
        let issues = svc
            .list_in_scope(&ctx, Some("issue"), &project)
            .await
            .expect("list");
        assert_eq!(issues.len(), 1, "{who} finds the issue");
        let page = svc
            .page_nodes(
                &ctx,
                &crate::artifact_ingest::graph::NodePageQuery {
                    type_filter: Some("issue"),
                    scope: Some(project.as_str()),
                    repo: None,
                    subject: None,
                    needle: None,
                    by_updated: false,
                    start: crate::artifact_ingest::graph::PageStart::Offset(0),
                    limit: 50,
                },
            )
            .await
            .expect("page");
        assert_eq!(page.total, 1, "{who} pages the issue");
    }
}

#[tokio::test]
async fn a_caller_who_does_not_reach_the_project_neither_syncs_nor_reads_it() {
    let db = db("artifact_org_stranger").await;
    let (svc, graph) = service(&db).await;
    sync_as(&svc, &admin()).await.expect("the sync runs");

    assert!(
        sync_as(&svc, &stranger()).await.is_err(),
        "a sync for a project the caller does not reach is refused"
    );
    assert_eq!(graph.tenants_written(), vec![ORG], "and wrote nowhere");
    let read = svc
        .list_in_scope(&stranger(), Some("issue"), &PROJECT.to_string())
        .await
        .expect("list");
    assert!(read.is_empty(), "nor reads the organization's issue");
}

#[tokio::test]
async fn a_run_for_an_organizations_project_is_filed_under_the_organization() {
    let db = db("artifact_org_run_tenant").await;
    let (svc, _) = service(&db).await;
    let project = PROJECT.to_string();
    let workspace = WS.to_string();

    assert_eq!(svc.run_tenant(&admin(), Some(project.as_str())).await.unwrap(), ORG);
    assert_eq!(svc.run_tenant(&admin(), Some(workspace.as_str())).await.unwrap(), ORG);
    assert_eq!(svc.run_tenant(&member(), Some(project.as_str())).await.unwrap(), ORG);
    // Unscoped: the caller's own tenant, as before.
    assert_eq!(svc.run_tenant(&admin(), None).await.unwrap(), ROOT);
    assert!(svc.run_tenant(&stranger(), Some(project.as_str())).await.is_err());

    // The caller stays who they are: only the tenant changes.
    let there = svc.org_ctx(&admin(), Some(project.as_str())).await.unwrap();
    assert_eq!(there.subject_tenant_id(), ORG);
    assert_eq!(there.subject_id(), admin().subject_id());
}

/// A run queued in the root before runs were filed under the organization
/// (or a schedule firing in the platform tenant) runs as the worker in the
/// root: the sync still writes where the project lives.
#[tokio::test]
async fn a_run_left_in_the_root_still_writes_in_the_organization() {
    let db = db("artifact_org_root_run").await;
    let (svc, graph) = service(&db).await;
    let worker = SecurityContext::builder()
        .subject_id(Uuid::from_u128(0x7a5c))
        .subject_type("service")
        .subject_tenant_id(ROOT)
        .token_scopes(vec!["*".to_owned()])
        .build()
        .unwrap();

    sync_as(&svc, &worker).await.expect("the sync runs");
    assert_eq!(graph.tenants_written(), vec![ORG]);
}

/// Pruning a detached source forgets it where the sync wrote it.
#[tokio::test]
async fn detaching_as_the_administrator_forgets_in_the_organization() {
    let db = db("artifact_org_detach").await;
    let (svc, graph) = service(&db).await;
    sync_as(&svc, &admin()).await.expect("the sync runs");

    let pruned = svc
        .prune_repository(&admin(), &PROJECT.to_string(), "acme/app")
        .await
        .expect("prune");
    assert_eq!(pruned.repos, 1, "the repository is found where it was synced");
    assert_eq!(graph.tenants_written(), vec![ORG]);
    let left = svc
        .list_in_scope(&member(), Some("issue"), &PROJECT.to_string())
        .await
        .expect("list");
    assert!(left.is_empty(), "its issue is forgotten in the organization");
}
