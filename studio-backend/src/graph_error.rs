//! A refusal from a gear, said in full.
//!
//! `CanonicalError`'s `Display` is its category and detail --
//! `invalid_argument: Request validation failed` -- and drops the field
//! violations that say *what* was invalid. graph-storage puts the real reason
//! there (which type, which trait, which path), so a log line built from
//! `{e}` alone sends whoever reads it to replay the request by hand to find
//! out (#512, S-15). This keeps the violations.

use toolkit_canonical_errors::{CanonicalError, Problem};

/// The error as `Display` says it, followed by each field violation:
/// `invalid_argument: Request validation failed [schema.x-gts-traits:
/// not declared by the base (TRAIT_NOT_ALLOWED)]`.
pub fn explain(e: &CanonicalError) -> String {
    let mut out = e.to_string();
    let violations: Vec<String> = Problem::from_error(e)
        .ok()
        .and_then(|p| p.context.get("field_violations").cloned())
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .map(|v| {
            let s = |k: &str| {
                v.get(k)
                    .and_then(|x| x.as_str())
                    .unwrap_or_default()
                    .to_string()
            };
            let reason = s("reason");
            if reason.is_empty() {
                format!("{}: {}", s("field"), s("description"))
            } else {
                format!("{}: {} ({reason})", s("field"), s("description"))
            }
        })
        .collect();
    if !violations.is_empty() {
        out.push_str(&format!(" [{}]", violations.join("; ")));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use toolkit_canonical_errors::resource_error;

    #[resource_error(gts_id!("cf.studio._.graph_error_test.v1~"))]
    struct TestError;

    #[test]
    fn the_violations_are_kept() {
        let e = TestError::invalid_argument()
            .with_field_violation(
                "schema.x-gts-traits",
                "not declared by the base",
                "TRAIT_NOT_ALLOWED",
            )
            .create();
        let text = explain(&e);
        assert!(text.starts_with(&e.to_string()), "{text}");
        assert!(
            text.contains("schema.x-gts-traits: not declared by the base (TRAIT_NOT_ALLOWED)"),
            "{text}"
        );
    }

    #[test]
    fn an_error_without_violations_reads_as_before() {
        let e = CanonicalError::internal("boom").create();
        assert_eq!(explain(&e), e.to_string());
    }
}
