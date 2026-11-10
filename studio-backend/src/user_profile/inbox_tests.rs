// Ported from the portal's waiting-on-me.test.ts at 00828880.

use serde_json::json;
use time::macros::datetime;

use super::*;

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

#[test]
fn a_person_s_pull_requests_wait_on_their_review_first_then_longest_quiet() {
    let ordered = pulls_in_order(vec![
        json!({"id": "a", "waiting": "author", "days_since_update": 9}),
        json!({"id": "r1", "waiting": "review", "days_since_update": 1}),
        json!({"id": "r2", "waiting": "review", "days_since_update": 5}),
    ]);
    let ids: Vec<&str> = ordered.iter().map(|p| p["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["r2", "r1", "a"]);
}

#[test]
fn the_workspaces_are_the_rollups_workspace_rows() {
    let r = json!({"items": [
        {"kind": "workspace", "id": "w1", "name": "One"},
        {"kind": "project", "id": "p1", "name": "P"}]});
    assert_eq!(workspaces(&r), [("w1".to_string(), "One".to_string())]);
}
