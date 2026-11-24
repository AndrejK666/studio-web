//! The build tests of ADR-0071 §3: every type a gear declares is claimed by
//! exactly one built-in kit or is core, every MCP tool a gear serves is
//! claimed by exactly one built-in kit or is the shell's, and every claim
//! names something real.

#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::collections::{BTreeMap, BTreeSet};

use super::super::manifest::read_kit_json;
use super::*;
use crate::domain_model::port::TypeNeed;

/// `(gear, type id)` of every type a gear declares through its `TypeNeed`,
/// held or open, read from the gears' own declarations.
fn declared() -> BTreeSet<(String, String)> {
    let mut needs: Vec<TypeNeed> = Vec::new();
    needs.extend(crate::artifact_ingest::declared_types());
    needs.extend(crate::documents::declared_types());
    needs.extend(crate::components_catalog::declared_types());
    needs.extend(crate::organizations::declared_view_types());
    needs.extend(crate::product::declared_types());
    needs.extend(crate::reports::declared_types());
    for kinds in [
        crate::connectors::gts::MODEL_KINDS,
        crate::environments::MODEL_KINDS,
        super::super::service::MODEL_KINDS,
        crate::organizations::project_types::MODEL_KINDS,
        crate::usage::MODEL_KINDS,
    ] {
        needs.extend(crate::model_metadata::declared_types(kinds));
    }
    needs.into_iter().map(|n| (n.declared_by, n.id)).collect()
}

/// Every gear's MCP tools, by the gear that serves them.
fn tools_by_gear() -> BTreeMap<&'static str, &'static str> {
    crate::mcp::tools_by_gear()
        .into_iter()
        .map(|(gear, t)| (t.name, gear))
        .collect()
}

#[test]
fn a_gears_claims_name_every_kit_that_stands_for_it() {
    let claims = builtin_gear_claims("studio-artifact-ingest");
    assert!(
        claims.iter().any(|c| c.kit == "project-tests"
            && c.types.iter().any(|t| t == "ci-run")
            && !c.kit_name.is_empty()),
        "{claims:?}"
    );
    // Case-blind, and nothing for a gear no kit names.
    assert_eq!(builtin_gear_claims("STUDIO-ARTIFACT-INGEST"), claims);
    assert!(builtin_gear_claims("no-such-gear").is_empty());
    assert!(builtin_gear_claims(" ").is_empty());
}

/// Studio's running core types: the seed's types no kit owns.
fn running_core() -> BTreeSet<String> {
    let seed: serde_json::Value =
        serde_json::from_str(include_str!("../domain_model/ontology.studio.json")).unwrap();
    seed["entities"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| {
            e.pointer("/meta/kit")
                .is_none_or(serde_json::Value::is_null)
        })
        .filter_map(|e| e["id"].as_str().map(str::to_owned))
        .collect()
}

#[test]
fn every_built_in_kit_has_a_kit_json_and_the_claims_do_not_conflict() {
    for kit in builtin_catalogue() {
        assert!(
            builtin_manifest(&kit.slug).is_some(),
            "`{}` has no compiled-in kit.json (ADR-0071 §6)",
            kit.slug
        );
    }
    Claims::of(&builtin_manifests()).expect("one kit per type, tool and route");
}

#[test]
fn every_type_a_gear_declares_is_claimed_once_or_core() {
    let claims = Claims::builtin();
    let core = running_core();
    let mut unclaimed = Vec::new();
    for (gear, id) in declared() {
        match claims.type_claim(&id) {
            Some(_) => assert!(
                !is_core_gear_type(&id),
                "`{id}` is claimed and listed as core"
            ),
            None if is_core_gear_type(&id) || core.contains(&id) => {}
            None => unclaimed.push(format!("{gear}: {id}")),
        }
    }
    assert!(
        unclaimed.is_empty(),
        "types a gear declares that no built-in kit claims and the core list does not \
         name (ADR-0071 §3, §7): {unclaimed:?}"
    );
}

#[test]
fn every_claimed_type_is_one_the_claimed_gear_declares() {
    let declared = declared();
    for (id, claim) in Claims::builtin().types() {
        assert!(
            declared.contains(&(claim.gear.clone(), id.to_owned())),
            "`{}` claims `{id}` of `{}`, which does not declare it",
            claim.kit,
            claim.gear
        );
    }
    for (id, _) in CORE_GEAR_TYPES {
        assert!(
            declared.iter().any(|(_, t)| t == id),
            "the core gear type `{id}` is declared by no gear"
        );
    }
}

