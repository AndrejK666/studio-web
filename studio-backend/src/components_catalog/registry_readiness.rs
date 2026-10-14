//! Whether a component can leave its project (ADR-0044 §1, phase 1): the
//! readiness check that comes before Extract.
//!
//! `GET /registry/{name}/readiness` reads the directory a component lives in,
//! and the rest of the crate around it, and says what would stop it building
//! as a crate of its own. Mechanical, no model; every failure names the file
//! and line that fails it. Nothing is written.
//!
//! - **The unit** is what would move: a module (`src/documents/` with its
//!   `mod.rs`, or `plugin.rs` beside a `plugin/` directory) or a crate (a
//!   directory with a `Cargo.toml`). [`locate`] finds it from the
//!   occurrence's path, which is a directory or, for a gear an attribute
//!   declares, a file.
//! - **The checks**, in [`assess`]: its size, a boundary (`port` and `sdk`),
//!   tables created by its own migrations, nothing it reaches outside itself
//!   (`crate::other`, `super::` past its top, a `path` dependency outside a
//!   crate), nothing outside reaching into its private modules, and the
//!   dependencies its new `Cargo.toml` would carry.
//! - **What is read**: every file of the unit, and the crate's other `.rs`
//!   files up to a budget. From a checkout every file is read; over the API a
//!   large crate is read in part, and the answer says so.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::registry::OccurrenceRecord;
use super::registry_publish::{self, MAX_BYTES, MAX_FILES};

/// The crate's other `.rs` files read over the API to find who reaches into
/// the unit. From a checkout there is no budget.
pub const OUTSIDE_BUDGET: usize = 150;
/// Places named per check, at most.
pub const MAX_SPOTS: usize = 20;

pub const CHECK_SIZE: &str = "size";
pub const CHECK_BOUNDARY: &str = "boundary";
pub const CHECK_PERSISTENCE: &str = "persistence";
pub const CHECK_REACHES_OUT: &str = "reaches_out";
pub const CHECK_REACHED_INTO: &str = "reached_into";
pub const CHECK_DEPENDENCIES: &str = "dependencies";
pub const CHECK_GEARS: &str = "gears";

/// The modules a gear is entered through from outside.
const PUBLIC_MODULES: [&str; 2] = ["sdk", "port"];
/// Path roots that are not dependencies.
const NOT_CRATES: [&str; 6] = ["crate", "self", "super", "std", "core", "alloc"];

/// What would move.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Unit {
    /// `module` or `crate`.
    pub kind: String,
    /// The module's directory (or its file's path without `.rs`), or the
    /// crate's directory.
    pub path: String,
    /// The `Cargo.toml` of the crate the unit is in, or is.
    pub manifest: Option<String>,
    /// For a module: its path inside its crate (`documents`,
    /// `connectors::plugin`); empty for a crate, or a module outside any
    /// crate's `src/`.
    pub module_path: Vec<String>,
    /// Every file that would move.
    pub files: Vec<String>,
}

impl Unit {
    fn is_crate(&self) -> bool {
        self.kind == "crate"
    }
}

/// One place a check fails at.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Spot {
    pub path: String,
    pub line: Option<u32>,
    /// The line, trimmed.
    pub text: Option<String>,
}

impl Spot {
    fn file(path: &str) -> Self {
        Self {
            path: path.to_owned(),
            line: None,
            text: None,
        }
    }

    fn at(path: &str, line: usize, text: &str) -> Self {
        Self {
            path: path.to_owned(),
            line: u32::try_from(line + 1).ok(),
            text: Some(text.trim().chars().take(200).collect()),
        }
    }
}

/// One check, and where it fails.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Check {
    pub key: String,
    /// It passed.
    pub ok: bool,
    /// A failure that stops Extract; a failed check that does not block is
    /// advice.
    pub blocks: bool,
    /// What it found, in words.
    pub summary: String,
    pub spots: Vec<Spot>,
    /// Places past [`MAX_SPOTS`] not listed.
    pub more: usize,
}

impl Check {
    fn pass(key: &str, summary: String) -> Self {
        Self {
            key: key.to_owned(),
            ok: true,
            blocks: false,
            summary,
            spots: Vec::new(),
            more: 0,
        }
    }

    fn fail(key: &str, blocks: bool, summary: String, mut spots: Vec<Spot>) -> Self {
        let more = spots.len().saturating_sub(MAX_SPOTS);
        spots.truncate(MAX_SPOTS);
        Self {
            key: key.to_owned(),
            ok: false,
            blocks,
            summary,
            spots,
            more,
        }
    }
}

/// A dependency the new crate's `Cargo.toml` would carry.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Dependency {
    /// As the code names it (`serde_json`), or the manifest's key.
    pub name: String,
    /// The manifest's line for it (`"1"`, `{ workspace = true }`); `None`
    /// when the crate's manifest does not list it.
    pub spec: Option<String>,
}

/// What was read.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadScope {
    /// The crate's other `.rs` files read to find who reaches into the unit.
    pub outside_read: usize,
    /// Of how many.
    pub outside_total: usize,
}

impl ReadScope {
    pub fn partial(&self) -> bool {
        self.outside_read < self.outside_total
    }
}

/// The answer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Readiness {
    /// No check blocks.
    pub ready: bool,
    pub unit: Unit,
    pub checks: Vec<Check>,
    pub dependencies: Vec<Dependency>,
    /// Other gears it uses through their `sdk` or `port`, by module path
    /// (`llm_proxy`, `connectors`).
    pub gears: Vec<String>,
    pub read: ReadScope,
}

