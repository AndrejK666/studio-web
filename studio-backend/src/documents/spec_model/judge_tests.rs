use super::*;
use crate::documents::spec_model::extract::Fact;

const PRD: &str = "# PRD\n\n## Seed\n\nThe seed is triggered by an operator.\n";
const DESIGN: &str = "# Design\n\n## Seed\n\nEvery ingestion pipeline runs the seed, and a CronJob runs it every 15 minutes.\n";

fn side(path: &str, line: usize, value: &str, quote: &str) -> Fact {
    Fact {
        kind: "lifecycle".into(),
        subject: "seed".into(),
        aspect: "trigger".into(),
        value: value.into(),
        text: String::new(),
        status: "active".into(),
        status_because: String::new(),
        path: path.into(),
        line_start: line,
        line_end: line,
        quote: quote.into(),
    }
}

fn candidate() -> Candidate {
    Candidate {
        rule: "contradiction.lifecycle",
        subject: "seed".into(),
        aspect: "trigger".into(),
        sides: [
            side(
                "PRD.md",
                5,
                "operator",
                "The seed is triggered by an operator.",
            ),
            side(
                "DESIGN.md",
                5,
                "every pipeline and a CronJob",
                "Every ingestion pipeline runs the seed",
            ),
        ],
    }
}

fn text_of(path: &str) -> Option<&'static str> {
    match path {
        "PRD.md" => Some(PRD),
        "DESIGN.md" => Some(DESIGN),
        _ => None,
    }
}

#[test]
fn the_question_shows_both_passages_in_their_sections() {
    let r = request(&candidate(), text_of);
    assert!(r.prompt.contains("Passage A: `PRD.md` lines 5-5"));
    assert!(
        r.prompt
            .contains("5| The seed is triggered by an operator.")
    );
    assert!(r.prompt.contains("3| ## Seed"));
}

#[test]
fn a_confirmed_conflict_is_a_finding_keyed_by_its_passages() {
    let c = candidate();
    let one = read_answer(
        &c,
        r#"{"conflict":true,"rule":"contradiction.lifecycle","explanation":"Operator-run vs scheduled.","fix":{"kind":"decide","options":["operator","schedule"]},"confidence":"high"}"#,
        text_of,
    )
    .unwrap()
    .unwrap();
    let reworded = read_answer(
        &c,
        r#"{"conflict":true,"rule":"contradiction.lifecycle","explanation":"Said differently.","confidence":"high"}"#,
        text_of,
    )
    .unwrap()
    .unwrap();
    assert_eq!(one.severity, "high");
    assert_eq!(one.decide, vec!["operator", "schedule"]);
    assert_eq!(one.sides.len(), 2);
    assert_eq!(one.fingerprint, reworded.fingerprint);
}

#[test]
fn no_conflict_or_low_confidence_is_no_finding() {
    let c = candidate();
    assert!(
        read_answer(&c, r#"{"conflict":false}"#, text_of)
            .unwrap()
            .is_none()
    );
    assert!(
        read_answer(
            &c,
            r#"{"conflict":true,"explanation":"maybe","confidence":"low"}"#,
            text_of
        )
        .unwrap()
        .is_none()
    );
}

#[test]
fn an_edit_is_kept_only_when_its_passage_is_in_the_document() {
    let c = candidate();
    let good = read_answer(
        &c,
        r#"{"conflict":true,"explanation":"x","confidence":"medium","fix":{"kind":"edit","path":"PRD.md","replace":"triggered by  an operator","with":"run by every pipeline"}}"#,
        text_of,
    )
    .unwrap()
    .unwrap();
    assert_eq!(good.edit.unwrap().path, "PRD.md");
    assert_eq!(good.severity, "medium");
    let invented = read_answer(
        &c,
        r#"{"conflict":true,"explanation":"x","confidence":"high","fix":{"kind":"edit","path":"PRD.md","replace":"not in the text","with":"y"}}"#,
        text_of,
    )
    .unwrap()
    .unwrap();
    assert!(invented.edit.is_none());
}

#[test]
fn an_unknown_rule_keeps_the_candidates() {
    let f = read_answer(
        &candidate(),
        r#"{"conflict":true,"rule":"contradiction.vibes","explanation":"x","confidence":"high"}"#,
        text_of,
    )
    .unwrap()
    .unwrap();
    assert_eq!(f.rule, "contradiction.lifecycle");
}
