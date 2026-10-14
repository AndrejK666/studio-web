use super::*;

fn doc<'a>(path: &'a str, text: &'a str) -> SourceDoc<'a> {
    SourceDoc {
        path,
        text,
        doc_type: None,
    }
}

const PRD: &str = "\
# PRD

**ID**: `cpt-app-actor-member`

A member of the organization.

## Functional requirements

#### Workspaces are tenants

- [x] `p1` - **ID**: `cpt-app-fr-workspaces`

The system **MUST** create workspaces as tenants (ADR-0010).

- **Rationale**: tenancy is already enforced.
- **Actors**: `cpt-app-actor-member`

#### Reserved areas

- [ ] `p2` - **ID**: `cpt-app-fr-reserved`

The portal **MUST** show a reserved area.

- **Rationale**: no fabricated data.

#### Export

- **ID**: `cpt-app-fr-export`

The system exports reports.

#### Limits

- **ID**: `cpt-app-fr-limits`

The upload limit is TBD with the storage team.

#### Volume

- **ID**: `cpt-app-fr-volume`

We assume about 1,000 files per project.
- **Source**: customer interviews, September

#### Retention

- **ID**: `cpt-app-fr-retention`

Should deleted projects be kept for 30 days?
";

const DESIGN: &str = "\
# Design

- **ID**: `cpt-app-design-tenants`

Implements `cpt-app-fr-workspaces`, see [the ADR](adr/0010.md) and #42.
";

fn by_id<'a>(all: &'a [Requirement], id: &str) -> &'a Requirement {
    all.iter().find(|r| r.id == id).expect(id)
}

#[test]
fn every_labelled_definition_is_a_requirement_in_document_order() {
    let all = requirements(&[doc("prd.md", PRD), doc("design.md", DESIGN)]);
    let ids: Vec<&str> = all.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(
        ids,
        [
            "cpt-app-actor-member",
            "cpt-app-fr-workspaces",
            "cpt-app-fr-reserved",
            "cpt-app-fr-export",
            "cpt-app-fr-limits",
            "cpt-app-fr-volume",
            "cpt-app-fr-retention",
            "cpt-app-design-tenants",
        ]
    );
}

#[test]
fn the_block_gives_title_statement_priority_and_checkbox() {
    let all = requirements(&[doc("prd.md", PRD)]);
    let r = by_id(&all, "cpt-app-fr-workspaces");
    assert_eq!(r.title.as_deref(), Some("Workspaces are tenants"));
    assert_eq!(
        r.text,
        "The system **MUST** create workspaces as tenants (ADR-0010)."
    );
    assert_eq!(r.kind.as_deref(), Some("fr"));
    assert_eq!(r.priority.as_deref(), Some("p1"));
    assert_eq!(r.done, Some(true));
    assert_eq!(r.line, 11);
    let reserved = by_id(&all, "cpt-app-fr-reserved");
    assert_eq!(reserved.done, Some(false));
    assert_eq!(by_id(&all, "cpt-app-fr-export").done, None);
}

#[test]
fn a_citation_makes_it_cited_and_an_id_of_the_same_document_does_not() {
    let all = requirements(&[doc("prd.md", PRD), doc("design.md", DESIGN)]);
    let r = by_id(&all, "cpt-app-fr-workspaces");
    assert_eq!(r.basis, Basis::Cited);
    // The actor is defined in the same PRD: a list of actors is not a source.
    assert_eq!(r.cites, ["ADR-0010"]);
    let design = by_id(&all, "cpt-app-design-tenants");
    assert_eq!(design.basis, Basis::Cited);
    assert_eq!(
        design.cites,
        ["#42", "adr/0010.md", "cpt-app-fr-workspaces"]
    );
}

#[test]
fn a_reason_without_a_citation_is_reasoned_and_nothing_is_stated() {
    let all = requirements(&[doc("prd.md", PRD)]);
    assert_eq!(by_id(&all, "cpt-app-fr-reserved").basis, Basis::Reasoned);
    assert_eq!(by_id(&all, "cpt-app-fr-export").basis, Basis::Stated);
    assert_eq!(by_id(&all, "cpt-app-actor-member").basis, Basis::Stated);
}

#[test]
fn doubt_outranks_a_citation() {
    let all = requirements(&[doc("prd.md", PRD)]);
    let limits = by_id(&all, "cpt-app-fr-limits");
    assert_eq!(limits.basis, Basis::OpenQuestion);
    assert_eq!(limits.because.as_deref(), Some("tbd"));
    let volume = by_id(&all, "cpt-app-fr-volume");
    // It names a source, but says it assumes.
    assert_eq!(volume.basis, Basis::Assumption);
    assert_eq!(volume.because.as_deref(), Some("assume"));
    assert_eq!(volume.cites, ["customer interviews, September"]);
    let retention = by_id(&all, "cpt-app-fr-retention");
    assert_eq!(retention.basis, Basis::OpenQuestion);
}

#[test]
fn issue_numbers_need_a_word_of_their_own() {
    assert_eq!(issue_refs("see #12, and (#7)"), ["#12", "#7"]);
    assert!(issue_refs("colour #fff and a#1 and ##").is_empty());
}

#[test]
fn a_long_statement_is_clipped() {
    let long = format!("- **ID**: `cpt-app-fr-long`\n\n{}\n", "word ".repeat(200));
    let all = requirements(&[doc("x.md", &long)]);
    assert!(all[0].text.ends_with('…'));
    assert_eq!(all[0].text.chars().count(), TEXT_MAX + 1);
}
