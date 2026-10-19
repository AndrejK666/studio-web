use super::*;

const PRD: &str = "# PRD\n\n## 1. Overview\n\n### 1.4 Glossary\n\n\
These terms are used with exactly this meaning.\n\n\
| Term | Definition |\n|------|------------|\n\
| Organization | An account-management tenant. |\n\
| **Member** | A person with a membership, recorded by `studio-user` (ADR-0016). |\n\
| Gear \\| module | A CF/Gears module. |\n\n\
## 2. Actors\n\nPeople.\n";

#[test]
fn a_glossary_section_inside_a_prd_is_found_with_its_rows() {
    let found = find([("docs/prd/x.md", PRD)]).expect("found");
    assert!(!found.whole);
    assert_eq!(found.heading.as_deref(), Some("1.4 Glossary"));
    assert_eq!(found.line_start, 5);
    assert_eq!(
        found.line_end, 14,
        "the section ends before the next heading of its level or above"
    );
    let terms: Vec<&str> = found.rows.iter().map(|r| r.term.as_str()).collect();
    assert_eq!(terms, ["Organization", "Member", "Gear | module"]);
    assert_eq!(
        found.rows[1].definition,
        "A person with a membership, recorded by `studio-user` (ADR-0016)."
    );
}

#[test]
fn the_glossary_file_wins_over_a_section() {
    let file = "# Glossary\n\n| Term | Definition | Also written as | Not the same as | Source |\n|---|---|---|---|---|\n\
| <a id=\"member\"></a>**Member** | A person. | participant, org member | [Membership](#membership) | `docs/a.md:3` |\n";
    let found = find([("docs/prd/x.md", PRD), (GLOSSARY_DOC_PATH, file)]).expect("found");
    assert!(found.whole);
    let r = &found.rows[0];
    assert_eq!(r.term, "Member");
    assert_eq!(r.aliases, ["participant", "org member"]);
    assert_eq!(r.not_same_as, ["Membership"]);
    assert_eq!(r.source.as_deref(), Some("docs/a.md:3"));
}

#[test]
fn a_table_that_is_not_about_terms_or_a_heading_that_is_not_a_glossary_is_not_one() {
    let other = "## Glossary\n\n| Route | Method |\n|---|---|\n| /x | GET |\n\n## Terms of the table\n\nNone.\n";
    assert_eq!(find([("docs/a.md", other)]), None);
    let not_named = "## Overview\n\n| Term | Definition |\n|---|---|\n| A | B |\n";
    assert_eq!(find([("docs/a.md", not_named)]), None);
}

#[test]
fn what_is_rendered_reads_back_as_the_same_rows() {
    let rows = vec![
        Row {
            term: "Member".into(),
            definition: "A person | with a role.".into(),
            aliases: vec!["participant".into()],
            not_same_as: vec!["Membership".into(), "Seat".into()],
            source: Some("docs/a.md:3".into()),
        },
        Row {
            term: "Membership".into(),
            definition: "The standing.".into(),
            ..Row::default()
        },
    ];
    let text = render(&rows);
    assert!(text.contains("[Membership](#membership), Seat"), "{text}");
    let found = find([(GLOSSARY_DOC_PATH, text.as_str())]).expect("found");
    assert_eq!(found.rows, rows);
}

#[test]
fn a_section_is_replaced_by_a_link_and_keeps_its_heading() {
    let found = find([("docs/prd/x.md", PRD)]).expect("found");
    let after = replace_section(PRD, &found);
    assert!(after.contains(
        "### 1.4 Glossary\n\nThe project's terms are kept in [the glossary](../glossary.md)"
    ));
    assert!(!after.contains("Organization |"));
    assert!(after.contains("## 2. Actors\n\nPeople.\n"));
}

#[test]
fn links_and_anchors() {
    assert_eq!(
        relative("docs/prd/x.md", GLOSSARY_DOC_PATH),
        "../glossary.md"
    );
    assert_eq!(relative("docs/x.md", GLOSSARY_DOC_PATH), "glossary.md");
    assert_eq!(relative("README.md", GLOSSARY_DOC_PATH), "docs/glossary.md");
    assert_eq!(anchor("Document type"), "document-type");
    assert_eq!(anchor("Gear | module"), "gear-module");
}

#[test]
fn the_written_glossary_declares_no_document_type_and_links_from_a_spec_folder() {
    let doc = render(&[Row {
        term: "Member".into(),
        definition: "A person with a membership.".into(),
        ..Row::default()
    }]);
    let (fm, _) = crate::documents::validate::split_front_matter(&doc);
    for key in ["type", "doc_type", "document_type", "kind"] {
        assert!(
            !fm.contains_key(key),
            "`{key}` would make the classifier bind the glossary as a specification"
        );
    }
    assert_eq!(fm.get("artifact").map(String::as_str), Some("glossary"));
    assert!(doc.contains("(../glossary.md#member)"));
}
