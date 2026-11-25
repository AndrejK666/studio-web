//! The Overview port: blocks collected by level and kit, and their signals
//! merged.

use std::collections::{BTreeMap, BTreeSet};

use super::*;

/// A block that answers nothing; only its registration is tested.
struct Quiet;

#[async_trait]
impl BlockSource for Quiet {
    async fn answer(
        &self,
        _hub: &ClientHub,
        _ctx: &SecurityContext,
        _prepared: Prepared,
        _scope: &BlockScope<'_>,
    ) -> Option<BlockAnswer> {
        None
    }
}

// Registered at the project level, which nothing collects yet, so the
// organization's real blocks are not disturbed.
inventory::submit! {
    OverviewBlock { kit: "test-kit-b", gear: "test", id: "second", order: 2, level: Level::Project, source: &Quiet }
}
inventory::submit! {
    OverviewBlock { kit: "test-kit-a", gear: "test", id: "first", order: 1, level: Level::Project, source: &Quiet }
}

fn ids(blocks: &[&'static OverviewBlock]) -> Vec<&'static str> {
    blocks.iter().map(|b| b.id).collect()
}

#[test]
fn blocks_come_in_their_order_and_only_where_their_kit_is_installed() {
    assert_eq!(ids(&registered(Level::Project)), ["first", "second"]);
    assert_eq!(
        ids(&applicable(Level::Project, &Kits::All)),
        ["first", "second"]
    );
    let only_b = Kits::Only(vec!["test-kit-b".into()]);
    assert_eq!(ids(&applicable(Level::Project, &only_b)), ["second"]);
    assert!(applicable(Level::Project, &Kits::Only(vec![])).is_empty());
}

#[test]
fn the_kits_own_blocks_are_registered_by_their_gears() {
    let org: Vec<(&str, &str)> = registered(Level::Organization)
        .iter()
        .map(|b| (b.kit, b.id))
        .collect();
    assert_eq!(
        org,
        [
            ("org-costs", "spend"),
            ("project-git", "delivery"),
            ("project-specs", "specs"),
            ("components", "decisions"),
        ]
    );
    // Without the Git kit, its block is not asked.
    let kits = Kits::Only(vec!["org-costs".into(), "components".into()]);
    assert_eq!(
        ids(&applicable(Level::Organization, &kits)),
        ["spend", "decisions"]
    );
}

fn seen(people: &[&str]) -> Activity {
    Activity::Seen(people.iter().map(|p| (*p).to_owned()).collect())
}

#[test]
fn signals_merge_spend_once_stuck_work_adds_up_and_unknown_wins() {
    let spend = Signals {
        spend: Some(BTreeMap::from([("p".into(), 3.0)])),
        previous: Some(BTreeMap::new()),
        activity: seen(&["ada"]),
        ..Signals::default()
    };
    let pulls = Signals {
        stuck: Some(BTreeMap::from([("p".into(), 2)])),
        activity: seen(&["bob"]),
        ..Signals::default()
    };
    let more = Signals {
        stuck: Some(BTreeMap::from([("p".into(), 1), ("q".into(), 1)])),
        ..Signals::default()
    };
    let all = merge([spend.clone(), pulls.clone(), more]);
    assert_eq!(all.spend, spend.spend);
    assert_eq!(
        all.stuck,
        Some(BTreeMap::from([("p".into(), 3), ("q".into(), 1)]))
    );
    assert_eq!(
        all.activity,
        Activity::Seen(BTreeSet::from(["ada".to_owned(), "bob".to_owned()]))
    );

    // A block that would say who works but could not: nobody is idle.
    let hidden = Signals {
        activity: Activity::Unknown,
        ..Signals::default()
    };
    assert_eq!(merge([pulls, hidden]).activity, Activity::Unknown);
    // Nobody says anything: no spend, no stuck work, nothing about people.
    assert_eq!(merge([]), Signals::default());
}