#[test]
fn a_type_moved_out_of_the_core_is_claimed_by_the_kit_it_moved_to() {
    let seed: serde_json::Value =
        serde_json::from_str(include_str!("../domain_model/ontology.studio.json")).unwrap();
    for (key, kit) in seed["moved_to_kits"].as_object().unwrap() {
        if let Some(claim) = Claims::builtin().type_claim(key) {
            assert_eq!(claim.kit, kit.as_str().unwrap(), "`{key}`");
        }
    }
}

#[test]
fn every_tool_a_gear_serves_is_claimed_once_or_the_shells() {
    let claims = Claims::builtin();
    let by_gear = tools_by_gear();
    let all: BTreeSet<&str> = crate::mcp::tools().iter().map(|t| t.name).collect();
    assert_eq!(
        all,
        by_gear.keys().copied().collect(),
        "the test reads every gear's tools"
    );
    let mut unclaimed = Vec::new();
    for tool in &all {
        let shell = SHELL_MCP_TOOLS.contains(tool);
        match claims.tool_claim(tool) {
            Some(c) => {
                assert!(!shell, "`{tool}` is claimed by `{}` and the shell's", c.kit);
                assert_eq!(
                    by_gear[tool], c.gear,
                    "`{}` claims `{tool}` of the wrong gear",
                    c.kit
                );
            }
            None if shell => {}
            None => unclaimed.push(*tool),
        }
    }
    assert!(
        unclaimed.is_empty(),
        "tools no built-in kit claims and the shell does not name: {unclaimed:?}"
    );
    for tool in SHELL_MCP_TOOLS {
        assert!(all.contains(tool), "the shell's `{tool}` is no tool");
    }
}

#[test]
fn every_claimed_route_is_a_write_route_the_backend_serves() {
    let contract: serde_json::Value =
        serde_json::from_str(include_str!("../../docs/api-contract.json")).unwrap();
    let served: BTreeSet<String> = contract["operations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|op| {
            format!(
                "{} {}",
                op["method"].as_str().unwrap(),
                op["path"].as_str().unwrap()
            )
        })
        .collect();
    let mut n = 0;
    for (route, claim) in Claims::builtin().routes() {
        n += 1;
        assert!(
            served.contains(&route),
            "`{}` claims `{route}`, not a route",
            claim.kit
        );
        assert!(!route.starts_with("GET "), "{route}: reads are not claimed");
        let m = builtin_manifest(&claim.kit).unwrap();
        assert!(m.permissions.writes.contains(&route), "{route}");
    }
    assert!(n > 0);
}

#[test]
fn the_claims_name_a_kit_for_the_types_the_adr_lists() {
    let kit = |id: &str| Claims::builtin().type_claim(id).map(|c| c.kit.clone());
    // ADR-0071 §6, the slugs after step 5.
    assert_eq!(kit("ci-run").as_deref(), Some("project-tests"));
    assert_eq!(kit("ci-job").as_deref(), Some("project-tests"));
    assert_eq!(kit("deployment-environment").as_deref(), Some("delivery"));
    assert_eq!(kit("deployment").as_deref(), Some("delivery"));
    assert_eq!(kit("product-build").as_deref(), Some("delivery"));
    assert_eq!(kit("project-product").as_deref(), Some("project-product"));
    // ADR-0074 as amended: the decisions are Spec mapping's.
    assert_eq!(kit("mapping-decision").as_deref(), Some("spec-mapping"));
    assert_eq!(kit("work-item").as_deref(), Some("project-git"));
    assert_eq!(kit("comment").as_deref(), Some("project-git"));
    assert_eq!(kit("finding").as_deref(), Some("project-domain-model"));
    assert_eq!(kit("budget").as_deref(), Some("org-costs"));
    assert_eq!(kit("model-price").as_deref(), Some("org-costs"));
    assert_eq!(kit("report-source").as_deref(), Some("org-reports"));
    assert_eq!(kit("gear").as_deref(), Some("components"));
    assert_eq!(kit("studio-document").as_deref(), Some("project-specs"));
    assert_eq!(
        kit("spec-extraction").as_deref(),
        Some("project-domain-model")
    );
    assert_eq!(kit("delivery-scope").as_deref(), Some("project-lifecycle"));
    assert_eq!(kit("project-type").as_deref(), Some("project-lifecycle"));
    for core in [
        "repository",
        "source-account",
        "kit-installation",
        "record-chunk",
    ] {
        assert_eq!(kit(core), None, "{core} is core");
    }
    // Planning names all three of its phase tools.
    let lifecycle = builtin_manifest("project-lifecycle").unwrap();
    assert!(
        lifecycle
            .mcp_tools
            .iter()
            .any(|t| t.name == "project_phases")
    );
    assert_eq!(
        Claims::builtin()
            .tool_claim("project_phases")
            .map(|c| c.kit.as_str()),
        Some("project-lifecycle")
    );
    // Research claims its tools only; the deploys are delivery's.
    assert_eq!(
        Claims::builtin()
            .tool_claim("research_projects")
            .map(|c| c.kit.as_str()),
        Some("constructor-research")
    );
    assert_eq!(
        Claims::builtin()
            .tool_claim("deploy_request")
            .map(|c| c.kit.as_str()),
        Some("delivery")
    );
}