fn parent(path: &str) -> &str {
    path.rfind('/').map_or("", |i| &path[..i])
}

fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn joined(dir: &str, rel: &str) -> String {
    if dir.is_empty() {
        rel.to_owned()
    } else {
        format!("{dir}/{rel}")
    }
}

fn under(path: &str, dir: &str) -> bool {
    dir.is_empty() || path.starts_with(&format!("{dir}/"))
}

/// The `Cargo.toml` nearest above `dir` (or in it), by the listing.
fn manifest_above(files: &BTreeSet<&str>, dir: &str) -> Option<String> {
    let mut d = dir;
    loop {
        let m = joined(d, "Cargo.toml");
        if files.contains(m.as_str()) {
            return Some(m);
        }
        if d.is_empty() {
            return None;
        }
        d = parent(d);
    }
}

/// The unit an occurrence at `occ_path` stands for, from the repository's
/// listing. `None` when nothing of it is in the listing.
pub fn locate(listing: &[String], occ_path: &str) -> Option<Unit> {
    let set: BTreeSet<&str> = listing.iter().map(String::as_str).collect();
    let p = occ_path.trim().trim_matches('/');
    let take = |dir: &str| -> Vec<String> {
        let sized: Vec<(String, Option<i64>)> = listing.iter().map(|f| (f.clone(), None)).collect();
        registry_publish::files_under(&sized, dir)
            .into_iter()
            .map(|(f, _)| f)
            .collect()
    };

    // A crate: a directory with its own manifest, or a crate's `src/`.
    let crate_dir = if set.contains(joined(p, "Cargo.toml").as_str()) && !p.ends_with(".rs") {
        Some(p.to_owned())
    } else if file_name(p) == "src" && set.contains(joined(parent(p), "Cargo.toml").as_str()) {
        Some(parent(p).to_owned())
    } else if matches!(file_name(p), "lib.rs" | "main.rs")
        && file_name(parent(p)) == "src"
        && set.contains(joined(parent(parent(p)), "Cargo.toml").as_str())
    {
        Some(parent(parent(p)).to_owned())
    } else {
        None
    };
    if let Some(dir) = crate_dir {
        let files = take(&dir);
        if files.is_empty() {
            return None;
        }
        return Some(Unit {
            kind: "crate".into(),
            manifest: Some(joined(&dir, "Cargo.toml")),
            path: dir,
            module_path: Vec::new(),
            files,
        });
    }

    // A module: a directory (with `mod.rs` or a sibling `dir.rs`), or a file
    // (`x.rs`, with `x/` beside it; `mod.rs`, for its directory).
    let (dir, top): (String, Option<String>) = if let Some(stem) = p.strip_suffix(".rs") {
        if file_name(p) == "mod.rs" {
            (parent(p).to_owned(), Some(p.to_owned()))
        } else {
            (stem.to_owned(), Some(p.to_owned()))
        }
    } else if set.contains(joined(p, "mod.rs").as_str()) {
        (p.to_owned(), Some(joined(p, "mod.rs")))
    } else {
        let sibling = format!("{p}.rs");
        let top = set.contains(sibling.as_str()).then_some(sibling);
        (p.to_owned(), top)
    };
    let mut files = take(&dir);
    if let Some(t) = &top
        && !files.contains(t)
    {
        files.insert(0, t.clone());
    }
    if files.is_empty() {
        return None;
    }
    let manifest = manifest_above(&set, &dir);
    let module_path = manifest
        .as_deref()
        .and_then(|m| {
            let src = joined(parent(m), "src");
            dir.strip_prefix(&format!("{src}/")).map(str::to_owned)
        })
        .map(|rel| rel.split('/').map(str::to_owned).collect())
        .unwrap_or_default();
    Some(Unit {
        kind: "module".into(),
        path: dir,
        manifest,
        module_path,
        files,
    })
}

/// The `.rs` files of the unit's crate that are not the unit's: where a reach
/// into it would be. Build output and vendored trees are skipped.
pub fn outside_sources(listing: &[String], unit: &Unit) -> Vec<String> {
    if unit.is_crate() {
        return Vec::new();
    }
    let Some(manifest) = unit.manifest.as_deref() else {
        return Vec::new();
    };
    let src = joined(parent(manifest), "src");
    let sized: Vec<(String, Option<i64>)> = listing.iter().map(|f| (f.clone(), None)).collect();
    registry_publish::files_under(&sized, &src)
        .into_iter()
        .map(|(f, _)| f)
        .filter(|f| f.ends_with(".rs") && !unit.files.contains(f))
        .collect()
}

