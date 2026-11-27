//! GitHub's comments read item by item across runs, by GitHub's own driver
//! against a fake GitHub ([`super::super::item_comments`]): a sync out of
//! time reads a portion and the next goes on from there; an item whose
//! `updated_at` has not moved is not asked about again, an edited one is;
//! no count of comments stops an item's reading; and the summary says how
//! many comments -- and nodes -- the repository holds, not how many this
//! pass wrote.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::prune_tests::NoSecrets;
use super::{IngestService, SyncSummary, out_of_time_for_items};
use crate::artifact_ingest::graph::{GraphStore, InMemoryGraphStore};
use crate::artifact_ingest::gts;
use crate::connectors::sdk::{ConnectorDriver, github_driver};
use crate::tasks::sdk::SyncReporter;

const WS: &str = "00000000-0000-0000-0000-0000000000ef";
const REPO: &str = "acme/talky";
const CONNECTOR: &str = "conn";
const PROVIDER: &str = "github";

/// Comments on the one item that has more than a page of them.
const CHATTY: i64 = 230;

/// A GitHub with `pulls` pull requests numbered from 1 and `issues` issues
/// after them -- one numbering, as GitHub's. Item `n` has `n % 3` comments,
/// the chatty one [`CHATTY`]. Its `/issues` listing carries the pull
/// requests too, as GitHub's does.
struct FakeGitHub {
    pulls: i64,
    issues: i64,
    chatty: Option<i64>,
    /// Each item's `updated_at`; a test moves one.
    updated: Mutex<HashMap<i64, String>>,
    /// Each comment page asked for: (item number, page).
    pages: Mutex<Vec<(i64, u32)>>,
}

impl FakeGitHub {
    fn new(pulls: i64, issues: i64) -> Self {
        let updated = (1..=pulls + issues)
            .map(|n| (n, "2026-11-02T10:00:00Z".to_owned()))
            .collect();
        Self {
            pulls,
            issues,
            chatty: None,
            updated: Mutex::new(updated),
            pages: Mutex::new(Vec::new()),
        }
    }

    fn comments_on(&self, number: i64) -> i64 {
        if self.chatty == Some(number) {
            CHATTY
        } else {
            number % 3
        }
    }

    /// Every comment GitHub holds.
    fn all_comments(&self) -> i64 {
        (1..=self.pulls + self.issues)
            .map(|n| self.comments_on(n))
            .sum()
    }

    fn touch(&self, number: i64) {
        self.updated
            .lock()
            .unwrap()
            .insert(number, "2026-11-03T08:00:00Z".to_owned());
    }

    /// The items whose comments were asked for since the last call, sorted.
    fn take_asked(&self) -> Vec<i64> {
        let pages = std::mem::take(&mut *self.pages.lock().unwrap());
        let mut asked: Vec<i64> = pages
            .into_iter()
            .filter(|(_, page)| *page == 1)
            .map(|(n, _)| n)
            .collect();
        asked.sort_unstable();
        asked
    }

    fn updated_at(&self, number: i64) -> String {
        self.updated.lock().unwrap()[&number].clone()
    }
}

#[derive(Deserialize)]
struct PageQuery {
    page: Option<usize>,
    per_page: Option<usize>,
}

impl PageQuery {
    fn slice(&self, all: Vec<Value>) -> Vec<Value> {
        let per_page = self.per_page.unwrap_or(30);
        let from = (self.page.unwrap_or(1).max(1) - 1) * per_page;
        all.into_iter().skip(from).take(per_page).collect()
    }
}

type Host = State<Arc<FakeGitHub>>;
type RepoPath = Path<(String, String)>;

/// `/repos/{o}/{r}/issues`: issues and pull requests, newest first.
async fn issues(State(h): Host, _: RepoPath, Query(q): Query<PageQuery>) -> Json<Value> {
    let all = (1..=h.pulls + h.issues)
        .rev()
        .map(|n| {
            let mut item = json!({
                "id": n,
                "number": n,
                "title": format!("Item {n}"),
                "state": "open",
                "user": { "login": "ada" },
                "html_url": format!("https://github.example/{REPO}/issues/{n}"),
                "updated_at": h.updated_at(n),
            });
            if n <= h.pulls {
                item["pull_request"] = json!({});
            }
            item
        })
        .collect();
    Json(Value::Array(q.slice(all)))
}

