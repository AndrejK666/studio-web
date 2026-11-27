//! Listings that go on across attempts ([`super::super::listing_cursor`]): a
//! sync out of time stores what it listed and stops; the next attempt asks for
//! the page it stopped at once more and goes on from there, never from page
//! 1; what an earlier attempt listed is linked, commented on and mentioned as
//! if one attempt had listed it all; a sync with time enough asks every page
//! once and leaves no cursor behind.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use async_trait::async_trait;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::prune_tests::NoSecrets;
use super::{IngestService, SyncSummary};
use crate::artifact_ingest::graph::{GraphStore, InMemoryGraphStore};
use crate::artifact_ingest::gts;
use crate::connectors::sdk::{
    ConnectionAuth, ConnectorCategory, ConnectorDriver, DriverIdentity, NumberRef, RemoteComment,
    RemoteCommit, RemoteFile, RemoteFileList, RemoteIssue, RemotePullRequest,
};
use crate::tasks::sdk::SyncReporter;

const WS: &str = "00000000-0000-0000-0000-0000000000cd";
const REPO: &str = "acme/long";
const CONNECTOR: &str = "conn";
const PROVIDER: &str = "long-host";

/// A provider with a few pages of everything, which says which page of which
/// listing it was asked for. Pull request `1000 + n` fixes issue `n`; every issue
/// but the last is part of the last one -- listed last, so a later attempt
/// than the issues naming it.
struct LongHost {
    issues: i64,
    pulls: i64,
    comments: i64,
    commits: usize,
    per_item: bool,
    /// (listing, page) in the order asked.
    pages: Mutex<Vec<(&'static str, u32)>>,
    /// Whose comments were asked for, where they are read per item.
    items: Mutex<Vec<(bool, i64)>>,
}

impl LongHost {
    fn new(issues: i64, pulls: i64, comments: i64, commits: usize) -> Self {
        Self {
            issues,
            pulls,
            comments,
            commits,
            per_item: false,
            pages: Mutex::new(Vec::new()),
            items: Mutex::new(Vec::new()),
        }
    }

    fn asked(&self, listing: &'static str, page: u32) {
        self.pages.lock().unwrap().push((listing, page));
    }

    fn take_pages(&self) -> Vec<(&'static str, u32)> {
        std::mem::take(&mut *self.pages.lock().unwrap())
    }

