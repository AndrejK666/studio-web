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
        layer: None,
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

const RECORD: &str = "# ADR-0039: Keys\n\n**Status**: Accepted\n\n## Context\n\nLong history the judge need not read.\n\n## Decision\n\nEvery model call uses the caller's key.\n";

fn misattributed() -> Candidate {
    let mut citing = side(
        "design.md",
        3,
        "",
        "As ADR-0039 decided, tables carry a tenant column.",
    );
    citing.kind = "reference".into();
    let mut cited = side("adr/0039.md", 1, "Keys", "# ADR-0039: Keys");
    cited.kind = "decision".into();
    Candidate {
        rule: "reference.misattributed",
        subject: "ADR-0039: Keys".into(),
        aspect: "what it is cited for".into(),
        sides: [citing, cited],
    }
}

#[test]
fn a_citation_is_judged_against_the_records_decision_not_its_context() {
    let req = request(&misattributed(), |p| (p == "adr/0039.md").then_some(RECORD));
    assert!(req.prompt.contains("cites the decision record B"));
    assert!(
        req.prompt
            .contains("Every model call uses the caller's key.")
    );
    assert!(req.prompt.contains("1| # ADR-0039: Keys"));
}

#[test]
fn a_misattribution_stays_one_whatever_rule_the_judge_names() {
    let answer = r#"{"conflict": true, "rule": "contradiction.value", "explanation": "ADR-0039 is about keys, not tenancy.", "fix": {"kind": "decide", "options": ["cite the tenancy record"]}, "confidence": "high"}"#;
    let found = read_answer(&misattributed(), answer, |_| None)
        .unwrap()
        .unwrap();
    assert_eq!(found.rule, "reference.misattributed");
    assert_eq!(found.severity, "high");
}

#[test]
fn a_decision_record_without_a_decision_section_shows_its_first_lines() {
    let text = (1..=30)
        .map(|n| format!("line {n}"))
        .collect::<Vec<_>>()
        .join("\n");
    let shown = decision_of(&text);
    assert!(shown.contains("12| line 12"));
    assert!(!shown.contains("13| line 13"));
}
