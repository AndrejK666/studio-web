use super::*;
use crate::documents::spec_model::requirements::Basis;

fn req(id: &str, text: &str) -> Requirement {
    Requirement {
        id: id.to_string(),
        path: "prd.md".to_string(),
        line: 1,
        title: None,
        text: text.to_string(),
        kind: Some("fr".to_string()),
        priority: None,
        done: None,
        basis: Basis::Stated,
        cites: Vec::new(),
        because: None,
    }
}

fn there(project: &str, id: &str, text: &str) -> Elsewhere {
    Elsewhere {
        project_id: project.to_string(),
        requirement: req(id, text),
    }
}

#[test]
fn the_same_requirement_in_another_project_is_found() {
    let here = [req(
        "a-fr-1",
        "The system MUST keep deleted tenants in a recycle bin for 30 days.",
    )];
    let elsewhere = [
        there(
            "p2",
            "b-fr-9",
            "The system MUST keep deleted tenants in a recycle bin for 30 days after deletion.",
        ),
        there(
            "p3",
            "c-fr-1",
            "The portal shows a reserved area as reserved.",
        ),
    ];
    let found = related(&here, &elsewhere);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].there.project_id, "p2");
    assert_eq!(found[0].relation, Relation::Same);
    assert!(found[0].shared.contains(&"recycle".to_string()));
}

#[test]
fn one_negating_the_other_reads_as_opposite() {
    let here = [req(
        "a-fr-2",
        "Audit records MUST be kept in the platform audit log.",
    )];
    let elsewhere = [there(
        "p2",
        "b-fr-3",
        "Audit records must not be kept in the platform audit log.",
    )];
    let found = related(&here, &elsewhere);
    assert_eq!(found[0].relation, Relation::Opposite);
}

#[test]
fn a_partial_overlap_is_shown_as_such_and_weak_ones_are_not() {
    let here = [req(
        "a-fr-3",
        "Workflow engine runs playbooks for disaster recovery with retries and timeouts.",
    )];
    let elsewhere = [
        there(
            "p2",
            "b-fr-4",
            "Workflow engine runs playbooks for remediation alerts with retries.",
        ),
        there(
            "p3",
            "c-fr-5",
            "Workflow diagrams render in the review view.",
        ),
    ];
    let found = related(&here, &elsewhere);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].relation, Relation::Overlap);
}

#[test]
fn short_statements_are_not_compared() {
    let here = [req("a-x", "MUST work.")];
    let elsewhere = [there("p2", "b-x", "MUST work.")];
    assert!(related(&here, &elsewhere).is_empty());
}

#[test]
fn at_most_three_matches_per_requirement_strongest_first() {
    let here = [req(
        "a",
        "Export monthly billing reports as signed PDF files nightly",
    )];
    let elsewhere: Vec<Elsewhere> = (0..5)
        .map(|i| {
            there(
                &format!("p{i}"),
                &format!("b{i}"),
                if i == 0 {
                    "Export monthly billing reports as signed PDF files nightly"
                } else {
                    "Export monthly billing reports as PDF files"
                },
            )
        })
        .collect();
    let found = related(&here, &elsewhere);
    assert_eq!(found.len(), PER_REQUIREMENT);
    assert_eq!(found[0].there.project_id, "p0");
}
