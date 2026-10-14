//! Components that are not gears: the services and applications a project's
//! repositories hold, and whether each is ready to be taken
//! (`docs/design/studio-components-catalog.md`, "Beyond gears"; issue #739).
//!
//! Interview problems 4.2, 4.4, 4.5: a company with 764 components trusts no
//! hand-kept catalogue; a consumer cannot tell whether a component is ready
//! without asking its author; owner and quality data typed in by hand go
//! stale. The registry finds gears and code that looks like one. This finds
//! the rest from what any build tool already declares — a `go.mod`, a
//! `pyproject.toml`, a `pom.xml`, a `package.json`, a `Dockerfile`, a Helm
//! `Chart.yaml` — and says how ready each is from facts: who changed it, how
//! recently, what is still open against it, whether it has tests and a
//! contract. Nothing is typed in by a person.

use std::collections::{BTreeMap, BTreeSet};

/// Manifests that make a directory a component, and the kind they say.
const MANIFESTS: [(&str, &str); 11] = [
    ("go.mod", "go"),
    ("pyproject.toml", "python"),
    ("setup.py", "python"),
    ("pom.xml", "java"),
    ("build.gradle", "java"),
    ("build.gradle.kts", "kotlin"),
    ("package.json", "node"),
    ("Cargo.toml", "rust"),
    ("Chart.yaml", "helm"),
    ("Dockerfile", "container"),
    ("*.csproj", "dotnet"),
];

/// Directories never searched.
const SKIP: [&str; 9] = [
    "node_modules",
    "target",
    "vendor",
    "dist",
    "build",
    ".git",
    "testdata",
    "fixtures",
    "examples",
];

/// At most this many components per repository, shallowest first.
pub const MAX_PER_REPO: usize = 40;

/// One component found in a repository.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Found {
    /// Repo-relative directory; empty for the root.
    pub dir: String,
    /// The name: the directory's last segment, or the repository's for the root.
    pub name: String,
    /// `go`, `python`, `node`, … the first manifest that declared it.
    pub kind: String,
    pub manifests: Vec<String>,
    /// Contract files under it: OpenAPI, AsyncAPI, protobuf.
    pub contracts: Vec<String>,
    pub has_tests: bool,
    pub has_readme: bool,
}

fn dir_of(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(d, _)| d)
}

fn file_of(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn skipped(path: &str) -> bool {
    path.split('/')
        .any(|seg| SKIP.contains(&seg) || (seg.starts_with('.') && seg.len() > 1))
}

fn manifest_kind(file: &str) -> Option<&'static str> {
    MANIFESTS.iter().find_map(|(m, kind)| {
        let hit = match m.strip_prefix('*') {
            Some(ext) => file.ends_with(ext),
            None => file == *m,
        };
        hit.then_some(*kind)
    })
}

fn is_contract(file: &str) -> bool {
    let f = file.to_ascii_lowercase();
    f.ends_with(".proto")
        || ((f.starts_with("openapi") || f.starts_with("swagger") || f.starts_with("asyncapi"))
            && (f.ends_with(".yaml") || f.ends_with(".yml") || f.ends_with(".json")))
}

fn is_test(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let name = file_of(&lower);
    lower
        .split('/')
        .any(|d| matches!(d, "test" | "tests" | "__tests__" | "spec" | "e2e"))
        || name.ends_with("_test.go")
        || name.ends_with("_test.py")
        || name.starts_with("test_")
        || name.contains(".test.")
        || name.contains(".spec.")
        || name.ends_with("test.java")
}

