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

#[test]
fn a_job_needs_its_run_and_keeps_the_failed_step() {
    assert!(job_of("j", &json!({ "title": "build" })).is_none());
    let j = job_of(
        "j",
        &json!({ "run": "r", "attempt": 2, "title": "test-backend",
                 "conclusion": "failure", "failed_step": "cargo test" }),
    )
    .expect("a job");
    assert_eq!(j.name, "test-backend");
    assert_eq!(j.attempt, Some(2));
    assert_eq!(j.failed_step.as_deref(), Some("cargo test"));
}

#[test]
fn a_run_shows_only_the_jobs_of_the_attempt_it_is_at() {
    let mut r = run(
        "r",
        "abc",
        "main",
        "completed",
        Some("success"),
        "2026-10-01T00:00:00Z",
    );
    r.attempt = Some(2);
    let job = |id: &str, run: &str, attempt: i64, at: &str| {
        job_of(
            id,
            &json!({ "run": run, "attempt": attempt, "title": id, "started_at": at }),
        )
        .unwrap()
    };
    let jobs = vec![
        job("test", "r", 2, "2026-10-01T00:05:00Z"),
        job("old-test", "r", 1, "2026-10-01T00:00:00Z"),
        job("build", "r", 2, "2026-10-01T00:01:00Z"),
        job("other", "s", 2, "2026-10-01T00:00:00Z"),
    ];
    let names: Vec<&str> = jobs_of_run(&r, &jobs)
        .iter()
        .map(|j| j.name.as_str())
        .collect();
    assert_eq!(names, vec!["build", "test"]);
    r.attempt = None;
    assert_eq!(
        jobs_of_run(&r, &jobs).len(),
        3,
        "a run that never said its attempt takes all its jobs"
    );
}
