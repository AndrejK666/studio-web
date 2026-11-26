//! The meter's rules, stated as tests.

use serde_json::json;
use uuid::Uuid;

use super::*;
use crate::usage::port::TokenCounts;
use crate::usage::{Fact, FactKind};

const P1: Uuid = Uuid::from_u128(0xA1);
const P2: Uuid = Uuid::from_u128(0xB1);

fn call(tenant: Uuid, payer: Payer, input: u64, model: &str) -> Fact {
    Fact {
        tenant,
        kind: FactKind::Llm,
        provider: "anthropic".into(),
        item: model.into(),
        payer: Some(payer),
        tokens: TokenCounts {
            input,
            ..TokenCounts::default()
        },
        ..Fact::default()
    }
}

/// One currency unit per input token of the one priced model.
fn priced(facts: Vec<Fact>) -> PricedUsage {
    PricedUsage::from_parts(
        facts,
        json!({
            "currency": "EUR",
            "models": [{ "provider": "anthropic", "model": "m", "input_per_mtok": 1_000_000.0 }],
        }),
    )
    .unwrap()
}

#[test]
fn the_meter_leaves_out_peoples_own_keys_and_names_what_has_no_price() {
    let m = metered(&priced(vec![
        call(P1, Payer::Organization, 10, "m"),
        call(P2, Payer::Workspace, 5, "m"),
        call(P1, Payer::Personal, 100, "m"),
        call(P1, Payer::Organization, 7, "unpriced-model"),
    ]));
    assert_eq!(m.currency, "EUR");
    let costs: Vec<(Uuid, Option<f64>, &str)> = m
        .items
        .iter()
        .map(|i| (i.tenant, i.cost.map(f64::round), i.item.as_str()))
        .collect();
    assert_eq!(
        costs,
        vec![
            (P1, Some(10.0), "anthropic/m"),
            (P2, Some(5.0), "anthropic/m"),
            (P1, None, "anthropic/unpriced-model"),
        ]
    );
}
