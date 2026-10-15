use super::*;

fn explanation(source: Source) -> Explanation {
    Explanation {
        text: "A thing.".into(),
        source,
        updated_at: "2026-10-15T00:00:00Z".into(),
    }
}

#[test]
fn a_model_never_writes_over_a_person_unless_asked() {
    assert!(may_generate(None, false));
    assert!(may_generate(Some(&explanation(Source::Generated)), false));
    assert!(!may_generate(Some(&explanation(Source::Edited)), false));
    assert!(may_generate(Some(&explanation(Source::Edited)), true));
}

#[test]
fn the_row_reads_and_writes_as_its_sources_spell_them() {
    let mut row = Explanations::default();
    row.items
        .insert("api-gateway".into(), explanation(Source::Edited));
    let value = serde_json::to_value(&row).unwrap();
    assert_eq!(value["items"]["api-gateway"]["source"], "edited");
    let back: Explanations = serde_json::from_value(value).unwrap();
    assert_eq!(back, row);
    // An empty row, as account-management might hold it.
    let empty: Explanations = serde_json::from_value(serde_json::json!({})).unwrap();
    assert!(empty.items.is_empty());
}

#[test]
fn a_person_s_text_is_trimmed_and_bounded() {
    assert_eq!(
        checked_text("  It sends mail.  ").unwrap(),
        "It sends mail."
    );
    assert!(checked_text("   ").is_err());
    assert!(checked_text(&"a".repeat(MAX_TEXT_CHARS + 1)).is_err());
    assert!(checked_text(&"é".repeat(MAX_TEXT_CHARS)).is_ok());
}

#[test]
fn the_question_carries_the_facts_and_the_readme_bounded() {
    let brief = GearBrief {
        id: "mini-chat".into(),
        crate_name: "cf-gears-mini-chat".into(),
        display_name: Some("Mini chat".into()),
        description: None,
        category: Some("communication".into()),
        maturity: Some("beta".into()),
        runtime_caps: vec!["rest".into(), "db".into()],
        host: None,
        points: vec!["ChatModel".into()],
        plugins: vec!["openai-chat".into()],
        brings: vec!["api-gateway".into()],
        path: Some("gears/mini-chat".into()),
        readme: Some(format!("# Mini chat\n{}", "x".repeat(MAX_README_BYTES * 2))),
    };
    let request = explanation_request(&brief);
    assert!(request.system.contains("two or three"));
    let p = &request.prompt;
    assert!(p.contains("Gear: Mini chat\n"));
    assert!(p.contains("Crate: cf-gears-mini-chat\n"));
    assert!(p.contains("Area: communication\n"));
    assert!(p.contains("Maturity: beta\n"));
    assert!(p.contains("Runtime capabilities: rest, db\n"));
    assert!(p.contains("ChatModel"));
    assert!(p.contains("openai-chat"));
    assert!(p.contains("always come with it: api-gateway"));
    assert!(!p.contains("Its own description"));
    assert!(p.contains("README:\n# Mini chat"));
    assert!(p.len() < MAX_README_BYTES + 1_000);
}

#[test]
fn a_plugin_is_asked_about_as_a_choice_for_its_host() {
    let brief = GearBrief {
        id: "s3-storage".into(),
        crate_name: "cf-gears-s3-storage".into(),
        host: Some("File storage".into()),
        description: Some("  ".into()),
        ..GearBrief::default()
    };
    let p = explanation_request(&brief).prompt;
    assert!(p.starts_with("Gear: cf-gears-s3-storage\n"));
    assert!(!p.contains("Crate:"));
    assert!(p.contains("one of the choices for File storage"));
    assert!(!p.contains("Its own description"));
    assert!(!p.contains("README"));
}

#[test]
fn an_answer_is_cleaned_to_plain_sentences() {
    assert_eq!(
        clean_answer("It keeps files.\n\nPick it when users upload things.").unwrap(),
        "It keeps files. Pick it when users upload things."
    );
    assert_eq!(
        clean_answer("```text\nIt keeps **files**.\n```").unwrap(),
        "It keeps files."
    );
    assert_eq!(
        clean_answer("Explanation: \"It sends mail.\"").unwrap(),
        "It sends mail."
    );
    assert_eq!(
        clean_answer("## About\n- It sends mail.").unwrap(),
        "About It sends mail."
    );
    assert_eq!(
        clean_answer("\u{201c}It sends mail.\u{201d}").unwrap(),
        "It sends mail."
    );
    assert!(clean_answer("  \n ```\n```").is_err());
}

#[test]
fn a_long_answer_is_cut_at_a_sentence_end() {
    let sentence = "This part keeps the product's files safe. ";
    let long = sentence.repeat(60);
    let cleaned = clean_answer(&long).unwrap();
    assert!(cleaned.chars().count() <= MAX_TEXT_CHARS);
    assert!(cleaned.ends_with('.'));
}
