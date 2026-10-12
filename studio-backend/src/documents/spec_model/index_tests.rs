use super::*;

fn doc<'a>(path: &'a str, text: &'a str) -> SourceDoc<'a> {
    SourceDoc {
        path,
        text,
        doc_type: None,
    }
}

fn run(docs: &[SourceDoc<'_>], extra: &[&str]) -> Vec<Finding> {
    let tree: BTreeSet<String> = docs
        .iter()
        .map(|d| d.path.to_string())
        .chain(extra.iter().map(|p| (*p).to_string()))
        .collect();
    reference_findings(docs, &tree).1
}

fn rules(findings: &[Finding]) -> Vec<(&str, &str)> {
    findings
        .iter()
        .map(|f| (f.rule.as_str(), f.sides[0].quote.as_deref().unwrap_or("")))
        .collect()
}

#[test]
fn an_adr_status_is_read_in_every_form_seen() {
    assert_eq!(
        adr_status("---\nstatus: proposed\n---\n# T").as_deref(),
        Some("proposed")
    );
    assert_eq!(
        adr_status("# T\n\n**Status**: Accepted (2026-01-02)").as_deref(),
        Some("accepted")
    );
    assert_eq!(
        adr_status("# T\n- **Status:** superseded by ADR-0011").as_deref(),
        Some("superseded")
    );
    assert_eq!(adr_status("# T\n| Status | Draft |").as_deref(), None);
    assert_eq!(adr_status("# T\nNo status here."), None);
}

#[test]
fn adrs_are_indexed_per_directory() {
    let docs = [
        doc(
            "docs/domain/specs/ADR/0002-a.md",
            "# Stable ids\nStatus: accepted",
        ),
        doc(
            "docs/components/x/specs/ADR/0002-b.md",
            "# Read from the store\n",
        ),
        doc("docs/notes/0002-not-an-adr.md", "# Notes"),
    ];
    let index = build_index(&docs);
    let found: Vec<(&str, u32)> = index
        .adrs
        .iter()
        .map(|a| (a.namespace.as_str(), a.number))
        .collect();
    assert_eq!(
        found,
        vec![
            ("docs/components/x/specs/ADR", 2),
            ("docs/domain/specs/ADR", 2)
        ]
    );
    assert_eq!(index.adrs[1].status.as_deref(), Some("accepted"));
    assert_eq!(index.adrs[1].title.as_deref(), Some("Stable ids"));
}

#[test]
fn an_adr_number_the_project_does_not_have_is_dangling() {
    let docs = [
        doc("docs/adr/0001-a.md", "# A"),
        doc("docs/design.md", "As ADR-0001 says, and ADR-0007 decided."),
    ];
    let found = run(&docs, &[]);
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].rule, "reference.dangling");
    assert!(found[0].message.contains("ADR-0007"));
}

#[test]
fn a_project_without_adrs_has_no_adr_findings() {
    let docs = [doc("docs/design.md", "Like the platform's ADR-0042.")];
    assert!(run(&docs, &[]).is_empty());
}

#[test]
fn a_number_two_adr_sets_share_is_ambiguous_only_from_outside_both() {
    let docs = [
        doc("docs/domain/ADR/0002-a.md", "# A"),
        doc("docs/component/ADR/0002-b.md", "# B"),
        doc(
            "docs/component/DESIGN.md",
            "Per ADR-0002 the reader is local.",
        ),
        doc("README.md", "See ADR-0002."),
    ];
    let found = run(&docs, &[]);
    assert_eq!(
        rules(&found),
        vec![("reference.ambiguous", "See ADR-0002.")]
    );
    assert_eq!(found[0].sides.len(), 3);
}

#[test]
fn a_citation_that_is_a_link_is_resolved_by_the_link() {
    let docs = [
        doc("docs/domain/ADR/0002-a.md", "# A"),
        doc("docs/component/ADR/0002-b.md", "# B"),
        doc("README.md", "See [ADR-0002](docs/domain/ADR/0002-a.md)."),
    ];
    assert!(run(&docs, &[]).is_empty());
}

