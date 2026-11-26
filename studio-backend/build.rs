//! Facts the binary carries about its own build, for `studio-assembly`.
//!
//! Two of them, and both are fixed here rather than read at run time, so the
//! answer a deployment gives cannot drift from the binary that gives it:
//!
//! * `STUDIO_BUILD_COMMIT` — the commit CI built from. CI sets it from
//!   `git rev-parse HEAD` of its checkout; a local build leaves it unset and
//!   the manifest says so (`commit: null`) rather than guessing. Not read from
//!   `.git` here: an incremental build would keep the commit of whichever
//!   build last ran this script, which is a wrong answer that looks right.
//! * the purpose of each Studio gear — the first paragraph of section 1.1 of
//!   its design, `docs/design/<gear>.md`, compiled into a table. A checkout
//!   without `docs/` (a build context that copied only this crate) builds
//!   with an empty table and a warning: the gears are still listed, without
//!   their purpose.

use std::env;
use std::fmt::Write as _;
use std::fs;
use std::path::Path;

fn main() {
    println!("cargo::rerun-if-env-changed=STUDIO_BUILD_COMMIT");
    let commit = env::var("STUDIO_BUILD_COMMIT")
        .map(|c| c.trim().to_owned())
        .unwrap_or_default();
    println!("cargo::rustc-env=STUDIO_BUILD_COMMIT={commit}");

    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR");
    let designs = Path::new(&manifest_dir).join("../docs/design");
    println!("cargo::rerun-if-changed={}", designs.display());

    let mut docs: Vec<(String, String)> = Vec::new();
    match fs::read_dir(&designs) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("md") {
                    continue;
                }
                let Some(name) = path.file_stem().and_then(|s| s.to_str()) else {
                    continue;
                };
                let Ok(text) = fs::read_to_string(&path) else {
                    continue;
                };
                if let Some(purpose) = vision(&text) {
                    docs.push((name.to_owned(), purpose));
                }
            }
        }
        Err(_) => println!(
            "cargo::warning=docs/design is not in this build context: \
             studio-assembly will list the gears without their purpose"
        ),
    }
    docs.sort();

    let mut out =
        String::from("/// `(design doc stem, its section 1.1 first paragraph)`, by stem.\n");
    out.push_str("pub const DESIGN_DOCS: &[(&str, &str)] = &[\n");
    for (name, purpose) in &docs {
        // `{:?}` of a str is a valid Rust string literal, escapes included.
        let _ = writeln!(out, "    ({name:?}, {purpose:?}),");
    }
    out.push_str("];\n");
    let out_dir = env::var("OUT_DIR").expect("cargo sets OUT_DIR");
    fs::write(Path::new(&out_dir).join("design_docs.rs"), out).expect("write design_docs.rs");

    let src = Path::new(&manifest_dir).join("src");
    println!("cargo::rerun-if-changed={}", src.display());
    fs::write(
        Path::new(&out_dir).join("gear_uses.rs"),
        gear_uses(&src) + &module_refs(&src),
    )
    .expect("write gear_uses.rs");
}

// ── Which Studio gear uses which, and how ─────────────────────────────────
//
// The toolkit's `deps` name crates, and every Studio gear lives in this one
// crate, so no Studio gear can declare that it needs another: the registry
// sees them all as independent. What one gear uses of another is read here
// from the code instead, as `crate::<gear module>::<item>` paths, and each is
// classified:
//
// * `port`     — the other gear's `port` or `sdk` module;
// * `surface`  — an item its `mod.rs` exports at the top (`crate::tasks::TaskQueue`);
// * `internal` — one of its other modules (`crate::spec_quality::record`).
//
// Test code is left out: files named `*tests.rs`/`*_test.rs`, and a file from
// its first `#[cfg(test)]` on.