/// The text with comments, string and character literals blanked, byte for
/// byte and keeping every line break, so a path named in a doc comment or a
/// test fixture's string is not read as code and line numbers still match.
fn code_only(text: &str) -> String {
    let b = text.as_bytes();
    let mut out: Vec<u8> = b.to_vec();
    let blank = |out: &mut Vec<u8>, from: usize, to: usize| {
        for byte in &mut out[from..to] {
            if *byte != b'\n' {
                *byte = b' ';
            }
        }
    };
    let ident = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        let next = b.get(i + 1).copied();
        let prev_ident = i > 0 && ident(b[i - 1]);
        // `// …`
        if c == b'/' && next == Some(b'/') {
            let end = b[i..]
                .iter()
                .position(|&x| x == b'\n')
                .map_or(b.len(), |p| i + p);
            blank(&mut out, i, end);
            i = end;
            continue;
        }
        // `/* … */`, nested.
        if c == b'/' && next == Some(b'*') {
            let mut depth = 0usize;
            let mut j = i;
            while j < b.len() {
                if b[j] == b'/' && b.get(j + 1) == Some(&b'*') {
                    depth += 1;
                    j += 2;
                } else if b[j] == b'*' && b.get(j + 1) == Some(&b'/') {
                    depth -= 1;
                    j += 2;
                    if depth == 0 {
                        break;
                    }
                } else {
                    j += 1;
                }
            }
            blank(&mut out, i, j.min(b.len()));
            i = j;
            continue;
        }
        // `r"…"`, `r#"…"#`, `br#"…"#`.
        if (c == b'r' || (c == b'b' && next == Some(b'r'))) && !prev_ident {
            let start = i;
            let mut j = i + if c == b'b' { 2 } else { 1 };
            let mut hashes = 0;
            while b.get(j) == Some(&b'#') {
                hashes += 1;
                j += 1;
            }
            if b.get(j) == Some(&b'"') {
                j += 1;
                let close: Vec<u8> = std::iter::once(b'"')
                    .chain(std::iter::repeat_n(b'#', hashes))
                    .collect();
                let end = b[j..]
                    .windows(close.len())
                    .position(|w| w == close.as_slice())
                    .map_or(b.len(), |p| j + p + close.len());
                blank(&mut out, start, end);
                i = end;
                continue;
            }
        }
        // `"…"`, with escapes.
        if c == b'"' {
            let mut j = i + 1;
            while j < b.len() && b[j] != b'"' {
                j += if b[j] == b'\\' { 2 } else { 1 };
            }
            let end = (j + 1).min(b.len());
            blank(&mut out, i, end);
            i = end;
            continue;
        }
        // `'x'`, `'\n'`, `'"'` -- not a lifetime (`'a`, which has no closing quote).
        if c == b'\'' {
            let close = if next == Some(b'\\') {
                b[i + 2..]
                    .iter()
                    .take(10)
                    .position(|&x| x == b'\'')
                    .map(|p| i + 2 + p)
            } else {
                let len = next.map_or(1, utf8_len);
                (b.get(i + 1 + len) == Some(&b'\'')).then_some(i + 1 + len)
            };
            if let Some(end) = close {
                blank(&mut out, i, end + 1);
                i = end + 1;
                continue;
            }
        }
        i += 1;
    }
    // Only ASCII bytes were replaced, each by a space, so the text is still
    // UTF-8 everywhere it was left alone.
    String::from_utf8(out).unwrap_or_default()
}

/// For each byte of `code`, how many inline `mod x { … }` blocks it is in:
/// a `super::` there climbs out of those first.
fn inline_mod_depths(code: &str) -> Vec<usize> {
    let b = code.as_bytes();
    let mut out = vec![0; b.len()];
    let mut stack: Vec<bool> = Vec::new();
    let mut inside = 0usize;
    let mut words: [&str; 2] = ["", ""];
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c.is_ascii_alphanumeric() || c == b'_' {
            let start = i;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
                out[i] = inside;
                i += 1;
            }
            words = [words[1], &code[start..i]];
            continue;
        }
        out[i] = inside;
        match c {
            b'{' => {
                let is_mod = words[0] == "mod";
                stack.push(is_mod);
                if is_mod {
                    inside += 1;
                }
                words = ["", ""];
            }
            b'}' => {
                if stack.pop() == Some(true) {
                    inside -= 1;
                }
                words = ["", ""];
            }
            b';' => words = ["", ""],
            _ => {}
        }
        i += 1;
    }
    out
}

fn utf8_len(first: u8) -> usize {
    match first {
        0x00..=0x7f => 1,
        0xc0..=0xdf => 2,
        0xe0..=0xef => 3,
        _ => 4,
    }
}

fn ident_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Every path a `use` tree or a qualified path spells after `start` (the byte
/// just past `crate::`), with braces expanded: `crate::{a::b, c}` gives
/// `[a, b]` and `[c]`. Bounded to a statement's worth of text.
fn paths_after(code: &str, start: usize) -> Vec<Vec<String>> {
    let rest: &str = &code[start..];
    let mut end = rest.find(';').unwrap_or(rest.len()).min(2000);
    while !rest.is_char_boundary(end) {
        end -= 1;
    }
    let rest = &rest[..end];
    let mut out = Vec::new();
    tree(rest, &mut 0, Vec::new(), &mut out);
    out
}

fn tree(s: &str, pos: &mut usize, prefix: Vec<String>, out: &mut Vec<Vec<String>>) {
    let bytes = s.as_bytes();
    let skip_ws = |pos: &mut usize| {
        while *pos < bytes.len() && (bytes[*pos] as char).is_whitespace() {
            *pos += 1;
        }
    };
    let mut path = prefix;
    loop {
        skip_ws(pos);
        if *pos < bytes.len() && bytes[*pos] == b'{' {
            *pos += 1;
            loop {
                tree(s, pos, path.clone(), out);
                skip_ws(pos);
                match bytes.get(*pos) {
                    Some(b',') => {
                        *pos += 1;
                        skip_ws(pos);
                        if bytes.get(*pos) == Some(&b'}') {
                            *pos += 1;
                            return;
                        }
                    }
                    Some(b'}') => {
                        *pos += 1;
                        return;
                    }
                    _ => return,
                }
            }
        }
        let from = *pos;
        while *pos < bytes.len() && ident_char(bytes[*pos] as char) {
            *pos += 1;
        }
        if *pos == from {
            if bytes.get(*pos) == Some(&b'*') {
                *pos += 1;
            }
            if !path.is_empty() {
                out.push(path);
            }
            return;
        }
        path.push(s[from..*pos].to_owned());
        if s[*pos..].starts_with("::") {
            *pos += 2;
            continue;
        }
        // `as x` and anything after the path end it.
        out.push(path);
        skip_ws(pos);
        if s[*pos..].starts_with("as ") {
            *pos += 3;
            skip_ws(pos);
            while *pos < bytes.len() && ident_char(bytes[*pos] as char) {
                *pos += 1;
            }
        }
        return;
    }
}

/// Every `crate::` path in `code`, with the line it starts on.
fn crate_paths(code: &str) -> Vec<(usize, Vec<String>)> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(at) = code[from..].find("crate::") {
        let start = from + at;
        let before = code[..start].chars().next_back();
        from = start + "crate::".len();
        if before.is_some_and(|c| ident_char(c) || c == ':') {
            continue;
        }
        let line = code[..start].matches('\n').count();
        for p in paths_after(code, from) {
            out.push((line, p));
        }
    }
    out
}

