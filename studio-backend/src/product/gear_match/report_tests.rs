//! Reading a coverage report for a person, preparing what is sent, and
//! telling two runs apart -- over a report in the matcher's shape (the
//! todo-app run of 2026-11-17, trimmed) and its PRD's requirement blocks.

use serde_json::{Value, json};

use super::*;

const PRD: &str = "# PRD - Todo App\n\
\n\
## 5. Functional Requirements\n\
\n\
#### Create Task\n\
\n\
- [x] `p1` - **ID**: `cpt-examples-todo-app-fr-create-task`\n\
\n\
The system **MUST** allow users to create a new task with a title.\n\
\n\
#### Changes Feed\n\
\n\
- [x] `p2` - **ID**: `cpt-examples-todo-app-fr-changes-feed`\n\
\n\
The system **MUST** propagate task changes to every device in real time.\n\
\n\
#### Sign In\n\
\n\
- [x] `p1` - **ID**: `cpt-examples-todo-app-fr-sign-in`\n\
\n\
Users sign in with the organization's identity provider.\n";

fn report() -> Value {
    json!({
        "schema_version": "1.2.0",
        "provenance": {"product_id": "todo-app", "gears_md_commit": "c14f0fb5", "gear_gdl_commit": "c14f0fb5"},
        "recommended_gears": [
            {"gear_id": "gears-rust/authn-resolver", "name": "AuthN Resolver", "confidence": 0.9, "in_code": true,
             "requirement_ids": ["cpt-examples-todo-app-fr-sign-in"]}
        ],
        "also_possible": [
            {"gear_id": "gears-rust/event-broker", "name": "Events Broker", "confidence": 0.5, "in_code": true,
             "requirement_ids": ["cpt-examples-todo-app-fr-changes-feed"]}
        ],
        "future_parts": [
            {"gear_id": "gears-rust/user-tasks-manager", "name": "User Tasks Manager", "confidence": 0.4,
             "in_code": false, "requirement_ids": ["cpt-examples-todo-app-fr-create-task"]}
        ],
        "requirements": [
            {"requirement_id": "cpt-examples-todo-app-fr-create-task", "kind": "fr", "planned": false,
             "coverage": "gap", "confidence": null, "low_confidence": false,
             "reason": "future part: only Gears with no code yet fit", "gear_provides": "", "remaining_work": "",
             "gears": [{"gear_id": "gears-rust/user-tasks-manager", "verdict": "unjudgeable", "confidence": 0.4,
                        "evidence": "", "covers": "", "missing": "", "rationale": "future part", "role": "other"}]},
            {"requirement_id": "cpt-examples-todo-app-fr-changes-feed", "kind": "fr", "planned": false,
             "coverage": "clarification_needed", "confidence": null, "low_confidence": false,
             "reason": "the judge could not decide for 2 of 3 gears", "gear_provides": "", "remaining_work": "",
             "gears": [{"gear_id": "gears-rust/event-broker", "verdict": "unjudgeable", "confidence": 0.5,
                        "evidence": "", "covers": "", "missing": "", "rationale": "", "role": "other"}]},
            {"requirement_id": "cpt-examples-todo-app-fr-sign-in", "kind": "fr", "planned": false,
             "coverage": "covered", "confidence": 0.9, "low_confidence": false,
             "reason": "", "gear_provides": "sign-in through the IdP", "remaining_work": "",
             "gears": [
                {"gear_id": "gears-rust/oagw", "verdict": "none", "confidence": 0.6,
                 "evidence": "", "covers": "", "missing": "", "rationale": "", "role": "other"},
                {"gear_id": "gears-rust/authn-resolver", "verdict": "covered", "confidence": 0.9,
                 "evidence": "resolves a bearer token to a subject", "covers": "sign-in", "missing": "",
                 "rationale": "", "role": "chosen"}]}
        ],
        "totals": {"requirements": 3,
                   "fr": {"covered": 1, "partial": 0, "gap": 1, "clarification_needed": 1, "not_assessed": 0},
                   "nfr": {"covered": 0, "partial": 0, "gap": 0, "clarification_needed": 0, "not_assessed": 0}},
        "inputs": [{"path": "docs/PRD.md", "status": "read", "requirements": 3, "reason": ""}],
        "clarifications": [
            {"topic": "Offline", "reason": "two documents disagree", "quote": "works offline", "path": "docs/PRD.md"}
        ]
    })
}

