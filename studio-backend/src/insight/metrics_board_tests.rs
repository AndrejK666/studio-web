//! The Insight half of the metrics board, stated as tests.

use super::*;

fn c(measure: &str, bucket: &str, total: f64) -> ActivityCell {
    ActivityCell {
        domain: "git".into(),
        measure: measure.into(),
        bucket: bucket.into(),
        total,
        median: None,
        n: 1,
        people: 1,
    }
}

#[test]
fn insight_says_why_it_has_no_answer_and_never_reads_as_zero() {
    assert_eq!(insight_dto(None, 3).state, "absent");
    assert_eq!(
        insight_dto(Some(Err(ActivityUnavailable::Unconfigured)), 3).state,
        "unconfigured"
    );
    let down = insight_dto(Some(Err(ActivityUnavailable::Unreachable("dns".into()))), 3);
    assert_eq!(
        (down.state.as_str(), down.detail.as_deref()),
        ("unreachable", Some("dns"))
    );
    assert_eq!(
        insight_dto(Some(Ok(RepositoryActivity::default())), 0).state,
        "no_repositories"
    );
    let ok = insight_dto(
        Some(Ok(RepositoryActivity {
            cells: vec![
                c("pr_merged", "2026-10-12", 3.0),
                c("pr_merged", "cur", 5.0),
                c("pr_merged", "2026-10-05", 2.0),
                c("pr_merged", "prev", 4.0),
            ],
            ai_rows: Some(0),
            ..RepositoryActivity::default()
        })),
        1,
    );
    assert_eq!(ok.state, "ok");
    assert_eq!(ok.ai_rows, Some(0));
    let m = &ok.measures[0];
    assert_eq!(m.key, "git.pr_merged");
    assert_eq!(m.current.as_ref().map(|c| c.total), Some(5.0));
    assert_eq!(m.previous.as_ref().map(|c| c.total), Some(4.0));
    assert_eq!(
        m.series
            .iter()
            .map(|p| p.bucket.as_str())
            .collect::<Vec<_>>(),
        vec!["2026-10-05", "2026-10-12"]
    );
}