#[test]
fn links_resolve_against_the_tree_and_the_headings() {
    let docs = [
        doc("docs/a.md", "# Title\n\n## The Finding\n\ntext"),
        doc(
            "docs/b.md",
            "[ok](a.md) [dir](../src) [anchor](a.md#the-finding) [web](https://x.y/z.md)\n\
             [gone](missing.md)\n\
             [bad anchor](a.md#nope)\n\
             [self](#local)\n\n## Local",
        ),
    ];
    let found = run(&docs, &["src/main.rs"]);
    assert_eq!(
        rules(&found),
        vec![
            ("reference.dangling", "[gone](missing.md)"),
            ("reference.dangling", "[bad anchor](a.md#nope)"),
        ]
    );
}

#[test]
fn code_comments_and_front_matter_are_not_read() {
    let docs = [doc(
        "docs/b.md",
        "---\nlink: \"[x](front.md)\"\n---\n```\n[x](code.md)\n```\n<!-- [x](comment.md) -->\nfine",
    )];
    assert!(run(&docs, &[]).is_empty());
}

#[test]
fn an_identifier_is_checked_only_in_a_family_the_project_defines() {
    let defs: String = (1..=5)
        .map(|i| format!("- **ID**: `app-fr-thing-{i}`\n"))
        .collect();
    let docs = [
        doc("docs/prd.md", &defs),
        doc(
            "docs/design.md",
            "Covers `app-fr-thing-1` and `app-fr-thing-9`, uses `serde-json-value` and `app-fr-*`.",
        ),
    ];
    let found = run(&docs, &[]);
    assert_eq!(found.len(), 1, "{found:?}");
    assert!(found[0].message.contains("`app-fr-thing-9`"));
}

#[test]
fn a_family_with_few_definitions_is_not_a_convention() {
    let docs = [
        doc("docs/prd.md", "- **ID**: `one-off-id`"),
        doc("docs/design.md", "`one-off-other`"),
    ];
    assert!(run(&docs, &[]).is_empty());
}

#[test]
fn one_missing_identifier_is_one_finding_with_every_place() {
    let defs: String = (1..=5)
        .map(|i| {
            format!(
                "- **ID**: `app-fr-thing-{i}`
"
            )
        })
        .collect();
    let docs = [
        doc("docs/prd.md", &defs),
        doc("docs/a.md", "Needs `app-fr-gone-one`."),
        doc("docs/b.md", "Also `app-fr-gone-one`, again."),
    ];
    let found = run(&docs, &[]);
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].sides.len(), 2);
    let alone = run(&docs[..2], &[]);
    assert_eq!(
        alone[0].fingerprint, found[0].fingerprint,
        "one more citation is the same finding"
    );
}

#[test]
fn a_section_counts_as_there_whichever_renderer_slugged_it() {
    let docs = [
        doc(
            "docs/a.md",
            "## D1 — Range naming — `effective_from`
### Three-column routing by `value_type` (chosen)",
        ),
        doc(
            "docs/b.md",
            "[x](a.md#d1----range-naming----effectivefrom) [y](a.md#three-column-routing-by-value_type-chosen) [z](a.md#gone)",
        ),
    ];
    let found = run(&docs, &[]);
    assert_eq!(found.len(), 1, "{found:?}");
    assert!(found[0].message.contains("#gone"));
}

#[test]
fn a_former_name_is_history_not_a_reference() {
    let defs: String = (1..=5)
        .map(|i| {
            format!(
                "- **ID**: `app-fr-thing-{i}`
"
            )
        })
        .collect();
    let docs = [
        doc("docs/prd.md", &defs),
        doc(
            "docs/a.md",
            "Formerly `app-fr-old-name` in the backend PRD.",
        ),
    ];
    assert!(run(&docs, &[]).is_empty());
}

#[test]
fn a_heading_that_is_a_link_is_slugged_by_its_label() {
    let docs = [doc(
        "docs/a.md",
        "- [2.4 Levels](#24-levels)

### 2.4 [Levels](feature/levels.md)",
    )];
    assert!(run(&docs, &["docs/feature/levels.md"]).is_empty());
}

