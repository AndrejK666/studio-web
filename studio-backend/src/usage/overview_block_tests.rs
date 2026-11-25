//! The Spend block's rules.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::json;
use time::macros::datetime;
use uuid::Uuid;

use super::*;
use crate::organizations::port::{Row, windows};
use crate::usage::port::TokenCounts;

const ORG: Uuid = Uuid::from_u128(0x0);
const ADA: Uuid = Uuid::from_u128(0xADA);
const ADA_OTHER_LOGIN: Uuid = Uuid::from_u128(0xADA2);
const BOB: Uuid = Uuid::from_u128(0xB0B);
const GONE: Uuid = Uuid::from_u128(0x6011E);

fn member(person: &str, subjects: &[Uuid]) -> RosterMember {
    RosterMember {
        person: person.into(),
        subjects: subjects.iter().map(Uuid::to_string).collect(),
    }
}

fn call(subject: Option<Uuid>, payer: Payer, input: u64, tenant: Uuid) -> Fact {
    Fact {
        tenant,
        person: subject,
        kind: FactKind::Llm,
        provider: "anthropic".into(),
        item: "claude-sonnet-5-5".into(),
        payer: Some(payer),
        tokens: TokenCounts {
            input,
            ..TokenCounts::default()
        },
        ..Fact::default()
    }
}

fn session(tenant: Uuid) -> Fact {
    Fact {
        tenant,
        kind: FactKind::Session,
        provider: "kubernetes".into(),
        item: "ide-session".into(),
        payer: Some(Payer::Organization),
        cpu_millicore_seconds: 1000,
        ..Fact::default()
    }
}

/// One currency unit per input token, one per core-second of a session.
fn priced(facts: Vec<Fact>) -> PricedUsage {
    PricedUsage::from_parts(
        facts,
        json!({
            "currency": "EUR",
            "models": [{ "provider": "anthropic", "model": "claude-sonnet-5-5", "input_per_mtok": 1_000_000.0 }],
            "session": { "cpu_core_hour": 3600.0 },
        }),
    )
    .unwrap()
}

#[test]
fn the_forecast_keeps_the_pace_and_growth_is_said_in_a_word() {
    assert_eq!(forecast(100.0, 10, 31), 310.0);
    assert_eq!(forecast(7.0, 0, 30), 7.0);
    assert_eq!(growth_text(150.0, 100.0), "+50%");
    assert_eq!(growth_text(95.0, 100.0), "−5%");
    assert_eq!(growth_text(100.0, 100.0), "±0%");
    assert_eq!(growth_text(10.0, 0.0), "new");
    assert_eq!(growth_text(0.0, 0.0), "—");
}

#[test]
fn spend_is_a_members_through_any_of_their_sign_ins_and_the_rest_is_said() {
    let members = [
        member("person-ada", &[ADA, ADA_OTHER_LOGIN]),
        member("person-bob", &[BOB]),
    ];
    let subjects = subjects_of(&members);
    let usage = priced(vec![
        call(Some(ADA), Payer::Organization, 3, ORG),
        call(Some(ADA_OTHER_LOGIN), Payer::Organization, 2, ORG),
        // Somebody who left: no active member signs in with it.
        call(Some(GONE), Payer::Organization, 4, ORG),
        // Bob's own key: he used a model, the organization did not pay.
        call(Some(BOB), Payer::Personal, 7, ORG),
        session(ORG),
    ]);
    let who = attribute(&usage, &subjects);
    assert_eq!(who.attributed, 5.0);
    assert_eq!(who.unattributed, 4.0);
    assert_eq!(who.sessions, 1.0);
    assert_eq!(
        who.spenders,
        BTreeSet::from(["person-ada".to_owned(), "person-bob".to_owned()])
    );

    let previous = priced(vec![call(Some(ADA), Payer::Organization, 1, ORG)]);
    let by_person = breakdown(&usage, &previous, GroupBy::Person, false, &subjects);
    let rows: Vec<(&str, f64, f64)> = by_person
        .iter()
        .map(|r| (r.key.as_str(), r.cost, r.previous))
        .collect();
    assert_eq!(
        rows,
        [
            ("person-ada", 5.0, 1.0),
            (UNATTRIBUTED, 4.0, 0.0),
            ("", 1.0, 0.0)
        ]
    );
    // With people's own keys, Bob's spend is his row.
    let with_own = breakdown(&usage, &previous, GroupBy::Person, true, &subjects);
    assert_eq!(with_own[0].key, "person-bob");
    assert_eq!(with_own[0].cost, 7.0);
}

// ── The block ──

const P1: Uuid = Uuid::from_u128(11);

struct Tree {
    at: BlockAt,
    rows: Vec<Row>,
    places: BTreeMap<String, String>,
    members: Vec<RosterMember>,
    names: BTreeMap<String, String>,
}

