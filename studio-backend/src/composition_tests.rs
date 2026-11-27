//! The composition switch (ADR-0079 §5): what the setting reads as, and what
//! a switched-off kit no longer brings.

use std::collections::BTreeSet;
use std::sync::Arc;

use axum::Router;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use toolkit::api::OpenApiRegistryImpl;
use toolkit::client_hub::ClientHub;
use toolkit::registry::{DatabaseCap, RestApiCap};
use toolkit::{GearCtx, GearRegistry};
use uuid::Uuid;

use super::{
    Composition, KitGear, from_vendor, gear_on, kit_available, kit_of, kit_on, known_kits, with,
};

/// Each kit gear and the kit it belongs to (ADR-0079 §7).
const KIT_GEARS: &[(&str, &str)] = &[
    ("studio-artifact-ingest", "project-git"),
    ("studio-git", "project-git"),
    ("studio-documents", "project-specs"),
    ("studio-spec-quality", "project-specs"),
    ("studio-spec-mapping", "spec-mapping"),
    ("studio-spec-graph", "spec-graph"),
    ("studio-environments", "delivery"),
    ("kubernetes-connector-plugin", "delivery"),
    ("studio-product", "project-product"),
    ("studio-components-catalog", "components"),
    ("studio-reports", "org-reports"),
    ("studio-usage", "org-costs"),
    ("studio-insight", "insight"),
    ("studio-llm-proxy", "assistant"),
    ("anthropic-connector-plugin", "assistant"),
    ("openai-connector-plugin", "assistant"),
    ("studio-theia", "ide"),
];

fn vendor(kits: Value) -> Value {
    json!({ "kits": kits })
}

fn all_but(off: &[&str]) -> Composition {
    Composition::Only(
        known_kits()
            .into_iter()
            .filter(|k| !off.contains(&k.as_str()))
            .collect(),
    )
}

fn no_kits() -> Composition {
    Composition::Only(BTreeSet::new())
}

struct NoConfig;
impl toolkit::config::ConfigProvider for NoConfig {
    fn get_gear_config(&self, _gear: &str) -> Option<&Value> {
        None
    }
}

fn ctx(gear: &'static str) -> GearCtx {
    GearCtx::new(
        gear,
        Uuid::nil(),
        Arc::new(NoConfig),
        Arc::new(ClientHub::new()),
        CancellationToken::new(),
    )
}

/// The operations gear `gear` registers, through its REST capability.
fn operations_of(registry: &GearRegistry, gear: &'static str) -> usize {
    let entry = registry
        .gears()
        .iter()
        .find(|e| e.name() == gear)
        .unwrap_or_else(|| panic!("{gear} is not linked"));
    let rest = entry
        .caps()
        .query::<RestApiCap>()
        .unwrap_or_else(|| panic!("{gear} has no REST capability"));
    let openapi = OpenApiRegistryImpl::new();
    let _router = rest
        .register_rest(&ctx(gear), Router::new(), &openapi)
        .unwrap_or_else(|e| panic!("{gear} register_rest: {e:#}"));
    openapi.operation_specs.len()
}

#[test]
fn no_setting_runs_every_kit() {
    assert_eq!(from_vendor(None).unwrap(), Composition::All);
    assert_eq!(from_vendor(Some(&json!({}))).unwrap(), Composition::All);
    assert_eq!(
        from_vendor(Some(&vendor(json!({ "enabled": "all", "disabled": "" })))).unwrap(),
        Composition::All
    );
    assert!(Composition::All.kit_on("org-reports"));
    assert!(Composition::All.off().is_empty());
}

#[test]
fn disabled_takes_kits_out_as_a_list_or_a_string() {
    for disabled in [
        json!(["org-reports", "org-costs"]),
        json!(" org-reports, org-costs "),
    ] {
        let c = from_vendor(Some(&vendor(json!({ "disabled": disabled })))).unwrap();
        assert!(!c.kit_on("org-reports"));
        assert!(!c.kit_on("org-costs"));
        assert!(c.kit_on("project-specs"));
        assert_eq!(
            c.off(),
            vec!["org-costs".to_owned(), "org-reports".to_owned()]
        );
    }
}

#[test]
fn enabled_lists_the_only_kits_that_run() {
    let c = from_vendor(Some(&vendor(json!({ "enabled": ["project-specs"] })))).unwrap();
    assert!(c.kit_on("project-specs"));
    assert!(!c.kit_on("org-reports"));
    let none = from_vendor(Some(&vendor(json!({ "enabled": "none" })))).unwrap();
    assert_eq!(none, no_kits());
    assert_eq!(none.off().len(), known_kits().len());
}

