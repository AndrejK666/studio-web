//! The types gears declare at run time (`TypeNeed`, through
//! `DomainObjects::ensure_type`), written down where the portal's type
//! generator can read them: `gear-declared-types.json`.
//!
//! An organization's model is the seed, the base kits' types and what its
//! gears declare as they start. `scripts/gen-domain-client.mjs` reads the
//! first two from their files; the third exists only in the gears' code, so
//! this test renders it, and fails when the file no longer says what the
//! gears declare. `UPDATE_GOLDEN=1` writes it instead; then run the
//! generator.
//!
//! The list of gears is the kits' claims test's (`kit_registry`): a gear that
//! starts declaring types belongs in both.

#![allow(clippy::expect_used, clippy::unwrap_used)]

use super::port::TypeNeed;

/// Every gear's declarations, in a stable order: by gear, then type, each
/// gear's repeated declarations of one type kept in the order it makes them
/// (the model merges them in that order).
fn declared() -> Vec<TypeNeed> {
    let mut needs: Vec<TypeNeed> = Vec::new();
    needs.extend(crate::artifact_ingest::declared_types());
    needs.extend(crate::documents::declared_types());
    needs.extend(crate::components_catalog::declared_types());
    needs.extend(crate::organizations::declared_view_types());
    needs.extend(crate::product::declared_types());
    needs.extend(crate::reports::declared_types());
    for kinds in [
        crate::connectors::gts::MODEL_KINDS,
        crate::environments::MODEL_KINDS,
        crate::kit_registry::service::MODEL_KINDS,
        crate::organizations::project_types::MODEL_KINDS,
        crate::usage::MODEL_KINDS,
    ] {
        needs.extend(crate::model_metadata::declared_types(kinds));
    }
    needs.sort_by(|a, b| (&a.declared_by, &a.id).cmp(&(&b.declared_by, &b.id)));
    needs
}

#[test]
fn the_generator_reads_what_the_gears_declare() {
    let mut actual = serde_json::to_string_pretty(&declared()).unwrap();
    actual.push('\n');
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/domain_model/gear-declared-types.json");
    if std::env::var("UPDATE_GOLDEN").is_ok_and(|v| v == "1") {
        std::fs::write(&path, &actual).expect("write gear-declared-types.json");
        return;
    }
    let expected = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{}: {e}; run with UPDATE_GOLDEN=1", path.display()))
        .replace("\r\n", "\n");
    assert!(
        actual == expected,
        "gear-declared-types.json is not what the gears declare; run this test with \
         UPDATE_GOLDEN=1, then `node scripts/gen-domain-client.mjs`"
    );
}
