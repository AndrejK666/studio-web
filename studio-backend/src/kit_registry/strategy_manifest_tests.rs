//! `assembly_strategy` as a kit writes it (ADR-0074 and its amendment): a
//! service strategy speaks a known contract and requires the Gears matcher
//! kit, whose pipeline runs it; the shipped ids stay their kits'.

use super::*;

fn kit(slug: &str, requires: &[&str], strategy: serde_json::Value) -> String {
    serde_json::json!({
        "slug": slug,
        "name": "Acme",
        "levels": ["organization"],
        "requires": requires,
        "assembly_strategy": strategy,
    })
    .to_string()
}

#[test]
fn an_organization_kit_brings_a_service_strategy() {
    let m = read_kit_json(&kit(
        "acme-matcher",
        &["gears-matcher"],
        serde_json::json!({"id": "acme_matcher", "name": "Acme matcher",
            "service": {"contract": "gears-matcher/v1"}}),
    ))
    .unwrap();
    let s = m.assembly_strategy.unwrap();
    assert_eq!(s.id, "acme_matcher");
    assert_eq!(s.service.unwrap().contract, "gears-matcher/v1");
}

#[test]
fn a_strategy_section_that_does_not_check_is_refused() {
    let refused = |slug: &str, requires: &[&str], s: serde_json::Value, says: &str| {
        let e = read_kit_json(&kit(slug, requires, s))
            .unwrap_err()
            .to_string();
        assert!(e.contains(says), "{e}");
    };
    // No service: only Spec mapping runs in Studio's own code.
    refused(
        "acme-matcher",
        &["gears-matcher"],
        serde_json::json!({"id": "acme", "name": "Acme"}),
        "assembly_strategy.service",
    );
    // A contract Studio does not speak.
    refused(
        "acme-matcher",
        &["gears-matcher"],
        serde_json::json!({"id": "acme", "name": "Acme", "service": {"contract": "acme/v9"}}),
        "not one Studio speaks",
    );
    // The pipeline is the Gears matcher kit's.
    refused(
        "acme-matcher",
        &[],
        serde_json::json!({"id": "acme", "name": "Acme",
            "service": {"contract": "gears-matcher/v1"}}),
        "add `gears-matcher` to `requires`",
    );
    // The shipped ids are their kits'.
    refused(
        "acme-matcher",
        &["gears-matcher"],
        serde_json::json!({"id": "gears_matcher", "name": "Acme",
            "service": {"contract": "gears-matcher/v1"}}),
        "is the `gears-matcher` kit's",
    );
    refused(
        "acme-matcher",
        &[],
        serde_json::json!({"id": "spec_mapping", "name": "Acme"}),
        "is the `spec-mapping` kit's",
    );
}

#[test]
fn the_shipped_kits_declare_their_strategies() {
    let gm = builtin_manifest("gears-matcher")
        .unwrap()
        .assembly_strategy
        .unwrap();
    assert_eq!(gm.id, "gears_matcher");
    assert_eq!(gm.service.unwrap().contract, "gears-matcher/v1");
    let sm = builtin_manifest("spec-mapping")
        .unwrap()
        .assembly_strategy
        .unwrap();
    assert_eq!(sm.id, "spec_mapping");
    assert!(sm.service.is_none());
}
