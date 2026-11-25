//! Text PostgreSQL can store: what every gear writing a graph or a model row
//! from foreign content needs, so it is the core's (ADR-0079), not a kit's.

use serde_json::Value;

/// `value` with every U+0000 removed from its strings and object keys.
///
/// graph-storage keeps the payload in a `jsonb` column and the name and search
/// text in `text` columns, and PostgreSQL can hold a NUL in neither: the
/// insert fails with `unsupported Unicode escape sequence`, which the gear
/// reports as `unknown`, and the whole batch is lost. A NUL is valid UTF-8, so
/// a source file can carry one — `scripts/check-api-usage.mjs` in this very
/// repository does — and one such file dead-lettered every repository sync.
/// Dropping the character changes nothing a reader can see; refusing the file
/// would lose the rest of it.
pub(crate) fn without_nul(value: Value) -> Value {
    match value {
        Value::String(s) => Value::String(str_without_nul(s)),
        Value::Array(items) => Value::Array(items.into_iter().map(without_nul).collect()),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(k, v)| (str_without_nul(k), without_nul(v)))
                .collect(),
        ),
        other => other,
    }
}

/// `s` without U+0000 — see [`without_nul`]. Allocates only when there is one.
pub(crate) fn str_without_nul(s: String) -> String {
    if s.contains('\0') {
        s.replace('\0', "")
    } else {
        s
    }
}
