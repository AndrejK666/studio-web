//! Pure-domain tests: the rules that justified making this a gear.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::*;

fn stages(keys: &[&str]) -> Vec<String> {
    keys.iter().map(|s| (*s).to_owned()).collect()
}

/* ── modes are two shapes, not a flag ── */

#[test]
fn a_source_determines_the_mode() {
    assert_eq!(ProjectSource::Idea { brief: None }.mode(), Mode::Greenfield);
    assert_eq!(ProjectSource::Git { url: "u".into() }.mode(), Mode::Modernize);
    assert_eq!(
        ProjectSource::Upload { file_id: Uuid::from_u128(1) }.mode(),
        Mode::Modernize
    );
}

#[test]
fn mode_parses_what_the_creation_screen_displays() {
    for s in ["greenfield", "new", "Build Something New", "BUILD-SOMETHING-NEW"] {
        assert_eq!(Mode::parse(s), Some(Mode::Greenfield), "{s}");
    }
    for s in ["modernize", "legacy", "Modernize Legacy Code"] {
        assert_eq!(Mode::parse(s), Some(Mode::Modernize), "{s}");
    }
    assert_eq!(Mode::parse("something else"), None);
}

#[test]
fn mode_and_status_round_trip_through_storage() {
    for m in [Mode::Greenfield, Mode::Modernize] {
        assert_eq!(Mode::from_smallint(m.as_smallint()), Some(m));
        assert_eq!(Mode::parse(m.as_str()), Some(m));
    }
    for s in [Status::Draft, Status::Active, Status::Archived] {
        assert_eq!(Status::from_smallint(s.as_smallint()), Some(s));
        assert_eq!(Status::parse(s.as_str()), Some(s));
    }
    assert_eq!(Mode::from_smallint(99), None);
    assert_eq!(Status::from_smallint(0), None);
}

/* ── the status ladder only goes up ── */

#[test]
fn status_goes_forward_only() {
    assert!(Status::Draft.can_transition_to(Status::Active));
    assert!(Status::Draft.can_transition_to(Status::Archived));
    assert!(Status::Active.can_transition_to(Status::Archived));

    assert!(!Status::Active.can_transition_to(Status::Draft));
    assert!(!Status::Archived.can_transition_to(Status::Active));
    assert!(
        !Status::Archived.can_transition_to(Status::Draft),
        "archived is terminal: reopening must create a new project, not resurrect \
         one whose agents already ran"
    );
}

#[test]
fn a_repeated_transition_is_a_no_op_not_a_conflict() {
    // A client retrying a PATCH it already applied must not get a 409.
    for s in [Status::Draft, Status::Active, Status::Archived] {
        assert!(s.can_transition_to(s), "{}", s.as_str());
    }
}

/* ── stages ── */

#[test]
fn intent_is_added_even_when_the_caller_omits_it() {
    // The UI renders Intent as checked-and-disabled, so omitting it describes
    // the same intent as sending it.
    let got = normalize_stages(&stages(&["testing"])).unwrap();
    assert_eq!(got, stages(&["intent", "testing"]));
}

#[test]
fn stages_come_back_in_catalogue_order_regardless_of_input_order() {
    let a = normalize_stages(&stages(&["testing", "architecture", "intent"])).unwrap();
    let b = normalize_stages(&stages(&["intent", "architecture", "testing"])).unwrap();
    assert_eq!(a, b, "storage must not depend on the order the client sent");
    assert_eq!(a, stages(&["intent", "architecture", "testing"]));
}

#[test]
fn duplicate_stages_collapse() {
    let got = normalize_stages(&stages(&["prd", "prd", "prd"])).unwrap();
    assert_eq!(got, stages(&["intent", "prd"]));
}

#[test]
fn an_unknown_stage_is_rejected_and_the_message_lists_the_known_ones() {
    let err = normalize_stages(&stages(&["intent", "deployment"])).unwrap_err();
    assert_eq!(err, ValidationError::UnknownStage { key: "deployment".into() });
    let msg = err.to_string();
    assert!(msg.contains("deployment"), "{msg}");
    assert!(msg.contains("user_stories"), "message should list the catalogue: {msg}");
}

#[test]
fn the_empty_selection_still_yields_the_required_stage() {
    // Never NoStages in practice, because `intent` is required — but the guard
    // stays so that making every stage optional cannot silently produce an
    // empty selection.
    assert_eq!(normalize_stages(&[]).unwrap(), stages(&["intent"]));
}