/// How deep below the unit's top a file's module sits: 0 for the top file
/// (`mod.rs`, or `x.rs` for `x/`), one more per directory, and one more for a
/// file that is not a `mod.rs`. `#[path]` files take their declarer's depth
/// plus one ([`path_depths`]).
fn depth_of(unit: &Unit, path: &str) -> usize {
    if path == format!("{}.rs", unit.path) {
        return 0;
    }
    let rel = path
        .strip_prefix(&format!("{}/", unit.path))
        .unwrap_or(path);
    let segments = rel.split('/').count();
    if file_name(rel) == "mod.rs" {
        segments - 1
    } else {
        segments
    }
}

/// Files a `#[path = "…"]` attribute brings in, with the depth of the module
/// it makes: the declaring file's depth plus one.
fn path_depths(unit: &Unit, texts: &BTreeMap<String, String>) -> BTreeMap<String, usize> {
    let mut out = BTreeMap::new();
    for file in &unit.files {
        let Some(text) = texts.get(file) else {
            continue;
        };
        let depth = depth_of(unit, file);
        for line in text.lines() {
            let l = line.trim();
            let Some(rest) = l.strip_prefix("#[path") else {
                continue;
            };
            let Some(q1) = rest.find('"') else { continue };
            let Some(q2) = rest[q1 + 1..].find('"') else {
                continue;
            };
            let target = &rest[q1 + 1..q1 + 1 + q2];
            if let Some(at) = resolve(parent(file), target) {
                out.insert(at, depth + 1);
            }
        }
    }
    out
}

/// The names of the unit's direct submodules: its files and directories one
/// level down, as modules.
fn submodules(unit: &Unit) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for f in &unit.files {
        let Some(rel) = f.strip_prefix(&format!("{}/", unit.path)) else {
            continue;
        };
        let first = rel.split('/').next().unwrap_or(rel);
        let name = first.strip_suffix(".rs").unwrap_or(first);
        if name != "mod" && !name.is_empty() {
            out.insert(name.to_owned());
        }
    }
    out
}

/// The dependencies a manifest lists, by the name code uses (`-` as `_`),
/// with the line's value.
pub fn manifest_dependencies(body: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut section = String::new();
    for raw in body.lines() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.starts_with('[') {
            section = line
                .trim_matches(|c| c == '[' || c == ']')
                .trim()
                .to_owned();
            // `[dependencies.serde]`
            for table in [
                "dependencies.",
                "dev-dependencies.",
                "build-dependencies.",
                "workspace.dependencies.",
            ] {
                if let Some(name) = section.strip_prefix(table) {
                    out.insert(name.trim().replace('-', "_"), "{ … }".to_owned());
                }
            }
            continue;
        }
        let deps = matches!(
            section.as_str(),
            "dependencies" | "dev-dependencies" | "build-dependencies" | "workspace.dependencies"
        ) || section.starts_with("target.") && section.ends_with("dependencies");
        if !deps {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            let key = key.trim().trim_matches('"');
            if !key.is_empty() && !key.contains('.') {
                out.insert(key.replace('-', "_"), value.trim().to_owned());
            } else if let Some((name, field)) = key.split_once('.') {
                // `serde.workspace = true`
                out.insert(
                    name.replace('-', "_"),
                    format!("{{ {field} = {} }}", value.trim()),
                );
            }
        }
    }
    out
}

/// `path = "../x"` dependencies of a manifest, with their lines.
fn path_dependencies(body: &str) -> Vec<(usize, String)> {
    body.lines()
        .enumerate()
        .filter_map(|(i, l)| {
            let code = l.split('#').next().unwrap_or("");
            let at = code.find("path")?;
            let rest = code[at + 4..].trim_start().strip_prefix('=')?.trim_start();
            let rest = rest.strip_prefix('"')?;
            let end = rest.find('"')?;
            Some((i, rest[..end].to_owned()))
        })
        .collect()
}

/// Resolve `rel` against `dir` (`..` allowed), or `None` past the root.
fn resolve(dir: &str, rel: &str) -> Option<String> {
    let mut parts: Vec<&str> = if dir.is_empty() {
        Vec::new()
    } else {
        dir.split('/').collect()
    };
    for seg in rel.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            s => parts.push(s),
        }
    }
    Some(parts.join("/"))
}

/// The gear a `crate::` path enters: the modules before the first `sdk` or
/// `port` (`crate::llm_proxy::port::X` is `llm_proxy`), or a top module that
/// has one, used through what its `mod.rs` exports
/// (`crate::user_profile::PersonResolver`).
fn gear_of(path: &[String], gear_modules: &BTreeSet<String>) -> Option<String> {
    if let Some(at) = path
        .iter()
        .position(|s| PUBLIC_MODULES.contains(&s.as_str()))
    {
        return (at > 0).then(|| path[..at].join("::"));
    }
    path.first().filter(|m| gear_modules.contains(*m)).cloned()
}

