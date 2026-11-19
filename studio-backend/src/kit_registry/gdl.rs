//! A kit's manifest as `kit.gdl`, in the GDL 1.7 shape of ADR-0068 §3 (with
//! ADR-0071 §2's `gears`), rendered from what Studio read of the kit.
//!
//! No kit is authored in that shape yet: a built-in kit is described by its
//! compiled-in `kit.json`, an official kit by its `.cf-studio-kit.toml`, an
//! organization's kit by the `kit.json` or `.cf-studio-kit.toml` its shelf
//! keeps. So the server writes the `kit.gdl` each would have, from the same
//! [`KitDetail`] the kit's page shows, and says in its first line that it is
//! rendered and from what. A kit whose directory holds an authored `kit.gdl`
//! (a bundle kit, `STUDIO_KIT_BUNDLES_DIR`) is served as written instead.
//!
//! The output is deterministic: sections in the ADR's order, lists in the
//! manifest's order, strings escaped as GDL (Starlark) writes them. A list
//! the ADR's example names (`types`, `tabs`, `mcp_tools`, `permissions`,
//! `material`) is always written, `[]` when the kit has none; the others only
//! when they hold something.

use super::contents::{KitContents, KitDetail, KitField};
use super::kind::KitKind;

/// The GDL version the rendered file states (ADR-0068 §3).
pub const GDL_VERSION: &str = "1.7";
/// The file name.
pub const KIT_GDL: &str = "kit.gdl";
/// Where the archive keeps the model overlay; the rendered `model = path(...)`
/// names it.
pub const OVERLAY_PATH: &str = "model/overlay.json";

/// What to render.
pub struct GdlInput<'a> {
    pub detail: &'a KitDetail,
    /// The manifest it is rendered from, for the first line (`kit.json`,
    /// `.cf-studio-kit.toml`, `built-in kit.json`).
    pub rendered_from: &'a str,
    /// The kit's model overlay is in the archive at [`OVERLAY_PATH`].
    pub overlay: bool,
    pub kind: &'a KitKind,
}

