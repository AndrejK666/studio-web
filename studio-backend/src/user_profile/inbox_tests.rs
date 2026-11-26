// Ported from the portal's waiting-on-me.test.ts at 00828880.

use serde_json::json;
use time::macros::datetime;

use super::*;

// The kits' sources this file reads through the Inbox port: project-specs'
// and project-git's.
const REVIEW_REQUESTS: &str = "review-requests";
const PULL_REQUESTS: &str = "pull-requests";

fn items_of(workspace_id: &str, workspace_name: &str, reviews: Vec<Value>, pulls: Vec<Value>) -> Vec<Item> {
    super::items_of(workspace_id, workspace_name, vec![reviews, pulls])
}

fn review_key(r: &Value) -> String {
    format!("review:{}", r["id"].as_str().unwrap_or_default())
}

fn pull_key(p: &Value) -> String {
    format!(
        "pr:{}@{}",
        p["id"].as_str().unwrap_or_default(),
        p["updated_at"].as_str().unwrap_or_default()
    )
}

fn review(id: &str, due: Option<&str>, overdue: bool) -> Value {
    json!({"id": id, "title": id, "due_at": due, "overdue": overdue})
}

fn pull(id: &str) -> Value {
    json!({"id": id, "updated_at": "2026-10-13T09:00:00Z"})
}

fn mark(key: &str, state: &str, until: Option<OffsetDateTime>) -> Mark {
    Mark {
        item_key: key.into(),
        state: state.into(),
        until,
    }
}

const NOW: OffsetDateTime = datetime!(2026-10-13 12:00:00 UTC);