#[test]
fn a_route_is_found_by_its_template_and_binds_its_parameters() {
    let claims = Claims::builtin();
    let (claim, params) = claims
        .route_match(
            "PUT",
            "/cf/studio-environments/v1/project-environments/7f3c0d3e-0000-0000-0000-000000000001",
        )
        .unwrap();
    assert_eq!(claim.kit, "delivery");
    assert_eq!(
        params.get("environment_id").map(String::as_str),
        Some("7f3c0d3e-0000-0000-0000-000000000001")
    );
    assert_eq!(
        claims
            .route_claim("PUT", "/studio-usage/v1/budgets")
            .map(|c| c.kit.as_str()),
        Some("org-costs")
    );
    // A read of a claimed path is not claimed.
    assert!(
        claims
            .route_claim("GET", "/studio-usage/v1/budgets")
            .is_none()
    );
    // A literal segment is not a parameter's.
    assert_eq!(
        claims
            .route_claim(
                "POST",
                "/studio-components-catalog/v1/registry/gear-repository/create"
            )
            .map(|c| c.kit.as_str()),
        Some("components")
    );
    assert!(
        claims
            .route_claim("POST", "/studio-usage/v1/budgets/x")
            .is_none()
    );
}

#[test]
fn two_kits_claiming_one_thing_is_a_conflict() {
    let kit = |slug: &str, gears: serde_json::Value| {
        read_kit_json(
            &serde_json::json!({
                "slug": slug, "name": slug,
                "permissions": {"writes": ["PUT /studio-usage/v1/budgets"]},
                "gears": gears,
            })
            .to_string(),
        )
        .unwrap()
    };
    let a = kit(
        "a",
        serde_json::json!([{"gear": "studio-usage", "types": ["budget"]}]),
    );
    let b = kit(
        "b",
        serde_json::json!([{"gear": "studio-usage", "types": ["budget"]}]),
    );
    assert!(
        Claims::of(&[a.clone(), b])
            .unwrap_err()
            .contains("`budget`")
    );
    let c = kit(
        "c",
        serde_json::json!([{"gear": "studio-usage", "routes": ["PUT /studio-usage/v1/budgets"]}]),
    );
    let d = kit(
        "d",
        serde_json::json!([{"gear": "studio-usage", "routes": ["PUT /studio-usage/v1/budgets"]}]),
    );
    assert!(Claims::of(&[c.clone(), d]).unwrap_err().contains("budgets"));
    // An organization's kit cannot take a built-in kit's type, tool or route,
    // the core's types or the shell's tools.
    let builtin = Claims::builtin();
    assert!(builtin.conflict_with(&a).unwrap().contains("org-costs"));
    assert!(builtin.conflict_with(&c).unwrap().contains("org-costs"));
    let core = kit(
        "e",
        serde_json::json!([{"gear": "studio-kits", "types": ["kit-installation"]}]),
    );
    assert!(builtin.conflict_with(&core).unwrap().contains("core"));
    let shell = kit(
        "f",
        serde_json::json!([{"gear": "studio-kits", "mcp_tools": ["kits_catalog"]}]),
    );
    assert!(builtin.conflict_with(&shell).unwrap().contains("shell"));
    let free = kit(
        "g",
        serde_json::json!([{"gear": "studio-usage", "mcp_tools": ["nobodys_tool"]}]),
    );
    assert_eq!(builtin.conflict_with(&free), None);
}
