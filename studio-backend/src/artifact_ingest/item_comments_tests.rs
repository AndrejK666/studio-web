//! Listings read to their end, and comments read item by item across runs
//! ([`super::super::item_comments`], [`super::super::paging`]): no count of
//! pages or items stops a sync; a provider whose comments hang off each item
//! has every item's comments read, a quiet stretch of items included; a sync
//! out of time reads a portion and the next goes on from there; an item that
//! changed is read again and only it.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use async_trait::async_trait;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::prune_tests::NoSecrets;
use super::{IngestService, SyncSummary, out_of_time_for_items};
use crate::artifact_ingest::graph::{GraphStore, InMemoryGraphStore};
use crate::artifact_ingest::gts;
use crate::connectors::sdk::{
    ConnectionAuth, ConnectorCategory, ConnectorDriver, DriverIdentity, RemoteComment,
    RemoteCommit, RemoteFile, RemoteFileList, RemoteIssue, RemotePullRequest,
};
use crate::tasks::sdk::SyncReporter;

const WS: &str = "00000000-0000-0000-0000-0000000000ab";
const REPO: &str = "acme/big";
const CONNECTOR: &str = "conn";
const PROVIDER: &str = "big-host";

/// A provider shaped like GitLab where it matters here: issues and merge
/// requests numbered apart, comments only per item. Merge request `n` and
/// issue `n` each have `n % 3` comments, none at all below `quiet_below`,
/// so a long quiet stretch comes first.
struct BigHost {
    pulls: i64,
    issues: i64,
    commits: usize,
    /// Leading issue pages holding only what the driver drops (GitHub's pull
    /// requests in its issue listing): no issues, but not the end.
    sparse_issue_pages: u32,
    quiet_below: i64,
    width: usize,
    per_item: bool,
    /// Each item's `updated_at`; a test moves one.
    updated: Mutex<HashMap<(bool, i64), String>>,
    /// Whose comments were asked for: (is_pull_request, number).
    asked: Mutex<Vec<(bool, i64)>>,
    in_flight: AtomicUsize,
    most_in_flight: AtomicUsize,
}

impl BigHost {
    fn new(pulls: i64, issues: i64) -> Self {
        let mut updated = HashMap::new();
        for n in 1..=pulls {
            updated.insert((true, n), "2026-11-02T10:00:00Z".to_owned());
        }
        for n in 1..=issues {
            updated.insert((false, n), "2026-11-02T10:00:00Z".to_owned());
        }
        Self {
            pulls,
            issues,
            commits: 0,
            sparse_issue_pages: 0,
            quiet_below: 0,
            width: 2,
            per_item: true,
            updated: Mutex::new(updated),
            asked: Mutex::new(Vec::new()),
            in_flight: AtomicUsize::new(0),
            most_in_flight: AtomicUsize::new(0),
        }
    }

    fn comments_on(&self, number: i64) -> i64 {
        if number < self.quiet_below {
            0
        } else {
            number % 3
        }
    }

    /// Every comment the provider holds.
    fn all_comments(&self) -> i64 {
        (1..=self.pulls).map(|n| self.comments_on(n)).sum::<i64>()
            + (1..=self.issues).map(|n| self.comments_on(n)).sum::<i64>()
    }

    fn take_asked(&self) -> Vec<(bool, i64)> {
        let mut asked = std::mem::take(&mut *self.asked.lock().unwrap());
        asked.sort_unstable();
        asked
    }

    fn page<T>(all: Vec<T>, page: u32, per_page: u32) -> Vec<T> {
        let from = (page.max(1) as usize - 1) * per_page as usize;
        all.into_iter().skip(from).take(per_page as usize).collect()
    }
}