/// The crate's top modules that have an `sdk` or a `port`: its gears.
fn gear_modules(unit: &Unit, listing: &[(String, Option<i64>)]) -> BTreeSet<String> {
    let Some(manifest) = unit.manifest.as_deref() else {
        return BTreeSet::new();
    };
    let src = format!("{}/", joined(parent(manifest), "src"));
    listing
        .iter()
        .filter_map(|(p, _)| p.strip_prefix(&src))
        .filter_map(|rel| {
            let mut parts = rel.split('/');
            let top = parts.next()?;
            let second = parts.next()?;
            let name = second.strip_suffix(".rs").unwrap_or(second);
            PUBLIC_MODULES.contains(&name).then(|| top.to_owned())
        })
        .collect()
}

/// A test's own file: `x_tests.rs`, `tests.rs`, or anything under `tests/`.
fn test_file(path: &str) -> bool {
    let name = file_name(path);
    name == "tests.rs" || name.ends_with("_tests.rs") || path.contains("/tests/")
}

/// Every `name::` that starts a path in `code`: not preceded by an
/// identifier character or `:`, lower-case, and not one of [`NOT_CRATES`].
fn qualified_roots(code: &str) -> BTreeSet<String> {
    let b = code.as_bytes();
    let mut out = BTreeSet::new();
    let mut from = 0;
    while let Some(at) = code[from..].find("::") {
        let end = from + at;
        from = end + 2;
        let mut start = end;
        while start > 0 && (b[start - 1].is_ascii_alphanumeric() || b[start - 1] == b'_') {
            start -= 1;
        }
        if start == end || (start > 0 && b[start - 1] == b':') {
            continue;
        }
        let name = &code[start..end];
        if name.starts_with(|c: char| c.is_ascii_lowercase()) && !NOT_CRATES.contains(&name) {
            out.insert(name.to_owned());
        }
    }
    out
}

/// The first segment of every `use` path and `extern crate` in `code`.
fn used_roots(code: &str) -> BTreeMap<String, (usize, String)> {
    let mut out = BTreeMap::new();
    for (i, line) in code.lines().enumerate() {
        let l = line.trim_start();
        let l = l.strip_prefix("pub ").unwrap_or(l);
        let l = l
            .strip_prefix("pub(crate) ")
            .or_else(|| l.strip_prefix("pub(super) "))
            .unwrap_or(l);
        let rest = if let Some(r) = l.strip_prefix("use ") {
            r
        } else if let Some(r) = l.strip_prefix("extern crate ") {
            r
        } else {
            continue;
        };
        let rest = rest.trim_start().trim_start_matches("::");
        let root: String = rest.chars().take_while(|c| ident_char(*c)).collect();
        if root.is_empty() {
            continue;
        }
        out.entry(root).or_insert((i, line.to_owned()));
    }
    out
}

