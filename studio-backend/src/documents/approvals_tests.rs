use super::*;

fn reviewer(person: &str, required: bool) -> Reviewer {
    Reviewer {
        person: person.to_string(),
        name: Some(person.to_uppercase()),
        required,
    }
}

fn verdict(approver: &str, verdict: &str, at: OffsetDateTime) -> Verdict {
    Verdict {
        approver: approver.to_string(),
        verdict: verdict.to_string(),
        decided_at: at,
    }
}

/// 2026-10-13 10:00 and 11:00 UTC.
fn t(hour: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp(1_791_885_600 + (hour - 10) * 3600)
        .expect("a valid instant")
}

#[test]
fn a_request_waits_on_its_required_reviewers_until_their_latest_verdict_approves() {
    let reviewers = [
        reviewer("ann", true),
        reviewer("bob", true),
        reviewer("cy", false),
    ];
    let none: Vec<Verdict> = Vec::new();
    let names = |rs: Vec<&Reviewer>| rs.into_iter().map(|r| r.person.clone()).collect::<Vec<_>>();
    assert_eq!(names(outstanding(&reviewers, &none)), ["ann", "bob"]);
    assert_eq!(names(awaiting(&reviewers, &none)), ["ann", "bob", "cy"]);

    let some = [
        verdict("ann", "changes_requested", t(10)),
        verdict("ann", "approved", t(11)),
        verdict("bob", "approved", t(10)),
    ];
    assert!(outstanding(&reviewers, &some).is_empty());
    assert!(approved(&reviewers, &some));
    // An optional reviewer who never answered does not hold it, but is
    // still awaited.
    assert_eq!(names(awaiting(&reviewers, &some)), ["cy"]);
}

#[test]
fn the_latest_verdict_wins_whatever_order_they_are_read_in() {
    let reviewers = [reviewer("ann", true)];
    let back_to_changes = [
        verdict("ann", "changes_requested", t(11)),
        verdict("ann", "approved", t(10)),
    ];
    assert!(!approved(&reviewers, &back_to_changes));
}

#[test]
fn with_no_required_reviewer_one_approval_is_enough() {
    let reviewers = [reviewer("ann", false), reviewer("bob", false)];
    assert!(!approved(&reviewers, &[]));
    assert!(approved(&reviewers, &[verdict("bob", "approved", t(10))]));
}

#[test]
fn late_means_past_due_and_not_approved() {
    let reviewers = [reviewer("ann", true)];
    assert!(overdue(Some(t(10)), &reviewers, &[], t(11)));
    assert!(!overdue(Some(t(11)), &reviewers, &[], t(10)));
    assert!(!overdue(None, &reviewers, &[], t(11)));
    assert!(!overdue(
        Some(t(10)),
        &reviewers,
        &[verdict("ann", "approved", t(10))],
        t(11)
    ));
}

#[test]
fn suggestions_rank_this_document_then_its_type_by_how_often_and_skip_the_requester() {
    let a = [reviewer("ann", true), reviewer("me", true)];
    let b = [reviewer("bob", false), reviewer("cy", true)];
    let c = [reviewer("cy", true), reviewer("dan", true)];
    let other_type = [reviewer("eve", true)];
    let earlier = [
        Earlier {
            subject_id: "doc-1",
            type_key: Some("prd"),
            reviewers: &a,
        },
        Earlier {
            subject_id: "doc-2",
            type_key: Some("prd"),
            reviewers: &b,
        },
        Earlier {
            subject_id: "doc-3",
            type_key: Some("prd"),
            reviewers: &c,
        },
        Earlier {
            subject_id: "doc-4",
            type_key: Some("adr"),
            reviewers: &other_type,
        },
    ];
    let got = suggest(&earlier, "doc-1", Some("prd"), "me", 10);
    let people: Vec<&str> = got.iter().map(|r| r.person.as_str()).collect();
    assert_eq!(people, ["ann", "cy", "bob", "dan"]);
    assert!(!got[2].required, "bob was optional when last asked");
    assert_eq!(suggest(&earlier, "doc-1", Some("prd"), "me", 2).len(), 2);
}