fn tree() -> Tree {
    let now = datetime!(2026-10-19 12:00 UTC);
    Tree {
        at: BlockAt {
            organization: ORG,
            windows: windows(now),
            now,
            health_only: false,
        },
        rows: vec![Row {
            id: P1,
            name: "Checkout".into(),
            workspace: Some(Uuid::from_u128(1)),
            ..Row::default()
        }],
        places: BTreeMap::from([(P1.to_string(), "Checkout".to_owned())]),
        members: vec![member("person-ada", &[ADA]), member("person-cid", &[])],
        names: BTreeMap::from([("person-ada".to_owned(), "Ada".to_owned())]),
    }
}

impl Tree {
    fn scope(&self) -> BlockScope<'_> {
        BlockScope {
            at: &self.at,
            organization_name: "Acme",
            rows: &self.rows,
            places: &self.places,
            members: Some(&self.members),
            names: &self.names,
        }
    }
}

fn first_line(tile: &TileDto) -> &str {
    tile.lines[0].text["en"].as_str()
}

#[test]
fn without_cost_view_the_tile_says_so_and_nobody_can_be_idle() {
    let t = tree();
    let hidden = answer(&None, &t.scope());
    let tile = hidden.tile.as_ref().unwrap();
    assert_eq!(first_line(tile), "Costs are hidden for you");
    assert!(tile.value.is_none());
    assert_eq!(tile.link.as_ref().unwrap().route, "/costs");
    assert!(hidden.needs.is_empty());
    assert_eq!(hidden.signals.activity, Activity::Unknown);
    assert!(hidden.signals.spend.is_none());
    assert_eq!(hidden.data["costs"], "hidden");

    let unreadable = answer(&Some(Err("collector down".into())), &t.scope());
    assert_eq!(
        first_line(unreadable.tile.as_ref().unwrap()),
        "Costs could not be read"
    );
    assert_eq!(unreadable.data["costs"], "unreadable");
}

#[test]
fn with_costs_spend_is_attributed_grows_and_says_who() {
    let t = tree();
    let spend = Spend {
        current: priced(vec![
            call(Some(ADA), Payer::Organization, 30, P1),
            call(Some(GONE), Payer::Organization, 10, P1),
            call(Some(ADA), Payer::Personal, 6, P1),
        ]),
        previous: priced(vec![call(Some(ADA), Payer::Organization, 20, P1)]),
        month: priced(vec![call(Some(ADA), Payer::Organization, 19, P1)]),
    };
    let a = answer(&Some(Ok(spend)), &t.scope());
    let tile = a.tile.as_ref().unwrap();
    let value = tile.value.as_ref().unwrap();
    assert_eq!(value.args["current"].value, Some(40.0));
    assert_eq!(value.args["current"].currency.as_deref(), Some("EUR"));
    assert_eq!(tile.lines[0].args["growth"].text.as_deref(), Some("+100%"));
    assert_eq!(tile.lines[0].args["forecast"].value, Some(31.0));

    let s = &a.data["spend"];
    assert_eq!(
        (
            s["current"].as_f64(),
            s["previous"].as_f64(),
            s["own_keys"].as_f64()
        ),
        (Some(40.0), Some(20.0), Some(6.0))
    );
    assert_eq!(
        (s["attributed"].as_f64(), s["unattributed"].as_f64()),
        (Some(30.0), Some(10.0))
    );
    assert_eq!(a.data["with_spend"], 1);
    assert_eq!(a.data["per_person"], 30.0);
    // Every grouping, with and without own keys, named where a key is a name.
    let money = a.data["money"].as_array().unwrap();
    assert_eq!(money.len(), 10);
    let people = money
        .iter()
        .find(|m| m["group_by"] == "person" && m["include_personal"] == false)
        .unwrap();
    assert_eq!(people["rows"][0]["label"], "Ada");
    assert_eq!(people["rows"][1]["key"], UNATTRIBUTED);

    // +100%: the need, naming the project that grew.
    assert_eq!(a.needs.len(), 1);
    let need = &a.needs[0];
    assert_eq!(
        need.detail.as_ref().unwrap().args["grower"].text.as_deref(),
        Some("Checkout")
    );
    assert_eq!(need.action.as_ref().unwrap().route, "/costs");

    // What the core's rules read: spend per project, and who spent.
    assert_eq!(a.signals.spend.as_ref().unwrap()[&P1.to_string()], 40.0);
    assert_eq!(a.signals.previous.as_ref().unwrap()[&P1.to_string()], 20.0);
    assert_eq!(
        a.signals.activity,
        Activity::Seen(BTreeSet::from(["person-ada".to_owned()]))
    );
}

#[test]
fn spend_growing_less_than_the_alert_is_not_news() {
    let t = tree();
    let spend = Spend {
        current: priced(vec![call(Some(ADA), Payer::Organization, 11, P1)]),
        previous: priced(vec![call(Some(ADA), Payer::Organization, 10, P1)]),
        month: priced(vec![]),
    };
    assert!(answer(&Some(Ok(spend)), &t.scope()).needs.is_empty());
}