#[async_trait]
impl ConnectorDriver for BigHost {
    fn provider(&self) -> &'static str {
        PROVIDER
    }
    fn display_name(&self) -> &'static str {
        "Big host"
    }
    fn default_base_url(&self) -> &'static str {
        "https://big.example.com"
    }
    fn category(&self) -> ConnectorCategory {
        ConnectorCategory::SourceCode
    }
    fn item_read_concurrency(&self) -> usize {
        self.width
    }
    fn comments_per_item(&self) -> bool {
        self.per_item
    }
    async fn test(&self, _: &ConnectionAuth) -> anyhow::Result<DriverIdentity> {
        anyhow::bail!("not asked")
    }
    async fn list_issues(
        &self,
        auth: &ConnectionAuth,
        repo: &str,
        since: Option<&str>,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<RemoteIssue>> {
        Ok(self
            .list_issue_page(auth, repo, since, page, per_page)
            .await?
            .0)
    }
    async fn list_issue_page(
        &self,
        _: &ConnectionAuth,
        _: &str,
        _: Option<&str>,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<(Vec<RemoteIssue>, bool)> {
        if page <= self.sparse_issue_pages {
            return Ok((Vec::new(), true));
        }
        let updated = self.updated.lock().unwrap().clone();
        let all: Vec<RemoteIssue> = (1..=self.issues)
            .map(|n| RemoteIssue {
                id: format!("issue-{n}"),
                number: n,
                title: format!("Issue {n}"),
                state: "open".into(),
                author: Some("ada".into()),
                body: None,
                url: None,
                created_at: None,
                updated_at: updated.get(&(false, n)).cloned(),
                labels: Vec::new(),
                parent: None,
                iteration: None,
            })
            .collect();
        let issues = Self::page(all, page - self.sparse_issue_pages, per_page);
        let more = !issues.is_empty();
        Ok((issues, more))
    }
    async fn list_pull_requests(
        &self,
        _: &ConnectionAuth,
        _: &str,
        _: Option<&str>,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<RemotePullRequest>> {
        let updated = self.updated.lock().unwrap().clone();
        let all: Vec<RemotePullRequest> = (1..=self.pulls)
            .map(|n| RemotePullRequest {
                id: format!("pr-{n}"),
                number: n,
                title: format!("Change {n}"),
                state: "merged".into(),
                author: Some("ada".into()),
                body: None,
                url: None,
                source_branch: Some(format!("b{n}")),
                target_branch: Some("main".into()),
                merged: true,
                created_at: None,
                updated_at: updated.get(&(true, n)).cloned(),
                draft: Some(false),
                requested_reviewers: Vec::new(),
                requested_teams: Vec::new(),
                assignees: Vec::new(),
                head_sha: Some(format!("h{n}")),
                merge_sha: None,
            })
            .collect();
        Ok(Self::page(all, page, per_page))
    }
    async fn list_files(
        &self,
        _: &ConnectionAuth,
        _: &str,
        _: Option<&str>,
    ) -> anyhow::Result<RemoteFileList> {
        Ok(RemoteFileList {
            files: vec![RemoteFile {
                path: "a.rs".into(),
                sha: "a".into(),
                is_dir: false,
                size: Some(1),
            }],
            truncated: false,
        })
    }
    async fn pull_request_files(
        &self,
        _: &ConnectionAuth,
        _: &str,
        _: i64,
    ) -> anyhow::Result<Vec<String>> {
        Ok(vec!["a.rs".into()])
    }
    async fn list_item_comments(
        &self,
        _: &ConnectionAuth,
        _: &str,
        _: Option<&str>,
        is_pull_request: bool,
        number: i64,
    ) -> anyhow::Result<Vec<RemoteComment>> {
        self.asked.lock().unwrap().push((is_pull_request, number));
        let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        self.most_in_flight.fetch_max(now, Ordering::SeqCst);
        tokio::task::yield_now().await;
        self.in_flight.fetch_sub(1, Ordering::SeqCst);
        let kind = if is_pull_request { "mr" } else { "issue" };
        Ok((0..self.comments_on(number))
            .map(|k| RemoteComment {
                id: format!("{kind}-{number}-{k}"),
                target_number: number,
                target_is_pull_request: Some(is_pull_request),
                author: Some(format!("user{k}")),
                body: Some("hello".into()),
                url: None,
                created_at: None,
                updated_at: None,
            })
            .collect())
    }
    async fn list_commits(
        &self,
        _: &ConnectionAuth,
        _: &str,
        _: Option<&str>,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<RemoteCommit>> {
        let from = (page.max(1) as usize - 1) * per_page as usize;
        Ok((from..self.commits.min(from + per_page as usize))
            .map(|n| RemoteCommit {
                sha: format!("c{n:08}"),
                message: None,
                author: None,
                author_name: None,
                url: None,
                created_at: None,
                committed_at: None,
            })
            .collect())
    }
}

fn ctx() -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(0xca8))
        .subject_type("user")
        .subject_tenant_id(Uuid::parse_str(WS).unwrap())
        .build()
        .unwrap()
}

fn service(driver: Arc<BigHost>) -> (IngestService, Arc<InMemoryGraphStore>) {
    let graph = Arc::new(InMemoryGraphStore::default());
    let mut drivers: HashMap<String, Arc<dyn ConnectorDriver>> = HashMap::new();
    drivers.insert(PROVIDER.into(), driver);
    let svc = IngestService::new(
        Arc::new(NoSecrets),
        drivers,
        graph.clone(),
        None,
        None,
        None,
    );
    (svc, graph)
}

async fn sync(svc: &IngestService, deadline: Option<Instant>) -> SyncSummary {
    svc.run_sync_until(
        deadline,
        &ctx(),
        PROVIDER,
        None,
        CONNECTOR,
        REPO,
        None,
        "token",
        None,
        Some(WS),
        None,
        None,
        &SyncReporter::detached(),
    )
    .await
    .expect("the sync runs")
}

/// Each stored comment's item, as (is_pull_request, number), from its
/// `comment_on` edge.
async fn comments_on(graph: &InMemoryGraphStore) -> Vec<(bool, i64)> {
    let mut items: HashMap<String, (bool, i64)> = HashMap::new();
    for (type_id, is_pr) in [(gts::ISSUE_TYPE, false), (gts::PULL_REQUEST_TYPE, true)] {
        for n in graph.list(&ctx(), Some(type_id)).await.unwrap().iter() {
            items.insert(
                n.instance_id.clone(),
                (is_pr, n.value["number"].as_i64().unwrap()),
            );
        }
    }
    let mut out: Vec<(bool, i64)> = graph
        .list_relations(&ctx())
        .await
        .unwrap()
        .into_iter()
        .filter(|e| e.type_id == gts::REL_COMMENT_ON)
        .map(|e| items[&e.to])
        .collect();
    out.sort_unstable();
    out
}

/// What every comment should be on, by the provider.
fn expected_comments(host: &BigHost) -> Vec<(bool, i64)> {
    let mut out: Vec<(bool, i64)> = Vec::new();
    for (is_pr, count) in [(true, host.pulls), (false, host.issues)] {
        for n in 1..=count {
            for _ in 0..host.comments_on(n) {
                out.push((is_pr, n));
            }
        }
    }
    out.sort_unstable();
    out
}

#[tokio::test]
async fn every_listing_is_read_to_its_end_past_the_old_ceilings() {
    // 210 pages of commits (the ceiling was 50 pages, then 200, and 20,000
    // commits); 250 merge requests over three pages; the issues behind three
    // pages that hold none of them.
    let mut host = BigHost::new(250, 120);
    host.commits = 21_000;
    host.sparse_issue_pages = 3;
    host.per_item = false;
    let (svc, graph) = service(Arc::new(host));
    let done = sync(&svc, None).await;
    assert_eq!(done.commits, 21_000);
    assert_eq!(done.pull_requests, 250);
    assert_eq!(done.issues, 120, "pages of no issues are not the end");
    assert_eq!(
        graph
            .list(&ctx(), Some(gts::COMMIT_TYPE))
            .await
            .unwrap()
            .len(),
        21_000
    );
}

#[tokio::test]
async fn every_items_comments_are_read_a_quiet_stretch_included() {
    // The first 120 merge requests and all the issues have no comment at
    // all: the old walk gave up after five pages of twenty such items.
    let mut host = BigHost::new(150, 60);
    host.quiet_below = 121;
    let host = Arc::new(host);
    let (svc, graph) = service(host.clone());
    let done = sync(&svc, None).await;
    assert!(!done.is_partial());
    assert_eq!(
        (done.comment_items_done, done.comment_items_total),
        (210, 210)
    );
    assert_eq!(done.comments as i64, host.all_comments());
    assert!(host.all_comments() > 0);
    assert_eq!(comments_on(&graph).await, expected_comments(&host));
    let most = host.most_in_flight.load(Ordering::SeqCst);
    assert!(most <= 2, "{most} in flight at most");
}

#[tokio::test]
async fn a_run_out_of_time_reads_a_portion_and_the_next_goes_on_from_there() {
    // Two in flight: a portion is sixteen items, of 30 merge requests and
    // 10 issues.
    let host = Arc::new(BigHost::new(30, 10));
    let (svc, graph) = service(host.clone());

    let first = sync(&svc, Some(out_of_time_for_items())).await;
    assert_eq!(
        (
            first.comment_items_done,
            first.comment_items_total,
            first.comment_items_left
        ),
        (16, 40, 24)
    );
    assert!(first.is_partial());
    let asked_first: HashSet<(bool, i64)> = host.take_asked().into_iter().collect();
    assert_eq!(asked_first.len(), 16);

    let second = sync(&svc, Some(out_of_time_for_items())).await;
    assert_eq!(
        (second.comment_items_done, second.comment_items_left),
        (32, 8)
    );
    let asked_second: HashSet<(bool, i64)> = host.take_asked().into_iter().collect();
    assert_eq!(asked_second.len(), 16);
    assert!(
        asked_first.is_disjoint(&asked_second),
        "nobody is asked twice"
    );

    let third = sync(&svc, None).await;
    assert_eq!(
        (third.comment_items_done, third.comment_items_left),
        (40, 0)
    );
    assert_eq!(host.take_asked().len(), 8);
    assert_eq!(comments_on(&graph).await, expected_comments(&host));

    // Both marks stand on every merge request: the comment pass writing a
    // node again does not take back the link mark, nor the other way round.
    for n in graph
        .list(&ctx(), Some(gts::PULL_REQUEST_TYPE))
        .await
        .unwrap()
        .iter()
    {
        assert!(n.value["files_linked"].is_string(), "{}", n.value);
        assert!(n.value["comments_read"].is_string(), "{}", n.value);
    }

    // A sync with nothing changed asks nobody.
    let fourth = sync(&svc, None).await;
    assert_eq!(
        (fourth.comment_items_done, fourth.comment_items_left),
        (40, 0)
    );
    assert!(host.take_asked().is_empty());
    // ...and still says how many comments the repository holds, not the
    // none it read: a quiet repository is not one without comments.
    assert_eq!(fourth.comments as i64, host.all_comments());
}

#[tokio::test]
async fn an_item_that_changed_is_read_again_and_only_it() {
    let host = Arc::new(BigHost::new(5, 5));
    let (svc, _graph) = service(host.clone());
    sync(&svc, None).await;
    assert_eq!(host.take_asked().len(), 10);

    // A new note on issue 3 touches the issue, not merge request 3.
    host.updated
        .lock()
        .unwrap()
        .insert((false, 3), "2026-11-03T08:00:00Z".to_owned());
    let again = sync(&svc, None).await;
    assert_eq!(host.take_asked(), vec![(false, 3)]);
    assert_eq!(
        (again.comment_items_done, again.comment_items_total),
        (10, 10)
    );
}