/// `/repos/{o}/{r}/pulls`, newest first.
async fn pulls(State(h): Host, _: RepoPath, Query(q): Query<PageQuery>) -> Json<Value> {
    let all = (1..=h.pulls)
        .rev()
        .map(|n| {
            json!({
                "id": 10_000 + n,
                "number": n,
                "title": format!("Change {n}"),
                "state": "closed",
                "user": { "login": "ada" },
                "html_url": format!("https://github.example/{REPO}/pull/{n}"),
                "head": { "ref": format!("b{n}"), "sha": format!("h{n}") },
                "base": { "ref": "main" },
                "merged_at": "2026-11-01T00:00:00Z",
                "updated_at": h.updated_at(n),
            })
        })
        .collect();
    Json(Value::Array(q.slice(all)))
}

/// `/repos/{o}/{r}/issues/{n}/comments`, oldest first.
async fn comments(
    State(h): Host,
    Path((_, _, number)): Path<(String, String, i64)>,
    Query(q): Query<PageQuery>,
) -> Result<Json<Value>, StatusCode> {
    if number < 1 || number > h.pulls + h.issues {
        return Err(StatusCode::NOT_FOUND);
    }
    h.pages
        .lock()
        .unwrap()
        .push((number, u32::try_from(q.page.unwrap_or(1)).unwrap()));
    let all = (0..h.comments_on(number))
        .map(|k| {
            json!({
                "id": number * 1_000 + k,
                "user": { "login": format!("user{}", k % 4) },
                "body": "hello",
                "html_url": format!("https://github.example/{REPO}/issues/{number}#c{k}"),
                "created_at": "2026-11-01T00:00:00Z",
                "updated_at": "2026-11-01T00:00:00Z",
            })
        })
        .collect();
    Ok(Json(Value::Array(q.slice(all))))
}

async fn nothing() -> Json<Value> {
    Json(json!([]))
}

/// Serve `host`; its address. Anything else it is asked answers 404, as a
/// token without Actions or a repository without a tree would.
async fn serve(host: Arc<FakeGitHub>) -> String {
    let app = Router::new()
        .route("/repos/{owner}/{repo}/issues", get(issues))
        .route("/repos/{owner}/{repo}/pulls", get(pulls))
        .route(
            "/repos/{owner}/{repo}/issues/{number}/comments",
            get(comments),
        )
        .route("/repos/{owner}/{repo}/commits", get(nothing))
        .with_state(host);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{addr}")
}

fn ctx() -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(0xca9))
        .subject_type("user")
        .subject_tenant_id(Uuid::parse_str(WS).unwrap())
        .build()
        .unwrap()
}

struct Stand {
    svc: IngestService,
    graph: Arc<InMemoryGraphStore>,
    base: String,
}

async fn stand(host: Arc<FakeGitHub>) -> Stand {
    let base = serve(host).await;
    let graph = Arc::new(InMemoryGraphStore::default());
    let mut drivers: HashMap<String, Arc<dyn ConnectorDriver>> = HashMap::new();
    drivers.insert(PROVIDER.into(), github_driver());
    let svc = IngestService::new(
        Arc::new(NoSecrets),
        drivers,
        graph.clone(),
        None,
        None,
        None,
    );
    Stand { svc, graph, base }
}