#[test]
fn the_catalogue_has_exactly_one_required_stage_and_unique_keys() {
    let required: Vec<&str> = STAGES.iter().filter(|s| s.required).map(|s| s.key).collect();
    assert_eq!(required, vec!["intent"]);
    let mut keys: Vec<&str> = STAGES.iter().map(|s| s.key).collect();
    let before = keys.len();
    keys.sort_unstable();
    keys.dedup();
    assert_eq!(keys.len(), before, "stage keys must be unique");
}

/* ── names ── */

#[test]
fn names_are_trimmed_and_bounded() {
    assert_eq!(normalize_name("  Payments v2  ").unwrap(), "Payments v2");
    assert_eq!(normalize_name("   ").unwrap_err(), ValidationError::NameEmpty);
    assert_eq!(normalize_name("").unwrap_err(), ValidationError::NameEmpty);
    let long = "x".repeat(NAME_MAX + 1);
    assert_eq!(
        normalize_name(&long).unwrap_err(),
        ValidationError::NameTooLong { max: NAME_MAX }
    );
    // The bound counts characters, not bytes: a name of multi-byte characters
    // that fits must not be rejected.
    assert!(normalize_name(&"ф".repeat(NAME_MAX)).is_ok());
}

/* ── sources ── */

#[test]
fn a_git_source_needs_a_url() {
    assert_eq!(
        normalize_source(ProjectSource::Git { url: "   ".into() }).unwrap_err(),
        ValidationError::GitUrlEmpty
    );
    assert_eq!(
        normalize_source(ProjectSource::Git { url: "  https://x/y.git ".into() }).unwrap(),
        ProjectSource::Git { url: "https://x/y.git".into() }
    );
}

#[test]
fn a_blank_brief_normalises_to_absent() {
    assert_eq!(
        normalize_source(ProjectSource::Idea { brief: Some("   ".into()) }).unwrap(),
        ProjectSource::Idea { brief: None }
    );
    assert_eq!(
        normalize_source(ProjectSource::Idea { brief: Some(" an idea ".into()) }).unwrap(),
        ProjectSource::Idea { brief: Some("an idea".into()) }
    );
}

#[test]
fn an_oversized_brief_is_rejected() {
    let brief = "x".repeat(BRIEF_MAX + 1);
    assert_eq!(
        normalize_source(ProjectSource::Idea { brief: Some(brief) }).unwrap_err(),
        ValidationError::BriefTooLong { max: BRIEF_MAX }
    );
}

#[test]
fn source_kind_is_absent_exactly_for_greenfield() {
    assert_eq!(ProjectSource::Idea { brief: None }.kind_smallint(), None);
    assert!(ProjectSource::Git { url: "u".into() }.kind_smallint().is_some());
    assert!(ProjectSource::Upload { file_id: Uuid::nil() }.kind_smallint().is_some());
}

/* ── the assembled request ── */

#[test]
fn build_validates_every_field_and_derives_the_mode() {
    let p = NewProject::build(
        Uuid::from_u128(1),
        Uuid::from_u128(2),
        "  Payments v2  ",
        ProjectSource::Git { url: " https://git/x ".into() },
        &stages(&["architecture"]),
    )
    .unwrap();

    assert_eq!(p.name, "Payments v2");
    assert_eq!(p.mode(), Mode::Modernize);
    assert_eq!(p.stages, stages(&["intent", "architecture"]));
    assert_eq!(p.source, ProjectSource::Git { url: "https://git/x".into() });
    assert!(!p.id.is_nil());
}

#[test]
fn build_reports_the_name_problem_before_touching_anything_else() {
    let err = NewProject::build(
        Uuid::from_u128(1),
        Uuid::from_u128(2),
        "",
        ProjectSource::Git { url: String::new() },
        &stages(&["nonsense"]),
    )
    .unwrap_err();
    assert_eq!(err, ValidationError::NameEmpty);
}

#[test]
fn two_builds_get_distinct_ids() {
    let mk = || {
        NewProject::build(
            Uuid::from_u128(1),
            Uuid::from_u128(2),
            "same name",
            ProjectSource::Idea { brief: None },
            &[],
        )
        .unwrap()
    };
    assert_ne!(mk().id, mk().id);
}
