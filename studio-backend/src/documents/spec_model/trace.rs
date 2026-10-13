//! Where each requirement is cited: the documents that refer to it, the code
//! that names it, the tests that name it (`docs/spec-domain-model.md`,
//! "From requirement to code and test"; issue #738).
//!
//! Mechanical, as the work links are: a file cites a requirement when it
//! names the identifier as a whole token. No model guesses which code
//! implements what. A test is told from code by its path, the conventions of
//! the common languages; nothing about a project is assumed beyond them.

use super::index::SourceDoc;
use super::requirements::Requirement;
use super::work::names;

/// One place an identifier is named.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cited {
    pub path: String,
    /// The first line that names it, from 1.
    pub line: usize,
}

/// One requirement and every place that names it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Trace {
    pub requirement: Requirement,
    /// Other documents (and other places in its own) that refer to it.
    pub documents: Vec<Cited>,
    /// Code that names it, tests left out.
    pub code: Vec<Cited>,
    pub tests: Vec<Cited>,
}

/// The most places of one kind kept per requirement.
const PER_KIND: usize = 20;

/// Whether a path is a test by the conventions of the common languages.
pub fn is_test_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let name = lower.rsplit('/').next().unwrap_or(&lower);
    let in_test_dir = lower.split('/').any(|d| {
        matches!(
            d,
            "test" | "tests" | "__tests__" | "spec" | "e2e" | "testdata"
        )
    });
    in_test_dir
        || name.ends_with("_test.rs")
        || name.ends_with("_tests.rs")
        || name.ends_with("_test.go")
        || name.ends_with("_test.py")
        || name.starts_with("test_")
        || [".test.", ".spec."].iter().any(|m| name.contains(m))
        || name.ends_with("test.java")
        || name.ends_with("tests.cs")
}

/// Whether a path is something a requirement can be implemented in: source
/// code and configuration, not prose or data dumps.
fn is_code_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    const CODE: [&str; 22] = [
        ".rs", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".go", ".py", ".java", ".kt", ".cs", ".rb",
        ".php", ".swift", ".scala", ".c", ".cc", ".cpp", ".h", ".sql", ".proto", ".gdl",
    ];
    CODE.iter().any(|ext| lower.ends_with(ext))
}

fn first_line_naming(text: &str, id: &str) -> Option<usize> {
    let lower_id = id.to_ascii_lowercase();
    text.lines()
        .enumerate()
        .find(|(_, line)| {
            let l = line.to_ascii_lowercase();
            l.contains(&lower_id) && names(&l, &lower_id)
        })
        .map(|(i, _)| i + 1)
}

/// Every requirement with the places that name it, in the requirements' order.
pub fn trace(
    requirements: &[Requirement],
    docs: &[SourceDoc<'_>],
    files: &[(String, String)],
) -> Vec<Trace> {
    requirements
        .iter()
        .map(|r| {
            let mut documents: Vec<Cited> = docs
                .iter()
                .filter_map(|d| {
                    // Its own definition is not a reference to it: look past it.
                    let text: String = if d.path == r.path {
                        d.text
                            .lines()
                            .enumerate()
                            .filter(|(i, _)| i + 1 != r.line)
                            .map(|(_, l)| l)
                            .collect::<Vec<_>>()
                            .join("\n")
                    } else {
                        d.text.to_string()
                    };
                    first_line_naming(&text, &r.id).map(|line| Cited {
                        path: d.path.to_string(),
                        line: if d.path == r.path && line >= r.line {
                            line + 1
                        } else {
                            line
                        },
                    })
                })
                .collect();
            documents.truncate(PER_KIND);
            let (mut tests, mut code): (Vec<Cited>, Vec<Cited>) = files
                .iter()
                .filter(|(path, _)| is_code_path(path) || is_test_path(path))
                .filter_map(|(path, text)| {
                    first_line_naming(text, &r.id).map(|line| Cited {
                        path: path.clone(),
                        line,
                    })
                })
                .partition(|c| is_test_path(&c.path));
            code.truncate(PER_KIND);
            tests.truncate(PER_KIND);
            Trace {
                requirement: r.clone(),
                documents,
                code,
                tests,
            }
        })
        .collect()
}

#[cfg(test)]
#[path = "trace_tests.rs"]
mod tests;