/// A directory under `src/` whose `mod.rs` declares a gear, with that gear's name.
fn gear_modules(src: &Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(src) else {
        return out;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        // `mod.rs` first, else `gear.rs`: where a module keeps its gear.
        let Some((text, at)) = ["mod.rs", "gear.rs"].iter().find_map(|f| {
            let text = fs::read_to_string(dir.join(f)).ok()?;
            let at = text.find("#[toolkit::gear(")?;
            Some((text, at))
        }) else {
            continue;
        };
        let decl = &text[at..];
        let name = decl
            .find("name = \"")
            .map(|i| &decl[i + 8..])
            .and_then(|rest| rest.find('"').map(|end| rest[..end].to_owned()));
        if let (Some(module), Some(name)) = (dir.file_name().and_then(|n| n.to_str()), name) {
            out.push((module.to_owned(), name));
        }
    }
    out.sort();
    out
}

fn rust_files(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            out.push(path);
        }
    }
}

fn is_ident(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// The first segment of every path `crate::<module>::…` names in `code`, as
/// `(module, segment)`; a `{a, b::c}` group gives each of its members.
fn crate_paths(code: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = code;
    while let Some(at) = rest.find("crate::") {
        let before_ok = rest[..at].chars().next_back().is_none_or(|c| !is_ident(c));
        rest = &rest[at + 7..];
        if !before_ok {
            continue;
        }
        let module: String = rest.chars().take_while(|c| is_ident(*c)).collect();
        let after = &rest[module.len()..];
        let Some(after) = after.strip_prefix("::") else {
            continue;
        };
        if let Some(group) = after.strip_prefix('{') {
            let Some(end) = group.find('}') else { continue };
            for member in group[..end].split(',') {
                let seg: String = member.trim().chars().take_while(|c| is_ident(*c)).collect();
                if !seg.is_empty() && seg != "self" {
                    out.push((module.clone(), seg));
                }
            }
        } else {
            let seg: String = after.chars().take_while(|c| is_ident(*c)).collect();
            if !seg.is_empty() {
                out.push((module.clone(), seg));
            }
        }
    }
    out
}

fn gear_uses(src: &Path) -> String {
    use std::collections::BTreeMap;
    let modules = gear_modules(src);
    let is_gear = |m: &str| modules.iter().any(|(module, _)| module == m);
    // (from, to, via, segment) → occurrences
    let mut uses: BTreeMap<(String, String, &str, String), u32> = BTreeMap::new();
    for (from, _) in &modules {
        let mut files = Vec::new();
        rust_files(&src.join(from), &mut files);
        for file in files {
            let name = file.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name.ends_with("tests.rs") || name.ends_with("_test.rs") {
                continue;
            }
            let Ok(text) = fs::read_to_string(&file) else {
                continue;
            };
            for (to, seg) in crate_paths(&non_test_code(&text)) {
                if to == *from || !is_gear(&to) {
                    continue;
                }
                let submodule = src.join(&to).join(format!("{seg}.rs")).is_file()
                    || src.join(&to).join(&seg).is_dir();
                let via = if seg == "port" || seg == "sdk" {
                    "port"
                } else if submodule {
                    "internal"
                } else {
                    "surface"
                };
                *uses.entry((from.clone(), to, via, seg)).or_default() += 1;
            }
        }
    }
    let mut out = String::from(
        "/// `(module, gear name)` of every directory under `src/` that declares a gear.\n\
         pub const GEAR_MODULES: &[(&str, &str)] = &[\n",
    );
    for (module, name) in &modules {
        let _ = writeln!(out, "    ({module:?}, {name:?}),");
    }
    out.push_str(
        "];\n\n/// `(from module, to module, via, first segment, occurrences)`: what one\n\
         /// Studio gear names of another, outside test code. `via` is `port`,\n\
         /// `surface` or `internal` (see `build.rs`).\n\
         pub const GEAR_USES: &[(&str, &str, &str, &str, u32)] = &[\n",
    );
    for ((from, to, via, seg), n) in &uses {
        let _ = writeln!(out, "    ({from:?}, {to:?}, {via:?}, {seg:?}, {n}),");
    }
    out.push_str("];\n");
    out
}

// ── Which top-level module names which ─────────────────────────────────────
//
// What the core-to-kit ratchet test in `assembly` holds against its allowlist
// (ADR-0079), for every module under `src/` (a directory or a root file),
// gear or not, and for the crate root (`lib.rs`, `main.rs`). Two readings:
//
// * `MODULE_REFS`: `crate::<to>::…` paths (and, in the crate root, bare
//   `<to>::…` paths, which mean the same there);
// * `MODULE_NAME_REFS`: a string literal naming a gear another module
//   declares (`"studio-documents"`, `"/studio-documents/v1/…"`);
// * `MODULE_SLUG_REFS`: a string literal that is a built-in kit's slug
//   (`"project-git"`, from `kit_registry/builtin/*.kit.json`).
//
// Both read the code without comments and without test code: files named
// `*tests.rs`/`*_test.rs`, and every item under a `#[cfg(test)]` (or
// `#[cfg(all(test, …))]`) attribute, to the end of that item (a `mod x { … }`
// block, a `mod x;`, a `fn`, a `use`), not to the end of the file.

/// Every top-level module under `src/` with the files that make it: a
/// directory's `.rs` files, or the root file itself. Test files are not
/// modules of their own; `lib.rs` and `main.rs` are the crate root, `lib` and
/// `main`.
fn top_level_modules(src: &Path) -> Vec<(String, Vec<std::path::PathBuf>)> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(src) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()).map(str::to_owned) else {
            continue;
        };
        if path.is_dir() {
            let mut files = Vec::new();
            rust_files(&path, &mut files);
            if !files.is_empty() {
                out.push((name, files));
            }
        } else if let Some(stem) = name.strip_suffix(".rs") {
            if stem.ends_with("tests") || stem.ends_with("_test") {
                continue;
            }
            out.push((stem.to_owned(), vec![path]));
        }
    }
    out.sort();
    out
}