/// Run every check over `unit`, from the texts read: the unit's files, the
/// manifests, and as much of the rest of its crate as `scope` says.
pub fn assess(
    unit: &Unit,
    sizes: &[(String, Option<i64>)],
    texts: &BTreeMap<String, String>,
    scope: ReadScope,
) -> Readiness {
    let mut checks = Vec::new();
    let code: BTreeMap<&str, String> = texts
        .iter()
        .filter(|(p, _)| p.ends_with(".rs"))
        .map(|(p, t)| (p.as_str(), code_only(t)))
        .collect();
    let in_unit = |p: &str| unit.files.iter().any(|f| f == p);

    // Size: what one pull request can carry.
    let unit_sizes: Vec<(String, Option<i64>)> =
        sizes.iter().filter(|(p, _)| in_unit(p)).cloned().collect();
    match registry_publish::bounded(&unit_sizes) {
        Ok(()) => checks.push(Check::pass(
            CHECK_SIZE,
            format!("{} files: one pull request carries them", unit.files.len()),
        )),
        Err(e) => checks.push(Check::fail(
            CHECK_SIZE,
            true,
            format!(
                "{e}; at most {MAX_FILES} files and {MAX_BYTES} bytes move in one pull request"
            ),
            Vec::new(),
        )),
    }

    // Boundary: how other code will reach it once it is a crate.
    let base = if unit.is_crate() {
        joined(&unit.path, "src")
    } else {
        unit.path.clone()
    };
    let has_module = |name: &str| {
        let file = joined(&base, &format!("{name}.rs"));
        let dir = joined(&base, name);
        unit.files
            .iter()
            .any(|f| *f == file || f.starts_with(&format!("{dir}/")))
    };
    let missing: Vec<&str> = PUBLIC_MODULES
        .iter()
        .copied()
        .filter(|m| !has_module(m))
        .collect();
    if missing.is_empty() {
        checks.push(Check::pass(
            CHECK_BOUNDARY,
            "it has a port and an sdk: other code reaches it through them".into(),
        ));
    } else {
        checks.push(Check::fail(
            CHECK_BOUNDARY,
            true,
            format!(
                "it has no {}: once it is its own crate, other code has nothing to call it through",
                missing.join(" and no ")
            ),
            vec![Spot::file(&base)],
        ));
    }

    // Persistence: its tables come with it.
    let persistence: Vec<&String> = unit
        .files
        .iter()
        .filter(|f| {
            matches!(file_name(f), "entity.rs" | "repo.rs" | "repository.rs")
                || f.contains("/entity/")
        })
        .collect();
    let migrations = unit
        .files
        .iter()
        .any(|f| file_name(f) == "migrations.rs" || f.contains("/migrations/"));
    if persistence.is_empty() {
        checks.push(Check::pass(CHECK_PERSISTENCE, "it keeps no tables".into()));
    } else if migrations {
        checks.push(Check::pass(
            CHECK_PERSISTENCE,
            "its tables are created by its own migrations".into(),
        ));
    } else {
        checks.push(Check::fail(
            CHECK_PERSISTENCE,
            true,
            "it reads and writes tables, but no migration of its own creates them".into(),
            persistence.iter().map(|f| Spot::file(f)).collect(),
        ));
    }

    // Reaches out: what it uses of the code it would leave. Another gear
    // used through its sdk or port is a gear it depends on, not code left
    // behind.
    let mut out_spots = Vec::new();
    let mut gear_uses: BTreeMap<String, Spot> = BTreeMap::new();
    let gear_mods = gear_modules(unit, sizes);
    if unit.is_crate() {
        if let Some(m) = &unit.manifest
            && let Some(body) = texts.get(m)
        {
            for (line, rel) in path_dependencies(body) {
                let target = resolve(&unit.path, &rel);
                if target
                    .as_deref()
                    .is_none_or(|t| !under(t, &unit.path) && t != unit.path)
                {
                    out_spots.push(Spot::at(m, line, body.lines().nth(line).unwrap_or("")));
                }
            }
        }
    } else {
        let depths = path_depths(unit, texts);
        for file in &unit.files {
            let Some(c) = code.get(file.as_str()) else {
                continue;
            };
            let raw = texts.get(file).map(String::as_str).unwrap_or("");
            let depth = depths
                .get(file)
                .copied()
                .unwrap_or_else(|| depth_of(unit, file));
            for (line, path) in crate_paths(c) {
                let n = unit.module_path.len();
                let mine = n > 0 && path.len() >= n && path[..n] == unit.module_path[..];
                if mine {
                    continue;
                }
                match gear_of(&path, &gear_mods) {
                    Some(gear) => {
                        gear_uses.entry(gear).or_insert_with(|| {
                            Spot::at(file, line, raw.lines().nth(line).unwrap_or(""))
                        });
                    }
                    None => {
                        out_spots.push(Spot::at(file, line, raw.lines().nth(line).unwrap_or("")))
                    }
                }
            }
            let inline = inline_mod_depths(c);
            let mut from = 0;
            while let Some(at) = c[from..].find("super::") {
                let start = from + at;
                let before = c[..start].chars().next_back();
                from = start + 7;
                if before.is_some_and(|ch| ident_char(ch) || ch == ':') {
                    continue;
                }
                let mut k = 1;
                while c[from..].starts_with("super::") {
                    k += 1;
                    from += 7;
                }
                if k > depth + inline[start] {
                    let line = c[..start].matches('\n').count();
                    out_spots.push(Spot::at(file, line, raw.lines().nth(line).unwrap_or("")));
                }
            }
        }
        out_spots.dedup();
    }
    // Its tests may lean on the crate's test helpers: worth knowing, not a
    // reason to stop.
    let in_code = out_spots.iter().filter(|s| !test_file(&s.path)).count();
    if out_spots.is_empty() {
        checks.push(Check::pass(
            CHECK_REACHES_OUT,
            "it uses nothing of the code around it".into(),
        ));
    } else if in_code == 0 {
        let n = out_spots.len();
        checks.push(Check::fail(
            CHECK_REACHES_OUT,
            false,
            format!(
                "only its tests use the code around it ({n} place{}): their helpers have to come along or be replaced",
                if n == 1 { "" } else { "s" }
            ),
            out_spots,
        ));
    } else {
        checks.push(Check::fail(
            CHECK_REACHES_OUT,
            true,
            format!(
                "it uses the code around it in {in_code} place{}: that code stays behind",
                if in_code == 1 { "" } else { "s" }
            ),
            out_spots,
        ));
    }

    // Gears: the ones it uses through their sdk or port must be crates it
    // can depend on before it builds alone.
    let gears: Vec<String> = gear_uses.keys().cloned().collect();
    if gear_uses.is_empty() {
        checks.push(Check::pass(CHECK_GEARS, "it uses no other gear".into()));
    } else {
        let k = gear_uses.len();
        checks.push(Check::fail(
            CHECK_GEARS,
            false,
            format!(
                "it uses {k} other gear{} ({}): each has to be a crate it can depend on -- extracted first, or the platform's",
                if k == 1 { "" } else { "s" },
                gears.join(", ")
            ),
            gear_uses.into_values().collect(),
        ));
    }

    // Reached into: who uses its private modules.
    if unit.is_crate() {
        checks.push(Check::pass(
            CHECK_REACHED_INTO,
            "a crate is used only through what it makes public".into(),
        ));
    } else if unit.module_path.is_empty() {
        checks.push(Check::fail(
            CHECK_REACHED_INTO,
            false,
            "not checked: the module is in no crate's src/".into(),
            Vec::new(),
        ));
    } else {
        let private: BTreeSet<String> = submodules(unit)
            .into_iter()
            .filter(|m| !PUBLIC_MODULES.contains(&m.as_str()))
            .collect();
        let n = unit.module_path.len();
        let mut spots = Vec::new();
        for (file, c) in &code {
            if in_unit(file) {
                continue;
            }
            let raw = texts.get(*file).map(String::as_str).unwrap_or("");
            for (line, path) in crate_paths(c) {
                if path.len() > n && path[..n] == unit.module_path[..] && private.contains(&path[n])
                {
                    spots.push(Spot::at(file, line, raw.lines().nth(line).unwrap_or("")));
                }
            }
        }
        spots.dedup();
        let partial = if scope.partial() {
            format!(
                " (read {} of the crate's {} other files)",
                scope.outside_read, scope.outside_total
            )
        } else {
            String::new()
        };
        let in_code = spots.iter().filter(|s| !test_file(&s.path)).count();
        if spots.is_empty() {
            checks.push(Check::pass(
                CHECK_REACHED_INTO,
                format!("no code outside it uses its private modules{partial}"),
            ));
        } else if in_code == 0 {
            let k = spots.len();
            checks.push(Check::fail(
                CHECK_REACHED_INTO,
                false,
                format!(
                    "only tests outside it use its private modules ({k} place{}){partial}",
                    if k == 1 { "" } else { "s" }
                ),
                spots,
            ));
        } else {
            let k = spots.len();
            checks.push(Check::fail(
                CHECK_REACHED_INTO,
                true,
                format!(
                    "code outside it uses its private modules in {k} place{}: move what they need into its sdk or port{partial}",
                    if k == 1 { "" } else { "s" }
                ),
                spots,
            ));
        }
    }

    // Dependencies: what its own Cargo.toml would list.
    let manifest = unit
        .manifest
        .as_deref()
        .and_then(|m| texts.get(m))
        .map(|b| manifest_dependencies(b))
        .unwrap_or_default();
    let mut dependencies = Vec::new();
    if unit.is_crate() {
        for (name, spec) in &manifest {
            dependencies.push(Dependency {
                name: name.clone(),
                spec: Some(spec.clone()),
            });
        }
        checks.push(Check::pass(
            CHECK_DEPENDENCIES,
            format!("its Cargo.toml lists {} dependencies", manifest.len()),
        ));
    } else {
        let own = submodules(unit);
        let mut roots: BTreeMap<String, (String, usize, String)> = BTreeMap::new();
        for file in &unit.files {
            let Some(c) = code.get(file.as_str()) else {
                continue;
            };
            let raw = texts.get(file).map(String::as_str).unwrap_or("");
            for (root, (line, _)) in used_roots(c) {
                roots.entry(root).or_insert_with(|| {
                    (
                        file.clone(),
                        line,
                        raw.lines().nth(line).unwrap_or("").to_owned(),
                    )
                });
            }
        }
        // A crate named only by path (`tracing::warn!`, `#[async_trait::async_trait]`)
        // is a dependency too. Only names the manifest lists count here: a
        // bare `x::` may be a local module.
        for file in &unit.files {
            let Some(c) = code.get(file.as_str()) else {
                continue;
            };
            for root in qualified_roots(c) {
                if manifest.contains_key(&root) && !own.contains(&root) {
                    roots
                        .entry(root)
                        .or_insert_with(|| (file.clone(), 0, String::new()));
                }
            }
        }
        let mut unknown = Vec::new();
        for (root, (file, line, text)) in roots {
            if NOT_CRATES.contains(&root.as_str())
                || own.contains(&root)
                || root.chars().next().is_some_and(char::is_uppercase)
            {
                continue;
            }
            let spec = manifest.get(&root).cloned();
            if spec.is_none() {
                unknown.push(Spot::at(&file, line, &text));
            }
            dependencies.push(Dependency { name: root, spec });
        }
        if unit.manifest.is_none() {
            checks.push(Check::fail(
                CHECK_DEPENDENCIES,
                true,
                "it is in no crate: there is no Cargo.toml to take its dependencies from".into(),
                Vec::new(),
            ));
        } else if unknown.is_empty() {
            checks.push(Check::pass(
                CHECK_DEPENDENCIES,
                format!(
                    "its Cargo.toml would list {} dependencies, all from its crate's",
                    dependencies.len()
                ),
            ));
        } else {
            let k = unknown.len();
            checks.push(Check::fail(
                CHECK_DEPENDENCIES,
                false,
                format!(
                    "{k} name{} it uses {} not in its crate's Cargo.toml: a module of the crate, or a dependency to add by hand",
                    if k == 1 { "" } else { "s" },
                    if k == 1 { "is" } else { "are" }
                ),
                unknown,
            ));
        }
    }

    let ready = checks.iter().all(|c| c.ok || !c.blocks);
    Readiness {
        ready,
        unit: unit.clone(),
        checks,
        dependencies,
        gears,
        read: scope,
    }
}