#[test]
fn a_slug_no_kit_has_fails_naming_it() {
    let err = from_vendor(Some(&vendor(json!({ "disabled": ["org-reprots"] })))).unwrap_err();
    assert!(err.to_string().contains("org-reprots"), "{err}");
    let err = from_vendor(Some(&vendor(json!({ "enabeld": "all" })))).unwrap_err();
    assert!(err.to_string().contains("enabeld"), "{err:#}");
}

#[test]
fn every_kit_gear_names_its_kit_and_the_kit_is_known() {
    let known = known_kits();
    for (gear, kit) in KIT_GEARS {
        assert_eq!(kit_of(gear), Some(*kit), "{gear}");
        assert!(known.contains(*kit), "{kit} is not a known kit");
    }
    let registered: BTreeSet<&str> = inventory::iter::<KitGear>
        .into_iter()
        .map(|g| g.gear)
        .collect();
    let listed: BTreeSet<&str> = KIT_GEARS.iter().map(|(g, _)| *g).collect();
    assert_eq!(
        registered, listed,
        "a kit gear registered here is not listed in KIT_GEARS"
    );
}

#[test]
fn every_registered_kit_gear_is_a_linked_gear() {
    let registry = GearRegistry::discover_and_build().unwrap();
    let linked: BTreeSet<&str> = registry.gears().iter().map(|e| e.name()).collect();
    for g in inventory::iter::<KitGear> {
        if g.gear == "studio-theia" && !cfg!(feature = "theia-bridge") {
            continue;
        }
        assert!(
            linked.contains(g.gear),
            "{} is registered for {} but not linked",
            g.gear,
            g.kit
        );
    }
}

#[test]
fn no_core_gear_depends_on_a_kit_gear() {
    let registry = GearRegistry::discover_and_build().unwrap();
    // `deps` name crates (`types_registry`), so compare in one spelling.
    let kit_crates: BTreeSet<String> = KIT_GEARS.iter().map(|(g, _)| g.replace('-', "_")).collect();
    for entry in registry.gears() {
        if kit_of(entry.name()).is_some() {
            continue;
        }
        for dep in entry.deps() {
            assert!(
                !kit_crates.contains(&dep.replace('-', "_")),
                "core gear {} depends on kit gear {dep}: with its kit off the core would not start",
                entry.name()
            );
        }
    }
}

/// The core with no kit at all: every kit gear stands down, mounts no route
/// and keeps no table, and every port answers with the core's contributions
/// alone — the core's MCP tools are still there.
#[test]
fn the_core_starts_with_no_kit() {
    let registry = GearRegistry::discover_and_build().unwrap();
    with(no_kits(), || {
        for entry in registry.gears() {
            let gear = entry.name();
            if kit_of(gear).is_none() {
                assert!(gear_on(gear), "core gear {gear} must start");
                continue;
            }
            assert!(super::stands_down(gear), "{gear} must not start");
            if entry.caps().has::<RestApiCap>() {
                assert_eq!(operations_of(&registry, gear), 0, "{gear} mounted routes");
            }
            if let Some(db) = entry.caps().query::<DatabaseCap>() {
                assert!(db.migrations().is_empty(), "{gear} keeps tables");
            }
        }

        let tools = crate::mcp::tools_by_gear();
        assert!(!tools.is_empty(), "the core's own MCP tools are gone");
        let claims = crate::kit_registry::port::Claims::builtin();
        for (gear, tool) in &tools {
            assert!(kit_of(gear).is_none(), "{gear} still offers {}", tool.name);
            assert!(
                claims.tool_claim(tool.name).is_none(),
                "{} is a kit's tool",
                tool.name
            );
        }
        for level in [
            crate::organizations::blocks::Level::Organization,
            crate::organizations::blocks::Level::Project,
        ] {
            for b in crate::organizations::blocks::registered(level) {
                assert!(
                    kit_of(b.gear).is_none() && !kit_on(b.kit),
                    "block {} stays",
                    b.id
                );
            }
        }
        for c in crate::organizations::status_port::registered() {
            assert!(kit_of(c.gear).is_none(), "status part of {} stays", c.gear);
        }
        for m in crate::organizations::metering_port::registered() {
            assert!(kit_of(m.gear).is_none(), "cost meter of {} stays", m.gear);
        }
        for s in crate::user_profile::port::sources() {
            assert!(kit_of(s.gear).is_none(), "inbox source {} stays", s.id);
        }
        for s in crate::user_profile::port::tool_sources() {
            assert!(kit_of(s.gear).is_none(), "inbox kind {} stays", s.kind);
        }
        assert!(crate::organizations::repository_metrics_port::registered().is_none());
    });
}

