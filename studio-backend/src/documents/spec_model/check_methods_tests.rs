use super::*;

const ONE: &str = r#"[{
  "id": "usability-test",
  "label": "Usability test",
  "uncertainty": "Can people do the task with it?",
  "inputs": "A clickable prototype.",
  "action": "Watch five people try the task.",
  "limits": "Five people are not a population.",
  "applies_to": ["request", "form"]
}]"#;

#[test]
fn a_kit_file_gives_its_methods() {
    let methods = parse(ONE).expect("a valid file");
    assert_eq!(methods.len(), 1);
    assert_eq!(methods[0].id, "usability-test");
    assert_eq!(methods[0].applies_to, vec!["request", "form"]);
}

#[test]
fn a_file_out_of_shape_is_refused_whole_with_the_reason() {
    assert!(parse("{}").unwrap_err().starts_with("not a list of methods"));
    let no_limits = ONE.replace(r#""limits": "Five people are not a population.","#, "");
    assert!(parse(&no_limits).is_err());
    let bad_id = ONE.replace("usability-test", "Usability Test");
    assert!(parse(&bad_id).unwrap_err().contains("lowercase"));
    let twice = format!("[{0},{0}]", &ONE[1..ONE.len() - 1]);
    assert!(parse(&twice).unwrap_err().contains("used twice"));
    let extra = ONE.replace(r#""label""#, r#""colour": "red", "label""#);
    assert!(parse(&extra).is_err());
}

#[test]
fn a_kit_slug_is_safe_in_a_path() {
    assert!(is_kit_slug("sdlc"));
    assert!(is_kit_slug("ux-research-2"));
    assert!(!is_kit_slug("../etc"));
    assert!(!is_kit_slug("a/b"));
    assert!(!is_kit_slug(""));
    assert!(!is_kit_slug("-x"));
    assert_eq!(
        path_of("sdlc"),
        ".cf-studio/config/kits/sdlc/check-methods.json"
    );
}