#[test]
fn a_singular_contract_label_defines_its_identifier() {
    let defs: String = (1..=5)
        .map(|i| {
            format!(
                "- **ID**: `app-fr-thing-{i}`
"
            )
        })
        .collect();
    let docs = [
        doc("docs/prd.md", &defs),
        doc(
            "docs/design.md",
            "- **Contract**: `app-contract-oidc-x`

- **Contracts**: `app-contract-oidc-x`",
        ),
    ];
    assert!(run(&docs, &[]).is_empty());
}

const ADR_KEYS: &str = "# ADR-0039: Model calls go out on a person's own provider key\n\n**Status**: Accepted\n\n## Context\n\nKeys.\n\n## Decision\n\nEvery model call uses the caller's key.\n";
const ADR_PDP: &str =
    "# ADR-0035: The PDP maps the domain object to a privilege\n\n**Status**: Accepted\n";

#[test]
fn a_citation_whose_words_miss_the_records_title_is_a_misattribution_candidate() {
    let design = "# Design\n\nAs ADR-0039 decided, every gear table carries a tenant column for row isolation.\n";
    let docs = [
        doc("docs/adr/0039-keys.md", ADR_KEYS),
        doc("docs/adr/0035-pdp.md", ADR_PDP),
        doc("docs/design.md", design),
    ];
    let found = misattribution_candidates(&docs, 10);
    assert_eq!(found.len(), 1);
    let c = &found[0];
    assert_eq!(c.rule, "reference.misattributed");
    assert_eq!(c.sides[0].path, "docs/design.md");
    assert_eq!(c.sides[0].line_start, 3);
    assert_eq!(c.sides[1].path, "docs/adr/0039-keys.md");
    assert_eq!(c.sides[1].line_start, 1);
    assert_eq!(c.sides[1].status, "accepted");
}

#[test]
fn a_citation_that_shares_the_titles_words_or_says_nothing_is_left_alone() {
    let design = "# Design\n\nModel calls use the caller's provider key (ADR-0039).\n\nSee ADR-0039.\n\nSee [the record](adr/0035-pdp.md) on how the domain object maps to a privilege.\n";
    let docs = [
        doc("docs/adr/0039-keys.md", ADR_KEYS),
        doc("docs/adr/0035-pdp.md", ADR_PDP),
        doc("docs/design.md", design),
    ];
    assert!(misattribution_candidates(&docs, 10).is_empty());
}

#[test]
fn a_linked_record_is_resolved_by_its_path_and_one_candidate_per_document_and_record() {
    let design = "# Design\n\nRetention of audit rows is set in [this record](adr/0035-pdp.md).\n\nAudit retention again per ADR-0035, ninety days.\n";
    let docs = [
        doc("docs/adr/0035-pdp.md", ADR_PDP),
        doc("docs/design.md", design),
    ];
    let found = misattribution_candidates(&docs, 10);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].sides[1].path, "docs/adr/0035-pdp.md");
}

#[test]
fn a_record_citing_itself_is_no_candidate_and_the_cap_holds() {
    let own = "# ADR-0035: The PDP maps the domain object to a privilege\n\nUnlike ADR-0035 of the billing set, rows are partitioned weekly.\n";
    assert!(misattribution_candidates(&[doc("docs/adr/0035-pdp.md", own)], 10).is_empty());
    let design = "# Design\n\nRetention of audit rows follows ADR-0035 strictly forever.\n\nEvery gear table carries a tenant column, as ADR-0039 decided.\n";
    let docs = [
        doc("docs/adr/0039-keys.md", ADR_KEYS),
        doc("docs/adr/0035-pdp.md", ADR_PDP),
        doc("docs/design.md", design),
    ];
    assert_eq!(misattribution_candidates(&docs, 10).len(), 2);
    assert_eq!(misattribution_candidates(&docs, 1).len(), 1);
}

#[test]
fn a_line_citing_two_records_a_heading_or_a_checklist_id_is_no_candidate() {
    let design = "# Design\n\nAudit rows are partitioned weekly (ADR-0035, ADR-0039).\n\n## Audit retention per ADR-0035 forever\n\nARCH-ADR-0035: audit retention is partitioned weekly.\n";
    let docs = [
        doc("docs/adr/0039-keys.md", ADR_KEYS),
        doc("docs/adr/0035-pdp.md", ADR_PDP),
        doc("docs/design.md", design),
    ];
    assert!(misattribution_candidates(&docs, 10).is_empty());
}