/// Every gear name a module declares (`#[toolkit::gear(name = "…")]`), its
/// plugins' included.
fn declared_gear_names(files: &[std::path::PathBuf]) -> Vec<String> {
    let mut out = Vec::new();
    for file in files {
        let name = file.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.ends_with("tests.rs") || name.ends_with("_test.rs") {
            continue;
        }
        let Ok(text) = fs::read_to_string(file) else {
            continue;
        };
        // Found in the production code (a gear a test or a comment declares
        // is not the module's), read from the text (the name is a string).
        let masked = production_code(&text).masked;
        let mut from = 0;
        while let Some(p) = masked[from..].find("#[toolkit::gear(") {
            let start = from + p + 16;
            from = start;
            let rest = &text[start..];
            let attr = &rest[..rest.find(")]").unwrap_or(rest.len())];
            if let Some(i) = attr.find("name = \"") {
                let value = &attr[i + 8..];
                if let Some(end) = value.find('"') {
                    out.push(value[..end].to_owned());
                }
            }
        }
    }
    out
}

fn module_refs(src: &Path) -> String {
    use std::collections::BTreeSet;
    let modules = top_level_modules(src);
    let names: BTreeSet<&str> = modules.iter().map(|(m, _)| m.as_str()).collect();
    let gear_names: Vec<(String, String)> = modules
        .iter()
        .flat_map(|(m, files)| {
            declared_gear_names(files)
                .into_iter()
                .map(move |n| (m.clone(), n))
        })
        .collect();
    let mut refs: BTreeSet<(String, String)> = BTreeSet::new();
    let mut name_refs: BTreeSet<(String, String)> = BTreeSet::new();
    let slugs = builtin_kit_slugs(&src.join("kit_registry").join("builtin"));
    let mut slug_refs: BTreeSet<(String, String)> = BTreeSet::new();
    for (from, files) in &modules {
        let root = from == "lib" || from == "main";
        for file in files {
            let name = file.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name.ends_with("tests.rs") || name.ends_with("_test.rs") {
                continue;
            }
            let Ok(text) = fs::read_to_string(file) else {
                continue;
            };
            let code = production_code(&text);
            let mut found: Vec<String> = crate_paths(&code.masked)
                .into_iter()
                .map(|(to, _)| to)
                .collect();
            if root {
                found.extend(bare_paths(&code.masked));
            }
            for to in found {
                if to != *from && names.contains(to.as_str()) {
                    refs.insert((from.clone(), to));
                }
            }
            for literal in &code.literals {
                for (to, gear) in &gear_names {
                    if to != from && names_token(literal, gear) {
                        name_refs.insert((from.clone(), to.clone()));
                    }
                }
                if slugs.contains(literal) {
                    slug_refs.insert((from.clone(), literal.clone()));
                }
            }
        }
    }
    let mut out = String::from(
        "\n/// `(from, to)`: a top-level module under `src/` (or the crate root,\n\
         /// `lib`/`main`) that names another as `crate::<to>::…` outside test\n\
         /// code and comments (see `build.rs`).\n\
         #[cfg(test)]\n\
         pub const MODULE_REFS: &[(&str, &str)] = &[\n",
    );
    for (from, to) in &refs {
        let _ = writeln!(out, "    ({from:?}, {to:?}),");
    }
    out.push_str(
        "];\n\n/// `(from, to)`: a top-level module whose string literals name a gear\n\
         /// `to` declares, as its name or in a REST path (`/studio-documents/v1/…`),\n\
         /// outside test code and comments (see `build.rs`).\n\
         #[cfg(test)]\n\
         pub const MODULE_NAME_REFS: &[(&str, &str)] = &[\n",
    );
    for (from, to) in &name_refs {
        let _ = writeln!(out, "    ({from:?}, {to:?}),");
    }
    out.push_str(
        "];\n\n/// `(from, kit slug)`: a top-level module with a string literal that is a\n\
         /// built-in kit's slug (`\"project-git\"`), outside test code and comments\n\
         /// (see `build.rs`).\n\
         #[cfg(test)]\n\
         pub const MODULE_SLUG_REFS: &[(&str, &str)] = &[\n",
    );
    for (from, slug) in &slug_refs {
        let _ = writeln!(out, "    ({from:?}, {slug:?}),");
    }
    out.push_str("];\n");
    out
}