fn docs() -> Vec<(String, String)> {
    vec![("docs/PRD.md".to_owned(), PRD.to_owned())]
}

#[test]
fn each_verdict_becomes_what_studio_offers() {
    let reqs = requirements(&report(), &docs());
    let by_id = |id: &str| {
        reqs.iter()
            .find(|r| r.requirement_id.ends_with(id))
            .unwrap()
    };
    assert_eq!(by_id("create-task").action, ACTION_CREATE_GEAR);
    assert_eq!(by_id("changes-feed").action, ACTION_ANSWER);
    let sign_in = by_id("sign-in");
    assert_eq!(sign_in.action, ACTION_PROPOSE);
    // The covering gear first, the one judged `none` after it and not proposed.
    assert_eq!(sign_in.candidates[0].gear_id, "gears-rust/authn-resolver");
    assert_eq!(sign_in.candidates[0].pick, "authn-resolver");
    assert_eq!(
        sign_in.candidates[0].name.as_deref(),
        Some("AuthN Resolver")
    );
    assert_eq!(sign_in.candidates[0].listed.as_deref(), Some("recommended"));
    assert!(sign_in.candidates[0].proposed);
    assert!(!sign_in.candidates[1].proposed);
    // A future part is never proposed, whatever it is judged.
    assert!(!by_id("create-task").candidates[0].proposed);
}

#[test]
fn a_covered_requirement_with_only_future_parts_is_reviewed_not_proposed() {
    let c = Candidate {
        gear_id: "gears-rust/x".into(),
        pick: "x".into(),
        name: None,
        verdict: "covered".into(),
        confidence: None,
        role: "chosen".into(),
        evidence: String::new(),
        covers: String::new(),
        missing: String::new(),
        rationale: String::new(),
        in_code: Some(false),
        listed: Some("future_part".into()),
        proposed: false,
    };
    assert_eq!(action_of("covered", &[c]), ACTION_REVIEW);
    assert_eq!(action_of("not_assessed", &[]), ACTION_RERUN);
}

#[test]
fn the_passage_is_the_requirements_heading_and_block() {
    let p = passage(&docs(), "cpt-examples-todo-app-fr-changes-feed").unwrap();
    assert_eq!(p.path, "docs/PRD.md");
    assert!(p.text.starts_with("#### Changes Feed"), "{}", p.text);
    assert!(p.text.contains("real time"));
    // It stops before the next requirement.
    assert!(!p.text.contains("Sign In"), "{}", p.text);
    assert_eq!(p.line, 11);
    assert_eq!(passage(&docs(), "cpt-nowhere"), None);
}

#[test]
fn an_id_is_not_found_inside_a_longer_one() {
    let d = vec![(
        "a.md".to_owned(),
        "x cpt-a-fr-one-more y\nthe cpt-a-fr-one line".to_owned(),
    )];
    assert_eq!(passage(&d, "cpt-a-fr-one").unwrap().line, 2);
}

