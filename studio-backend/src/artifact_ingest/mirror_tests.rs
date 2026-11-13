//! The mirror path of a sync, on a fake mirror: what it reads, as whom, and
//! what the graph gets from it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::{DateTime, TimeZone, Utc};
use credstore_sdk::{
    CredStoreClientV1, CredStoreError, GetSecretResponse, SecretRef, SecretValue, SharingMode,
    WriteOptions, WritePrecondition,
};
use github_mirror_sdk as sdk;
use github_mirror_sdk::GithubMirrorClientV1;
use toolkit_canonical_errors::CanonicalError;
use toolkit_odata::{ODataQuery, Page};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::*;
use crate::artifact_ingest::graph::{GraphStore, InMemoryGraphStore};
use crate::artifact_ingest::gts;
use crate::artifact_ingest::service::IngestService;
use crate::connectors::sdk::{ConnectorCategory, DriverIdentity};

const ORG: Uuid = Uuid::from_u128(0x0a11_ce00_0000_4000_8000_0000_0000_0001);
const PROJECT: &str = "00000000-0000-0000-0000-00000000000b";

/// The worker's context for a run in the organization's tenant.
fn run_ctx() -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(0x7a5c))
        .subject_type("service")
        .subject_tenant_id(ORG)
        .build()
        .expect("security context")
}

/* ── Fakes ── */

/// The SDK client: records the refreshes it was asked for.
#[derive(Default)]
struct FakeClient {
    refreshed: Mutex<Vec<(Uuid, String, String)>>,
    /// Who asked: (subject, subject type).
    callers: Mutex<Vec<(Uuid, Option<String>)>>,
    fail: bool,
}

#[async_trait]
impl GithubMirrorClientV1 for FakeClient {
    async fn status(&self, _ctx: &SecurityContext) -> Result<sdk::MirrorStatus, CanonicalError> {
        Err(CanonicalError::internal("not asked in these tests").create())
    }

    async fn list_repos(
        &self,
        _ctx: &SecurityContext,
        _query: ODataQuery,
    ) -> Result<Page<sdk::Repo>, CanonicalError> {
        Err(CanonicalError::internal("not asked in these tests").create())
    }

    async fn sync_repository(
        &self,
        ctx: &SecurityContext,
        owner: &str,
        name: &str,
    ) -> Result<sdk::SyncSummary, CanonicalError> {
        self.callers
            .lock()
            .expect("callers")
            .push((ctx.subject_id(), ctx.subject_type().map(str::to_owned)));
        self.refreshed.lock().expect("refreshed").push((
            ctx.subject_tenant_id(),
            owner.to_owned(),
            name.to_owned(),
        ));
        if self.fail {
            return Err(CanonicalError::internal("GitHub refused the mirror's key").create());
        }
        Ok(sdk::SyncSummary {
            repository: format!("{owner}/{name}"),
            ..Default::default()
        })
    }
}

/// The reads: one page of each kind, and the tenants it was read as.
#[derive(Default)]
struct FakeReads {
    tenants: Mutex<Vec<Uuid>>,
    subjects: Mutex<Vec<Uuid>>,
    since: Mutex<Vec<Option<DateTime<Utc>>>>,
}

impl FakeReads {
    fn saw(&self, ctx: &SecurityContext) {
        self.tenants
            .lock()
            .expect("tenants")
            .push(ctx.subject_tenant_id());
        self.subjects
            .lock()
            .expect("subjects")
            .push(ctx.subject_id());
    }
}

fn actor(login: &str) -> sdk::Actor {
    sdk::Actor {
        login: login.to_owned(),
        id: None,
        node_id: None,
        account_type: None,
        avatar_url: None,
        html_url: None,
        site_admin: None,
    }
}

