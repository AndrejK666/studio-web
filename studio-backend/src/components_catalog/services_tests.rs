use super::*;

fn paths(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| (*s).to_string()).collect()
}

#[test]
fn services_are_found_by_their_manifests_and_gears_are_left_to_the_registry() {
    let files = paths(&[
        "README.md",
        "services/billing/go.mod",
        "services/billing/main.go",
        "services/billing/main_test.go",
        "services/billing/api/openapi.yaml",
        "services/billing/README.md",
        "services/billing/Dockerfile",
        "web/portal/package.json",
        "web/portal/src/app.tsx",
        "web/portal/node_modules/x/package.json",
        "gears/audit/Cargo.toml",
        "gears/audit/gear.gdl",
        "tools/.cache/pyproject.toml",
        "charts/billing/Chart.yaml",
    ]);
    let gears: BTreeSet<String> = ["gears/audit".to_string()].into();
    let found = detect("acme/platform", &files, &gears);
    let dirs: Vec<(&str, &str)> = found
        .iter()
        .map(|f| (f.dir.as_str(), f.kind.as_str()))
        .collect();
    assert_eq!(
        dirs,
        [
            ("charts/billing", "helm"),
            ("services/billing", "go"),
            ("web/portal", "node"),
        ]
    );
    let billing = &found[1];
    assert_eq!(billing.name, "billing");
    assert_eq!(billing.manifests, ["go.mod", "Dockerfile"]);
    assert_eq!(billing.contracts, ["services/billing/api/openapi.yaml"]);
    assert!(billing.has_tests && billing.has_readme);
    assert!(!found[2].has_tests && !found[2].has_readme);
}

#[test]
fn the_root_is_a_component_named_after_the_repository() {
    let found = detect(
        "acme/tool",
        &paths(&["pyproject.toml", "tests/test_x.py"]),
        &BTreeSet::new(),
    );
    assert_eq!(found[0].name, "tool");
    assert_eq!(found[0].kind, "python");
    assert!(found[0].has_tests);
}

#[test]
fn readiness_says_why() {
    let ready = readiness(&Facts {
        days_since_change: Some(10),
        authors: 4,
        open_pulls: 1,
        has_tests: true,
        has_readme: true,
        has_contract: true,
    });
    assert_eq!(ready.signal, "ready");
    assert!(
        ready
            .reasons
            .contains(&"4 people have changed it".to_string())
    );

    let busy = readiness(&Facts {
        days_since_change: Some(400),
        authors: 1,
        open_pulls: 5,
        has_tests: true,
        has_readme: true,
        has_contract: true,
    });
    assert_eq!(busy.signal, "caution");
    assert!(
        busy.reasons
            .iter()
            .any(|r| r.contains("5 open pull requests"))
    );
    assert!(
        busy.reasons
            .iter()
            .any(|r| r.contains("unchanged for 400 days"))
    );
    assert!(busy.reasons.iter().any(|r| r.contains("one person")));

    let untested = readiness(&Facts {
        has_tests: false,
        ..Facts::default()
    });
    assert_eq!(untested.signal, "not_ready");
    assert_eq!(untested.reasons[0], "no tests");
}
