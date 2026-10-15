use super::*;
use serde_json::json;

fn run(
    id: &str,
    sha: &str,
    branch: &str,
    status: &str,
    conclusion: Option<&str>,
    at: &str,
) -> CiRun {
    run_of(
        id,
        &json!({ "workflow": "CI", "sha": sha, "branch": branch, "status": status,
                 "conclusion": conclusion, "created_at": at }),
    )
    .expect("a run")
}

#[test]
fn a_node_without_a_sha_is_not_a_run() {
    assert!(run_of("x", &json!({ "workflow": "CI" })).is_none());
}

#[test]
fn runs_are_filtered_by_revision_prefix_and_branch_newest_first() {
    let runs = vec![
        run(
            "a",
            "abc123",
            "main",
            "completed",
            Some("success"),
            "2026-10-01T00:00:00Z",
        ),
        run(
            "b",
            "abc123",
            "feature",
            "completed",
            Some("failure"),
            "2026-10-02T00:00:00Z",
        ),
        run(
            "c",
            "def456",
            "main",
            "in_progress",
            None,
            "2026-10-03T00:00:00Z",
        ),
    ];
    let ids = |r: Vec<CiRun>| r.into_iter().map(|x| x.id).collect::<Vec<_>>();
    assert_eq!(ids(filter(runs.clone(), Some("abc"), None)), ["b", "a"]);
    assert_eq!(ids(filter(runs.clone(), None, Some("main"))), ["c", "a"]);
    assert_eq!(ids(filter(runs, Some("abc123"), Some("main"))), ["a"]);
}

#[test]
fn the_mainline_speaks_first_and_an_unfinished_run_does_not() {
    let runs = vec![
        run(
            "old-main",
            "1",
            "main",
            "completed",
            Some("failure"),
            "2026-10-01T00:00:00Z",
        ),
        run(
            "new-main",
            "2",
            "main",
            "completed",
            Some("success"),
            "2026-10-05T00:00:00Z",
        ),
        run(
            "running",
            "3",
            "main",
            "in_progress",
            None,
            "2026-10-09T00:00:00Z",
        ),
        run(
            "branch",
            "4",
            "feature",
            "completed",
            Some("failure"),
            "2026-10-08T00:00:00Z",
        ),
    ];
    assert_eq!(
        latest_completed(&runs).map(|r| r.id.as_str()),
        Some("new-main")
    );
    let no_main = vec![run(
        "f",
        "5",
        "feature",
        "completed",
        Some("success"),
        "2026-10-01T00:00:00Z",
    )];
    assert_eq!(latest_completed(&no_main).map(|r| r.id.as_str()), Some("f"));
    assert!(latest_completed(&[]).is_none());
}
