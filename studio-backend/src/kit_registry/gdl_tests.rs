use super::{GdlInput, quote, render};
use crate::kit_registry::archive::{overlay_of, rendered_from};
use crate::kit_registry::contents::describe;
use crate::kit_registry::kind::kind_of;
use crate::kit_registry::service::{SHELF_BUILTIN, builtin_catalogue, official_catalogue};

/// `slug`'s rendered kit.gdl; a built-in kit at a fixed version, so the
/// golden file does not move with every Studio release.
fn rendered(slug: &str) -> String {
    let mut kit = builtin_catalogue()
        .into_iter()
        .chain(official_catalogue())
        .find(|k| k.slug == slug)
        .expect("a kit of the library");
    if kit.shelf == SHELF_BUILTIN {
        kit.default_version = "0.0.0-golden".to_owned();
    }
    let detail = describe(kit);
    let kind = kind_of(&detail);
    render(&GdlInput {
        detail: &detail,
        rendered_from: rendered_from(&detail).expect("not authored"),
        overlay: overlay_of(&detail, None).is_some(),
        kind: &kind,
    })
}

/// Compare with `golden/<file>`; `UPDATE_GOLDEN=1` writes it instead.
fn golden(file: &str, actual: &str) {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/kit_registry/golden")
        .join(file);
    if std::env::var("UPDATE_GOLDEN").is_ok_and(|v| v == "1") {
        std::fs::write(&path, actual).expect("write the golden file");
        return;
    }
    let expected = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{}: {e}; run with UPDATE_GOLDEN=1", path.display()))
        .replace("\r\n", "\n");
    assert_eq!(
        actual, expected,
        "the rendered kit.gdl differs from {file}; if the change is meant, run the test with \
         UPDATE_GOLDEN=1 and review the diff"
    );
}

#[test]
fn a_built_in_kit_renders_as_its_golden_file() {
    golden(
        "constructor-research.kit.gdl",
        &rendered("constructor-research"),
    );
}

#[test]
fn a_built_in_kit_with_a_model_renders_as_its_golden_file() {
    golden("project-lifecycle.kit.gdl", &rendered("project-lifecycle"));
}

#[test]
fn an_official_kit_renders_from_its_cf_studio_kit_toml() {
    golden("sdlc.kit.gdl", &rendered("sdlc"));
}

#[test]
fn every_kit_of_the_library_renders_and_says_from_what() {
    for kit in builtin_catalogue().into_iter().chain(official_catalogue()) {
        let text = rendered(&kit.slug);
        assert!(
            text.starts_with("# kit.gdl rendered by Studio from "),
            "{}",
            kit.slug
        );
        assert!(
            text.contains("gdl_version = \"1.7\"\n\nkit(\n"),
            "{}",
            kit.slug
        );
        assert!(
            text.contains(&format!("    slug = {},\n", quote(&kit.slug))),
            "{}",
            kit.slug
        );
        // The sections ADR-0068 §3's example names are always written.
        for key in ["types", "tabs", "mcp_tools", "permissions", "material"] {
            assert!(
                text.contains(&format!("\n    {key} = ")),
                "{}: {key}",
                kit.slug
            );
        }
        assert!(text.ends_with(")\n"), "{}", kit.slug);
        // Brackets and parentheses balance: the call is one expression.
        let mut depth = 0i32;
        let (mut in_string, mut escaped) = (false, false);
        for line in text.lines().filter(|l| !l.trim_start().starts_with('#')) {
            for ch in line.chars() {
                if in_string {
                    match (escaped, ch) {
                        (true, _) => escaped = false,
                        (false, '\\') => escaped = true,
                        (false, '"') => in_string = false,
                        _ => {}
                    }
                    continue;
                }
                match ch {
                    '"' => in_string = true,
                    '(' | '[' => depth += 1,
                    ')' | ']' => depth -= 1,
                    _ => {}
                }
                assert!(depth >= 0, "{}", kit.slug);
            }
            assert!(!in_string, "{}: a string spans lines", kit.slug);
        }
        assert_eq!(depth, 0, "{}", kit.slug);
    }
}

#[test]
fn strings_are_escaped_as_gdl_writes_them() {
    assert_eq!(quote("plain"), "\"plain\"");
    assert_eq!(quote("a \"b\" \\ c"), "\"a \\\"b\\\" \\\\ c\"");
    assert_eq!(quote("two\nlines"), "\"two\\nlines\"");
}