fn an_issue(number: i64, is_pull_request: bool) -> sdk::Issue {
    sdk::Issue {
        id: 1000 + number,
        node_id: None,
        repo_id: 7,
        number,
        title: format!("issue {number}"),
        body: Some("body".to_owned()),
        state: "open".to_owned(),
        is_pull_request,
        created_at: "2026-11-01T10:00:00Z".to_owned(),
        updated_at: "2026-11-02T10:00:00Z".to_owned(),
        closed_at: None,
        html_url: Some(format!("https://github.com/acme/app/issues/{number}")),
        author_login: Some("old-login".to_owned()),
        author: Some(actor("alice")),
        assignees: vec![],
        labels: vec![sdk::LabelRef {
            id: None,
            node_id: None,
            name: "bug".to_owned(),
            color: None,
            is_default: None,
            description: None,
        }],
        comments_count: None,
        locked: None,
    }
}

fn a_pull(number: i64, merged_at: Option<&str>) -> sdk::PullRequest {
    sdk::PullRequest {
        id: 2000 + number,
        node_id: None,
        repo_id: 7,
        number,
        title: format!("pull {number}"),
        body: None,
        state: "closed".to_owned(),
        draft: false,
        merged: merged_at.is_some(),
        head_sha: Some("abc".to_owned()),
        base_sha: None,
        lines_added: 1,
        lines_removed: 0,
        created_at: "2026-11-01T10:00:00Z".to_owned(),
        updated_at: "2026-11-02T10:00:00Z".to_owned(),
        closed_at: None,
        merged_at: merged_at.map(str::to_owned),
        html_url: Some(format!("https://github.com/acme/app/pull/{number}")),
        head_ref: Some("feature".to_owned()),
        base_ref: Some("main".to_owned()),
        author_login: None,
        author: Some(actor("bob")),
        assignees: vec![actor("carol")],
        labels: vec![],
        comments_count: None,
        locked: None,
        requested_reviewers: vec![actor("dave")],
    }
}

/// Only the first page has anything: the sync pages until a page is empty.
fn first_page<T>(page: u32, items: impl FnOnce() -> Vec<T>) -> Vec<T> {
    if page == 1 { items() } else { Vec::new() }
}

#[async_trait]
impl MirrorReads for FakeReads {
    async fn issues(
        &self,
        ctx: &SecurityContext,
        owner: &str,
        name: &str,
        page: u32,
        _per_page: u32,
        since: Option<DateTime<Utc>>,
    ) -> anyhow::Result<Vec<sdk::Issue>> {
        assert_eq!((owner, name), ("acme", "app"));
        self.saw(ctx);
        self.since.lock().expect("since").push(since);
        // GitHub's /issues lists pull requests as well; #2 is one.
        Ok(first_page(page, || {
            vec![an_issue(1, false), an_issue(2, true)]
        }))
    }

    async fn pull_requests(
        &self,
        ctx: &SecurityContext,
        _owner: &str,
        _name: &str,
        page: u32,
        _per_page: u32,
    ) -> anyhow::Result<Vec<sdk::PullRequest>> {
        self.saw(ctx);
        Ok(first_page(page, || {
            vec![a_pull(2, Some("2026-11-02T09:00:00Z"))]
        }))
    }

    async fn pull_request_files(
        &self,
        ctx: &SecurityContext,
        _owner: &str,
        _name: &str,
        _number: i64,
        _page: u32,
        _per_page: u32,
    ) -> anyhow::Result<Vec<sdk::PullRequestFile>> {
        self.saw(ctx);
        Ok(Vec::new())
    }

    async fn comments(
        &self,
        ctx: &SecurityContext,
        _owner: &str,
        _name: &str,
        page: u32,
        _per_page: u32,
        _since: Option<DateTime<Utc>>,
    ) -> anyhow::Result<Vec<sdk::Comment>> {
        self.saw(ctx);
        Ok(first_page(page, || {
            vec![sdk::Comment {
                id: 3001,
                repo_id: 7,
                issue_number: 1,
                author_login: Some("erin".to_owned()),
                body: Some("looks right".to_owned()),
                created_at: "2026-11-02T11:00:00Z".to_owned(),
                updated_at: "2026-11-02T11:00:00Z".to_owned(),
                html_url: None,
            }]
        }))
    }

