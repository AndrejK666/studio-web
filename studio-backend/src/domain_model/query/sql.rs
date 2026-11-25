//! A query's `where`, `order_by` and aggregate keys as SQL over
//! `studio_domain_objects` (ADR-0066 §3).
//!
//! The SQL has to answer what the in-memory executor answers, because a
//! tenant moves from one to the other when its read model fills, and
//! `mirror_tests.rs` asks both the same questions. So it spells out the same
//! reading of the payload:
//!
//! * a field is absent when the path is missing or holds JSON `null`, and an
//!   absent field matches no comparison (`_is_null` is how to ask for it);
//! * numbers compare by value, strings by code point (`COLLATE "C"`),
//!   booleans false-first, and two different kinds never compare;
//! * `_contains` is a case-insensitive substring on text and membership on a
//!   list. Case folding is Postgres's `lower`, which follows the database's
//!   ctype: the same as Rust's for ASCII, and for other letters only under a
//!   UTF-8 ctype.
//!
//! Every comparison is wrapped so it is `TRUE` or `FALSE`, never `NULL`, so
//! `_not` turns a non-match into a match the way it does in memory. A cast
//! sits inside a `CASE` on the value's kind, which Postgres evaluates in
//! order, so a string is never cast to a number.
//!
//! Field names travel as bound parameters (`payload -> $1 -> $2`), never as
//! SQL text.
//!
//! Equality with a string or a boolean is asked as containment instead,
//! `payload @> '{"field": "value"}'`: the same answer (containment of a
//! scalar under a key is equality of kind and value, and a list holding the
//! value does not contain it), read from the payload once rather than four
//! times through `jsonb_typeof` and `#>>`, and one the GIN index on
//! `payload` can answer when the value is rare. Numbers keep the cast, which
//! compares them as `f64` the way the in-memory reading does.

use sea_orm::sea_query::{Expr as SqlExpr, Value as SqlValue};
use sea_orm::{Condition, Order};
use serde_json::Value;

use super::{Direction, Expr, Op};

/// The longest `_in` list asked as one containment per value; a longer one
/// is one list test ([`Sql::contained`]).
const OR_LIST_MAX: usize = 16;

/// SQL text and the parameters its `$n` placeholders name, numbered from 1.
#[derive(Default)]
struct Sql {
    params: Vec<SqlValue>,
}

impl Sql {
    fn param(&mut self, v: SqlValue) -> String {
        self.params.push(v);
        format!("${}", self.params.len())
    }

    fn done(self, text: String) -> SqlExpr {
        SqlExpr::cust_with_values(text, self.params)
    }

    /// The JSON at `path`: the object's id for `id`, a payload path otherwise.
    fn value_at(&mut self, path: &[String]) -> String {
        if path.len() == 1 && path[0] == "id" {
            return "to_jsonb(instance_id)".to_string();
        }
        let mut s = String::from("(payload");
        for seg in path {
            let p = self.param(SqlValue::String(Some(seg.clone())));
            s.push_str(" -> ");
            s.push_str(&p);
            s.push_str("::text");
        }
        s.push(')');
        s
    }

    /// `v` equals `arg`, by the in-memory `equal`.
    fn eq(&mut self, v: &str, arg: &Value) -> String {
        match arg {
            Value::Number(n) => match n.as_f64() {
                Some(f) => {
                    let p = self.param(SqlValue::Double(Some(f)));
                    format!(
                        "CASE WHEN jsonb_typeof({v}) = 'number' THEN ({v} #>> '{{}}')::float8 = {p} ELSE FALSE END"
                    )
                }
                None => "FALSE".to_string(),
            },
            Value::String(s) => {
                let p = self.param(SqlValue::String(Some(s.clone())));
                format!(
                    "CASE WHEN jsonb_typeof({v}) = 'string' THEN ({v} #>> '{{}}') = {p} ELSE FALSE END"
                )
            }
            Value::Bool(b) => {
                let p = self.param(SqlValue::Bool(Some(*b)));
                format!(
                    "CASE WHEN jsonb_typeof({v}) = 'boolean' THEN ({v} #>> '{{}}')::boolean = {p} ELSE FALSE END"
                )
            }
            // A field is never present as `null`, so nothing equals it.
            Value::Null => "FALSE".to_string(),
            Value::Array(_) | Value::Object(_) => {
                let p = self.param(SqlValue::Json(Some(Box::new(arg.clone()))));
                format!("({v} = {p}::jsonb)")
            }
        }
    }