async fn sync(stand: &Stand, deadline: Option<Instant>) -> SyncSummary {
    stand
        .svc
        .run_sync_until(
            deadline,
            &ctx(),
            PROVIDER,
            Some(&stand.base),
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

/// Each stored comment's item number, from its `comment_on` edge.
async fn comments_on(graph: &InMemoryGraphStore) -> Vec<i64> {
    let mut items: HashMap<String, i64> = HashMap::new();
    for type_id in [gts::ISSUE_TYPE, gts::PULL_REQUEST_TYPE] {
        for n in graph.list(&ctx(), Some(type_id)).await.unwrap().iter() {
            items.insert(n.instance_id.clone(), n.value["number"].as_i64().unwrap());
        }
    }
    let mut out: Vec<i64> = graph
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

/// What every comment should be on, by GitHub.
fn expected_comments(host: &FakeGitHub) -> Vec<i64> {
    let mut out: Vec<i64> = (1..=host.pulls + host.issues)
        .flat_map(|n| std::iter::repeat_n(n, usize::try_from(host.comments_on(n)).unwrap()))
        .collect();
    out.sort_unstable();
    out
}

#[tokio::test]
async fn a_run_out_of_time_reads_a_portion_and_the_next_goes_on_from_there() {
    // GitHub is read one item at a time: a portion is eight items, of 20
    // pull requests and 12 issues.
    let host = Arc::new(FakeGitHub::new(20, 12));
    let stand = stand(host.clone()).await;

    let first = sync(&stand, Some(out_of_time_for_items())).await;
    assert_eq!(
        (
            first.comment_items_done,
            first.comment_items_total,
            first.comment_items_left
        ),
        (8, 32, 24)
    );
    assert!(first.is_partial());
    let asked_first: HashSet<i64> = host.take_asked().into_iter().collect();
    assert_eq!(asked_first.len(), 8);

    let second = sync(&stand, Some(out_of_time_for_items())).await;
    assert_eq!(
        (second.comment_items_done, second.comment_items_left),
        (16, 16)
    );
    let asked_second: HashSet<i64> = host.take_asked().into_iter().collect();
    assert_eq!(asked_second.len(), 8);
    assert!(
        asked_first.is_disjoint(&asked_second),
        "nobody is asked twice"
    );

    let third = sync(&stand, None).await;
    assert_eq!(
        (third.comment_items_done, third.comment_items_left),
        (32, 0)
    );
    assert!(!third.is_partial());
    let asked_third: HashSet<i64> = host.take_asked().into_iter().collect();
    assert_eq!(asked_third.len(), 16);
    assert!(asked_third.is_disjoint(&asked_first) && asked_third.is_disjoint(&asked_second));
    assert_eq!(comments_on(&stand.graph).await, expected_comments(&host));
    assert_eq!(third.comments as i64, host.all_comments());
}

#[tokio::test]
async fn an_unchanged_item_is_not_read_again() {
    let host = Arc::new(FakeGitHub::new(6, 4));
    let stand = stand(host.clone()).await;
    sync(&stand, None).await;
    assert_eq!(host.take_asked(), (1..=10).collect::<Vec<_>>());

    let again = sync(&stand, None).await;
    assert!(host.take_asked().is_empty(), "nothing moved, nobody asked");
    assert_eq!(
        (again.comment_items_done, again.comment_items_total),
        (10, 10)
    );
    assert_eq!(comments_on(&stand.graph).await, expected_comments(&host));
}

#[tokio::test]
async fn an_edited_item_is_read_again_and_only_it() {
    let host = Arc::new(FakeGitHub::new(6, 4));
    let stand = stand(host.clone()).await;
    sync(&stand, None).await;
    host.take_asked();

    // A comment written on pull request 2 and one edited on issue 8 move
    // their items' `updated_at`.
    host.touch(2);
    host.touch(8);
    let again = sync(&stand, None).await;
    assert_eq!(host.take_asked(), vec![2, 8]);
    assert_eq!(
        (again.comment_items_done, again.comment_items_total),
        (10, 10)
    );
    assert_eq!(comments_on(&stand.graph).await, expected_comments(&host));
}

#[tokio::test]
async fn an_items_comments_are_read_to_their_end() {
    // 230 comments on issue 7: three pages of a hundred.
    let mut host = FakeGitHub::new(3, 5);
    host.chatty = Some(7);
    let host = Arc::new(host);
    let stand = stand(host.clone()).await;
    let done = sync(&stand, None).await;
    let pages: Vec<u32> = host
        .pages
        .lock()
        .unwrap()
        .iter()
        .filter(|(n, _)| *n == 7)
        .map(|(_, p)| *p)
        .collect();
    assert_eq!(pages, vec![1, 2, 3]);
    assert_eq!(done.comments as i64, host.all_comments());
    assert_eq!(comments_on(&stand.graph).await, expected_comments(&host));
}

#[tokio::test]
async fn the_summary_counts_what_the_repository_holds() {
    let host = Arc::new(FakeGitHub::new(6, 4));
    let stand = stand(host.clone()).await;
    let first = sync(&stand, None).await;
    let quiet = sync(&stand, None).await;

    // Comments: every one GitHub holds, though the quiet sync read none.
    assert_eq!(first.comments as i64, host.all_comments());
    assert_eq!(quiet.comments as i64, host.all_comments());
    let stored_comments = stand
        .graph
        .list(&ctx(), Some(gts::COMMENT_TYPE))
        .await
        .unwrap()
        .len();
    assert_eq!(quiet.comments, stored_comments);

    // Nodes: the repository, its ten items and their comments -- the same
    // after a sync that wrote far fewer.
    let held = 1 + 10 + stored_comments;
    assert_eq!(first.stored, Some(held));
    assert_eq!(quiet.stored, Some(held));
    assert!(
        quiet.nodes_written < held,
        "{} written of {held}",
        quiet.nodes_written
    );
    assert!(first.nodes_written > quiet.nodes_written);
}