    async fn commits(
        &self,
        ctx: &SecurityContext,
        _owner: &str,
        _name: &str,
        page: u32,
        _per_page: u32,
        _since: Option<DateTime<Utc>>,
    ) -> anyhow::Result<Vec<sdk::Commit>> {
        self.saw(ctx);
        Ok(first_page(page, || {
            vec![sdk::Commit {
                repo_id: 7,
                sha: "c0ffee".to_owned(),
                message: "fix it".to_owned(),
                author_login: Some("alice".to_owned()),
                committer_login: None,
                authored_at: Some("2026-11-01T08:00:00Z".to_owned()),
                committed_at: Some("2026-11-01T09:00:00Z".to_owned()),
                additions: 1,
                deletions: 1,
                html_url: None,
            }]
        }))
    }

    async fn workflows(
        &self,
        ctx: &SecurityContext,
        _owner: &str,
        _name: &str,
        _page: u32,
        _per_page: u32,
    ) -> anyhow::Result<Vec<sdk::Workflow>> {
        self.saw(ctx);
        Ok(Vec::new())
    }

    async fn workflow_runs(
        &self,
        ctx: &SecurityContext,
        _owner: &str,
        _name: &str,
        _workflow: Option<i64>,
        _page: u32,
        _per_page: u32,
    ) -> anyhow::Result<Vec<sdk::WorkflowRun>> {
        self.saw(ctx);
        Ok(Vec::new())
    }

    async fn artifacts(
        &self,
        ctx: &SecurityContext,
        _owner: &str,
        _name: &str,
        _page: u32,
        _per_page: u32,
    ) -> anyhow::Result<Vec<sdk::Artifact>> {
        self.saw(ctx);
        Ok(Vec::new())
    }

    async fn releases(
        &self,
        ctx: &SecurityContext,
        _owner: &str,
        _name: &str,
        _page: u32,
        _per_page: u32,
    ) -> anyhow::Result<Vec<sdk::Release>> {
        self.saw(ctx);
        Ok(Vec::new())
    }

    async fn workflow_jobs(
        &self,
        ctx: &SecurityContext,
        _owner: &str,
        _name: &str,
        _run_id: i64,
        _page: u32,
        _per_page: u32,
    ) -> anyhow::Result<Vec<sdk::WorkflowJob>> {
        self.saw(ctx);
        Ok(Vec::new())
    }
}

/// A GitHub driver that serves no metadata: every listing is the trait's
/// refusal. A mirror sync that asked it would fail at its first page.
struct NoMetadata;