/// Every component a repository's file list declares, not counting `gears`
/// (directories that hold a gear: those are the registry's).
pub fn detect(repo: &str, paths: &[String], gear_dirs: &BTreeSet<String>) -> Vec<Found> {
    let under_gear = |dir: &str| {
        gear_dirs
            .iter()
            .any(|g| dir == g || dir.starts_with(&format!("{g}/")) || g.is_empty())
    };
    let mut by_dir: BTreeMap<String, Vec<(String, &'static str)>> = BTreeMap::new();
    for p in paths.iter().filter(|p| !skipped(p)) {
        if let Some(kind) = manifest_kind(file_of(p)) {
            let dir = dir_of(p).to_string();
            if !under_gear(&dir) {
                by_dir
                    .entry(dir)
                    .or_default()
                    .push((file_of(p).to_string(), kind));
            }
        }
    }
    // A Dockerfile or a chart next to a language manifest describes the same
    // component; a nested package of a monorepo root is its own component.
    let mut found: Vec<Found> = by_dir
        .into_iter()
        .map(|(dir, manifests)| {
            let kind = manifests
                .iter()
                .find(|(_, k)| !matches!(*k, "container" | "helm"))
                .or(manifests.first())
                .map(|(_, k)| (*k).to_string())
                .unwrap_or_default();
            let prefix = if dir.is_empty() {
                String::new()
            } else {
                format!("{dir}/")
            };
            let inside: Vec<&String> = paths
                .iter()
                .filter(|p| p.starts_with(&prefix) && !skipped(p))
                .collect();
            let name = if dir.is_empty() {
                repo.rsplit('/').next().unwrap_or(repo).to_string()
            } else {
                file_of(&dir).to_string()
            };
            Found {
                name,
                kind,
                manifests: manifests.into_iter().map(|(m, _)| m).collect(),
                contracts: inside
                    .iter()
                    .filter(|p| is_contract(file_of(p)))
                    .map(|p| (*p).clone())
                    .collect(),
                has_tests: inside.iter().any(|p| is_test(p)),
                has_readme: inside.iter().any(|p| {
                    dir_of(p) == dir && file_of(p).to_ascii_lowercase().starts_with("readme")
                }),
                dir,
            }
        })
        .collect();
    found.sort_by_key(|f| {
        (
            f.dir.matches('/').count() + usize::from(!f.dir.is_empty()),
            f.dir.clone(),
        )
    });
    found.truncate(MAX_PER_REPO);
    found
}

/// The facts readiness is judged from.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Facts {
    /// Days since the last commit under it; `None` when unknown.
    pub days_since_change: Option<i64>,
    /// People with commits under it in the history read.
    pub authors: usize,
    /// Open pull requests that change it.
    pub open_pulls: usize,
    pub has_tests: bool,
    pub has_readme: bool,
    pub has_contract: bool,
}

/// `ready`, `caution` or `not_ready`, with every reason a person can check.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Readiness {
    pub signal: &'static str,
    pub reasons: Vec<String>,
}

/// More open pull requests than this and "can I take it now?" is "ask first".
pub const BUSY_PULLS: usize = 3;
/// Untouched for longer than this, and nobody may be left who knows it.
pub const STALE_DAYS: i64 = 365;

/// Whether a component is ready to be taken, from its facts.
pub fn readiness(f: &Facts) -> Readiness {
    let mut blockers = Vec::new();
    let mut cautions = Vec::new();
    let mut good = Vec::new();
    if f.has_tests {
        good.push("has tests".to_string());
    } else {
        blockers.push("no tests".to_string());
    }
    if f.has_contract {
        good.push("publishes a contract".to_string());
    } else {
        cautions.push("no contract file (OpenAPI, AsyncAPI, protobuf)".to_string());
    }
    if !f.has_readme {
        cautions.push("no README".to_string());
    }
    match f.authors {
        0 => cautions.push("nobody known to have changed it".to_string()),
        1 => cautions.push("one person has changed it".to_string()),
        n => good.push(format!("{n} people have changed it")),
    }
    if f.open_pulls > BUSY_PULLS {
        cautions.push(format!("{} open pull requests change it", f.open_pulls));
    }
    match f.days_since_change {
        Some(d) if d > STALE_DAYS => cautions.push(format!("unchanged for {d} days")),
        Some(d) => good.push(format!("changed {d} days ago")),
        None => {}
    }
    let signal = if !blockers.is_empty() {
        "not_ready"
    } else if !cautions.is_empty() {
        "caution"
    } else {
        "ready"
    };
    let mut reasons = blockers;
    reasons.extend(cautions);
    reasons.extend(good);
    Readiness { signal, reasons }
}

#[cfg(test)]
#[path = "services_tests.rs"]
mod tests;
