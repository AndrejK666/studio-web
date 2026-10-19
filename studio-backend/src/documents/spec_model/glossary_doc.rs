//! The project's glossary as one document of its repository,
//! `docs/glossary.md`: one table row per term — what it means, the other
//! names it goes by, the terms it is not — that every other document links
//! to instead of saying again what a word means.
//!
//! A project that already keeps a glossary keeps it: the file itself, or a
//! "Glossary" section with a term table inside another document (a PRD's
//! §1.4). Its rows are read as written and stand; Studio adds what the
//! documents name and the glossary does not, fills what a row leaves out, and
//! moves a section-glossary into the file, leaving a link where it was.
//!
//! Pure: no I/O. The routes in `rest.rs` read and write the files.

/// Where the project's glossary is kept, from the repository's root.
pub const GLOSSARY_DOC_PATH: &str = "docs/glossary.md";

/// One term of the glossary.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Row {
    pub term: String,
    pub definition: String,
    /// Other names that mean the same; not to be used in new text.
    pub aliases: Vec<String>,
    /// Terms that look alike and are something else.
    pub not_same_as: Vec<String>,
    /// Where the definition was read: `path:line`.
    pub source: Option<String>,
}

/// A glossary the documents already keep.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Found {
    pub path: String,
    /// The section's heading, for a glossary kept inside another document.
    pub heading: Option<String>,
    /// 1-based, inclusive: the heading's line through the section's last.
    pub line_start: usize,
    pub line_end: usize,
    /// The whole document is the glossary.
    pub whole: bool,
    pub rows: Vec<Row>,
}

/// Words a glossary section's heading carries.
const HEADINGS: &[&str] = &[
    "glossary",
    "terminology",
    "terms",
    "definitions",
    "dictionary",
    "глоссарий",
    "термины",
    "словарь",
];

/// The glossary the documents keep, if any: [`GLOSSARY_DOC_PATH`] first,
/// else the glossary section with the most rows. A section counts when its
/// heading names a glossary and it holds a table whose first column is the
/// term.
pub fn find<'a>(docs: impl IntoIterator<Item = (&'a str, &'a str)>) -> Option<Found> {
    let mut best: Option<Found> = None;
    for (path, text) in docs {
        if path == GLOSSARY_DOC_PATH {
            let lines: Vec<&str> = text.lines().collect();
            return Some(Found {
                path: path.to_owned(),
                heading: None,
                line_start: 1,
                line_end: lines.len().max(1),
                whole: true,
                rows: rows_of(&lines),
            });
        }
        for found in sections(path, text) {
            if best
                .as_ref()
                .is_none_or(|b| found.rows.len() > b.rows.len())
            {
                best = Some(found);
            }
        }
    }
    best
}

/// The glossary sections of one document.
fn sections(path: &str, text: &str) -> Vec<Found> {
    let lines: Vec<&str> = text.lines().collect();
    let mut out = Vec::new();
    let mut fenced = false;
    let headings: Vec<(usize, usize, &str)> = lines
        .iter()
        .enumerate()
        .filter_map(|(i, l)| {
            if l.trim_start().starts_with("```") {
                fenced = !fenced;
            }
            if fenced {
                return None;
            }
            heading(l).map(|(level, title)| (i, level, title))
        })
        .collect();
    for (k, &(i, level, title)) in headings.iter().enumerate() {
        if !names_a_glossary(title) {
            continue;
        }
        let end = headings[k + 1..]
            .iter()
            .find(|&&(_, l, _)| l <= level)
            .map_or(lines.len(), |&(j, _, _)| j);
        let rows = rows_of(&lines[i + 1..end]);
        if !rows.is_empty() {
            out.push(Found {
                path: path.to_owned(),
                heading: Some(title.to_owned()),
                line_start: i + 1,
                line_end: end,
                whole: false,
                rows,
            });
        }
    }
    out
}