/// `s` as a GDL string literal.
pub fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => out.push_str(&format!("\\x{:02x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// `["a", "b"]`.
fn strings<S: AsRef<str>>(items: &[S]) -> String {
    let inner: Vec<String> = items.iter().map(|s| quote(s.as_ref())).collect();
    format!("[{}]", inner.join(", "))
}

/// One call, `name(k = v, ...)`, from its arguments in order; `None` values
/// are left out.
fn call(name: &str, args: &[(&str, Option<String>)]) -> String {
    let inner: Vec<String> = args
        .iter()
        .filter_map(|(k, v)| v.as_ref().map(|v| format!("{k} = {v}")))
        .collect();
    format!("{name}({})", inner.join(", "))
}

fn some_str(s: &str) -> Option<String> {
    Some(quote(s))
}

fn opt_str(s: Option<&str>) -> Option<String> {
    s.filter(|s| !s.is_empty()).map(quote)
}

fn non_empty(items: &[String]) -> Option<String> {
    (!items.is_empty()).then(|| strings(items))
}

/// The arguments of `kit(...)`, written one per line.
struct Args {
    out: String,
}

impl Args {
    const INDENT: &'static str = "    ";

    fn scalar(&mut self, key: &str, value: String) {
        self.out
            .push_str(&format!("{}{key} = {value},\n", Self::INDENT));
    }

    /// A list of calls or strings, one per line; `[]` when empty.
    fn list(&mut self, key: &str, items: &[String]) {
        if items.is_empty() {
            self.scalar(key, "[]".to_owned());
            return;
        }
        self.out.push_str(&format!("{}{key} = [\n", Self::INDENT));
        for item in items {
            self.out
                .push_str(&format!("{}{}{item},\n", Self::INDENT, Self::INDENT));
        }
        self.out.push_str(&format!("{}],\n", Self::INDENT));
    }

    /// Only when it holds something.
    fn list_if_any(&mut self, key: &str, items: &[String]) {
        if !items.is_empty() {
            self.list(key, items);
        }
    }

    fn comment(&mut self, text: &str) {
        self.out.push_str(&format!("{}# {text}\n", Self::INDENT));
    }
}

fn field(f: &KitField) -> String {
    call(
        "kit_field",
        &[
            ("on", opt_str(f.on.as_deref())),
            ("name", some_str(&f.name)),
            ("type", opt_str(Some(f.type_name.as_str()))),
            ("required", f.required.then(|| "True".to_owned())),
            ("origin", (f.origin != "kit").then(|| quote(f.origin))),
            ("description", opt_str(f.description.as_deref())),
        ],
    )
}

fn types(c: &KitContents) -> Vec<String> {
    c.types
        .iter()
        .map(|t| {
            let fields: Vec<String> = t.fields.iter().map(field).collect();
            call(
                "kit_type",
                &[
                    ("gts", some_str(&t.gts)),
                    ("id", some_str(&t.id)),
                    ("name", some_str(&t.name)),
                    ("adopts", t.adopts.then(|| "True".to_owned())),
                    ("description", opt_str(t.description.as_deref())),
                    (
                        "fields",
                        (!fields.is_empty()).then(|| format!("[{}]", fields.join(", "))),
                    ),
                ],
            )
        })
        .collect()
}

fn tabs(c: &KitContents) -> Vec<String> {
    let screens = c.screens.iter().filter(|s| s.kind == "tab").map(|s| {
        call(
            "kit_tab",
            &[
                ("level", some_str(&s.level)),
                ("label", some_str(&s.label)),
                ("route", opt_str(s.route.as_deref())),
                ("needs", non_empty(&s.needs)),
            ],
        )
    });
    let model = c.model.tabs.iter().map(|t| {
        call(
            "kit_tab",
            &[
                ("level", some_str(&t.level)),
                ("name", some_str(&t.name)),
                ("label", some_str(&t.label)),
                ("shows", some_str(&t.target)),
            ],
        )
    });
    screens.chain(model).collect()
}

fn sections(c: &KitContents) -> Vec<String> {
    c.screens
        .iter()
        .filter(|s| s.kind == "section")
        .map(|s| {
            call(
                "kit_section",
                &[
                    ("level", some_str(&s.level)),
                    ("slot", opt_str(s.slot.as_deref())),
                    ("label", some_str(&s.label)),
                    ("route", opt_str(s.route.as_deref())),
                    ("needs", non_empty(&s.needs)),
                ],
            )
        })
        .collect()
}

/// The kit's manifest as `kit.gdl` (ADR-0068 §3), rendered.
pub fn render(input: &GdlInput<'_>) -> String {
    let d = input.detail;
    let k = &d.kit;
    let c = &d.contents;
    let mut head = String::new();
    head.push_str(&format!(
        "# {KIT_GDL} rendered by Studio from {}: not an authored {KIT_GDL}.\n",
        input.rendered_from
    ));
    head.push_str(&format!(
        "# {} at {}, on the {} shelf. The shape is ADR-0068 §3 (GDL {GDL_VERSION}).\n",
        k.slug, k.default_version, k.shelf
    ));
    head.push_str(&format!(
        "# Kit type: {} (brings {}).\n",
        input.kind.kind,
        input.kind.brings.join(", ")
    ));
    head.push_str(&format!("gdl_version = {}\n\n", quote(GDL_VERSION)));

    let mut a = Args { out: String::new() };
    a.scalar("slug", quote(&k.slug));
    a.scalar("name", quote(&k.name));
    a.scalar("version", quote(&k.default_version));
    if !k.description.trim().is_empty() {
        a.scalar("description", quote(k.description.trim()));
    }
    if !k.publisher.trim().is_empty() {
        a.scalar("publisher", quote(k.publisher.trim()));
    }
    if let Some(icon) = k.icon.as_deref() {
        a.scalar("icon", quote(icon));
    }
    a.scalar("levels", strings(&k.levels));

    a.list("types", &types(c));
    if input.overlay {
        a.scalar("model", format!("path({})", quote(OVERLAY_PATH)));
    }
    let extra: Vec<String> = c
        .model
        .fields
        .iter()
        .map(field)
        .chain(c.model.relations.iter().map(|r| {
            call(
                "kit_relation",
                &[
                    ("on", some_str(&r.on)),
                    ("name", some_str(&r.name)),
                    ("target", some_str(&r.target)),
                    ("verb", opt_str(r.verb.as_deref())),
                    ("label", opt_str(r.label.as_deref())),
                    ("origin", (r.origin != "kit").then(|| quote(r.origin))),
                ],
            )
        }))
        .collect();
    if !extra.is_empty() {
        a.comment("Fields and relations its model adds on types it does not bring.");
        a.list("extends", &extra);
    }

    a.list("tabs", &tabs(c));
    a.list_if_any("sections", &sections(c));
    a.list_if_any(
        "mfe",
        &c.mfe
            .iter()
            .map(|p| format!("path({})", quote(p)))
            .collect::<Vec<_>>(),
    );

    a.list_if_any(
        "rules",
        &c.rules
            .iter()
            .map(|r| {
                call(
                    "kit_rule",
                    &[
                        ("name", some_str(&r.name)),
                        ("description", opt_str(r.description.as_deref())),
                    ],
                )
            })
            .collect::<Vec<_>>(),
    );
    a.list_if_any(
        "functions",
        &c.functions
            .iter()
            .map(|f| {
                call(
                    "kit_function",
                    &[
                        ("name", some_str(&f.name)),
                        ("runtime", some_str(f.runtime)),
                        ("description", opt_str(f.description.as_deref())),
                    ],
                )
            })
            .collect::<Vec<_>>(),
    );
    a.list_if_any(
        "services",
        &c.services
            .iter()
            .map(|s| {
                call(
                    "use_service",
                    &[
                        ("name", some_str(&s.name)),
                        ("description", opt_str(s.description.as_deref())),
                    ],
                )
            })
            .collect::<Vec<_>>(),
    );
    a.list_if_any(
        "inbox",
        &c.inbox
            .iter()
            .map(|i| {
                let dest = i.destination.as_ref();
                call(
                    "kit_inbox_source",
                    &[
                        ("id", some_str(&i.id)),
                        ("label", some_str(&i.label)),
                        ("route", opt_str(dest.and_then(|d| d.route.as_deref()))),
                        (
                            "mcp_tool",
                            opt_str(dest.and_then(|d| d.mcp_tool.as_deref())),
                        ),
                    ],
                )
            })
            .collect::<Vec<_>>(),
    );
    a.list(
        "mcp_tools",
        &c.mcp_tools
            .iter()
            .map(|t| quote(&t.name))
            .collect::<Vec<_>>(),
    );
    a.list_if_any(
        "requires",
        &c.requires.iter().map(|r| quote(r)).collect::<Vec<_>>(),
    );
    a.list_if_any(
        "gears",
        &c.gears
            .iter()
            .map(|g| {
                call(
                    "kit_gear_claim",
                    &[
                        ("gear", some_str(&g.gear)),
                        ("types", non_empty(&g.types)),
                        ("mcp_tools", non_empty(&g.mcp_tools)),
                        ("routes", non_empty(&g.routes)),
                        (
                            "sync_only_with_kit",
                            g.sync_only_with_kit.then(|| "True".to_owned()),
                        ),
                    ],
                )
            })
            .collect::<Vec<_>>(),
    );

    // permissions(...), one list per line.
    let p = &c.permissions;
    let mut perms = String::from("permissions(\n");
    for (key, list) in [
        ("reads", &p.reads),
        ("writes", &p.writes),
        ("listens", &p.listens),
    ] {
        if list.is_empty() {
            perms.push_str(&format!("        {key} = [],\n"));
        } else {
            perms.push_str(&format!("        {key} = [\n"));
            for item in list {
                perms.push_str(&format!("            {},\n", quote(item)));
            }
            perms.push_str("        ],\n");
        }
    }
    perms.push_str("    )");
    a.scalar("permissions", perms);

    a.list(
        "material",
        &c.material
            .iter()
            .map(|m| format!("path({})", quote(&m.path)))
            .collect::<Vec<_>>(),
    );
    a.list_if_any(
        "kinds",
        &c.kinds.iter().map(|s| quote(s)).collect::<Vec<_>>(),
    );
    a.list_if_any(
        "docs",
        &c.docs
            .iter()
            .map(|s| format!("path({})", quote(s)))
            .collect::<Vec<_>>(),
    );

    format!("{head}kit(\n{})\n", a.out)
}

#[cfg(test)]
#[path = "gdl_tests.rs"]
mod tests;
