//! Pull request → file links across runs ([`super::super::pr_links`]): a sync
//! out of time links a portion and says how many are left, the next one goes
//! on from there, a pull request pushed to since is linked again, and answers
//! read several at a time stay with their own pull request.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::prune_tests::NoSecrets;
use super::{IngestService, SyncSummary};
use crate::artifact_ingest::graph::{GraphStore, InMemoryGraphStore};
use crate::artifact_ingest::gts;
use crate::connectors::sdk::{
    ConnectionAuth, ConnectorCategory, ConnectorDriver, DriverIdentity, RemoteFile, RemoteFileList,
    RemoteIssue, RemotePullRequest,
};
use crate::tasks::sdk::SyncReporter;

const WS: &str = "00000000-0000-0000-0000-0000000000aa";
const REPO: &str = "acme/app";
const CONNECTOR: &str = "conn";
const PROVIDER: &str = "many-pulls";

/// A provider with `count` pull requests, numbered from 1, each changing
/// `f{n}.rs`, `README.md` and a file the repository no longer has.
struct ManyPulls {
    count: i64,
    /// Reads in flight at once, as the driver allows them.
    width: usize,
    /// Each pull request's head; a test moves one.
    heads: Mutex<HashMap<i64, String>>,
    /// Whose files were asked for.
    asked: Mutex<Vec<i64>>,
    /// A read of pull request `n` takes `stagger * (count + 1 - n)`: the later
    /// ones answer first.
    stagger: Duration,
    /// Pull requests whose files the provider will not give.
    refused: HashSet<i64>,
    in_flight: AtomicUsize,
    most_in_flight: AtomicUsize,
}

impl ManyPulls {
    fn new(count: i64, width: usize) -> Self {
        Self {
            count,
            width,
            heads: Mutex::new((1..=count).map(|n| (n, format!("h{n}"))).collect()),
            asked: Mutex::new(Vec::new()),
            stagger: Duration::ZERO,
            refused: HashSet::new(),
            in_flight: AtomicUsize::new(0),
            most_in_flight: AtomicUsize::new(0),
        }
    }

    /// Whose files were asked for since the last look, in number order:
    /// reads in flight together may start in either order.
    fn take_asked(&self) -> Vec<i64> {
        let mut asked = std::mem::take(&mut *self.asked.lock().unwrap());
        asked.sort_unstable();
        asked
    }
}

#[async_trait]
impl ConnectorDriver for ManyPulls {
    fn provider(&self) -> &'static str {
        PROVIDER
    }
    fn display_name(&self) -> &'static str {
        "Many pulls"
    }
    fn default_base_url(&self) -> &'static str {
        "https://many.example.com"
    }
    fn category(&self) -> ConnectorCategory {
        ConnectorCategory::SourceCode
    }
    fn item_read_concurrency(&self) -> usize {
        self.width
    }
    async fn test(&self, _: &ConnectionAuth) -> anyhow::Result<DriverIdentity> {
        anyhow::bail!("not asked")
    }
    async fn list_issues(
        &self,
        _: &ConnectionAuth,
        _: &str,
        _: Option<&str>,
        _: u32,
        _: u32,
    ) -> anyhow::Result<Vec<RemoteIssue>> {
        Ok(Vec::new())
    }
    async fn list_pull_requests(
        &self,
        _: &ConnectionAuth,
        _: &str,
        _: Option<&str>,
        page: u32,
        _: u32,
    ) -> anyhow::Result<Vec<RemotePullRequest>> {
        if page > 1 {
            return Ok(Vec::new());
        }
        let heads = self.heads.lock().unwrap().clone();
        Ok((1..=self.count)
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
                created_at: Some("2026-11-01T10:00:00Z".into()),
                updated_at: Some("2026-11-02T10:00:00Z".into()),
                draft: Some(false),
                requested_reviewers: Vec::new(),
                requested_teams: Vec::new(),
                assignees: Vec::new(),
                head_sha: heads.get(&n).cloned(),
                merge_sha: Some(format!("m{n}")),
            })
            .collect())
    }
    async fn list_files(
        &self,
        _: &ConnectionAuth,
        _: &str,
        _: Option<&str>,
    ) -> anyhow::Result<RemoteFileList> {
        let mut files: Vec<RemoteFile> = (1..=self.count)
            .map(|n| RemoteFile {
                path: format!("f{n}.rs"),
                sha: format!("s{n}"),
                is_dir: false,
                size: Some(10),
            })
            .collect();
        files.push(RemoteFile {
            path: "README.md".into(),
            sha: "readme".into(),
            is_dir: false,
            size: Some(10),
        });
        Ok(RemoteFileList {
            files,
            truncated: false,
        })
    }
    async fn pull_request_files(
        &self,
        _: &ConnectionAuth,
        _: &str,
        number: i64,
    ) -> anyhow::Result<Vec<String>> {
        self.asked.lock().unwrap().push(number);
        let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        self.most_in_flight.fetch_max(now, Ordering::SeqCst);
        let wait = self.stagger * u32::try_from(self.count + 1 - number).unwrap_or(1);
        tokio::time::sleep(wait).await;
        self.in_flight.fetch_sub(1, Ordering::SeqCst);
        if self.refused.contains(&number) {
            anyhow::bail!("403 on pull request {number}");
        }
        Ok(vec![
            format!("f{number}.rs"),
            "README.md".into(),
            "gone.rs".into(),
        ])
    }
}