    fn page<T>(all: Vec<T>, page: u32, per_page: u32) -> Vec<T> {
        let from = (page.max(1) as usize - 1) * per_page as usize;
        all.into_iter().skip(from).take(per_page as usize).collect()
    }
}

#[async_trait]
impl ConnectorDriver for LongHost {
    fn provider(&self) -> &'static str {
        PROVIDER
    }
    fn display_name(&self) -> &'static str {
        "Long host"
    }
    fn default_base_url(&self) -> &'static str {
        "https://long.example.com"
    }
    fn category(&self) -> ConnectorCategory {
        ConnectorCategory::SourceCode
    }
    fn item_read_concurrency(&self) -> usize {
        2
    }
    fn comments_per_item(&self) -> bool {
        self.per_item
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
        per_page: u32,
    ) -> anyhow::Result<Vec<RemoteIssue>> {
        self.asked("issues", page);
        let last = self.issues;
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
                updated_at: Some("2026-11-02T10:00:00Z".into()),
                labels: Vec::new(),
                parent: (n != last).then(|| NumberRef {
                    repo: None,
                    number: last,
                    ..Default::default()
                }),
                iteration: None,
            })
            .collect();
        Ok(Self::page(all, page, per_page))
    }
    async fn list_pull_requests(
        &self,
        _: &ConnectionAuth,
        _: &str,
        _: Option<&str>,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<RemotePullRequest>> {
        self.asked("pull requests", page);
        let all: Vec<RemotePullRequest> = (1..=self.pulls)
            .map(|n| RemotePullRequest {
                id: format!("pr-{n}"),
                number: 1000 + n,
                title: format!("Change {n}"),
                state: "merged".into(),
                author: Some("bob".into()),
                body: Some(format!("Fixes #{n}")),
                url: None,
                source_branch: Some(format!("b{n}")),
                target_branch: Some("main".into()),
                merged: true,
                created_at: None,
                updated_at: Some("2026-11-02T10:00:00Z".into()),
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
    async fn list_comments(
        &self,
        _: &ConnectionAuth,
        _: &str,
        _: Option<&str>,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<RemoteComment>> {
        self.asked("comments", page);
        let issues = self.issues;
        let all: Vec<RemoteComment> = (1..=self.comments)
            .map(|k| RemoteComment {
                id: format!("comment-{k}"),
                // On the issues, in turn: one sequence of numbers, as GitHub.
                target_number: (k - 1) % issues + 1,
                target_is_pull_request: Some(false),
                author: Some("cy".into()),
                body: Some("hello".into()),
                url: None,
                created_at: None,
                updated_at: None,
            })
            .collect();
        Ok(Self::page(all, page, per_page))
    }
    async fn list_item_comments(
        &self,
        _: &ConnectionAuth,
        _: &str,
        _: Option<&str>,
        is_pull_request: bool,
        number: i64,
    ) -> anyhow::Result<Vec<RemoteComment>> {
        self.items.lock().unwrap().push((is_pull_request, number));
        let kind = if is_pull_request { "mr" } else { "issue" };
        Ok(vec![RemoteComment {
            id: format!("{kind}-{number}"),
            target_number: number,
            target_is_pull_request: Some(is_pull_request),
            author: Some("cy".into()),
            body: Some("hello".into()),
            url: None,
            created_at: None,
            updated_at: None,
        }])
    }
    async fn list_commits(
        &self,
        _: &ConnectionAuth,
        _: &str,
        _: Option<&str>,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<RemoteCommit>> {
        self.asked("commits", page);
        let from = (page.max(1) as usize - 1) * per_page as usize;
        Ok((from..self.commits.min(from + per_page as usize))
            .map(|n| RemoteCommit {
                sha: format!("c{n:08}"),
                message: None,
                author: Some("dee".into()),
                author_name: None,
                url: None,
                created_at: None,
                committed_at: None,
            })
            .collect())
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
}

fn ctx() -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(0xcd8))
        .subject_type("user")
        .subject_tenant_id(Uuid::parse_str(WS).unwrap())
        .build()
        .unwrap()
}

fn service(driver: Arc<LongHost>) -> (IngestService, Arc<InMemoryGraphStore>) {
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

/// Attempts until one is not partial, each out of time from its start; the
/// summaries in order.
async fn attempts_out_of_time(svc: &IngestService) -> Vec<SyncSummary> {
    let mut out = Vec::new();
    for _ in 0..200 {
        let summary = sync(svc, Some(Instant::now())).await;
        out.push(summary);
        if !summary.is_partial() {
            return out;
        }
    }
    panic!("200 attempts and still partial");
}

async fn count(graph: &InMemoryGraphStore, type_id: &str) -> usize {
    graph.list(&ctx(), Some(type_id)).await.unwrap().len()
}

async fn relations(graph: &InMemoryGraphStore, type_id: &str) -> usize {
    graph
        .list_relations(&ctx())
        .await
        .unwrap()
        .into_iter()
        .filter(|e| e.type_id == type_id)
        .map(|e| (e.from, e.to))
        .collect::<HashSet<_>>()
        .len()
}

async fn cursor_on_repo(graph: &InMemoryGraphStore) -> serde_json::Value {
    let repos = graph.list(&ctx(), Some(gts::REPO_TYPE)).await.unwrap();
    assert_eq!(repos.len(), 1);
    repos[0].value["listing"].clone()
}

#[tokio::test]
async fn a_walk_out_of_time_goes_on_from_its_page_and_ends_whole() {
    // Three pages of issues, four of pull requests, two of comments, five
    // of commits (and the empty page that ends each).
    let host = Arc::new(LongHost::new(250, 320, 180, 430));
    let (svc, graph) = service(host.clone());

    // The first attempt reads a page and stops, with every listing left and
    // nothing after the listings run; the repository node says where.
    let first = sync(&svc, Some(Instant::now())).await;
    assert!(first.is_partial());
    assert_eq!(first.listings_left, 4);
    assert_eq!((first.issues, first.pull_requests), (100, 0));
    assert_eq!(first.links_total, 0, "no links on a part of the items");
    let cursor = cursor_on_repo(&graph).await;
    assert_eq!(cursor["issues"]["next"], 1, "{cursor}");
    assert_eq!(count(&graph, gts::ISSUE_TYPE).await, 100);

    let mut runs = vec![first];
    runs.extend(attempts_out_of_time(&svc).await);

    // Every page is asked once, and at most once more as the next attempt's
    // overlap: never the walk again from page 1.
    let pages = host.take_pages();
    let mut asked: HashMap<(&str, u32), usize> = HashMap::new();
    for p in &pages {
        *asked.entry(*p).or_default() += 1;
    }
    for (page, times) in &asked {
        assert!(*times <= 2, "{page:?} asked {times} times");
    }
    let twice = asked.values().filter(|t| **t == 2).count();
    assert!(twice < runs.len(), "one overlap page an attempt at most");
    for (listing, last) in [
        ("issues", 4),
        ("pull requests", 5),
        ("comments", 3),
        ("commits", 6),
    ] {
        for page in 1..=last {
            assert!(asked.contains_key(&(listing, page)), "{listing} {page}");
        }
        assert!(
            !asked.contains_key(&(listing, last + 1)),
            "{listing} past its end"
        );
    }

    // It ends whole, with the counts of the walk, not of its last attempt.
    let last = *runs.last().unwrap();
    assert_eq!(last.listings_left, 0);
    assert_eq!(
        (last.issues, last.pull_requests, last.comments, last.commits),
        (250, 320, 180, 430)
    );
    assert_eq!(
        (last.links_done, last.links_total, last.links_left),
        (320, 320, 0)
    );
    assert_eq!(count(&graph, gts::ISSUE_TYPE).await, 250);
    assert_eq!(count(&graph, gts::PULL_REQUEST_TYPE).await, 320);
    assert_eq!(count(&graph, gts::COMMENT_TYPE).await, 180);
    assert_eq!(count(&graph, gts::COMMIT_TYPE).await, 430);

    // What an earlier attempt listed is linked, mentioned and commented on
    // as if one attempt had listed it all.
    for n in graph
        .list(&ctx(), Some(gts::PULL_REQUEST_TYPE))
        .await
        .unwrap()
        .iter()
    {
        assert!(n.value["files_linked"].is_string(), "{}", n.value);
    }
    assert_eq!(relations(&graph, gts::REL_CLOSES).await, 250);
    assert_eq!(relations(&graph, gts::REL_PART_OF).await, 249);
    assert_eq!(relations(&graph, gts::REL_COMMENT_ON).await, 180);
    assert_eq!(
        relations(&graph, gts::REL_AUTHORED_BY).await,
        250 + 320 + 180 + 430
    );
    assert_eq!(relations(&graph, gts::REL_MODIFIES).await, 320);
    assert_eq!(count(&graph, gts::USER_TYPE).await, 4);
    assert!(cursor_on_repo(&graph).await.is_null(), "the walk is over");

    // The next sync is a new walk from page 1, asking each page once.
    let again = sync(&svc, None).await;
    assert!(!again.is_partial());
    let pages = host.take_pages();
    let distinct: HashSet<_> = pages.iter().collect();
    assert_eq!(distinct.len(), pages.len(), "{pages:?}");
    assert!(pages.contains(&("issues", 1)));
}

#[tokio::test]
async fn a_sync_with_time_enough_asks_every_page_once_and_leaves_no_cursor() {
    let host = Arc::new(LongHost::new(150, 120, 30, 210));
    let (svc, graph) = service(host.clone());
    for _ in 0..2 {
        let done = sync(&svc, None).await;
        assert!(!done.is_partial());
        assert_eq!(
            (done.issues, done.pull_requests, done.comments, done.commits),
            (150, 120, 30, 210)
        );
        let pages = host.take_pages();
        let distinct: HashSet<_> = pages.iter().collect();
        assert_eq!(distinct.len(), pages.len(), "{pages:?}");
        // 2 + 1, 2 + 1, 1 + 1 and 3 + 1 pages: nothing more.
        assert_eq!(pages.len(), 12, "{pages:?}");
        assert!(cursor_on_repo(&graph).await.is_null());
    }
}

#[tokio::test]
async fn items_an_earlier_attempt_listed_have_their_comments_read_once() {
    let mut host = LongHost::new(130, 140, 0, 0);
    host.per_item = true;
    let host = Arc::new(host);
    let (svc, graph) = service(host.clone());

    let runs = attempts_out_of_time(&svc).await;
    assert!(runs.len() > 2);
    let last = *runs.last().unwrap();
    assert_eq!(
        (last.comment_items_done, last.comment_items_total),
        (270, 270)
    );
    let mut items = std::mem::take(&mut *host.items.lock().unwrap());
    items.sort_unstable();
    let once: HashSet<_> = items.iter().copied().collect();
    assert_eq!(once.len(), items.len(), "nobody is asked twice");
    assert_eq!(once.len(), 270, "everybody is asked");
    assert_eq!(relations(&graph, gts::REL_COMMENT_ON).await, 270);
    for type_id in [gts::ISSUE_TYPE, gts::PULL_REQUEST_TYPE] {
        for n in graph.list(&ctx(), Some(type_id)).await.unwrap().iter() {
            assert!(n.value["comments_read"].is_string(), "{}", n.value);
        }
    }
}

#[tokio::test]
async fn listings_done_and_links_left_are_not_listed_again() {
    let host = Arc::new(LongHost::new(50, 60, 10, 50));
    let (svc, _graph) = service(host.clone());

    // Time for the listings, none for the links: one portion of them.
    let first = sync(&svc, Some(super::out_of_time_for_items())).await;
    assert_eq!(first.listings_left, 0);
    assert!(first.links_left > 0);
    assert!(!host.take_pages().is_empty());

    // The next attempt links on, with the listings' counts, and lists
    // nothing.
    let second = sync(&svc, None).await;
    assert!(!second.is_partial());
    assert_eq!(
        (
            second.issues,
            second.pull_requests,
            second.comments,
            second.commits
        ),
        (50, 60, 10, 50)
    );
    assert_eq!((second.links_done, second.links_total), (60, 60));
    assert!(host.take_pages().is_empty(), "nothing listed again");
}
