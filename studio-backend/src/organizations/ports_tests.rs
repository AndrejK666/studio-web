//! The core knows no kit (ADR-0079): studio-organizations reaches the kits
//! only through the ports it declares (Overview blocks, project status,
//! project creation, rollup counts, cost metering, repository metrics), so
//! no file of it names a kit's gear outside its tests.

/// The kit gears whose parts organizations now takes through its ports.
const PORTED: &[&str] = &[
    "artifact_ingest",
    "documents",
    "environments",
    "insight",
    "product",
    "usage",
];

/// Every `.rs` file of this module that is not a test file, with its code
/// before its inline `mod tests` and without comment lines: stricter than
/// `build.rs`'s ratchet, which stops at the first `#[cfg(test)]`.
fn module_code() -> Vec<(String, String)> {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/organizations");
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).expect("src/organizations is readable") {
        let path = entry.expect("a directory entry").path();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_owned();
        if !name.ends_with(".rs") || name.ends_with("tests.rs") || name.ends_with("_test.rs") {
            continue;
        }
        let text = std::fs::read_to_string(&path).expect("a source file is readable");
        let code = text
            .lines()
            .take_while(|l| l.trim() != "mod tests {")
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        out.push((name, code));
    }
    out
}

#[test]
fn organizations_names_no_kit_it_reaches_through_a_port() {
    let mut named = Vec::new();
    for (file, code) in module_code() {
        for kit in PORTED {
            if code.contains(&format!("crate::{kit}::")) {
                named.push(format!("{file} -> {kit}"));
            }
        }
    }
    assert!(
        named.is_empty(),
        "studio-organizations names a kit's gear it reaches through a core port: {named:?}"
    );
}
