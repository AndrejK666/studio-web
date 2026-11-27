#![allow(clippy::expect_used, clippy::unwrap_used)]

use serde_json::json;

use super::*;
use crate::components_catalog::registry::{EntryRecord, OccurrenceRecord};

const GEAR_TYPE: &str = "gts.cf.studio.catalog.gear.v1~";

fn engine_gear(id: &str, role: &str) -> ReferenceEngineGearDto {
    ReferenceEngineGearDto {
        id: id.to_owned(),
        display_name: None,
        role: role.to_owned(),
        category: None,
        gdl_path: Some(format!("gears/{id}/gear.gdl")),
        runtime_caps: vec!["db".to_owned(), "rest".to_owned()],
        colocated_deps: vec!["types-registry".to_owned()],
        extension_points: Vec::new(),
        fills: None,
        hosts: Vec::new(),
        plugins: Vec::new(),
    }
}

#[test]
fn a_scanned_gear_lists_what_it_provides_and_needs_and_where_its_gdl_is() {
    let node = json!({
        "name": "cf-gears-credstore",
        "kind": "gear",
        "synced_from": "constructorfabric/gears-rust",
        "repo_path": "gears/system/credstore",
        "tier": "platform",
    });
    let profile = json!({
        "gear_name": "cf-gears-credstore",
        "auto": {
            "manifest": { "v": "gear.gdl", "b": "gear.gdl" },
            "capabilities": { "v": "rest, db", "b": "rest, db" },
            "extpoint_specs": ["cf.core.credstore.plugin.v1~"],
            "deps_names": ["types-registry", "account-management", "types-registry"],
            "consumers_names": ["oagw"],
            "dbs": { "v": "postgres", "b": "postgres" },
            "events": { "v": "yes", "b": "yes", "s": "good" },
            "openapi": { "v": "no", "b": "no", "s": "none" },
            "maturity": { "v": "preview", "b": "preview" },
            "docs": ["gears/system/credstore/README.md"],
            "gtstypes": { "v": "cf.core.credstore.secret.v1~", "b": "1 types", "n": 1 },
        }
    });
    let mut gear = engine_gear("credstore", "service");
    gear.extension_points = vec![ReferenceExtensionPointDto {
        spec: "cf.core.credstore.plugin.v1~".to_owned(),
        interface: Some("credstore_sdk::Plugin".to_owned()),
        sdk_crate: Some("cf-gears-credstore-sdk".to_owned()),
    }];
    gear.plugins = vec!["static-credstore-plugin".to_owned()];
    let reference = ComponentReferenceDto {
        name: "cf-gears-credstore".to_owned(),
        kind: "gear".to_owned(),
        kind_reason: "described by a gear.gdl (a service gear)".to_owned(),
        engine: vec![gear],
        ..ComponentReferenceDto::default()
    };
    let d = build(DetailInputs {
        name: "cf-gears-credstore",
        node: Some((GEAR_TYPE, &node)),
        profile: Some(&profile),
        reference: Some(&reference),
        ..DetailInputs::default()
    });
    assert_eq!(d.component_type, "gear");
    assert!(d.type_reason.contains("gear.gdl"), "{}", d.type_reason);
    assert_eq!(d.tier.as_deref(), Some("platform"));
    let passport = d.passport.expect("a passport");
    assert_eq!(passport.label, "gear.gdl");
    assert_eq!(passport.path, "gears/system/credstore/gear.gdl");
    assert_eq!(
        passport.url.as_deref(),
        Some(
            "https://github.com/constructorfabric/gears-rust/blob/HEAD/gears/system/credstore/gear.gdl"
        )
    );
    assert_eq!(d.docs.len(), 1);
    assert_eq!(d.docs[0].label, "README.md");
    assert_eq!(d.provides.capabilities, ["rest", "db"]);
    assert_eq!(
        d.provides.extension_points.len(),
        1,
        "the engine's point and the scan's are one"
    );
    assert_eq!(
        d.provides.extension_points[0].interface.as_deref(),
        Some("credstore_sdk::Plugin")
    );
    assert_eq!(d.provides.plugins, ["static-credstore-plugin"]);
    assert_eq!(d.provides.events, Some(true));
    assert_eq!(d.provides.openapi, Some(false));
    assert_eq!(d.provides.types, ["cf.core.credstore.secret.v1~"]);
    assert_eq!(d.needs.components, ["types-registry", "account-management"]);
    assert_eq!(d.needs.databases, ["postgres"]);
    assert_eq!(d.needs.runtime, ["db", "rest"]);
    assert_eq!(d.needs.services, ["types-registry"]);
    assert_eq!(d.used_by.components, ["oagw"]);
    assert_eq!(d.maturity.as_deref(), Some("preview"));
}