    /// `v` orders against `arg` as `op` asks; two kinds never compare.
    fn ordered(&mut self, v: &str, op: &str, arg: &Value) -> String {
        match arg {
            Value::Number(n) => match n.as_f64() {
                Some(f) => {
                    let p = self.param(SqlValue::Double(Some(f)));
                    format!(
                        "CASE WHEN jsonb_typeof({v}) = 'number' THEN ({v} #>> '{{}}')::float8 {op} {p} ELSE FALSE END"
                    )
                }
                None => "FALSE".to_string(),
            },
            Value::String(s) => {
                let p = self.param(SqlValue::String(Some(s.clone())));
                format!(
                    "CASE WHEN jsonb_typeof({v}) = 'string' THEN ({v} #>> '{{}}') COLLATE \"C\" {op} {p} ELSE FALSE END"
                )
            }
            Value::Bool(b) => {
                let p = self.param(SqlValue::Bool(Some(*b)));
                format!(
                    "CASE WHEN jsonb_typeof({v}) = 'boolean' THEN ({v} #>> '{{}}')::boolean {op} {p} ELSE FALSE END"
                )
            }
            _ => "FALSE".to_string(),
        }
    }

    /// `id` compared for (in)equality, on the column itself so the primary
    /// key `(tenant_id, instance_id)` answers it. `None` for the comparisons
    /// that keep the generic JSON reading (ordering, `_contains`, `_is_null`).
    ///
    /// The same answers as the JSON reading: an id is always a string and
    /// never absent, so it equals only a string, `_neq` / `_nin` are the
    /// plain negations, and an empty list matches nothing.
    fn id_cmp(&mut self, op: &Op, arg: &Value) -> Option<String> {
        let strings = |arg: &Value| -> Vec<String> {
            arg.as_array()
                .map(|l| {
                    l.iter()
                        .filter_map(|a| a.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default()
        };
        let is = match op {
            Op::Eq | Op::Neq => match arg.as_str() {
                Some(s) => {
                    let p = self.param(SqlValue::String(Some(s.to_string())));
                    format!("instance_id = {p}")
                }
                None => "FALSE".to_string(),
            },
            Op::In | Op::Nin => {
                let ids = strings(arg);
                if ids.is_empty() {
                    "FALSE".to_string()
                } else {
                    // One parameter whatever the list's length: a JSON array
                    // unpacked into `text[]`, which the index scan takes as
                    // `= ANY(...)`.
                    let list = Value::Array(ids.into_iter().map(Value::String).collect());
                    let p = self.param(SqlValue::Json(Some(Box::new(list))));
                    format!(
                        "instance_id = ANY(ARRAY(SELECT jsonb_array_elements_text({p}::jsonb)))"
                    )
                }
            }
            _ => return None,
        };
        Some(match op {
            Op::Neq | Op::Nin => format!("(NOT ({is}))"),
            _ => format!("({is})"),
        })
    }

    /// `payload @> {path: arg}` for a string or a boolean `arg`: what
    /// [`Sql::eq`] answers for those, on the payload as a whole. `None` for
    /// any other value, which keeps the typed reading.
    fn contains_at(&mut self, path: &[String], arg: &Value) -> Option<String> {
        if !matches!(arg, Value::String(_) | Value::Bool(_)) {
            return None;
        }
        let mut doc = arg.clone();
        for seg in path.iter().rev() {
            let mut m = serde_json::Map::new();
            m.insert(seg.clone(), doc);
            doc = Value::Object(m);
        }
        let p = self.param(SqlValue::Json(Some(Box::new(doc))));
        Some(format!("(payload @> {p}::jsonb)"))
    }

    /// The value at `path` (read as `v`) equals `arg`: containment where it
    /// answers, [`Sql::eq`] otherwise.
    fn eq_at(&mut self, path: &[String], v: &str, arg: &Value) -> String {
        self.contains_at(path, arg)
            .unwrap_or_else(|| self.eq(v, arg))
    }

    /// `_eq` / `_in` when every value is a string or a boolean: containment
    /// alone, never NULL and outside any `COALESCE`, so the planner sees
    /// each `@>` and can answer it from the GIN index. `None` otherwise.
    ///
    /// A list longer than [`OR_LIST_MAX`] is one test instead, the list
    /// containing the field's value (`$list @> jsonb_build_array(v)`): one
    /// parameter and one read of the payload however long it is, where a
    /// chunk lookup by thousands of owner ids would otherwise plan thousands
    /// of clauses. The same answer: a list of scalars contains `[v]` only
    /// when `v` is one of them, never when `v` is a list, an object, another
    /// kind or absent (`[null]`).
    fn contained(&mut self, path: &[String], op: &Op, arg: &Value) -> Option<String> {
        let scalar = |a: &Value| matches!(a, Value::String(_) | Value::Bool(_));
        match op {
            Op::Eq if scalar(arg) => self.contains_at(path, arg),
            Op::In => {
                let list = arg.as_array()?;
                if list.is_empty() || !list.iter().all(scalar) {
                    return None;
                }
                if list.len() > OR_LIST_MAX {
                    let v = self.value_at(path);
                    let p = self.param(SqlValue::Json(Some(Box::new(arg.clone()))));
                    return Some(format!("({p}::jsonb @> jsonb_build_array({v}))"));
                }
                let items: Vec<String> = list
                    .iter()
                    .filter_map(|a| self.contains_at(path, a))
                    .collect();
                Some(format!("({})", items.join(" OR ")))
            }
            _ => None,
        }
    }

    fn any_of(&mut self, path: &[String], v: &str, arg: &Value) -> String {
        let items: Vec<String> = arg
            .as_array()
            .map(|l| l.iter().map(|a| self.eq_at(path, v, a)).collect())
            .unwrap_or_default();
        if items.is_empty() {
            "FALSE".to_string()
        } else {
            format!("({})", items.join(" OR "))
        }
    }

    fn expr(&mut self, e: &Expr) -> String {
        match e {
            Expr::And(list) if list.is_empty() => "TRUE".to_string(),
            Expr::Or(list) if list.is_empty() => "FALSE".to_string(),
            Expr::And(list) => {
                let parts: Vec<String> = list.iter().map(|e| self.expr(e)).collect();
                format!("({})", parts.join(" AND "))
            }
            Expr::Or(list) => {
                let parts: Vec<String> = list.iter().map(|e| self.expr(e)).collect();
                format!("({})", parts.join(" OR "))
            }
            Expr::Not(e) => format!("(NOT {})", self.expr(e)),
            Expr::Cmp { path, op, arg } => {
                if is_id(path)
                    && let Some(sql) = self.id_cmp(op, arg)
                {
                    return sql;
                }
                if let Some(sql) = self.contained(path, op, arg) {
                    return sql;
                }
                let v = self.value_at(path);
                let absent = format!("(jsonb_typeof({v}) IS NULL OR jsonb_typeof({v}) = 'null')");
                let body = match op {
                    Op::IsNull => {
                        if arg.as_bool().unwrap_or(true) {
                            absent
                        } else {
                            format!("(NOT {absent})")
                        }
                    }
                    Op::Eq => self.eq_at(path, &v, arg),
                    Op::Neq => {
                        let eq = self.eq_at(path, &v, arg);
                        format!("(NOT {absent} AND NOT ({eq}))")
                    }
                    Op::Gt => self.ordered(&v, ">", arg),
                    Op::Gte => self.ordered(&v, ">=", arg),
                    Op::Lt => self.ordered(&v, "<", arg),
                    Op::Lte => self.ordered(&v, "<=", arg),
                    Op::In => self.any_of(path, &v, arg),
                    Op::Nin => {
                        let any = self.any_of(path, &v, arg);
                        format!("(NOT {absent} AND NOT ({any}))")
                    }
                    Op::Contains => {
                        let member = self.eq("e.x", arg);
                        let in_list = format!(
                            "EXISTS (SELECT 1 FROM jsonb_array_elements({v}) AS e(x) WHERE {member})"
                        );
                        match arg {
                            Value::String(s) => {
                                let p = self.param(SqlValue::String(Some(s.clone())));
                                format!(
                                    "CASE WHEN jsonb_typeof({v}) = 'string' THEN strpos(lower({v} #>> '{{}}'), lower({p})) > 0 \
                                     WHEN jsonb_typeof({v}) = 'array' THEN {in_list} ELSE FALSE END"
                                )
                            }
                            _ => format!(
                                "CASE WHEN jsonb_typeof({v}) = 'array' THEN {in_list} ELSE FALSE END"
                            ),
                        }
                    }
                };
                format!("COALESCE(({body}), FALSE)")
            }
        }
    }
}

/// The object's own id, not a payload field.
fn is_id(path: &[String]) -> bool {
    path.len() == 1 && path[0] == "id"
}

/// A `where` as one SQL condition.
pub(super) fn condition(e: &Expr) -> Condition {
    let mut sql = Sql::default();
    let text = sql.expr(e);
    Condition::all().add(sql.done(text))
}

/// Sort keys, each as the in-memory order has it: absent last whichever way
/// the key runs, then numbers, text by code point, and booleans, each by
/// value. The caller appends the id tie-break.
pub(super) fn order(keys: &[(Vec<String>, Direction)]) -> Vec<(SqlExpr, Order)> {
    let mut out = Vec::new();
    for (path, dir) in keys {
        let by = if *dir == Direction::Desc {
            Order::Desc
        } else {
            Order::Asc
        };
        let mut absent = Sql::default();
        let v = absent.value_at(path);
        out.push((
            absent.done(format!(
                "CASE WHEN jsonb_typeof({v}) IS NULL OR jsonb_typeof({v}) = 'null' THEN 1 ELSE 0 END"
            )),
            Order::Asc,
        ));
        for (kind, cast) in [
            ("number", "({v} #>> '{}')::float8"),
            ("string", "({v} #>> '{}') COLLATE \"C\""),
            ("boolean", "({v} #>> '{}')::boolean"),
        ] {
            let mut sql = Sql::default();
            let v = sql.value_at(path);
            let cast = cast.replace("{v}", &v);
            out.push((
                sql.done(format!(
                    "CASE WHEN jsonb_typeof({v}) = '{kind}' THEN {cast} END"
                )),
                by.clone(),
            ));
        }
    }
    out
}

/// The rows after a cursor, in the order [`order`] and the id tie-break give.
///
/// Each key sorts as four columns: whether it is absent (ascending), then its
/// number, text and boolean reading in the key's direction, where Postgres puts
/// a column's NULLs last ascending and first descending. A row is after the
/// cursor when, at the first column where they differ, it is on the far side:
/// the usual keyset expansion, `c1 > v1 OR (c1 = v1 AND c2 > v2) OR …`, with
/// those NULL placements spelled out because `>` on a NULL is never true.
pub(super) fn after(keys: &[(Vec<String>, Direction)], at: &[Option<Value>], id: &str) -> SqlExpr {
    let mut sql = Sql::default();
    // (column, its value at the cursor, descending)
    let mut cols: Vec<(String, Option<SqlValue>, bool)> = Vec::new();
    for ((path, dir), value) in keys.iter().zip(at) {
        let v = sql.value_at(path);
        let desc = *dir == Direction::Desc;
        cols.push((
            format!("(CASE WHEN jsonb_typeof({v}) IS NULL OR jsonb_typeof({v}) = 'null' THEN 1 ELSE 0 END)"),
            Some(SqlValue::Int(Some(i32::from(value.is_none())))),
            false,
        ));
        let (number, text, flag) = match value {
            Some(Value::Number(n)) => (n.as_f64().map(|f| SqlValue::Double(Some(f))), None, None),
            Some(Value::String(s)) => (None, Some(SqlValue::String(Some(s.clone()))), None),
            Some(Value::Bool(b)) => (None, None, Some(SqlValue::Bool(Some(*b)))),
            _ => (None, None, None),
        };
        cols.push((
            format!("(CASE WHEN jsonb_typeof({v}) = 'number' THEN ({v} #>> '{{}}')::float8 END)"),
            number,
            desc,
        ));
        cols.push((
            format!(
                "(CASE WHEN jsonb_typeof({v}) = 'string' THEN ({v} #>> '{{}}') COLLATE \"C\" END)"
            ),
            text,
            desc,
        ));
        cols.push((
            format!("(CASE WHEN jsonb_typeof({v}) = 'boolean' THEN ({v} #>> '{{}}')::boolean END)"),
            flag,
            desc,
        ));
    }
    cols.push((
        "instance_id".to_string(),
        Some(SqlValue::String(Some(id.to_string()))),
        false,
    ));

    let mut either = Vec::new();
    for (i, (col, value, desc)) in cols.iter().enumerate() {
        let beyond = match (value, desc) {
            // Ascending, NULLs come last: nothing is past a NULL.
            (None, false) => continue,
            // Descending, NULLs come first: every value is past a NULL.
            (None, true) => format!("{col} IS NOT NULL"),
            (Some(v), false) => {
                let p = sql.param(v.clone());
                format!("({col} > {p} OR {col} IS NULL)")
            }
            (Some(v), true) => {
                let p = sql.param(v.clone());
                format!("{col} < {p}")
            }
        };
        let mut all: Vec<String> = cols[..i]
            .iter()
            .map(|(c, v, _)| match v {
                Some(v) => {
                    let p = sql.param(v.clone());
                    format!("{c} = {p}")
                }
                None => format!("{c} IS NULL"),
            })
            .collect();
        all.push(beyond);
        either.push(format!("({})", all.join(" AND ")));
    }
    let text = if either.is_empty() {
        "FALSE".to_string()
    } else {
        format!("({})", either.join(" OR "))
    };
    sql.done(text)
}

/// The grouping key of an aggregate: the grouped values as one JSON array,
/// `null` where a field is absent.
pub(super) fn group_key(paths: &[Vec<String>]) -> SqlExpr {
    let mut sql = Sql::default();
    let parts: Vec<String> = paths
        .iter()
        .map(|p| {
            let v = sql.value_at(p);
            format!("CASE WHEN jsonb_typeof({v}) = 'null' THEN NULL ELSE {v} END")
        })
        .collect();
    sql.done(format!("jsonb_build_array({})", parts.join(", ")))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::{Expr, Op};
    use super::Sql;

    fn compiled(op: Op, arg: serde_json::Value) -> (String, usize) {
        let (text, params) = compiled_at(&["id"], op, arg);
        (text, params.len())
    }

    /// The text and the parameters a comparison on `path` compiles to.
    fn compiled_at(
        path: &[&str],
        op: Op,
        arg: serde_json::Value,
    ) -> (String, Vec<sea_orm::sea_query::Value>) {
        let mut sql = Sql::default();
        let text = sql.expr(&Expr::Cmp {
            path: path.iter().map(|s| (*s).to_string()).collect(),
            op,
            arg,
        });
        (text, sql.params)
    }

    fn json_param(v: &sea_orm::sea_query::Value) -> serde_json::Value {
        match v {
            sea_orm::sea_query::Value::Json(Some(j)) => (**j).clone(),
            other => panic!("not a JSON parameter: {other:?}"),
        }
    }

    /// Equality with a string or a boolean is one containment of the field's
    /// path, bare (no `COALESCE`, no cast) so the GIN index can answer it.
    #[test]
    fn a_string_or_boolean_equality_is_containment() {
        let (eq, params) = compiled_at(&["project_id"], Op::Eq, json!("p1"));
        assert_eq!(eq, "(payload @> $1::jsonb)");
        assert_eq!(params.len(), 1);
        assert_eq!(json_param(&params[0]), json!({"project_id": "p1"}));

        let (nested, params) = compiled_at(&["source", "kind"], Op::Eq, json!(true));
        assert_eq!(nested, "(payload @> $1::jsonb)");
        assert_eq!(json_param(&params[0]), json!({"source": {"kind": true}}));

        // `_in` of scalars: one containment each, joined by OR.
        let (any, params) = compiled_at(&["impact"], Op::In, json!(["high", "low"]));
        assert_eq!(any, "((payload @> $1::jsonb) OR (payload @> $2::jsonb))");
        assert_eq!(json_param(&params[1]), json!({"impact": "low"}));
        // A long list is one test of the list, one parameter for its values.
        let many: Vec<String> = (0..40).map(|i| format!("o{i}")).collect();
        let (long, params) = compiled_at(&["owner"], Op::In, json!(many));
        assert_eq!(
            long,
            "($2::jsonb @> jsonb_build_array((payload -> $1::text)))"
        );
        assert_eq!(params.len(), 2);
        assert_eq!(json_param(&params[1]), json!(many));

        for text in [&eq, &nested, &any] {
            assert!(!text.contains("jsonb_typeof"), "{text}");
            assert!(!text.contains("COALESCE"), "{text}");
        }
    }

    /// What containment cannot say keeps the typed reading: numbers (compared
    /// as `f64`), a list with a number in it, and the negations, which still
    /// ask that the field is present.
    #[test]
    fn numbers_and_negations_keep_the_typed_reading() {
        let (num, _) = compiled_at(&["score"], Op::Eq, json!(2));
        assert!(num.contains("::float8"), "{num}");
        assert!(!num.contains("@>"), "{num}");

        let (mixed, _) = compiled_at(&["score"], Op::In, json!(["unknown", 2]));
        assert!(mixed.starts_with("COALESCE("), "{mixed}");
        assert!(mixed.contains("(payload @> $"), "{mixed}");
        assert!(mixed.contains("::float8"), "{mixed}");

        let (neq, _) = compiled_at(&["status"], Op::Neq, json!("closed"));
        assert!(neq.contains("jsonb_typeof"), "{neq}");
        assert!(neq.contains("NOT ((payload @> $"), "{neq}");

        // Every `$n` the text names is a parameter it binds, and no more.
        let cases = [
            compiled_at(&["status"], Op::Neq, json!("closed")),
            compiled_at(&["score"], Op::In, json!(["unknown", 2])),
            compiled_at(&["status"], Op::Nin, json!(["a", "b"])),
        ];
        for (text, params) in cases {
            let n = params.len();
            for i in 1..=n {
                assert!(text.contains(&format!("${i}")), "${i} unused in {text}");
            }
            assert!(!text.contains(&format!("${}", n + 1)), "{text}");
        }
    }
}