/// The occurrence to check: one that declares the entry, as Publish takes;
/// for a candidate, its best-scored finding.
pub fn occurrence_to_check(occurrences: &[OccurrenceRecord]) -> Option<&OccurrenceRecord> {
    let declaring = occurrences.iter().filter(|o| !o.detected()).min_by(|a, b| {
        b.in_organization()
            .cmp(&a.in_organization())
            .then_with(|| a.project_name.cmp(&b.project_name))
            .then_with(|| a.path.cmp(&b.path))
    });
    declaring.or_else(|| occurrences.iter().max_by_key(|o| o.score.unwrap_or(0)))
}

/// Why there is no answer.
#[derive(Debug)]
pub enum ReadinessFailure {
    NotFound(String),
    /// Nothing says where the component is.
    NoOccurrence,
    /// The occurrence names no tenant to read it through.
    NoConnection,
    /// The occurrence is read through a connection the organization only
    /// inherits (the platform's): its code is not the organization's to read.
    NotOwnConnection(uuid::Uuid),
    /// The listing holds nothing at the occurrence's path any more.
    Gone(String),
    Read(anyhow::Error),
}

impl From<anyhow::Error> for ReadinessFailure {
    fn from(e: anyhow::Error) -> Self {
        Self::Read(e)
    }
}

