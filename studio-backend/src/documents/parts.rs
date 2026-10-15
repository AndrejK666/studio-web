//! An application's own parts beyond its gears: configuration, storage and
//! deployment (`docs/design/studio-documents.md`, "Application parts";
//! issue #786).
//!
//! Found in the project's repositories by what the files are — a Helm chart,
//! a Dockerfile, a compose file, Kubernetes or Terraform directories, config
//! files, migrations and schemas — so nobody has to list them. What a person
//! knows and a file does not (who owns a part, the document that describes
//! it, its boundary, what it relates to) is kept beside it as the project's
//! record, keyed by the part's kind and reference.

use std::collections::BTreeMap;

/// `configuration`, `storage`, `deployment`.
pub const KINDS: [&str; 3] = ["configuration", "storage", "deployment"];

/// Directories never searched.
const SKIP: [&str; 7] = [
    "node_modules",
    "target",
    "vendor",
    "dist",
    "build",
    ".git",
    "testdata",
];

/// One part found in a repository.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Part {
    pub kind: &'static str,
    /// A directory or a file, repo-relative.
    pub reference: String,
    pub name: String,
    /// What it was recognised by.
    pub evidence: String,
}

fn dir_of(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(d, _)| d)
}

fn file_of(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// In a directory never searched, or a hidden one other than `.github`. A
/// hidden *file* (`.env.example`) is still read.
fn skipped(path: &str) -> bool {
    dir_of(path).split('/').any(|seg| {
        SKIP.contains(&seg) || (seg.starts_with('.') && seg != ".github" && seg.len() > 1)
    })
}

fn name_of(reference: &str, repo: &str) -> String {
    if reference.is_empty() {
        repo.rsplit('/').next().unwrap_or(repo).to_string()
    } else {
        file_of(reference).to_string()
    }
}

/// Every part a repository's file list shows, by kind then reference.
pub fn detect(repo: &str, paths: &[String]) -> Vec<Part> {
    let mut found: BTreeMap<(&'static str, String), String> = BTreeMap::new();
    let mut add = |kind: &'static str, reference: &str, evidence: String| {
        found
            .entry((kind, reference.to_string()))
            .or_insert(evidence);
    };
    for p in paths.iter().filter(|p| !skipped(p)) {
        let file = file_of(p);
        let lower = file.to_ascii_lowercase();
        let dir = dir_of(p);
        let dir_lower = dir.to_ascii_lowercase();
        let in_dir = |names: &[&str]| dir_lower.split('/').any(|d| names.contains(&d));
        // Deployment.
        if file == "Chart.yaml" {
            add("deployment", dir, "Helm chart".into());
        } else if lower == "kustomization.yaml" || lower == "kustomization.yml" {
            add("deployment", dir, "Kustomize".into());
        } else if lower.starts_with("dockerfile") {
            add("deployment", p, "Dockerfile".into());
        } else if lower.starts_with("docker-compose")
            || lower == "compose.yaml"
            || lower == "compose.yml"
        {
            add("deployment", p, "Compose file".into());
        } else if lower.ends_with(".tf") {
            add("deployment", dir, "Terraform".into());
        } else if dir_lower == ".github/workflows"
            && (lower.contains("deploy") || lower.contains("release"))
        {
            add("deployment", p, "deployment workflow".into());
        } else if (lower.ends_with(".yaml") || lower.ends_with(".yml"))
            && in_dir(&["k8s", "kubernetes", "manifests", "deploy", "deployment"])
            && !in_dir(&["templates"])
        {
            add("deployment", dir, "Kubernetes manifests".into());
        }
        // Configuration.
        if lower.starts_with("values") && (lower.ends_with(".yaml") || lower.ends_with(".yml")) {
            add("configuration", p, "Helm values".into());
        } else if lower == ".env.example" || lower == "env.example" {
            add("configuration", p, "environment template".into());
        } else if (lower.starts_with("config")
            || lower.starts_with("settings")
            || lower.starts_with("application"))
            && [".yaml", ".yml", ".toml", ".json", ".properties", ".ini"]
                .iter()
                .any(|e| lower.ends_with(e))
        {
            add("configuration", p, "configuration file".into());
        } else if in_dir(&["config", "configs", "settings"])
            && [".yaml", ".yml", ".toml", ".json"]
                .iter()
                .any(|e| lower.ends_with(e))
        {
            add("configuration", dir, "configuration directory".into());
        }
        // Storage.
        if in_dir(&["migrations", "migration", "alembic", "flyway", "liquibase"]) {
            let root = dir
                .split('/')
                .scan(String::new(), |acc, seg| {
                    if !acc.is_empty() {
                        acc.push('/');
                    }
                    acc.push_str(seg);
                    Some((acc.clone(), seg.to_ascii_lowercase()))
                })
                .find(|(_, seg)| {
                    ["migrations", "migration", "alembic", "flyway", "liquibase"]
                        .contains(&seg.as_str())
                })
                .map(|(path, _)| path)
                .unwrap_or_else(|| dir.to_string());
            add("storage", &root, "schema migrations".into());
        } else if lower == "schema.sql" || lower.ends_with(".prisma") || lower == "schema.graphql" {
            add("storage", p, "schema".into());
        }
    }
    found
        .into_iter()
        .map(|((kind, reference), evidence)| Part {
            kind,
            name: name_of(&reference, repo),
            reference,
            evidence,
        })
        .collect()
}

#[cfg(test)]
#[path = "parts_tests.rs"]
mod tests;
