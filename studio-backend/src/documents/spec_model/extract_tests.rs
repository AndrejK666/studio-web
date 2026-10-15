use super::*;

fn chunk_of(text: &str) -> Chunk {
    Chunk {
        first_line: 1,
        lines: text.lines().map(str::to_string).collect(),
    }
}

fn answer(facts: &str) -> String {
    format!("Here you are:\n```json\n{{\"facts\": [{facts}]}}\n```")
}

const DOC: &str = "# Billing\n\n## Seats\n\nEach `(seat, month)` snapshot is emitted once, dated at the first day of its billing month.\nA window inside a month returns nothing.\n";

#[test]
fn a_fact_whose_quote_is_in_its_lines_is_kept_where_it_is() {
    let c = chunk_of(DOC);
    let out = read_answer(
        "docs/DESIGN.md",
        &c,
        &answer(
            r#"{"kind":"lifecycle","subject":"seat snapshot","aspect":"dating rule","value":"first day of the billing month","text":"A snapshot is dated at the first of its month.","status":"active","line_start":5,"line_end":5,"quote":"dated at the first day of its billing month"}"#,
        ),
    )
    .unwrap();
    assert_eq!(out.dropped, 0);
    let f = &out.facts[0];
    assert_eq!((f.line_start, f.line_end), (5, 5));
    assert_eq!(f.aspect, "dating rule");
    assert_eq!(f.path, "docs/DESIGN.md");
}

#[test]
fn markup_the_model_left_out_does_not_drop_a_quote() {
    let c = chunk_of(DOC);
    let out = read_answer(
        "d.md",
        &c,
        &answer(
            r#"{"kind":"entity","subject":"seat snapshot","text":"t","status":"active","line_start":5,"line_end":5,"quote":"Each (seat, month) snapshot is emitted once"}"#,
        ),
    )
    .unwrap();
    assert_eq!(out.facts.len(), 1);
}

#[test]
fn wrong_lines_are_corrected_and_an_invented_quote_is_dropped() {
    let c = chunk_of(DOC);
    let out = read_answer(
        "d.md",
        &c,
        &answer(
            r#"{"kind":"constraint","subject":"window","text":"t","status":"active","line_start":1,"line_end":1,"quote":"A window inside a month returns nothing."},
               {"kind":"constraint","subject":"window","text":"t","status":"active","line_start":6,"line_end":6,"quote":"A window inside a month returns the whole month."}"#,
        ),
    )
    .unwrap();
    assert_eq!(out.dropped, 1);
    assert_eq!((out.facts[0].line_start, out.facts[0].line_end), (6, 6));
}

#[test]
fn an_unknown_kind_or_status_is_dropped() {
    let c = chunk_of(DOC);
    let out = read_answer(
        "d.md",
        &c,
        &answer(
            r#"{"kind":"vibe","subject":"x","text":"t","status":"active","quote":"A window inside a month returns nothing."},
               {"kind":"entity","subject":"x","text":"t","status":"maybe","quote":"A window inside a month returns nothing."}"#,
        ),
    )
    .unwrap();
    assert_eq!((out.facts.len(), out.dropped), (0, 2));
}

#[test]
fn an_answer_without_json_is_an_error() {
    assert!(read_answer("d.md", &chunk_of(DOC), "I cannot help with that.").is_err());
}

#[test]
fn a_document_is_cut_at_top_level_headings_and_keeps_its_line_numbers() {
    let section = |n: usize| format!("## S{n}\n{}\n", "x".repeat(5_000));
    let text: String = (1..=4).map(section).collect();
    let parts = chunks(&text);
    assert_eq!(parts.len(), 2, "two sections of 5k fit one 12k piece");
    assert_eq!(parts[0].first_line, 1);
    assert_eq!(parts[1].first_line, 5);
    assert_eq!(parts[1].lines[0], "## S3");
    let total: usize = parts.iter().map(|c| c.lines.len()).sum();
    assert_eq!(total, text.lines().count());
}

#[test]
fn a_heading_inside_a_code_fence_does_not_cut() {
    let text = format!("# T\n```\n## not a heading\n```\n{}", "y\n".repeat(3));
    assert_eq!(chunks(&text).len(), 1);
}

#[test]
fn a_section_longer_than_a_piece_is_cut_between_lines() {
    let text = format!("## Long\n{}", "line of text\n".repeat(2_000));
    let parts = chunks(&text);
    assert!(parts.len() > 1);
    assert!(
        parts
            .iter()
            .all(|c| c.lines.iter().map(|l| l.len() + 1).sum::<usize>() <= 12_000)
    );
}

#[test]
fn the_question_numbers_every_line() {
    let c = Chunk {
        first_line: 40,
        lines: vec!["a".into(), "b".into()],
    };
    let r = request("docs/PRD.md", Some("prd"), &c, (2, 3));
    assert!(
        r.prompt
            .contains("`docs/PRD.md` (a prd), part 2 of 3, lines 40-41")
    );
    assert!(r.prompt.contains("40| a\n41| b\n"));
}

#[test]
fn a_revision_changes_with_the_text_only() {
    assert_eq!(revision("a"), revision("a"));
    assert_ne!(revision("a"), revision("b"));
}

#[test]
fn an_entity_keeps_the_layer_it_is_given_and_other_kinds_drop_it() {
    let c = chunk_of(DOC);
    let out = read_answer(
        "d.md",
        &c,
        &answer(concat!(
            r#"{"kind":"entity","subject":"seat snapshot","text":"t","status":"active","quote":"Each (seat, month) snapshot is emitted once","layer":" System "},"#,
            r#"{"kind":"entity","subject":"billing month","text":"t","status":"active","quote":"dated at the first day of its billing month","layer":"cloud"},"#,
            r#"{"kind":"entity","subject":"window","text":"t","status":"active","quote":"A window inside a month returns nothing"},"#,
            r#"{"kind":"constraint","subject":"window","text":"t","status":"active","quote":"A window inside a month returns nothing","layer":"domain"}"#,
        )),
    )
    .unwrap();
    assert_eq!(out.dropped, 0);
    let layers: Vec<Option<&str>> = out.facts.iter().map(|f| f.layer.as_deref()).collect();
    assert_eq!(layers, [Some("system"), None, None, None]);
}

#[test]
fn a_kept_fact_without_a_layer_still_loads() {
    let stored = r#"[{"kind":"entity","subject":"seat","aspect":"","value":"","text":"t","status":"active","status_because":"","path":"d.md","line_start":1,"line_end":1,"quote":"q"}]"#;
    let facts: Vec<Fact> = serde_json::from_str(stored).unwrap();
    assert_eq!(facts[0].layer, None);
    assert!(!serde_json::to_string(&facts).unwrap().contains("layer"));
}

#[test]
fn the_question_asks_for_a_layer() {
    let c = chunk_of(DOC);
    let r = request("d.md", None, &c, (1, 1));
    assert!(r.system.contains("\"layer\""));
    assert!(r.system.contains("deployment (where it runs"));
}
