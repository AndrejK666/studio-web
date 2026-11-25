//! The Delivery block's rules.

use std::collections::{BTreeMap, BTreeSet};

use time::macros::datetime;
use uuid::Uuid;

use super::*;
use crate::organizations::port::{BlockAt, Row, windows};

const P1: Uuid = Uuid::from_u128(11);

fn pull(waiting: &str, on: &[&str], since: u32) -> OpenPull {
    OpenPull {
        id: "pull-1".into(),
        number: 1,
        title: "Update checkout".into(),
        url: None,
        project_id: Some(P1.to_string()),
        author: Some("dev".into()),
        waiting: waiting.into(),
        waiting_on: on.iter().map(|s| (*s).to_owned()).collect(),
        reviewers: on.iter().map(|s| (*s).to_owned()).collect(),
        days_open: Some(since + 2),
        days_since_update: Some(since),
    }
}

#[test]
fn a_pull_request_is_stuck_after_seven_days_and_a_draft_never_is() {
    let pulls = [
        pull("review", &["ann"], 8),
        pull("review", &["ann"], 2),
        pull("draft", &[], 30),
        pull("nobody", &[], 7),
    ];
    assert_eq!(stuck(&pulls, STUCK_DAYS).len(), 2);
}

#[test]
fn stuck_work_is_queued_by_the_person_it_waits_on() {
    let pulls = [
        pull("review", &["ann-gh", "bob"], 9),
        pull("review", &["ann-work"], 12),
        pull("nobody", &[], 8),
    ];
    let stuck = stuck(&pulls, STUCK_DAYS);
    // Ann has two accounts; both are the same member.
    let member = |login: &str| {
        login
            .starts_with("ann")
            .then(|| ("person-ann".to_owned(), Some("Ann Lee".to_owned())))
    };
    let queues = waiting_on(&stuck, &member);
    let summary: Vec<(Option<&str>, Option<&str>, u32, u32)> = queues
        .iter()
        .map(|q| {
            (
                q.person_id.as_deref(),
                q.who.as_deref(),
                q.count,
                q.oldest_days,
            )
        })
        .collect();
    assert_eq!(
        summary,
        [
            (Some("person-ann"), Some("Ann Lee"), 2, 12),
            (None, Some("bob"), 1, 9),
            (None, None, 1, 8),
        ]
    );
}

#[test]
fn a_pull_requests_repository_is_read_off_its_address() {
    assert_eq!(
        repository_of("https://github.com/acme/shop/pull/12").as_deref(),
        Some("acme/shop")
    );
    assert_eq!(
        repository_of("https://gitlab.com/g/sub/proj/-/merge_requests/3").as_deref(),
        Some("g/sub/proj")
    );
    assert_eq!(repository_of("ftp://x/y/pull/1"), None);
}

struct Tree {
    at: BlockAt,
    rows: Vec<Row>,
    places: BTreeMap<String, String>,
    names: BTreeMap<String, String>,
}

fn tree() -> Tree {
    let now = datetime!(2026-10-19 12:00 UTC);
    Tree {
        at: BlockAt {
            organization: Uuid::nil(),
            windows: windows(now),
            now,
            health_only: false,
        },
        rows: vec![Row {
            id: P1,
            name: "Checkout".into(),
            workspace: Some(Uuid::from_u128(1)),
            pulls_open: Some(2),
            pulls_merged: Some(5),
            ..Row::default()
        }],
        places: BTreeMap::from([(P1.to_string(), "Checkout".to_owned())]),
        names: BTreeMap::new(),
    }
}

impl Tree {
    fn scope(&self) -> BlockScope<'_> {
        BlockScope {
            at: &self.at,
            organization_name: "Acme",
            rows: &self.rows,
            places: &self.places,
            members: None,
            names: &self.names,
        }
    }
}

#[test]
fn the_tile_counts_the_projects_pull_requests_and_the_queues_are_needs() {
    let t = tree();
    let pulls = vec![
        pull("review", &["ada-gh"], 9),
        OpenPull {
            id: "lonely".into(),
            url: Some("https://github.com/acme/shop/pull/7".into()),
            ..pull("nobody", &[], 8)
        },
        OpenPull {
            id: "team-review".into(),
            ..pull("review", &[], 12)
        },
        OpenPull {
            id: "recent".into(),
            ..pull("nobody", &[], 2)
        },
    ];
    let accounts = BTreeMap::from([(
        "ada-gh".to_owned(),
        ("person-ada".to_owned(), Some("Ada".to_owned())),
    )]);
    let a = answer(Some(&pulls), &accounts, &t.scope());
    let tile = a.tile.as_ref().unwrap();
    assert_eq!(tile.value.as_ref().unwrap().args["merged"].value, Some(5.0));
    assert_eq!(tile.lines[0].args["open"].value, Some(2.0));
    assert_eq!(tile.link.as_ref().unwrap().route, WORKSPACES_ROUTE);

    // Ada's queue and the queue nobody was asked to review; a team review
    // waits on nobody in particular and is in no queue.
    let keys: Vec<&str> = a.needs.iter().map(|n| n.key.as_str()).collect();
    assert_eq!(keys, ["queue:person-ada", "queue:nobody"]);
    let nobody = &a.needs[1];
    let details = nobody.details.as_ref().unwrap();
    assert_eq!(details.rows.len(), 1);
    assert_eq!(details.rows[0].text, "#1 Update checkout");
    assert_eq!(
        details.rows[0].href.as_deref(),
        Some("https://github.com/acme/shop/pull/7")
    );
    assert_eq!(
        details.rows[0].note[1].args["repo"].text.as_deref(),
        Some("acme/shop")
    );
    assert_eq!(a.data["pulls_without_reviewers"][0]["id"], "lonely");

    // The core's rules: three stuck in the project, and Ada seen at work.
    assert_eq!(a.signals.stuck.as_ref().unwrap()[&P1.to_string()], 3);
    assert_eq!(
        a.signals.activity,
        Activity::Seen(BTreeSet::from(["person-ada".to_owned()]))
    );
}

#[test]
fn without_a_pull_request_source_the_figures_are_unknown_and_nobody_waits() {
    let t = tree();
    let a = answer(None, &BTreeMap::new(), &t.scope());
    assert!(a.needs.is_empty());
    assert!(a.signals.stuck.is_none());
    assert_eq!(a.signals.activity, Activity::Silent);
    assert!(a.data["waiting_on"].is_null());
    // The merged count is the rows', read apart.
    assert_eq!(a.data["merged"], 5);
    assert!(a.data["median_wait_days"].is_null());
}