/// One kit off: its gear mounts nothing while the same gear with the kit on
/// does, and its tools, block and meter leave the ports.
#[test]
fn one_kit_off_takes_its_routes_and_contributions_out() {
    let registry = GearRegistry::discover_and_build().unwrap();
    let on = operations_of(&registry, "studio-spec-mapping");
    assert!(
        on > 0,
        "studio-spec-mapping registers routes with its kit on"
    );
    let off = with(all_but(&["spec-mapping"]), || {
        assert!(!gear_on("studio-spec-mapping"));
        assert!(
            gear_on("studio-documents"),
            "another kit's gear keeps running"
        );
        operations_of(&registry, "studio-spec-mapping")
    });
    assert_eq!(
        off, 0,
        "studio-spec-mapping mounted routes with its kit off"
    );

    let has_usage = || {
        let tools = crate::mcp::tools_by_gear()
            .iter()
            .any(|(g, _)| *g == "studio-usage");
        let block = crate::organizations::blocks::registered(
            crate::organizations::blocks::Level::Organization,
        )
        .iter()
        .any(|b| b.gear == "studio-usage");
        let meter = crate::organizations::metering_port::registered()
            .iter()
            .any(|m| m.gear == "studio-usage");
        (tools, block, meter)
    };
    let (_, block, meter) = has_usage();
    assert!(
        block && meter,
        "org-costs contributes a block and a meter when on"
    );
    assert_eq!(
        with(all_but(&["org-costs"]), has_usage),
        (false, false, false)
    );
    let migrations = with(all_but(&["org-costs"]), || {
        registry
            .gears()
            .iter()
            .filter(|e| e.name() == "studio-environments")
            .filter_map(|e| e.caps().query::<DatabaseCap>())
            .map(|db| db.migrations().len())
            .sum::<usize>()
    });
    assert!(
        migrations > 0,
        "turning org-costs off leaves delivery's tables alone"
    );
}

/// A kit with no gear of its own (Gears matcher, in studio-product) loses
/// the tools it claims, and what it claims is refused.
#[test]
fn a_kit_without_a_gear_loses_its_claimed_tools() {
    let claims = crate::kit_registry::port::Claims::builtin();
    let claimed = |name: &str| {
        claims
            .tool_claim(name)
            .is_some_and(|c| c.kit == "gears-matcher")
    };
    assert!(crate::mcp::tools().iter().any(|t| claimed(t.name)));
    with(all_but(&["gears-matcher"]), || {
        assert!(gear_on("studio-product"), "the product gear keeps running");
        assert!(!crate::mcp::tools().iter().any(|t| claimed(t.name)));
        let detail = crate::kit_registry::port::KitRefusal::NotInstalled {
            kit: "gears-matcher".into(),
        }
        .detail();
        assert!(detail.contains("vendor.studio.kits"), "{detail}");
    });
}

/// A switched-off kit's status steps and signals are hidden even where every
/// kit applies, and a signal another kit's tab opens falls back.
#[test]
fn a_switched_off_kit_shows_in_no_status() {
    use crate::organizations::status::Kits;
    assert!(Kits::All.has(Some("project-product")));
    assert_eq!(
        crate::organizations::kit_parts::opens("kind"),
        Some("components")
    );
    with(all_but(&["project-product", "ide"]), || {
        assert!(!Kits::All.has(Some("project-product")));
        assert!(Kits::All.has(None));
        assert_eq!(crate::organizations::kit_parts::opens("kind"), None);
        assert_eq!(crate::organizations::kit_parts::opens("threads-me"), None);
    });
}

#[test]
fn only_a_linked_kit_switched_off_is_unavailable() {
    with(all_but(&["org-reports"]), || {
        assert!(!kit_available("org-reports"));
        assert!(kit_available("org-costs"));
        assert!(kit_available("someone-elses-kit"));
    });
    with(no_kits(), || {
        assert!(known_kits().iter().all(|k| !kit_available(k)));
        assert!(kit_available("someone-elses-kit"));
    });
}