/// The slugs of the built-in kits, from their compiled-in `kit.json`s.
fn builtin_kit_slugs(dir: &Path) -> std::collections::BTreeSet<String> {
    let mut out = std::collections::BTreeSet::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let Ok(text) = fs::read_to_string(entry.path()) else {
            continue;
        };
        if let Some(i) = text.find("\"slug\": \"") {
            let rest = &text[i + 9..];
            if let Some(end) = rest.find('"') {
                out.insert(rest[..end].to_owned());
            }
        }
    }
    out
}

/// Whether `text` holds `name` as a whole token: not inside a longer name
/// (`studio-git` is not in `studio-git-proxy`).
fn names_token(text: &str, name: &str) -> bool {
    let part = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-';
    text.match_indices(name).any(|(at, _)| {
        text[..at].chars().next_back().is_none_or(|c| !part(c))
            && text[at + name.len()..]
                .chars()
                .next()
                .is_none_or(|c| !part(c))
    })
}

/// `<module>::…` paths that start a path (not `x::<module>`, not a field or
/// method), as the crate root writes `crate::<module>::…`.
fn bare_paths(code: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = code.as_bytes();
    let mut start = None;
    for (i, &b) in bytes.iter().enumerate() {
        match (ident_byte(b), start) {
            (true, None) => start = Some(i),
            (false, Some(s)) => {
                start = None;
                let before = code[..s].trim_end();
                let inside_path = before.ends_with("::") || before.ends_with('.');
                if code[i..].starts_with("::") && !inside_path {
                    out.push(code[s..i].to_owned());
                }
            }
            _ => {}
        }
    }
    out
}

/// A file's production code. `masked` is the text with comments, test items
/// and the insides of string and char literals blanked (same length, line
/// breaks kept); `literals` are the contents of the string literals outside
/// test items.
struct Production {
    masked: String,
    literals: Vec<String>,
}

