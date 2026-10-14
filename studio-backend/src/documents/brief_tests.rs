use super::*;

const OLD: &str = "\
- **ID**: `cpt-app-fr-export`

The system exports reports.

- **ID**: `cpt-app-fr-limit`

Uploads are limited to 10 MB.

- **ID**: `cpt-app-fr-gone`

The system prints reports.
";

const NEW: &str = "\
- **ID**: `cpt-app-fr-export`

The system   exports reports.

- **ID**: `cpt-app-fr-limit`

Uploads are limited to 50 MB.

- **ID**: `cpt-app-fr-new`

The system signs reports.
";

#[test]
fn changes_are_computed_from_the_labelled_requirements() {
    let got = changes("prd.md", OLD, NEW);
    let kinds: Vec<(&str, &str)> = got
        .iter()
        .map(|c| (c.id.as_str(), c.kind.as_str()))
        .collect();
    assert_eq!(
        kinds,
        [
            ("cpt-app-fr-limit", "changed"),
            ("cpt-app-fr-new", "added"),
            ("cpt-app-fr-gone", "removed"),
        ],
        "whitespace alone is not a change"
    );
}

#[test]
fn the_answer_is_read_and_held_to_the_computed_changes() {
    let changed = changes("prd.md", OLD, NEW);
    let answer = r#"Here you go:
```json
{"problem": "Reports", "roles": ["PM"], "scope": "export", "assumptions": [],
 "open_decisions": ["Is 50 MB enough?"],
 "changes": [
   {"id": "cpt-app-fr-limit", "meaning": false, "why": "wording"},
   {"id": "cpt-invented", "meaning": true, "why": "made up"},
   {"id": "cpt-app-fr-new", "meaning": false, "why": "the model is wrong"}
 ]}
```"#;
    let brief = read_answer(answer, &changed).expect("a brief");
    assert_eq!(brief.problem, "Reports");
    assert_eq!(brief.open_decisions, ["Is 50 MB enough?"]);
    let by_id = |id: &str| brief.changes.iter().find(|c| c.id == id).cloned();
    assert!(
        by_id("cpt-invented").is_none(),
        "no claim about what was not found"
    );
    assert!(
        !by_id("cpt-app-fr-limit").expect("limit").meaning,
        "the model's reading of a reworded line stands"
    );
    assert!(
        by_id("cpt-app-fr-new").expect("new").meaning,
        "an added requirement always changes what is required"
    );
    assert!(
        by_id("cpt-app-fr-gone").expect("gone").meaning,
        "a skipped change counts as meaning"
    );
}

#[test]
fn an_answer_without_json_is_refused() {
    assert!(read_answer("no idea", &[]).is_err());
}

#[test]
fn the_request_carries_the_changes_and_clips_the_text() {
    let long = "x".repeat(TEXT_MAX + 10);
    let r = request("prd.md", Some("prd"), &long, &changes("prd.md", OLD, NEW));
    assert!(r.prompt.contains("cpt-app-fr-limit"));
    assert!(r.prompt.contains("(a prd)"));
    assert!(r.prompt.len() < TEXT_MAX + 4_000);
}