#[test]
fn an_answer_goes_after_its_requirement_and_only_into_the_copy() {
    let answers = vec![(
        "cpt-examples-todo-app-fr-changes-feed".to_owned(),
        "Changes reach\nother devices within 2 s.".to_owned(),
    )];
    let (text, applied) = with_answers(PRD, &answers);
    assert_eq!(
        applied,
        vec!["cpt-examples-todo-app-fr-changes-feed".to_owned()]
    );
    let feed = text.find("real time").unwrap();
    let answer = text.find("**Answered in Studio**").unwrap();
    let next = text.find("#### Sign In").unwrap();
    assert!(feed < answer && answer < next, "{text}");
    assert!(text.contains("Changes reach other devices within 2 s."));
    // The answered block is still the requirement's passage.
    let d = vec![("docs/PRD.md".to_owned(), text)];
    assert!(
        passage(&d, "cpt-examples-todo-app-fr-changes-feed")
            .unwrap()
            .text
            .contains("Answered in Studio")
    );
    // An id the text does not have is not applied.
    let (same, none) = with_answers(PRD, &[("cpt-x".into(), "y".into())]);
    assert_eq!(same, PRD);
    assert!(none.is_empty());
}

#[test]
fn general_answers_are_a_section_at_the_end() {
    let out = with_general_answers("# A\n", &[("Offline".into(), "yes, read-only".into())]);
    assert!(
        out.ends_with("## Answers given in Studio\n\n- **Offline**: yes, read-only\n"),
        "{out}"
    );
    assert_eq!(with_general_answers("# A\n", &[]), "# A\n");
}

#[test]
fn the_questions_are_the_undecided_requirements_then_the_reports_own() {
    let r = report();
    let reqs = requirements(&r, &docs());
    let q = questions(&r, &reqs, |p| {
        (p == "docs/PRD.md").then(|| "docs/PRD.md".to_owned())
    });
    assert_eq!(q.len(), 2);
    assert_eq!(q[0].id, "cpt-examples-todo-app-fr-changes-feed");
    assert_eq!(q[0].path.as_deref(), Some("docs/PRD.md"));
    assert!(
        q[1].id.starts_with("c-") && q[1].id.len() == 14,
        "{}",
        q[1].id
    );
    assert_eq!(q[1].requirement_id, None);
    assert_eq!(q[1].topic, "Offline");
}

#[test]
fn totals_add_fr_and_nfr() {
    let t = totals(&report());
    assert_eq!(
        t,
        Totals {
            requirements: 3,
            covered: 1,
            partial: 0,
            gap: 1,
            clarification_needed: 1,
            not_assessed: 0
        }
    );
    assert!(t.line().starts_with("3 requirements: 1 covered"));
    assert!(readable(&report()));
    assert!(!readable(&json!({"schema_version": "2.0.0"})));
}

#[test]
fn two_runs_differ_by_verdict_and_by_proposed_gear() {
    let base = requirements(&report(), &docs());
    let mut second = report();
    second["requirements"][1]["coverage"] = json!("partial");
    second["requirements"][1]["gears"][0]["verdict"] = json!("partial");
    let head = requirements(&second, &docs());
    let (changes, same) = diff(&base, &head);
    assert_eq!(same, 2);
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].before.as_deref(), Some("clarification_needed"));
    assert_eq!(changes[0].after.as_deref(), Some("partial"));
    assert_eq!(
        changes[0].gears_after,
        vec!["gears-rust/event-broker".to_owned()]
    );
    // A requirement only one run has is a change too.
    let (changes, _) = diff(&base, &head[..2]);
    assert!(changes.iter().any(|c| c.after.is_none()));
}

#[test]
fn a_path_is_one_the_matcher_takes() {
    assert_eq!(
        matcher_path("docs/prd/constructor-studio.md"),
        "docs/prd/constructor-studio.md"
    );
    assert_eq!(matcher_path("upload:survey.csv"), "upload/survey.csv.md");
    assert_eq!(
        matcher_path("studio:f8345044-3c41-4eeb-a9da-07d11a666b5c"),
        "studio/f8345044-3c41-4eeb-a9da-07d11a666b5c.md"
    );
    assert_eq!(matcher_path("/a/../b\\c.MD"), "a/_/b/c.MD");
    assert!(matcher_path(&"x/".repeat(400)).chars().count() <= 300);
    assert_eq!(sha256_hex("").len(), 64);
}