fn heading(line: &str) -> Option<(usize, &str)> {
    let level = line.chars().take_while(|&c| c == '#').count();
    let rest = &line[level..];
    ((1..=6).contains(&level) && rest.starts_with(' ')).then(|| (level, rest.trim()))
}

fn names_a_glossary(title: &str) -> bool {
    let lower = title.to_lowercase();
    lower
        .split(|c: char| !c.is_alphanumeric())
        .any(|w| HEADINGS.contains(&w))
}

/// The rows of the term tables among `lines`.
fn rows_of(lines: &[&str]) -> Vec<Row> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let header = lines[i].trim();
        let is_table =
            header.starts_with('|') && lines.get(i + 1).is_some_and(|l| is_separator(l.trim()));
        if !is_table {
            i += 1;
            continue;
        }
        let cols: Vec<String> = cells(header)
            .iter()
            .map(|c| plain(c).to_lowercase())
            .collect();
        let col = |words: &[&str]| {
            cols.iter()
                .position(|c| words.iter().any(|w| c.contains(w)))
        };
        let term_like = cols.first().is_some_and(|c| {
            ["term", "термин", "name", "word", "concept", "слово"]
                .iter()
                .any(|w| c.contains(w))
        });
        i += 2;
        if !term_like {
            continue;
        }
        let def = col(&[
            "definition",
            "meaning",
            "определение",
            "значение",
            "description",
        ])
        .unwrap_or(1);
        let aliases = col(&["alias", "also", "синоним"]);
        let apart = col(&["not the same"]);
        let source = col(&["source", "источник"]);
        while i < lines.len() && lines[i].trim().starts_with('|') {
            let c = cells(lines[i].trim());
            let term = plain(c.first().map_or("", String::as_str));
            if !term.is_empty() {
                let list = |k: Option<usize>| {
                    k.and_then(|k| c.get(k))
                        .map(|s| split_list(s))
                        .unwrap_or_default()
                };
                out.push(Row {
                    term,
                    definition: c
                        .get(def)
                        .map(|s| s.trim())
                        .filter(|s| *s != "—")
                        .unwrap_or_default()
                        .to_owned(),
                    aliases: list(aliases),
                    not_same_as: list(apart),
                    source: source
                        .and_then(|k| c.get(k))
                        .map(|s| plain(s).trim_matches('`').to_owned())
                        .filter(|s| !s.is_empty() && s != "—"),
                });
            }
            i += 1;
        }
    }
    out
}

fn is_separator(line: &str) -> bool {
    line.starts_with('|') && line.contains('-') && line.chars().all(|c| "|-: ".contains(c))
}

/// A table row's cells, `\|` kept inside its cell.
fn cells(line: &str) -> Vec<String> {
    let inner = line.trim().trim_start_matches('|');
    let inner = inner.strip_suffix('|').unwrap_or(inner);
    let mut out = vec![String::new()];
    let mut chars = inner.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' if chars.peek() == Some(&'|') => {
                out.last_mut().unwrap().push('|');
                chars.next();
            }
            '|' => out.push(String::new()),
            c => out.last_mut().unwrap().push(c),
        }
    }
    out.iter().map(|c| c.trim().to_owned()).collect()
}

/// A cell's text without emphasis, anchors and link targets.
fn plain(cell: &str) -> String {
    let mut s = cell.to_owned();
    // `<a id="x"></a>` and any other inline tag.
    while let (Some(a), Some(b)) = (s.find('<'), s.find('>')) {
        if b < a {
            break;
        }
        s.replace_range(a..=b, "");
    }
    // `[text](target)` → `text`.
    while let Some(a) = s.find("](") {
        let Some(b) = s[a..].find(')') else { break };
        s.replace_range(a..a + b + 1, "");
        if let Some(open) = s[..a].rfind('[') {
            s.remove(open);
        }
    }
    s.replace("**", "")
        .replace('*', "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn split_list(cell: &str) -> Vec<String> {
    plain(cell)
        .split([',', ';'])
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "—" && *s != "-")
        .map(str::to_owned)
        .collect()
}