#[async_trait]
impl ConnectorDriver for NoMetadata {
    fn provider(&self) -> &'static str {
        "github"
    }
    fn display_name(&self) -> &'static str {
        "GitHub"
    }
    fn default_base_url(&self) -> &'static str {
        "https://api.github.com"
    }
    fn category(&self) -> ConnectorCategory {
        ConnectorCategory::SourceCode
    }
    async fn test(&self, _: &ConnectionAuth) -> anyhow::Result<DriverIdentity> {
        Err(anyhow!("not asked"))
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

fn service(mirror: Option<Mirror>) -> (IngestService, Arc<InMemoryGraphStore>) {
    let graph = Arc::new(InMemoryGraphStore::default());
    let mut drivers: HashMap<String, Arc<dyn ConnectorDriver>> = HashMap::new();
    drivers.insert("github".into(), Arc::new(NoMetadata));
    let svc = IngestService::new(
        Arc::new(NoSecrets),
        drivers,
        graph.clone(),
        None,
        None,
        None,
    )
    .with_mirror(mirror);
    (svc, graph)
}

async fn sync(
    svc: &IngestService,
    through_mirror: bool,
    since: Option<&str>,
) -> anyhow::Result<()> {
    svc.run_sync(
        &run_ctx(),
        "github",
        None,
        "conn",
        "acme/app",
        since,
        "the-connections-key",
        through_mirror,
        None,
        Some(PROJECT),
        None,
        &SyncReporter::detached(),
    )
    .await
    .map(|_| ())
}

async fn titles(graph: &InMemoryGraphStore, type_id: &str) -> Vec<String> {
    let mut out: Vec<String> = graph
        .list(&run_ctx(), Some(type_id))
        .await
        .expect("list")
        .iter()
        .filter_map(|n| n.value["title"].as_str().map(str::to_owned))
        .collect();
    out.sort();
    out
}

/* ── The sync ── */

#[tokio::test]
async fn a_mirror_sync_refreshes_then_reads_everything_in_the_runs_tenant() {
    let client = Arc::new(FakeClient::default());
    let reads = Arc::new(FakeReads::default());
    let (svc, graph) = service(Some(Mirror {
        client: client.clone(),
        reads: reads.clone(),
    }));

    sync(&svc, true, Some("2026-11-01T00:00:00Z"))
        .await
        .expect("the mirror serves every listing; the driver serves none");

    assert_eq!(
        *client.refreshed.lock().expect("refreshed"),
        vec![(ORG, "acme".to_owned(), "app".to_owned())],
        "one refresh, through the SDK, in the run's tenant"
    );
    let tenants = reads.tenants.lock().expect("tenants").clone();
    assert!(!tenants.is_empty());
    assert!(
        tenants.iter().all(|t| *t == ORG),
        "every read in the run's tenant: {tenants:?}"
    );
    assert_eq!(
        *client.callers.lock().expect("callers"),
        vec![(
            MIRROR_SYNC_SUBJECT_ID,
            Some(SERVICE_SUBJECT_TYPE.to_owned())
        )],
        "the refresh is made as the sync's service identity, not as the task worker"
    );
    assert!(
        reads
            .subjects
            .lock()
            .expect("subjects")
            .iter()
            .all(|s| *s == MIRROR_SYNC_SUBJECT_ID),
        "every read as the sync"
    );
    assert_eq!(
        reads.since.lock().expect("since")[0],
        Some(Utc.with_ymd_and_hms(2026, 11, 1, 0, 0, 0).unwrap()),
        "the cursor reaches the mirror as an instant"
    );

    assert_eq!(
        titles(&graph, gts::ISSUE_TYPE).await,
        vec!["issue 1"],
        "the pull request /issues lists is not an issue"
    );
    assert_eq!(titles(&graph, gts::PULL_REQUEST_TYPE).await, vec!["pull 2"]);
    assert_eq!(
        graph
            .list(&run_ctx(), Some(gts::COMMENT_TYPE))
            .await
            .expect("comments")
            .len(),
        1
    );
    assert_eq!(
        graph
            .list(&run_ctx(), Some(gts::COMMIT_TYPE))
            .await
            .expect("commits")
            .len(),
        1
    );
}

#[tokio::test]
async fn a_refresh_that_fails_still_reads_what_the_mirror_holds() {
    let client = Arc::new(FakeClient {
        fail: true,
        ..Default::default()
    });
    let reads = Arc::new(FakeReads::default());
    let (svc, graph) = service(Some(Mirror {
        client: client.clone(),
        reads,
    }));

    sync(&svc, true, None)
        .await
        .expect("the reads still answer");

    assert_eq!(client.refreshed.lock().expect("refreshed").len(), 1);
    assert_eq!(titles(&graph, gts::ISSUE_TYPE).await, vec!["issue 1"]);
}

#[tokio::test]
async fn without_the_mirror_a_platform_sync_fails_and_says_why() {
    let (svc, _) = service(None);
    assert!(!svc.mirror_linked());

    let err = sync(&svc, true, None)
        .await
        .expect_err("nothing may read it");
    assert!(err.to_string().contains("GitHub Mirror gear"), "{err}");
}

#[tokio::test]
async fn a_connection_without_platform_auth_never_touches_the_mirror() {
    let client = Arc::new(FakeClient::default());
    let reads = Arc::new(FakeReads::default());
    let (svc, _) = service(Some(Mirror {
        client: client.clone(),
        reads: reads.clone(),
    }));

    let err = sync(&svc, false, None)
        .await
        .expect_err("the driver lists nothing");
    assert!(err.to_string().contains("does not expose issues"), "{err}");
    assert!(client.refreshed.lock().expect("refreshed").is_empty());
    assert!(reads.tenants.lock().expect("tenants").is_empty());
}

#[tokio::test]
async fn a_cursor_that_is_not_a_timestamp_is_refused() {
    let (svc, _) = service(Some(Mirror {
        client: Arc::new(FakeClient::default()),
        reads: Arc::new(FakeReads::default()),
    }));
    let err = sync(&svc, true, Some("yesterday"))
        .await
        .expect_err("the mirror filters by instant");
    assert!(err.to_string().contains("RFC 3339"), "{err}");
}

/* ── The mapping ── */

#[test]
fn an_owner_and_a_name_or_nothing() {
    assert_eq!(split_repo("acme/app").unwrap(), ("acme", "app"));
    assert_eq!(split_repo("/acme/app/").unwrap(), ("acme", "app"));
    for bad in ["acme", "acme/", "/app", "group/sub/app", ""] {
        assert!(split_repo(bad).is_err(), "{bad}");
    }
}

#[test]
fn an_issue_takes_its_author_object_before_the_bare_login() {
    let i = issue(an_issue(1, false)).expect("an issue");
    assert_eq!(i.id, "1001");
    assert_eq!(i.author.as_deref(), Some("alice"));
    assert_eq!(i.labels, vec!["bug"]);
    assert_eq!(i.created_at.as_deref(), Some("2026-11-01T10:00:00Z"));
    assert!(i.parent.is_none() && i.iteration.is_none());

    let mut old = an_issue(3, false);
    old.author = None;
    assert_eq!(
        issue(old).expect("an issue").author.as_deref(),
        Some("old-login")
    );
    assert!(issue(an_issue(2, true)).is_none(), "a pull request");
}

#[test]
fn a_merged_pull_request_says_merged() {
    let p = pull_request(a_pull(2, Some("2026-11-02T09:00:00Z")));
    assert_eq!(p.state, "merged");
    assert!(p.merged);
    assert_eq!(p.source_branch.as_deref(), Some("feature"));
    assert_eq!(p.target_branch.as_deref(), Some("main"));
    assert_eq!(p.requested_reviewers, vec!["dave"]);
    assert_eq!(p.assignees, vec!["carol"]);
    assert_eq!(p.draft, Some(false));
    assert_eq!(p.head_sha.as_deref(), Some("abc"));

    let open = pull_request(a_pull(3, None));
    assert_eq!(open.state, "closed");
    assert!(!open.merged);
}

#[test]
fn a_commit_without_a_link_gets_githubs_own() {
    let c = commit(
        sdk::Commit {
            repo_id: 7,
            sha: "c0ffee".to_owned(),
            message: "fix it".to_owned(),
            author_login: Some("alice".to_owned()),
            committer_login: None,
            authored_at: Some("a".to_owned()),
            committed_at: Some("b".to_owned()),
            additions: 0,
            deletions: 0,
            html_url: None,
        },
        "acme",
        "app",
    );
    assert_eq!(
        c.url.as_deref(),
        Some("https://github.com/acme/app/commit/c0ffee")
    );
    assert_eq!(c.message.as_deref(), Some("fix it"));
    assert_eq!(
        (c.created_at.as_deref(), c.committed_at.as_deref()),
        (Some("a"), Some("b"))
    );
}

#[test]
fn an_artifact_past_its_expiry_is_expired_and_its_run_brings_branch_and_commit() {
    let now = Utc.with_ymd_and_hms(2026, 11, 13, 0, 0, 0).unwrap();
    let base = sdk::Artifact {
        id: 5,
        repo_id: 7,
        name: "dist".to_owned(),
        size_in_bytes: 10,
        expired: false,
        workflow_run_id: Some(42),
        head_branch: Some("main".to_owned()),
        head_sha: Some("abc".to_owned()),
        created_at: None,
        updated_at: None,
        expires_at: Some("2026-11-12T00:00:00Z".to_owned()),
    };
    let a = artifact(base.clone(), now);
    assert!(a.expired);
    assert_eq!(a.run_id, Some(42));
    assert_eq!(a.branch.as_deref(), Some("main"));

    let fresh = artifact(
        sdk::Artifact {
            expires_at: Some("2026-12-01T00:00:00Z".to_owned()),
            workflow_run_id: None,
            ..base
        },
        now,
    );
    assert!(!fresh.expired);
    assert!(fresh.branch.is_none() && fresh.sha.is_none());
}

#[test]
fn a_job_names_its_first_failed_step_by_number() {
    let step = |name: &str, number: i64, conclusion: &str| sdk::WorkflowStep {
        name: name.to_owned(),
        status: Some("completed".to_owned()),
        conclusion: Some(conclusion.to_owned()),
        number: Some(number),
        started_at: None,
        completed_at: None,
        extra: serde_json::Map::new(),
    };
    let j = workflow_job(sdk::WorkflowJob {
        id: 9,
        repo_id: 7,
        run_id: 42,
        run_attempt: 1,
        name: "build".to_owned(),
        status: Some("completed".to_owned()),
        conclusion: Some("failure".to_owned()),
        head_sha: "abc".to_owned(),
        runner_name: None,
        started_at: None,
        completed_at: None,
        html_url: None,
        steps: vec![
            step("test", 3, "failure"),
            step("lint", 2, "failure"),
            step("checkout", 1, "success"),
        ],
    });
    assert_eq!(j.failed_step.as_deref(), Some("lint"));
}

#[test]
fn a_release_leaves_out_an_asset_it_cannot_name() {
    let asset = |id: Option<i64>, name: &str| sdk::ReleaseAsset {
        id,
        node_id: None,
        name: name.to_owned(),
        label: None,
        content_type: None,
        size: Some(1),
        download_count: None,
        browser_download_url: None,
        created_at: None,
        updated_at: None,
    };
    let r = release(sdk::Release {
        id: 1,
        repo_id: 7,
        tag_name: "v1".to_owned(),
        name: Some("  ".to_owned()),
        draft: false,
        prerelease: true,
        body: None,
        author_login: None,
        created_at: "2026-11-01T00:00:00Z".to_owned(),
        published_at: None,
        html_url: None,
        assets: vec![asset(Some(11), "app.tar.gz"), asset(None, "lost")],
    });
    assert_eq!(r.tag, "v1");
    assert!(r.name.is_none(), "a blank name is no name");
    assert!(r.prerelease);
    assert_eq!(
        r.assets.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(),
        vec!["app.tar.gz"]
    );
}

#[test]
fn a_run_keeps_its_workflow_name_number_and_attempt() {
    let r = workflow_run(sdk::WorkflowRun {
        id: 42,
        repo_id: 7,
        workflow_id: 3,
        run_number: 17,
        run_attempt: 2,
        name: Some("Studio Delivery".to_owned()),
        event: "push".to_owned(),
        status: Some("completed".to_owned()),
        conclusion: Some("success".to_owned()),
        head_branch: Some("main".to_owned()),
        head_sha: "abc".to_owned(),
        created_at: "2026-11-01T00:00:00Z".to_owned(),
        updated_at: "2026-11-01T00:10:00Z".to_owned(),
        html_url: None,
        actor_login: Some("alice".to_owned()),
    });
    assert_eq!(r.workflow, "Studio Delivery");
    assert_eq!((r.run_number, r.attempt), (Some(17), Some(2)));
    assert_eq!(r.event.as_deref(), Some("push"));
    assert_eq!(r.actor.as_deref(), Some("alice"));
}