fn ctx() -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(0xca7))
        .subject_type("user")
        .subject_tenant_id(Uuid::parse_str(WS).unwrap())
        .build()
        .unwrap()
}

fn service(driver: Arc<ManyPulls>) -> (IngestService, Arc<InMemoryGraphStore>) {
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

/// Each stored pull request's mark, by number.
async fn marks(graph: &InMemoryGraphStore) -> HashMap<i64, Option<String>> {
    graph
        .list(&ctx(), Some(gts::PULL_REQUEST_TYPE))
        .await
        .unwrap()
        .iter()
        .map(|n| {
            (
                n.value["number"].as_i64().unwrap(),
                n.value[super::super::pr_links::LINKED_FIELD]
                    .as_str()
                    .map(str::to_owned),
            )
        })
        .collect()
}

/// The files each pull request is linked to (`modifies`), by number.
async fn links(graph: &InMemoryGraphStore) -> HashMap<i64, HashSet<String>> {
    let number_of: HashMap<String, i64> = graph
        .list(&ctx(), Some(gts::PULL_REQUEST_TYPE))
        .await
        .unwrap()
        .iter()
        .map(|n| (n.instance_id.clone(), n.value["number"].as_i64().unwrap()))
        .collect();
    let path_of: HashMap<String, String> = graph
        .list(&ctx(), Some(gts::FILE_TYPE))
        .await
        .unwrap()
        .iter()
        .map(|n| {
            (
                n.instance_id.clone(),
                n.value["path"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    let mut out: HashMap<i64, HashSet<String>> = HashMap::new();
    for e in graph.list_relations(&ctx()).await.unwrap() {
        if e.type_id != gts::REL_MODIFIES {
            continue;
        }
        let number = number_of[&e.from];
        out.entry(number)
            .or_default()
            .insert(path_of[&e.to].clone());
    }
    out
}

fn own_files(n: i64) -> HashSet<String> {
    [format!("f{n}.rs"), "README.md".to_owned()].into()
}

#[tokio::test]
async fn a_run_out_of_time_links_a_portion_and_the_next_goes_on_from_there() {
    // Two in flight: a portion is sixteen pull requests.
    let driver = Arc::new(ManyPulls::new(40, 2));
    let (svc, graph) = service(driver.clone());

    // Out of time from the start: one portion, and the rest is left.
    let first = sync(&svc, Some(Instant::now())).await;
    assert_eq!(
        (first.links_done, first.links_total, first.links_left),
        (16, 40, 24)
    );
    assert!(first.is_partial());
    let asked_first = driver.take_asked();
    assert_eq!(asked_first, (1..=16).collect::<Vec<_>>());
    let stored = marks(&graph).await;
    assert_eq!(stored.len(), 40, "every pull request is stored either way");
    for n in 1..=40 {
        let want = (n <= 16).then(|| format!("h{n}"));
        assert_eq!(stored[&n], want, "pull request {n}");
    }
    // What it linked is in the graph now, not only at the end of a sync.
    let linked = links(&graph).await;
    assert_eq!(linked.len(), 16);

    // The next attempt does not ask again about the sixteen.
    let second = sync(&svc, Some(Instant::now())).await;
    assert_eq!(
        (second.links_done, second.links_total, second.links_left),
        (32, 40, 8)
    );
    assert_eq!(driver.take_asked(), (17..=32).collect::<Vec<_>>());

    // With time enough, it finishes -- and says so.
    let third = sync(&svc, None).await;
    assert_eq!(
        (third.links_done, third.links_total, third.links_left),
        (40, 40, 0)
    );
    assert!(!third.is_partial());
    assert_eq!(driver.take_asked(), (33..=40).collect::<Vec<_>>());

    let linked = links(&graph).await;
    for n in 1..=40 {
        // Its own files, and not one the repository no longer has.
        assert_eq!(linked[&n], own_files(n), "pull request {n}");
    }

    // A sync with nothing left asks nobody.
    let fourth = sync(&svc, None).await;
    assert_eq!((fourth.links_done, fourth.links_left), (40, 0));
    assert!(driver.take_asked().is_empty());
}

#[tokio::test]
async fn a_pull_request_pushed_to_since_is_linked_again_and_only_it() {
    let driver = Arc::new(ManyPulls::new(5, 3));
    let (svc, graph) = service(driver.clone());
    sync(&svc, None).await;
    assert_eq!(driver.take_asked().len(), 5);

    driver
        .heads
        .lock()
        .unwrap()
        .insert(3, "h3-pushed".to_owned());
    let again = sync(&svc, None).await;
    assert_eq!(driver.take_asked(), vec![3]);
    assert_eq!((again.links_done, again.links_total), (5, 5));
    assert_eq!(marks(&graph).await[&3].as_deref(), Some("h3-pushed"));
}

#[tokio::test]
async fn answers_read_several_at_once_stay_with_their_own_pull_request() {
    // The later a pull request in the listing, the sooner its answer comes.
    let mut many = ManyPulls::new(12, 4);
    many.stagger = Duration::from_millis(3);
    let driver = Arc::new(many);
    let (svc, graph) = service(driver.clone());
    let done = sync(&svc, None).await;
    assert_eq!((done.links_done, done.links_left), (12, 0));

    let most = driver.most_in_flight.load(Ordering::SeqCst);
    assert!(most > 1 && most <= 4, "{most} in flight at most");
    let linked = links(&graph).await;
    for n in 1..=12 {
        assert_eq!(linked[&n], own_files(n), "pull request {n}");
    }
    let stored = marks(&graph).await;
    for n in 1..=12 {
        assert_eq!(stored[&n].as_deref(), Some(format!("h{n}").as_str()));
    }
}

#[tokio::test]
async fn a_pull_request_the_provider_will_not_answer_is_asked_again_next_sync() {
    let mut many = ManyPulls::new(4, 2);
    many.refused.insert(2);
    let driver = Arc::new(many);
    let (svc, graph) = service(driver.clone());

    // Not a deadline: the sync is complete, with one pull request unlinked.
    let first = sync(&svc, None).await;
    assert_eq!(
        (first.links_done, first.links_total, first.links_left),
        (3, 4, 0)
    );
    assert!(!first.is_partial());
    assert_eq!(marks(&graph).await[&2], None);

    driver.take_asked();
    sync(&svc, None).await;
    assert_eq!(driver.take_asked(), vec![2]);
}

#[tokio::test]
async fn without_a_deadline_every_pull_request_is_linked_in_one_sync() {
    // Many portions, one sync: `run_sync` as every caller but the task has it.
    let driver = Arc::new(ManyPulls::new(50, 1));
    let (svc, graph) = service(driver.clone());
    let done = svc
        .run_sync(
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
        .unwrap();
    assert_eq!((done.links_done, done.links_left), (50, 0));
    assert_eq!(driver.take_asked().len(), 50);
    assert_eq!(links(&graph).await.len(), 50);
}
