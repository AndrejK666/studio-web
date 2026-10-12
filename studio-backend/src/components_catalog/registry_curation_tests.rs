use super::*;

fn request(org: u128, name: &str, at: &str) -> PublicationRequest {
    PublicationRequest {
        organization_id: Uuid::from_u128(org),
        organization_name: None,
        name: name.to_owned(),
        version: None,
        reason: None,
        requested_by: "ada".to_owned(),
        requested_by_name: None,
        at: at.to_owned(),
    }
}

#[test]
fn a_second_request_for_one_entry_replaces_the_first_and_the_queue_stays_oldest_first() {
    let queue = with_request(Vec::new(), request(1, "billing", "2026-10-12T10:00:00Z"));
    let queue = with_request(queue, request(2, "ledger", "2026-10-12T09:00:00Z"));
    let queue = with_request(queue, request(1, "Billing", "2026-10-12T11:00:00Z"));
    let names: Vec<(&str, &str)> = queue
        .iter()
        .map(|r| (r.name.as_str(), r.at.as_str()))
        .collect();
    assert_eq!(
        names,
        vec![
            ("ledger", "2026-10-12T09:00:00Z"),
            ("Billing", "2026-10-12T11:00:00Z")
        ]
    );
}

#[test]
fn the_same_name_in_another_organization_is_another_request() {
    let queue = with_request(Vec::new(), request(1, "billing", "a"));
    let queue = with_request(queue, request(2, "billing", "b"));
    assert_eq!(queue.len(), 2);
    let (queue, removed) = without_request(queue, Uuid::from_u128(2), "BILLING");
    assert!(removed);
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].organization_id, Uuid::from_u128(1));
    let (_, removed) = without_request(queue, Uuid::from_u128(3), "billing");
    assert!(!removed);
}

#[test]
fn curators_are_kept_once_each_without_blanks() {
    let c = |id: &str, name: Option<&str>| Curator {
        id: id.to_owned(),
        name: name.map(str::to_owned),
    };
    let out = normalize_curators(vec![
        c(" u1 ", Some(" Ada ")),
        c("", Some("nobody")),
        c("u1", Some("Ada again")),
        c("u2", Some("  ")),
    ]);
    assert_eq!(out, vec![c("u1", Some("Ada")), c("u2", None)]);
    assert!(is_curator(&out, "u2"));
    assert!(!is_curator(&out, "u3"));
}
