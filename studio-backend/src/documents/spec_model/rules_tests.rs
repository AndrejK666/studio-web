use super::*;

fn fact(path: &str, line: usize, subject: &str, aspect: &str, value: &str, status: &str) -> Fact {
    Fact {
        kind: "constraint".into(),
        subject: subject.into(),
        aspect: aspect.into(),
        value: value.into(),
        text: format!("{subject} {aspect} is {value}"),
        status: status.into(),
        status_because: String::new(),
        path: path.into(),
        line_start: line,
        line_end: line,
        quote: format!("q{line}"),
    }
}

#[test]
fn subjects_meet_across_case_articles_and_plurals() {
    assert_eq!(
        subject_key("The Seat Snapshots"),
        subject_key("seat snapshot")
    );
    assert_eq!(subject_key("access"), "access");
    assert_eq!(subject_key("status"), "status");
}

#[test]
fn two_active_values_of_one_slot_in_two_documents_are_a_candidate() {
    let facts = [
        fact(
            "docs/DESIGN.md",
            470,
            "Seat snapshot",
            "dating rule",
            "first day of the billing month",
            "active",
        ),
        fact(
            "docs/DECOMPOSITION.md",
            226,
            "seat snapshots",
            "Dating rule",
            "the day it was last read",
            "active",
        ),
    ];
    let found = candidates(&facts, 10);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].rule, "contradiction.lifecycle");
}

#[test]
fn the_same_value_written_differently_is_no_candidate() {
    let facts = [
        fact("a.md", 1, "gateway", "timeout", "30 s", "active"),
        fact("b.md", 9, "Gateway", "timeout", "30s", "active"),
    ];
    // "30 s" and "30s" fold differently ("30 s" vs "30s"): the judge sees it.
    // Exactly equal folds never reach it.
    let same = [
        fact("a.md", 1, "gateway", "timeout", "**30 s**", "active"),
        fact("b.md", 9, "Gateway", "timeout", "30 s.", "active"),
    ];
    assert_eq!(candidates(&facts, 10).len(), 1);
    assert!(candidates(&same, 10).is_empty());
}

#[test]
fn a_deferred_or_proposed_value_is_not_compared() {
    let facts = [
        fact("a.md", 1, "report", "percentile", "p95", "active"),
        fact("b.md", 9, "report", "percentile", "p99", "deferred"),
        fact("c.md", 3, "report", "percentile", "p90", "proposed"),
    ];
    assert!(candidates(&facts, 10).is_empty());
}

#[test]
fn one_candidate_per_pair_of_values_not_per_passage() {
    let facts = [
        fact("a.md", 1, "seed", "trigger", "operator", "active"),
        fact("a.md", 40, "seed", "trigger", "operator", "active"),
        fact("b.md", 7, "seed", "trigger", "every pipeline run", "active"),
        fact("c.md", 2, "seed", "trigger", "every pipeline run", "active"),
    ];
    assert_eq!(candidates(&facts, 10).len(), 1);
}

#[test]
fn one_passage_extracted_twice_is_no_candidate() {
    let mut b = fact("a.md", 5, "seed", "trigger", "a cron job", "active");
    b.line_start = 4;
    let facts = [fact("a.md", 5, "seed", "trigger", "operator", "active"), b];
    assert!(candidates(&facts, 10).is_empty());
}

#[test]
fn active_text_naming_a_replaced_value_is_a_stale_candidate() {
    let facts = [
        fact(
            "docs/design.md",
            384,
            "chat proxy",
            "upstream",
            "configured upstream with a key from config",
            "active",
        ),
        fact(
            "docs/adr/0039.md",
            133,
            "chat proxy",
            "upstream",
            "configured upstream with a key from config",
            "superseded",
        ),
    ];
    let found = candidates(&facts, 10);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].rule, "stale.superseded");
    assert_eq!(found[0].sides[0].status, "active");
}

#[test]
fn candidates_across_documents_come_first_and_the_cap_holds() {
    let facts = [
        fact("a.md", 1, "x", "limit", "1", "active"),
        fact("a.md", 9, "x", "limit", "2", "active"),
        fact("a.md", 20, "y", "limit", "1", "active"),
        fact("b.md", 9, "y", "limit", "2", "active"),
    ];
    let found = candidates(&facts, 1);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].subject, "y");
}

#[test]
fn the_rule_follows_the_aspect() {
    let mut f = fact("a.md", 1, "summary row", "grain", "connector", "active");
    assert_eq!(rule_for(&f), "contradiction.cardinality");
    f.aspect = "who may read".into();
    assert_eq!(rule_for(&f), "contradiction.access");
    f.aspect = "routing".into();
    assert_eq!(rule_for(&f), "contradiction.value");
}

fn decision(
    path: &str,
    line: usize,
    subject: &str,
    aspect: &str,
    value: &str,
    status: &str,
) -> Fact {
    Fact {
        kind: "decision".into(),
        ..fact(path, line, subject, aspect, value, status)
    }
}

#[test]
fn text_against_an_active_decision_is_a_decision_candidate_with_the_decision_second() {
    let facts = [
        decision(
            "docs/adr/0035.md",
            20,
            "PDP",
            "privilege mapping",
            "the domain object",
            "active",
        ),
        fact(
            "docs/design.md",
            88,
            "pdp",
            "privilege mapping",
            "no privilege",
            "active",
        ),
    ];
    let found = candidates(&facts, 10);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].rule, "contradiction.decision");
    assert_eq!(found[0].sides[0].path, "docs/design.md");
    assert_eq!(found[0].sides[1].kind, "decision");
}

#[test]
fn text_stating_a_proposed_decision_as_done_is_a_decision_candidate() {
    let facts = [
        decision(
            "docs/adr/0040.md",
            12,
            "catalogue",
            "publisher",
            "a curator",
            "proposed",
        ),
        fact(
            "docs/prd.md",
            300,
            "Catalogue",
            "publisher",
            "a curator",
            "active",
        ),
    ];
    let found = candidates(&facts, 10);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].rule, "contradiction.decision");
    assert_eq!(found[0].sides[0].path, "docs/prd.md");
    assert_eq!(found[0].sides[1].status, "proposed");
}

#[test]
fn a_proposed_decision_restated_in_its_own_record_is_no_candidate() {
    let facts = [
        decision(
            "docs/adr/0040.md",
            12,
            "catalogue",
            "publisher",
            "a curator",
            "proposed",
        ),
        fact(
            "docs/adr/0040.md",
            30,
            "catalogue",
            "publisher",
            "a curator",
            "active",
        ),
    ];
    assert!(candidates(&facts, 10).is_empty());
}
