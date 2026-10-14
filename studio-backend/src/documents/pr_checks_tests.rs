use super::*;
use crate::documents::model::builtin_types;

fn adr() -> DocumentType {
    builtin_types()
        .into_iter()
        .find(|t| t.key == "adr")
        .expect("the built-in catalogue has an ADR type")
}

/// A document that fills every section the type requires with enough words.
fn filled(ty: &DocumentType) -> String {
    let mut text = String::from("---\n");
    for key in &ty.template.rules.front_matter {
        text.push_str(&format!("{key}: proposed\n"));
    }
    text.push_str("---\n\n# Title\n\n");
    for s in &ty.template.sections {
        text.push_str(&format!("## {}\n\n", s.title));
        text.push_str(&"word ".repeat(s.min_words.unwrap_or(1) + 40));
        text.push_str("\n\n");
    }
    text
}

#[test]
fn documents_that_follow_their_template_pass() {
    let ty = adr();
    let out = check(&[("docs/adr/0001.md".to_string(), &ty, filled(&ty))]);
    assert_eq!(out.state, "success", "{out:?}");
    assert_eq!(out.description, "1 document(s) follow their templates");
}

#[test]
fn a_missing_required_section_fails_and_says_which() {
    let ty = adr();
    let required = ty
        .template
        .sections
        .iter()
        .find(|s| s.required)
        .expect("an ADR requires a section")
        .title
        .clone();
    let text = filled(&ty).replace(&format!("## {required}\n"), "## Something else\n");
    let out = check(&[
        ("docs/adr/0002.md".to_string(), &ty, text),
        ("docs/adr/0003.md".to_string(), &ty, filled(&ty)),
    ]);
    assert_eq!(out.state, "failure");
    assert!(
        out.description.starts_with("1 of 2 document(s)"),
        "{}",
        out.description
    );
    assert!(out.description.contains("0002.md"));
    assert!(out.description.chars().count() <= 140);
    assert!(
        out.files[0].issues.iter().any(|i| i.contains(&required)),
        "{:?}",
        out.files[0].issues
    );
}

#[test]
fn nothing_changed_is_said_so() {
    assert_eq!(check(&[]).description, "No Studio document changed");
}

#[test]
fn open_pulls_are_read_with_their_head_and_files() {
    let answer = json!({ "data": { "repository": { "pullRequests": { "nodes": [
        { "number": 4, "title": "ADR", "url": "https://x/4", "headRefOid": "abc",
          "files": { "nodes": [ { "path": "docs/adr/0002.md" } ] } }
    ] } } } });
    let pulls = read_open_pulls(&answer).expect("read");
    assert_eq!(pulls[0].head, "abc");
    assert_eq!(pulls[0].files, ["docs/adr/0002.md"]);
}
