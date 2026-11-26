//! The metrics board's rules, stated as tests.

use std::collections::{BTreeMap, BTreeSet};

use time::macros::{date, datetime};
use uuid::Uuid;

use super::*;

const ORG: Uuid = Uuid::from_u128(0x0);
const WS_A: Uuid = Uuid::from_u128(0xA);
const WS_B: Uuid = Uuid::from_u128(0xB);
const P1: Uuid = Uuid::from_u128(0xA1);
const P2: Uuid = Uuid::from_u128(0xB1);

fn project(id: Uuid, ws: Uuid, ws_name: &str) -> OrgProject {
    OrgProject {
        id,
        name: format!("p{id}"),
        workspace_id: ws,
        workspace_name: ws_name.into(),
    }
}

fn tree() -> Vec<OrgProject> {
    vec![project(P1, WS_A, "Alpha"), project(P2, WS_B, "Beta")]
}

#[test]
fn a_range_is_7_30_or_90_days_and_30_by_default() {
    assert_eq!(Range::parse(None), Some(Range::Month));
    assert_eq!(Range::parse(Some("7d")), Some(Range::Week));
    assert_eq!(Range::parse(Some("90d")), Some(Range::Quarter));
    assert_eq!(Range::parse(Some("365d")), None);
}

#[test]
fn a_week_is_bucketed_by_day_and_ends_today() {
    let s = span(Range::Week, datetime!(2026-11-04 15:00 UTC));
    assert_eq!(s.current_from, date!(2026 - 10 - 29));
    assert_eq!(s.to, date!(2026 - 11 - 04));
    assert_eq!(s.previous_from, date!(2026 - 10 - 22));
    assert_eq!(s.bucket, Bucket::Day);
    assert_eq!(s.buckets.len(), 7);
    assert_eq!(s.buckets[6], date!(2026 - 11 - 04));
}

#[test]
fn a_month_is_bucketed_by_monday_weeks_the_first_one_partial() {
    let s = span(Range::Month, datetime!(2026-11-04 15:00 UTC));
    assert_eq!(s.current_from, date!(2026 - 10 - 06));
    assert_eq!(s.previous_from, date!(2026 - 09 - 06));
    assert_eq!(s.bucket, Bucket::Week);
    // Mon 5 Oct … Mon 2 Nov.
    assert_eq!(s.buckets.first(), Some(&date!(2026 - 10 - 05)));
    assert_eq!(s.buckets.last(), Some(&date!(2026 - 11 - 02)));
    assert_eq!(s.buckets.len(), 5);
    // A bucket's spend is read over its own days inside the window.
    assert_eq!(
        s.bucket_window(date!(2026 - 10 - 05)),
        (
            datetime!(2026-10-06 0:00 UTC),
            datetime!(2026-10-12 0:00 UTC)
        )
    );
    assert_eq!(
        s.bucket_window(date!(2026 - 11 - 02)),
        (
            datetime!(2026-11-02 0:00 UTC),
            datetime!(2026-11-05 0:00 UTC)
        )
    );
    assert_eq!(
        s.previous_window(),
        (
            datetime!(2026-09-06 0:00 UTC),
            datetime!(2026-10-06 0:00 UTC)
        )
    );
}

#[test]
fn a_scope_is_the_organization_or_one_of_its_workspaces_or_projects() {
    let all = tree();
    let ws: BTreeSet<Uuid> = [WS_A, WS_B].into();
    assert_eq!(Scope::Organization.projects(&all, &ws).unwrap().len(), 2);
    let a = Scope::Workspace(WS_A).projects(&all, &ws).unwrap();
    assert_eq!(a.iter().map(|p| p.id).collect::<Vec<_>>(), vec![P1]);
    assert_eq!(Scope::Project(P2).projects(&all, &ws).unwrap()[0].id, P2);
    assert!(
        Scope::Project(Uuid::from_u128(0xFF))
            .projects(&all, &ws)
            .is_none()
    );
    assert!(
        Scope::Workspace(Uuid::from_u128(0xFF))
            .projects(&all, &ws)
            .is_none()
    );
}

#[test]
fn spend_sums_what_is_priced_inside_the_scope_and_names_what_is_not() {
    // As a meter says it: people's own keys are the meter's to leave out
    // (`usage/metering.rs`).
    let item = |tenant: Uuid, cost: Option<f64>, item: &str| metering_port::MeteredItem {
        tenant,
        cost,
        item: item.to_owned(),
    };
    let usage = Metered {
        currency: "EUR".into(),
        items: vec![
            item(P1, Some(10.0), "anthropic/m"),
            item(P2, Some(5.0), "anthropic/m"),
            item(P1, None, "anthropic/unpriced-model"),
        ],
    };
    let all = spent(&usage, None);
    assert!((all.total - 15.0).abs() < 1e-9);
    assert_eq!(
        all.unpriced,
        BTreeSet::from(["anthropic/unpriced-model".to_owned()])
    );
    let p1 = spent(&usage, Some(&BTreeSet::from([P1])));
    assert!((p1.total - 10.0).abs() < 1e-9);
}

#[test]
fn a_projects_spend_is_its_workspaces_and_the_rest_the_organizations() {
    let cur = BTreeMap::from([(P1, 10.0), (WS_A, 1.0), (P2, 30.0), (ORG, 2.0)]);
    let prev = BTreeMap::from([(P1, 4.0)]);
    let rows = by_workspace(ORG, "Org", &tree(), &cur, &prev);
    assert_eq!(rows[0], (WS_B, "Beta".into(), 30.0, 0.0));
    assert_eq!(rows[1], (WS_A, "Alpha".into(), 11.0, 4.0));
    assert_eq!(rows[2], (ORG, "Org".into(), 2.0, 0.0));
}