fn production_code(text: &str) -> Production {
    let b = text.as_bytes();
    let (mut masked, spans) = lex(b);
    let tests = test_items(&masked);
    for &(from, to) in &tests {
        blank(&mut masked, from, to);
    }
    let literals = spans
        .into_iter()
        .filter(|&(s, _)| !tests.iter().any(|&(from, to)| from <= s && s < to))
        .map(|(s, e)| String::from_utf8_lossy(&b[s..e]).into_owned())
        .collect();
    Production {
        masked: String::from_utf8_lossy(&masked).into_owned(),
        literals,
    }
}

fn blank(m: &mut [u8], from: usize, to: usize) {
    let to = to.min(m.len());
    for c in m.iter_mut().take(to).skip(from) {
        if *c != b'\n' {
            *c = b' ';
        }
    }
}

fn ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Rust source with comments and the insides of literals blanked, and the
/// spans of the string literals' contents.
fn lex(b: &[u8]) -> (Vec<u8>, Vec<(usize, usize)>) {
    let len = b.len();
    let mut m = b.to_vec();
    let mut spans = Vec::new();
    let mut i = 0;
    while i < len {
        let c = b[i];
        if c == b'/' && b.get(i + 1) == Some(&b'/') {
            let end = b[i..]
                .iter()
                .position(|&x| x == b'\n')
                .map_or(len, |p| i + p);
            blank(&mut m, i, end);
            i = end;
        } else if c == b'/' && b.get(i + 1) == Some(&b'*') {
            // Block comments nest.
            let mut depth = 0;
            let mut j = i;
            while j < len {
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
            blank(&mut m, i, j);
            i = j;
        } else if c == b'"' {
            let start = i + 1;
            let mut k = start;
            while k < len && b[k] != b'"' {
                k += if b[k] == b'\\' { 2 } else { 1 };
            }
            let k = k.min(len);
            spans.push((start, k));
            blank(&mut m, start, k);
            i = k + 1;
        } else if c == b'\'' {
            if b.get(i + 1) == Some(&b'\\') {
                let mut k = (i + 3).min(len);
                while k < len && b[k] != b'\'' {
                    k += 1;
                }
                blank(&mut m, i + 1, k);
                i = k + 1;
            } else {
                let n = b.get(i + 1).map_or(1, |&x| utf8_len(x));
                if b.get(i + 1 + n) == Some(&b'\'') {
                    blank(&mut m, i + 1, i + 1 + n);
                    i += 2 + n;
                } else {
                    // A lifetime or a label.
                    i += 1;
                }
            }
        } else if ident_byte(c) {
            // A raw string (`r"…"`, `r#"…"#`, `br…`, `cr…`) starts with an
            // identifier-looking prefix; anything else is skipped whole, so
            // an `r` inside a name starts nothing.
            let mut j = i;
            while j < len && ident_byte(b[j]) {
                j += 1;
            }
            let word = &b[i..j];
            let raw = matches!(word, b"r" | b"br" | b"cr");
            if raw && matches!(b.get(j), Some(b'"' | b'#')) {
                let mut h = j;
                while b.get(h) == Some(&b'#') {
                    h += 1;
                }
                let hashes = h - j;
                if b.get(h) == Some(&b'"') {
                    let start = h + 1;
                    let mut k = start;
                    while k < len
                        && !(b[k] == b'"' && (0..hashes).all(|n| b.get(k + 1 + n) == Some(&b'#')))
                    {
                        k += 1;
                    }
                    let k = k.min(len);
                    spans.push((start, k));
                    blank(&mut m, start, k);
                    i = k + 1 + hashes;
                    continue;
                }
                // `r#ident`, a raw identifier: go on after the `#`.
                i = h;
                continue;
            }
            // `b"…"`/`c"…"` and `b'…'`: the quote is read next.
            i = j;
        } else {
            i += 1;
        }
    }
    (m, spans)
}

fn utf8_len(first: u8) -> usize {
    match first {
        0xF0..=0xFF => 4,
        0xE0..=0xEF => 3,
        0xC0..=0xDF => 2,
        _ => 1,
    }
}

/// The spans of the items under a test-only `#[cfg(…)]` in lexed code: the
/// attribute, any attributes after it, and the item to its end (`;`, `,`, its
/// block's closing brace, or the end of the block around it). A file with
/// `#![cfg(test)]` is test code whole.
fn test_items(m: &[u8]) -> Vec<(usize, usize)> {
    let len = m.len();
    let text = String::from_utf8_lossy(m);
    if text.contains("#![cfg(test)]") {
        return vec![(0, len)];
    }
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(p) = text[from..].find("#[cfg(") {
        let at = from + p;
        let attr_end = bracket_end(m, at + 1);
        from = attr_end;
        let attr = &text[at..attr_end];
        let names_test = attr.match_indices("test").any(|(i, _)| {
            attr[..i].chars().next_back().is_none_or(|c| !is_ident(c))
                && attr[i + 4..].chars().next().is_none_or(|c| !is_ident(c))
        });
        if !names_test || attr.contains("not(") || attr.contains("any(") {
            continue;
        }
        // Further attributes, then the item.
        let mut j = attr_end;
        loop {
            while j < len && m[j].is_ascii_whitespace() {
                j += 1;
            }
            if m.get(j) == Some(&b'#') && m.get(j + 1) == Some(&b'[') {
                j = bracket_end(m, j + 1);
            } else {
                break;
            }
        }
        let mut depth = 0i32;
        let mut k = j;
        let end = loop {
            if k >= len {
                break len;
            }
            match m[k] {
                b'(' | b'[' | b'{' => depth += 1,
                b')' | b']' => {
                    depth -= 1;
                    if depth < 0 {
                        break k;
                    }
                }
                b'}' => {
                    depth -= 1;
                    if depth < 0 {
                        break k;
                    }
                    if depth == 0 {
                        break k + 1;
                    }
                }
                b';' | b',' if depth == 0 => break k + 1,
                _ => {}
            }
            k += 1;
        };
        out.push((at, end));
        from = end;
    }
    out
}

/// The index after the bracket that closes the one at `open`.
fn bracket_end(m: &[u8], open: usize) -> usize {
    let mut depth = 0i32;
    for (k, &c) in m.iter().enumerate().skip(open) {
        match c {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => {
                depth -= 1;
                if depth == 0 {
                    return k + 1;
                }
            }
            _ => {}
        }
    }
    m.len()
}

/// A file's code before its first `#[cfg(test)]`, without comment lines.
fn non_test_code(text: &str) -> String {
    text.lines()
        .take_while(|l| !l.trim_start().starts_with("#[cfg(test)]"))
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The first paragraph under `### 1.1 …` (every gear design calls it
/// "Architectural Vision"), as plain text: links keep their words, emphasis
/// and code marks go.
fn vision(text: &str) -> Option<String> {
    let mut lines = text.lines().skip_while(|l| !l.starts_with("### 1.1"));
    lines.next()?;
    let paragraph: Vec<&str> = lines
        .skip_while(|l| l.trim().is_empty())
        .take_while(|l| !l.trim().is_empty() && !l.starts_with('#'))
        .map(str::trim)
        .collect();
    if paragraph.is_empty() {
        return None;
    }
    Some(plain(&paragraph.join(" ")))
}

/// `[words](target)` → `words`; `**`, `*` and backticks dropped.
fn plain(markdown: &str) -> String {
    let mut out = String::with_capacity(markdown.len());
    let mut rest = markdown;
    while let Some(open) = rest.find('[') {
        let after = &rest[open + 1..];
        let link = after.find("](").and_then(|close| {
            after[close + 2..]
                .find(')')
                .map(|end| (close, close + 2 + end))
        });
        match link {
            Some((close, end)) => {
                out.push_str(&rest[..open]);
                out.push_str(&after[..close]);
                rest = &after[end + 1..];
            }
            None => {
                out.push_str(&rest[..=open]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out.replace("**", "").replace('`', "")
}
