#![allow(clippy::expect_used, clippy::unwrap_used)]

use super::*;

fn paths(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).to_owned()).collect()
}

fn commit(sha: &str, email: &str, at: &str, files: &[&str]) -> LoggedCommit {
    LoggedCommit {
        sha: sha.to_owned(),
        author_name: Some(format!("Name of {sha}")),
        author_email: Some(email.to_owned()),
        committed_at: Some(at.to_owned()),
        paths: paths(files),
    }
}

#[test]
fn components_are_found_from_the_synced_files_and_owned_from_the_clones_history() {
    let files = paths(&[
        "svc/api/go.mod",
        "svc/api/main.go",
        "svc/api/main_test.go",
        "svc/api/openapi.yaml",
        "svc/api/README.md",
        "web/package.json",
        "web/src/app.ts",
        "gears/x/gear.gdl",
        "gears/x/Cargo.toml",
    ]);
    let pr = OpenPullFiles {
        repo: "org/repo".into(),
        number: 7,
        paths: paths(&["svc/api/main.go"]),
    };
    let log = vec![
        commit(
            "c3",
            "1+ann@users.noreply.github.com",
            "2026-11-20T10:00:00Z",
            &["svc/api/main.go"],
        ),
        commit(
            "c2",
            "49699333+dependabot[bot]@users.noreply.github.com",
            "2026-11-19T10:00:00Z",
            &["svc/api/go.mod"],
        ),
        commit(
            "c1",
            "bob@corp.io",
            "2026-11-01T10:00:00Z",
            &["svc/api/main.go", "web/src/app.ts"],
        ),
        commit(
            "c0",
            "1+ann@users.noreply.github.com",
            "2026-10-01T10:00:00Z",
            &["svc/api/README.md"],
        ),
    ];
    let found = components_of("org/repo", &files, &[&pr], false, Some(&log), Some("c3"));
    let names: Vec<&str> = found.iter().map(|c| c.name.as_str()).collect();
    // The gear is the registry's, not a component here.
    assert_eq!(names, vec!["web", "api"]);
    let api = found.iter().find(|c| c.name == "api").unwrap();
    assert_eq!(api.kind, "go");
    assert!(api.has_tests && api.has_readme);
    assert_eq!(api.contracts, vec!["svc/api/openapi.yaml"]);
    assert_eq!(api.open_pulls, 1);
    // The login from the no-reply address, the bot left out, most commits first.
    assert_eq!(api.owners, vec!["ann", "Name of c1"]);
    assert_eq!(api.authors, 2);
    assert_eq!(api.last_change.as_deref(), Some("2026-11-20T10:00:00Z"));
    assert_eq!(api.commit.as_deref(), Some("c3"));
    let web = found.iter().find(|c| c.name == "web").unwrap();
    assert_eq!(web.open_pulls, 0);
    assert_eq!(web.owners, vec!["Name of c1"]);
}

#[test]
fn without_a_clone_a_component_has_no_owners_and_is_still_listed() {
    let files = paths(&["go.mod", "main.go"]);
    let found = components_of("org/tool", &files, &[], true, None, None);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].name, "tool");
    assert!(found[0].owners.is_empty() && found[0].last_change.is_none());
    assert!(found[0].open_pulls_partial);
    // Read on any day: unknown history is a caution, missing tests a blocker.
    let r = found[0].readiness(time::OffsetDateTime::now_utc());
    assert_eq!(r.signal, "not_ready");
    assert!(
        r.reasons
            .iter()
            .any(|x| x == "nobody known to have changed it")
    );
}

#[test]
fn a_kept_component_round_trips_through_its_payload() {
    let c = StoredComponent {
        repo: "org/repo".into(),
        dir: "svc".into(),
        name: "svc".into(),
        kind: "go".into(),
        owners: vec!["ann".into()],
        authors: 1,
        ..StoredComponent::default()
    };
    let mut payload = serde_json::to_value(&c).unwrap();
    // The view adds the project; reading ignores what it does not know.
    payload["project_id"] = serde_json::json!("p");
    let back: StoredComponent = serde_json::from_value(payload).unwrap();
    assert_eq!(back, c);
    assert_eq!(c.key(), "org/repo:svc");
}

#[test]
fn the_view_declares_two_types_the_gear_holds() {
    let needs = VIEW.needs();
    let ids: Vec<&str> = needs.iter().map(|n| n.id.as_str()).collect();
    assert_eq!(ids, vec!["project-component", "project-component-view"]);
}
