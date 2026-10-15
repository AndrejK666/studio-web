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

/// #744: the answer says whether it is all of the open pull requests.
#[test]
fn an_open_pulls_answer_that_stops_at_a_page_is_a_lower_bound() {
    let answer = |more_pulls: bool, more_files: bool| {
        serde_json::json!({ "data": { "repository": { "pullRequests": {
            "pageInfo": { "hasNextPage": more_pulls },
            "nodes": [
                { "files": { "pageInfo": { "hasNextPage": more_files },
                             "nodes": [{ "path": "svc/a.go" }, { "path": "README.md" }] } },
                { "files": { "pageInfo": { "hasNextPage": false }, "nodes": [] } }
            ]
        } } } })
    };
    let (files, all) = open_pull_files(&answer(false, false));
    assert!(all);
    assert_eq!(
        files,
        vec![
            vec!["svc/a.go".to_string(), "README.md".to_string()],
            vec![]
        ]
    );
    assert!(
        !open_pull_files(&answer(true, false)).1,
        "more pull requests"
    );
    assert!(
        !open_pull_files(&answer(false, true)).1,
        "a pull request with more files"
    );
    // No answer at all (no access): nothing counted, nothing claimed missing.
    assert_eq!(open_pull_files(&serde_json::json!({})), (Vec::new(), true));
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
        ..Facts::default()
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
        ..Facts::default()
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

    // #744: a count cut short by the read is a lower bound, and not "ready".
    let unread = readiness(&Facts {
        days_since_change: Some(10),
        authors: 4,
        open_pulls: 1,
        open_pulls_partial: true,
        has_tests: true,
        has_readme: true,
        has_contract: true,
    });
    assert_eq!(unread.signal, "caution");
    assert!(
        unread
            .reasons
            .iter()
            .any(|r| r.contains("at least 1 open pull requests"))
    );

    let untested = readiness(&Facts {
        has_tests: false,
        ..Facts::default()
    });
    assert_eq!(untested.signal, "not_ready");
    assert_eq!(untested.reasons[0], "no tests");
}