#[test]
fn a_plugin_names_the_point_it_fills_and_its_hosts() {
    let mut gear = engine_gear("static-credstore-plugin", "plugin");
    gear.fills = Some("cf.core.credstore.plugin.v1~".to_owned());
    gear.hosts = vec!["credstore".to_owned()];
    let reference = ComponentReferenceDto {
        name: "cf-gears-static-credstore-plugin".to_owned(),
        kind: "plugin".to_owned(),
        engine: vec![gear],
        ..ComponentReferenceDto::default()
    };
    let d = build(DetailInputs {
        name: "cf-gears-static-credstore-plugin",
        reference: Some(&reference),
        ..DetailInputs::default()
    });
    assert_eq!(d.component_type, "plugin");
    assert_eq!(
        d.provides.implements.as_deref(),
        Some("cf.core.credstore.plugin.v1~")
    );
    assert_eq!(d.provides.hosts, ["credstore"]);
    // Only the engine knows it: its descriptor's path, with no link.
    let passport = d.passport.expect("the engine's gdl");
    assert_eq!(passport.path, "gears/static-credstore-plugin/gear.gdl");
    assert_eq!(passport.url, None);
}

#[test]
fn an_mfe_lists_its_screens_and_the_gears_it_calls() {
    let node = json!({
        "name": "@constructor-studio/tests-mfe",
        "kind": "frontx",
        "synced_from": "constructorfabric/studio-web",
        "repo_path": "studio-frontend/src-app/mfe_packages/tests-mfe",
    });
    let profile = json!({
        "gear_name": "@constructor-studio/tests-mfe",
        "auto": {
            "frontx_described": true,
            "frontx_kind": { "v": "mfe", "b": "mfe" },
            "mfe_calls": ["studio-artifact-ingest"],
            "mfe_extensions": [
                { "id": "ext.tests", "domain": "screen", "label": "Tests", "route": "/tests", "level": "project", "icon": null, "order": 10 },
                { "label": "no id, not a screen" }
            ],
        }
    });
    let reference = ComponentReferenceDto {
        name: "@constructor-studio/tests-mfe".to_owned(),
        kind: "micro-frontend".to_owned(),
        ..ComponentReferenceDto::default()
    };
    let d = build(DetailInputs {
        name: "@constructor-studio/tests-mfe",
        node: Some((GEAR_TYPE, &node)),
        profile: Some(&profile),
        reference: Some(&reference),
        ..DetailInputs::default()
    });
    assert_eq!(d.component_type, "mfe");
    assert_eq!(
        d.passport.as_ref().map(|p| p.label.as_str()),
        Some("frontx.gdl")
    );
    assert_eq!(
        d.passport.unwrap().path,
        "studio-frontend/src-app/mfe_packages/tests-mfe/frontx.gdl"
    );
    assert_eq!(d.provides.screens.len(), 1);
    assert_eq!(d.provides.screens[0].route.as_deref(), Some("/tests"));
    assert_eq!(d.provides.screens[0].level.as_deref(), Some("project"));
    assert_eq!(d.needs.services, ["studio-artifact-ingest"]);
}

#[test]
fn an_infra_service_is_infra_with_its_variables_ports_and_secrets() {
    let node = json!({
        "name": "keycloak",
        "kind": "service",
        "service_kind": "infra",
        "ports": { "http": 8080 },
        "health": "/health/ready",
        "requires": [],
        "provides": [],
        "env": {},
        "repository": "https://github.com/acme/product",
        "git_ref": "main",
        "passport_path": "infra/keycloak/service.gdl",
        "infra": {
            "secrets": ["KC_BOOTSTRAP_ADMIN_PASSWORD"],
            "provides": { "oidc.issuer": "{public_url}/realms/product" }
        }
    });
    let d = build(DetailInputs {
        name: "keycloak",
        node: Some((super::SERVICE_TYPE, &node)),
        ..DetailInputs::default()
    });
    assert_eq!(d.component_type, "infra");
    assert_eq!(d.provides.ports, ["http: 8080"]);
    assert_eq!(d.provides.health.as_deref(), Some("/health/ready"));
    assert_eq!(d.provides.variables, ["oidc.issuer"]);
    assert_eq!(d.needs.connections, ["KC_BOOTSTRAP_ADMIN_PASSWORD"]);
    let passport = d.passport.unwrap();
    assert_eq!(passport.label, "service.gdl");
    assert_eq!(
        passport.url.as_deref(),
        Some("https://github.com/acme/product/blob/main/infra/keycloak/service.gdl")
    );
}