/// The anchor a term is linked by: `glossary.md#<anchor>`.
pub fn anchor(term: &str) -> String {
    let mut out = String::new();
    for c in term.to_lowercase().chars() {
        if c.is_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_owned()
}

/// No document type in the front matter: a glossary is a contract the
/// specifications link to, not one of them, and a declared `type` wins the
/// classification outright -- `design` had it validated against the design
/// template. The link example is relative from a specification's folder
/// (`docs/design/`), where the documents that link to it live.
const HEAD: &str = "---\nartifact: glossary\n---\n\n# Glossary\n\n\
These terms are used with exactly this meaning in every document of the project. \
Link a term where a document first uses it — to `../glossary.md#member` from a \
specification under `docs/` — \
instead of saying again what it means. The names under *Also written as* mean the \
same thing; use the term, not them, in new text.\n\n\
<!-- Kept by Constructor Studio from the Glossary tab: one row per term. \
Edit it here or there. -->\n";

/// A cell that cannot break the table.
fn inline(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace('|', "\\|")
}

/// The glossary document for `rows`, in their order.
pub fn render(rows: &[Row]) -> String {
    let terms: std::collections::BTreeSet<String> =
        rows.iter().map(|r| r.term.to_lowercase()).collect();
    let mut out = String::from(HEAD);
    out.push_str("\n| Term | Definition | Also written as | Not the same as | Source |\n|---|---|---|---|---|\n");
    for r in rows {
        let apart: Vec<String> = r
            .not_same_as
            .iter()
            .map(|t| {
                if terms.contains(&t.to_lowercase()) {
                    format!("[{}](#{})", inline(t), anchor(t))
                } else {
                    inline(t)
                }
            })
            .collect();
        let or_dash = |s: String| if s.is_empty() { "—".to_owned() } else { s };
        out.push_str(&format!(
            "| <a id=\"{}\"></a>**{}** | {} | {} | {} | {} |\n",
            anchor(&r.term),
            inline(&r.term),
            or_dash(inline(&r.definition)),
            or_dash(inline(&r.aliases.join(", "))),
            or_dash(apart.join(", ")),
            or_dash(
                r.source
                    .as_deref()
                    .map(|s| format!("`{}`", inline(s)))
                    .unwrap_or_default()
            ),
        ));
    }
    out
}

/// `to` as a link from the document at `from`, both from the repository's root.
pub fn relative(from: &str, to: &str) -> String {
    let mut from_dir: Vec<&str> = from.split('/').collect();
    from_dir.pop();
    let to_parts: Vec<&str> = to.split('/').collect();
    let common = from_dir
        .iter()
        .zip(&to_parts)
        .take_while(|(a, b)| a == b)
        .count();
    let mut out: Vec<&str> = vec![".."; from_dir.len() - common];
    out.extend(&to_parts[common..]);
    out.join("/")
}

/// The document that kept the glossary as a section, the section's table
/// replaced by a link to the glossary: the heading stays, so links to it
/// still land.
pub fn replace_section(text: &str, found: &Found) -> String {
    let link = relative(&found.path, GLOSSARY_DOC_PATH);
    let mut out: Vec<String> = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let n = i + 1;
        if n == found.line_start {
            out.push(line.to_owned());
            out.push(String::new());
            out.push(format!(
                "The project's terms are kept in [the glossary]({link}): one row per term, with what it \
                 means and the other names it goes by. Link a term there where a document first uses it."
            ));
            out.push(String::new());
        } else if n > found.line_start && n <= found.line_end {
            continue;
        } else {
            out.push(line.to_owned());
        }
    }
    let mut s = out.join("\n");
    if text.ends_with('\n') {
        s.push('\n');
    }
    s
}

#[cfg(test)]
#[path = "glossary_doc_tests.rs"]
mod tests;