/// [`OccurrenceFiles`](registry_publish::OccurrenceFiles) through the
/// occurrence's connection, from a checkout when there is one.
pub struct ReadinessFiles<'a> {
    pub service: &'a super::service::CatalogService,
    pub checkout: Option<std::path::PathBuf>,
}

impl ReadinessFiles<'_> {
    fn reader(&self, occ: &OccurrenceRecord) -> anyhow::Result<super::repo_enrich::RepoEnricher> {
        let connectors = self.service.connector_service().ok_or_else(|| {
            anyhow::anyhow!("no connector service is available to read the component")
        })?;
        let tenant = occ
            .tenant
            .ok_or_else(|| anyhow::anyhow!("the occurrence names no tenant"))?;
        let reader = super::repo_enrich::RepoEnricher::new(
            connectors,
            tenant,
            occ.connection_id,
            occ.repo.clone(),
            occ.git_ref.clone().unwrap_or_default(),
            super::repo_enrich::RepoMode::parse("gears"),
        )
        .ok_or_else(|| anyhow::anyhow!("the occurrence names no repository"))?;
        Ok(match &self.checkout {
            Some(dir) => reader.with_checkout(dir.clone()),
            None => reader,
        })
    }

    /// How many of the crate's other files to read: all from a checkout.
    pub fn budget(&self) -> usize {
        if self.checkout.is_some() {
            usize::MAX
        } else {
            OUTSIDE_BUDGET
        }
    }
}

#[async_trait::async_trait]
impl registry_publish::OccurrenceFiles for ReadinessFiles<'_> {
    async fn listing(
        &self,
        ctx: &toolkit_security::SecurityContext,
        occ: &OccurrenceRecord,
    ) -> anyhow::Result<Vec<(String, Option<i64>)>> {
        self.reader(occ)?.file_listing(ctx).await
    }

    async fn read(
        &self,
        ctx: &toolkit_security::SecurityContext,
        occ: &OccurrenceRecord,
        paths: &[String],
    ) -> anyhow::Result<Vec<(String, Option<String>)>> {
        self.reader(occ)?.read_texts(ctx, paths).await
    }
}

/// The context an occurrence is read in: its project's tenant, or the
/// organization's for its gear repository.
pub fn occurrence_ctx(
    ctx: &toolkit_security::SecurityContext,
    occ: &OccurrenceRecord,
) -> Result<toolkit_security::SecurityContext, ReadinessFailure> {
    match occ.project_id {
        Some(project_id) => Ok(super::registry::in_tenant(ctx, project_id)?),
        None if occ.in_organization() => Ok(ctx.clone()),
        None => Err(ReadinessFailure::NoConnection),
    }
}

impl super::service::CatalogService {
    /// The entry `name` and the occurrence its readiness is checked at.
    pub async fn readiness_target(
        &self,
        ctx: &toolkit_security::SecurityContext,
        name: &str,
    ) -> Result<OccurrenceRecord, ReadinessFailure> {
        let wanted = name.trim();
        let entry = self
            .registry_entry(ctx, wanted)
            .await?
            .ok_or_else(|| ReadinessFailure::NotFound(wanted.to_owned()))?;
        let occ = occurrence_to_check(&entry.occurrences)
            .ok_or(ReadinessFailure::NoOccurrence)?
            .clone();
        let Some(tenant) = occ.tenant else {
            return Err(ReadinessFailure::NoConnection);
        };
        // As Publish: the code is read only through the organization's own
        // connection, never one it inherits from the platform.
        if !self
            .connection_is_organizations(ctx, tenant, occ.project_id)
            .await
        {
            return Err(ReadinessFailure::NotOwnConnection(tenant));
        }
        Ok(occ)
    }

    /// Whether `occ` could leave its project: its unit located in the
    /// repository's listing, its files and up to `budget` of its crate's
    /// other files read, and [`assess`]ed. Nothing is written.
    pub async fn registry_readiness(
        &self,
        ctx: &toolkit_security::SecurityContext,
        occ: &OccurrenceRecord,
        files: &dyn registry_publish::OccurrenceFiles,
        budget: usize,
    ) -> Result<Readiness, ReadinessFailure> {
        let octx = occurrence_ctx(ctx, occ)?;
        let sizes = files.listing(&octx, occ).await?;
        let listing: Vec<String> = sizes.iter().map(|(p, _)| p.clone()).collect();
        let unit =
            locate(&listing, &occ.path).ok_or_else(|| ReadinessFailure::Gone(occ.path.clone()))?;
        let outside = outside_sources(&listing, &unit);
        let take = outside.len().min(budget);
        let mut wanted: Vec<String> = unit
            .files
            .iter()
            .filter(|f| f.ends_with(".rs") || f.ends_with("Cargo.toml"))
            .take(MAX_FILES)
            .cloned()
            .collect();
        if let Some(m) = &unit.manifest
            && !wanted.contains(m)
        {
            wanted.push(m.clone());
        }
        wanted.extend(outside.iter().take(take).cloned());
        let texts: BTreeMap<String, String> = files
            .read(&octx, occ, &wanted)
            .await?
            .into_iter()
            .filter_map(|(p, t)| t.map(|t| (p, t)))
            .collect();
        Ok(assess(
            &unit,
            &sizes,
            &texts,
            ReadScope {
                outside_read: take,
                outside_total: outside.len(),
            },
        ))
    }
}

#[cfg(test)]
#[path = "registry_readiness_tests.rs"]
mod tests;