#[test]
fn an_own_service_is_a_service_and_says_what_it_requires() {
    let node = json!({
        "name": "studio-theia",
        "kind": "service",
        "service_kind": "own",
        "requires": ["studio-session"],
        "provides": ["ide"],
        "env": { "STUDIO_API_URL": "gateway.url" },
    });
    let d = build(DetailInputs {
        name: "studio-theia",
        node: Some((super::SERVICE_TYPE, &node)),
        ..DetailInputs::default()
    });
    assert_eq!(d.component_type, "service");
    assert_eq!(d.provides.capabilities, ["ide"]);
    assert_eq!(d.needs.services, ["studio-session"]);
    assert_eq!(d.needs.connections, ["STUDIO_API_URL ← gateway.url"]);
}

#[test]
fn a_gear_only_a_project_declares_reads_its_registry_entry() {
    let registry = RegistryEntry {
        entry: EntryRecord {
            name: "billing".to_owned(),
            kind: "gear".to_owned(),
            state: "declared".to_owned(),
            capabilities: vec!["invoices".to_owned()],
            version: Some("0.2.0".to_owned()),
            ..EntryRecord::default()
        },
        occurrences: vec![OccurrenceRecord {
            entry: "billing".to_owned(),
            repo: "acme/shop".to_owned(),
            git_ref: Some("main".to_owned()),
            path: "gears/billing".to_owned(),
            declared_in: "gear.gdl".to_owned(),
            declared_file: "gears/billing/gear.gdl".to_owned(),
            ..OccurrenceRecord::default()
        }],
    };
    let claims = vec![ComponentKitClaimDto {
        kit: "billing-kit".to_owned(),
        kit_name: "Billing".to_owned(),
        gear: "billing".to_owned(),
        types: vec!["invoice".to_owned()],
        mcp_tools: Vec::new(),
        routes: Vec::new(),
    }];
    let d = build(DetailInputs {
        name: "billing",
        registry: Some(&registry),
        claims: claims.clone(),
        ..DetailInputs::default()
    });
    assert_eq!(d.component_type, "gear");
    assert_eq!(d.type_reason, "a project declares it as a gear");
    assert_eq!(d.version.as_deref(), Some("0.2.0"));
    assert_eq!(
        d.repository.as_deref(),
        Some("https://github.com/acme/shop")
    );
    assert_eq!(d.path.as_deref(), Some("gears/billing"));
    assert_eq!(
        d.passport.unwrap().url.as_deref(),
        Some("https://github.com/acme/shop/blob/main/gears/billing/gear.gdl")
    );
    assert_eq!(d.provides.capabilities, ["invoices"]);
    assert_eq!(d.used_by.kits, claims);
}

#[test]
fn the_type_follows_the_taxonomy_and_says_so_when_nothing_decides() {
    let t =
        |kind: Option<&str>, registry: Option<&str>| component_type(None, None, kind, registry).0;
    assert_eq!(t(Some("sdk"), None), "library");
    assert_eq!(t(Some("frontend-library"), None), "library");
    assert_eq!(t(Some("planned"), None), "gear");
    assert_eq!(t(Some("tool"), None), "other");
    assert_eq!(t(Some("kit"), None), "kit");
    assert_eq!(t(None, Some("plugin")), "plugin");
    assert_eq!(t(None, Some("frontx")), "other");
    assert_eq!(t(None, None), "other");
    assert_eq!(
        component_type(Some(super::KIT_TYPE), None, None, None).0,
        "kit"
    );
}

#[test]
fn a_list_reads_however_it_was_stored() {
    assert_eq!(list_of(Some(&json!(["a", " b ", "", "a"]))), ["a", "b"]);
    assert_eq!(list_of(Some(&json!("a, b,,c"))), ["a", "b", "c"]);
    assert_eq!(list_of(Some(&json!({ "v": "x, y", "b": "2" }))), ["x", "y"]);
    assert!(list_of(None).is_empty());
    assert_eq!(yes_no(Some(&json!({ "v": "yes" }))), Some(true));
    assert_eq!(yes_no(Some(&json!(false))), Some(false));
    assert_eq!(yes_no(Some(&json!({ "v": "maybe" }))), None);
}