#[test]
fn overdue_reviews_first_then_by_due_date_then_pull_requests() {
    let items = items_of(
        "w",
        "W",
        vec![
            review("later", Some("2026-10-20T23:59:59Z"), false),
            review("none", None, false),
            review("late", Some("2026-10-10T23:59:59Z"), true),
            review("soon", Some("2026-10-14T23:59:59Z"), false),
        ],
        vec![pull("p1"), pull("p2")],
    );
    let (open, hidden) = inbox(items, &[], NOW);
    let ids: Vec<&str> = open
        .iter()
        .map(|i| i.record["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["late", "soon", "later", "none", "p1", "p2"]);
    assert!(hidden.is_empty());
    assert_eq!(open[4].source, PULL_REQUESTS);
    assert_eq!(open[0].source, REVIEW_REQUESTS);
}

#[test]
fn what_is_done_or_snoozed_until_later_is_hidden_and_listed_apart() {
    let marks = [
        mark(&review_key(&review("a", None, false)), "done", None),
        mark(
            &review_key(&review("b", None, false)),
            "snoozed",
            Some(datetime!(2026-10-14 00:00:00 UTC)),
        ),
        mark(
            &review_key(&review("c", None, false)),
            "snoozed",
            Some(datetime!(2026-10-13 11:00:00 UTC)),
        ),
        mark(&pull_key(&pull("p1")), "done", None),
        mark("review:gone", "done", None),
    ];
    let items = items_of(
        "w",
        "W",
        vec![
            review("a", None, false),
            review("b", None, false),
            review("c", None, false),
        ],
        vec![pull("p1")],
    );
    let (open, hidden) = inbox(items, &marks, NOW);
    let keys = |is: &[Item]| is.iter().map(|i| i.key.clone()).collect::<Vec<_>>();
    assert_eq!(keys(&open), ["review:c"]);
    // Only items still on a list: a mark for one that is gone is not hidden.
    assert_eq!(
        keys(&hidden),
        ["review:a", "review:b", "pr:p1@2026-10-13T09:00:00Z"]
    );
}

#[test]
fn a_pull_request_comes_back_when_it_moves_again() {
    let done = [mark(&pull_key(&pull("p1")), "done", None)];
    let moved = json!({"id": "p1", "updated_at": "2026-10-13T11:30:00Z"});
    let (open, _) = inbox(items_of("w", "W", Vec::new(), vec![moved]), &done, NOW);
    assert_eq!(open.len(), 1);
}

/// The backend's routes as the Inbox calls them, recording each path:
/// two workspaces, a review and a pull request in each, a kit source.
async fn backend() -> (Api, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
    use axum::extract::Request;
    let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let seen = calls.clone();
    let app = axum::Router::new().fallback(move |req: Request| {
        let seen = seen.clone();
        async move {
            let path = req.uri().path().to_string();
            let query = req.uri().query().unwrap_or_default().to_string();
            seen.lock().unwrap().push(path.clone());
            let ws = if query.contains("workspace_id=w2") {
                "w2"
            } else {
                "w1"
            };
            let body = match path.as_str() {
                "/studio-kits/v1/inbox-sources" => json!({"items": [
                    studio_source("project-specs", REVIEW_REQUESTS),
                    studio_source("project-git", PULL_REQUESTS),
                    {"kit_slug": "project-lifecycle", "kit_name": "Project lifecycle",
                     "kit_version": "1.0.0", "kind": "query", "id": "phase-waiting",
                     "label": "Phases", "query": {"type": "project"}, "destination": null},
                ]}),
                "/studio-documents/v1/review-requests" => {
                    json!({"items": [review(&format!("r-{ws}"), None, false)]})
                }
                "/studio-artifact-ingest/v1/open-pull-requests" => json!({
                    "items": [pull(&format!("p-{ws}"))], "total": 1, "members_known": true}),
                "/studio-tasks/v1/runs" => json!({"items": []}),
                "/studio-domain-model/v1/query" => json!({"items": []}),
                _ => {
                    return (
                        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                        axum::Json(json!({"detail": "not expected"})),
                    );
                }
            };
            (axum::http::StatusCode::OK, axum::Json(body))
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let api = Api::new(reqwest::Client::new(), &format!("http://{addr}"), None);
    (api, calls)
}

/// What Dev showed (#1077): the Inbox asked `GET /rollups` -- every
/// project's counts, 10 s at the median -- for the workspace list alone.
/// It is handed the list now, and calls no route of the organizations gear.
#[tokio::test]
async fn the_inbox_reads_its_sources_without_asking_for_rollups() {
    let (api, calls) = backend().await;
    let spaces = vec![
        ("w1".to_string(), "One".to_string()),
        ("w2".to_string(), "Two".to_string()),
    ];
    let read = read(&api, "u-7", Some("org-1"), async { Ok(spaces) }).await;
    assert!(read.unread.is_empty(), "{:?}", read.unread);
    assert_eq!(read.workspaces, 2);
    let keys: Vec<(&str, &str)> = read
        .items
        .iter()
        .map(|i| (i.source.as_str(), i.workspace_id.as_str()))
        .collect();
    // In the order the portal put them: every workspace's reviews, then
    // every workspace's pull requests.
    assert_eq!(
        keys,
        [
            (REVIEW_REQUESTS, "w1"),
            (REVIEW_REQUESTS, "w2"),
            (PULL_REQUESTS, "w1"),
            (PULL_REQUESTS, "w2"),
        ]
    );
    let calls = calls.lock().unwrap().clone();
    assert!(
        !calls
            .iter()
            .any(|p| p.starts_with("/studio-organizations/")),
        "{calls:?}"
    );
    assert_eq!(
        calls
            .iter()
            .filter(|p| p.as_str() == "/studio-domain-model/v1/query")
            .count(),
        1,
        "the kit's source is read once"
    );
}

/// A workspace list that could not be read is named, and the rest is still
/// read.
#[tokio::test]
async fn workspaces_that_could_not_be_listed_are_named_not_shown_as_none() {
    let (api, _) = backend().await;
    let read = read(&api, "u-7", None, async {
        Err("account-management: unavailable".to_string())
    })
    .await;
    assert_eq!(read.workspaces, 0);
    assert_eq!(read.unread, ["workspaces: account-management: unavailable"]);
}

#[test]
fn a_kit_s_source_names_the_person_as_me() {
    let q = json!({"type": "project", "where": {"_and": [{"phase_owner": {"_eq": "$me"}}, {"phase": {"_in": ["idea"]}}]}});
    let q = with_me(&q, "u-7");
    assert_eq!(q["where"]["_and"][0]["phase_owner"]["_eq"], "u-7");
    assert_eq!(q["where"]["_and"][1]["phase"]["_in"][0], "idea");
}

#[test]
fn a_kit_s_title_is_filled_from_the_row() {
    let row = json!({"name": "Atlas", "phase": "build", "n": 3});
    assert_eq!(
        fill("{name} waits in its {phase} phase", &row),
        "Atlas waits in its build phase"
    );
    assert_eq!(fill("{n} of {missing}{", &row), "3 of {");
}

#[test]
fn a_kit_s_rows_are_items_that_carry_their_kit() {
    let source = json!({"kit_slug": "project-lifecycle", "kit_name": "Project lifecycle", "kit_version": "1.0.0",
        "id": "phase-waiting", "label": "A project waiting", "title": "{name} waits in its {phase} phase",
        "workspace_field": "parent_tenant_id"});
    let row = |phase: &str| {
        json!({"id": "obj-1", "entity": "project",
        "value": {"name": "Atlas", "phase": phase, "parent_tenant_id": "w1"}})
    };
    let spaces = [("w1".to_string(), "One".to_string())];
    let items = kit_items(&source, vec![row("idea")], &spaces);
    assert_eq!(items.len(), 1);
    let item = &items[0];
    assert_eq!(item.source, "kit:project-lifecycle/phase-waiting");
    assert_eq!(item.title, "Atlas waits in its idea phase");
    assert_eq!(
        (item.workspace_id.as_str(), item.workspace_name.as_str()),
        ("w1", "One")
    );
    let kit = item.kit.as_ref().unwrap();
    assert_eq!(
        (kit.slug.as_str(), kit.name.as_str()),
        ("project-lifecycle", "Project lifecycle")
    );
    assert!(
        item.key
            .starts_with("kit:project-lifecycle/phase-waiting:obj-1@")
    );
    // Marked done, it comes back when its object moves on.
    let moved = kit_items(&source, vec![row("discovery")], &spaces);
    assert_ne!(moved[0].key, item.key);
    assert_eq!(
        kit_items(&source, vec![row("idea")], &spaces)[0].key,
        item.key
    );
    // Ordered with the rest: not overdue, no due date.
    let (open, _) = inbox(items, &[], NOW);
    assert_eq!(open.len(), 1);
}

#[test]
fn an_endpoint_source_s_items_are_what_its_route_answers() {
    let source = json!({
        "kit_slug": "constructor-research", "kit_name": "Constructor Research",
        "kit_version": "0.9.0", "id": "deploy-failed", "label": "A Research deploy failed",
        "kind": "endpoint", "path": "/studio-environments/v1/research/inbox/deploys"
    });
    let spaces = vec![("w1".to_owned(), "Web".to_owned())];
    let items = endpoint_items(
        &source,
        vec![
            json!({"id": "d1", "title": "Shop: the deploy failed", "workspace_id": "w1",
                   "due_at": "2026-11-20T00:00:00Z", "overdue": true}),
            json!({"title": "no id: left out"}),
            json!({"id": 7}),
        ],
        &spaces,
    );
    assert_eq!(items.len(), 2);
    let first = &items[0];
    assert_eq!(first.source, "kit:constructor-research/deploy-failed");
    assert!(
        first
            .key
            .starts_with("kit:constructor-research/deploy-failed:d1@")
    );
    assert_eq!(first.title, "Shop: the deploy failed");
    assert_eq!(
        (first.workspace_id.as_str(), first.workspace_name.as_str()),
        ("w1", "Web")
    );
    assert_eq!(first.due_at.as_deref(), Some("2026-11-20T00:00:00Z"));
    assert!(first.overdue);
    assert_eq!(first.kit.as_ref().unwrap().name, "Constructor Research");
    // No title of its own: the source's label.
    assert_eq!(items[1].title, "A Research deploy failed");
    assert!(items[1].key.contains(":7@"));
    // A changed item is a new one: a done mark does not hide it.
    let again = endpoint_items(
        &source,
        vec![json!({"id": "d1", "title": "other"})],
        &spaces,
    );
    assert_ne!(again[0].key, first.key);
    // The source's template wins over the item's title.
    let templated = json!({"kit_slug": "k", "id": "s", "label": "L", "title": "{name} waits",
                           "kind": "endpoint"});
    let items = endpoint_items(&templated, vec![json!({"id": "1", "name": "Atlas"})], &[]);
    assert_eq!(items[0].title, "Atlas waits");
}

#[test]
fn an_endpoint_source_calls_only_studio_s_own_routes() {
    assert!(endpoint_path_allowed(
        "/studio-environments/v1/research/inbox/deploys"
    ));
    for bad in [
        "https://evil.example/studio-x/v1/y",
        "/studio-environments/v1/x?all=1",
        "/studio-environments/v1/../v2/x",
        "/studio-environments/v1/{id}",
        "/api/v1/x",
        "//studio-x/v1/y",
    ] {
        assert!(!endpoint_path_allowed(bad), "{bad}");
    }
}

#[test]
fn a_failed_run_of_the_person_waits_on_them_for_a_week() {
    let now = time::OffsetDateTime::parse(
        "2026-11-11T12:00:00Z",
        &time::format_description::well_known::Rfc3339,
    )
    .unwrap();
    let run = |id: &str, by: &str, state: &str, at: &str| {
        serde_json::json!({
            "id": id, "requested_by": by, "state": state, "updated_at": at,
            "task_type": "notify.send", "last_error": "the channel refused it",
        })
    };
    let items = failed_run_items(
        vec![
            run("old", "me", "failed", "2026-11-01T12:00:00Z"),
            run("a", "me", "failed", "2026-11-09T12:00:00Z"),
            run("b", "me", "failed", "2026-11-10T12:00:00Z"),
            run("theirs", "you", "failed", "2026-11-10T12:00:00Z"),
            run("fine", "me", "succeeded", "2026-11-10T12:00:00Z"),
        ],
        "me",
        now,
    );
    let keys: Vec<&str> = items.iter().map(|i| i.key.as_str()).collect();
    assert_eq!(keys, ["run:b", "run:a"]);
    assert_eq!(items[0].source, FAILED_RUNS);
    assert_eq!(items[0].title, "notify.send failed: the channel refused it");
}

// ── Studio's own sources belong to kits (ADR-0070 §7) ──

fn studio_source(kit: &str, id: &str) -> Value {
    json!({"kit_slug": kit, "kit_name": kit, "kit_version": "1.0.0", "kind": "studio",
        "id": id, "label": id, "query": null, "destination": null})
}

#[test]
fn studio_s_own_sources_are_read_only_where_their_kits_list_them() {
    let specs = studio_source("project-specs", REVIEW_REQUESTS);
    let git = studio_source("project-git", PULL_REQUESTS);
    let other = json!({"kit_slug": "delivery", "kind": "endpoint",
        "id": "deploys-awaiting-approval", "path": "/studio-environments/v1/inbox/x"});

    // Both kits installed: both sources, each with its kit.
    let both = [specs.clone(), git.clone(), other.clone()];
    assert_eq!(owner(Some(&both), REVIEW_REQUESTS), Some(Some(specs.clone())));
    assert_eq!(owner(Some(&both), PULL_REQUESTS), Some(Some(git.clone())));

    // Without project-specs: no review requests.
    let no_specs = [git.clone(), other.clone()];
    assert!(owner(Some(&no_specs), REVIEW_REQUESTS).is_none());
    assert!(owner(Some(&no_specs), PULL_REQUESTS).is_some());

    // An organization with no kits at all: neither.
    assert!(owner(Some(&[]), REVIEW_REQUESTS).is_none());
    assert!(owner(Some(&[]), PULL_REQUESTS).is_none());

    // A source of the same id that is not Studio's kind turns nothing on.
    let mut endpoint = git.clone();
    endpoint["kind"] = json!("endpoint");
    assert!(owner(Some(&[endpoint]), PULL_REQUESTS).is_none());

    // The kits could not be read: both are read, as the shell's.
    assert_eq!(owner(None, REVIEW_REQUESTS), Some(None));
    assert_eq!(owner(None, PULL_REQUESTS), Some(None));
}

/// The sources are the kits' gears', registered through the Inbox port, in
/// the order their items are listed.
#[test]
fn the_registered_sources_are_reviews_then_pull_requests() {
    let ids: Vec<&str> = super::super::port::sources().iter().map(|s| s.id).collect();
    assert_eq!(ids, [REVIEW_REQUESTS, PULL_REQUESTS]);
}

#[test]
fn an_item_of_studio_s_own_source_names_its_kit_and_keeps_its_key() {
    let items = items_of(
        "w1",
        "Payments",
        vec![review("r1", None, false)],
        vec![pull("p1")],
    );
    let git = studio_source("project-git", PULL_REQUESTS);
    let (reviews, pulls): (Vec<Item>, Vec<Item>) =
        items.into_iter().partition(|i| i.source == REVIEW_REQUESTS);
    let pulls = owned_by(pulls, Some(&git));
    assert_eq!(pulls[0].source, PULL_REQUESTS);
    assert_eq!(
        pulls[0].key, "pr:p1@2026-10-13T09:00:00Z",
        "marks still apply"
    );
    assert_eq!(
        pulls[0].kit,
        Some(ItemKit {
            slug: "project-git".into(),
            name: "project-git".into(),
            version: "1.0.0".into()
        })
    );
    // Without an owner, an item stays the shell's.
    let reviews = owned_by(reviews, None);
    assert!(reviews[0].kit.is_none());
}
