//! What an environment, a binding and a deployment are, and the rules about
//! them that need no I/O (ADR-0043). Everything here is tested without a
//! server; the service applies it over account-management and the cluster.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// The namespace pattern an environment gets unless it says otherwise: one
/// namespace per project and environment (ADR-0043 §1).
pub const DEFAULT_NAMESPACE_PATTERN: &str = "{project}-{environment}";

/// How many deployments an organization's history keeps. The latest one per
/// project and environment is always kept on top of these, so "what runs
/// where" never loses its answer to a busy week.
pub const HISTORY: usize = 200;

/// How large a chart a deploy request may carry. A generated chart is a few
/// kilobytes; this is the limit of a mistake, not of a product.
pub const MAX_CHART_BYTES: usize = 512 * 1024;

/// How an environment gives a product's `db` gears a database.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseMode {
    /// The product brings its own, or has none.
    #[default]
    None,
    /// A Postgres server of the environment, one database per gear. Recorded
    /// now; handed to the chart once the engine's chart asks for it
    /// (ADR-0043, phase 4).
    Shared,
}

/// One place an organization's products run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Environment {
    pub id: Uuid,
    /// `dev`, `stage`, `prod`: what people choose and see. A DNS label, since
    /// it goes into namespaces.
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// The cluster: a connection of the `kubernetes` kind the organization
    /// holds.
    pub connection_id: Uuid,
    /// The prefix images are pushed to and the chart pulls from
    /// (`ghcr.io/acme`). Empty: the images are used as generated.
    #[serde(default)]
    pub registry: String,
    #[serde(default = "default_pattern")]
    pub namespace_pattern: String,
    #[serde(default)]
    pub database: DatabaseMode,
    /// A deploy waits for an organization administrator's approval.
    #[serde(default)]
    pub protected: bool,
    /// The projects that may deploy here; `None` is all of them.
    #[serde(default)]
    pub projects: Option<Vec<Uuid>>,
    pub updated_by: String,
    pub updated_at: String,
}

fn default_pattern() -> String {
    DEFAULT_NAMESPACE_PATTERN.to_owned()
}

/// The organization's environments: one metadata row on the organization.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvironmentList {
    #[serde(default)]
    pub items: Vec<Environment>,
}

/// What a person may set on an environment.
#[derive(Debug, Clone)]
pub struct EnvironmentInput {
    pub name: String,
    pub description: String,
    pub connection_id: Uuid,
    pub registry: String,
    pub namespace_pattern: Option<String>,
    pub database: DatabaseMode,
    pub protected: bool,
    pub projects: Option<Vec<Uuid>>,
}

/// A refusal of an environment as written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invalid {
    pub field: &'static str,
    pub reason: String,
}

impl std::fmt::Display for Invalid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.field, self.reason)
    }
}

fn invalid(field: &'static str, reason: impl Into<String>) -> Invalid {
    Invalid {
        field,
        reason: reason.into(),
    }
}

/// Is `s` a DNS-1123 label: lowercase letters, digits and `-`, starting and
/// ending with an alphanumeric, at most 63 characters? What Kubernetes asks
/// of a namespace, and so of everything that goes into one.
pub fn is_dns_label(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 63
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !s.starts_with('-')
        && !s.ends_with('-')
}

/// A name made fit for a namespace: lowercased, every run of other characters
/// one `-`, trimmed of `-`. `Studio Web 2` → `studio-web-2`.
pub fn slug(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_owned()
}

/// The namespace `pattern` gives `project` in `environment`. Refused when the
/// result is not a namespace, which says the pattern or the names need
/// changing -- never truncated into a namespace somebody else might have.
pub fn namespace_for(pattern: &str, project: &str, environment: &str) -> Result<String, Invalid> {
    let ns = pattern
        .replace("{project}", &slug(project))
        .replace("{environment}", &slug(environment));
    if is_dns_label(&ns) {
        Ok(ns)
    } else {
        Err(invalid(
            "namespace_pattern",
            format!(
                "'{pattern}' gives '{ns}' for project '{project}', which is not a Kubernetes \
                 namespace (lowercase letters, digits and '-', at most 63)"
            ),
        ))
    }
}

/// An image registry prefix: `host[:port]/path`, no scheme, no tag.
fn check_registry(registry: &str) -> Result<(), Invalid> {
    if registry.is_empty() {
        return Ok(());
    }
    if registry.contains("://") {
        return Err(invalid(
            "registry",
            "write the registry without a scheme, e.g. ghcr.io/acme",
        ));
    }
    let ok = registry
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b'/' | b':'));
    if !ok || registry.starts_with('/') || registry.contains("//") {
        return Err(invalid(
            "registry",
            format!("'{registry}' is not an image registry prefix, e.g. ghcr.io/acme"),
        ));
    }
    Ok(())
}

/// The environment `input` describes, checked against the others in `list`
/// (`id` is the one being edited, if any).
pub fn checked(
    list: &EnvironmentList,
    id: Option<Uuid>,
    input: EnvironmentInput,
    by: String,
    at: String,
) -> Result<Environment, Invalid> {
    let name = input.name.trim().to_owned();
    if !is_dns_label(&name) {
        return Err(invalid(
            "name",
            "an environment name is lowercase letters, digits and '-' (dev, stage, prod)",
        ));
    }
    if list
        .items
        .iter()
        .any(|e| e.name == name && Some(e.id) != id)
    {
        return Err(invalid(
            "name",
            format!("the organization already has an environment '{name}'"),
        ));
    }
    let pattern = input
        .namespace_pattern
        .map(|p| p.trim().to_owned())
        .filter(|p| !p.is_empty())
        .unwrap_or_else(default_pattern);
    // A pattern without the project would put every project into one
    // namespace, where one product's release overwrites another's.
    if !pattern.contains("{project}") {
        return Err(invalid(
            "namespace_pattern",
            "the pattern must contain {project}: each project gets its own namespace",
        ));
    }
    namespace_for(&pattern, "a-project", &name)?;
    let registry = input.registry.trim().trim_end_matches('/').to_owned();
    check_registry(&registry)?;
    Ok(Environment {
        id: id.unwrap_or_else(Uuid::new_v4),
        name,
        description: input.description.trim().to_owned(),
        connection_id: input.connection_id,
        registry,
        namespace_pattern: pattern,
        database: input.database,
        protected: input.protected,
        projects: input.projects.map(|mut p| {
            p.sort();
            p.dedup();
            p
        }),
        updated_by: by,
        updated_at: at,
    })
}

impl Environment {
    /// May `project` deploy here?
    pub fn admits(&self, project: Uuid) -> bool {
        self.projects.as_ref().is_none_or(|p| p.contains(&project))
    }

    /// An image as this environment's registry holds it.
    pub fn image(&self, image: &str) -> String {
        if self.registry.is_empty() {
            image.to_owned()
        } else {
            format!("{}/{image}", self.registry)
        }
    }
}

/// One of a project's product profiles bound to an environment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Binding {
    /// The `kubernetes` profile's id in `product.gdl` (`prod`).
    pub profile: String,
    pub environment_id: Uuid,
}

/// A project's bindings: one metadata row on the project.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BindingList {
    #[serde(default)]
    pub items: Vec<Binding>,
}

/// Bindings as written: each profile once, each a profile id.
pub fn checked_bindings(items: Vec<Binding>) -> Result<BindingList, Invalid> {
    let mut seen = std::collections::BTreeSet::new();
    for b in &items {
        let ok = !b.profile.is_empty()
            && b.profile.len() <= 63
            && b.profile
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_');
        if !ok {
            return Err(invalid(
                "profile",
                format!("'{}' is not a profile id", b.profile),
            ));
        }
        if !seen.insert(b.profile.clone()) {
            return Err(invalid(
                "profile",
                format!("profile '{}' is bound twice", b.profile),
            ));
        }
    }
    Ok(BindingList { items })
}

/// Where a deployment has got to. `Queued`, `Running`, `Succeeded` and
/// `Failed` come from its run (ADR-0038); the first two states are this
/// gear's own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeploymentState {
    AwaitingApproval,
    Declined,
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

impl DeploymentState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AwaitingApproval => "awaiting_approval",
            Self::Declined => "declined",
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

/// One image of the product, as Generate built it (`repository:tag`, no
/// registry) and the application whose chart values name it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeployImage {
    pub app: String,
    pub image: String,
}

/// One deploy: asked for, decided, run. The record of "what runs where"
/// (ADR-0043 §4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Deployment {
    pub id: Uuid,
    pub project_id: Uuid,
    #[serde(default)]
    pub project_name: String,
    pub environment_id: Uuid,
    #[serde(default)]
    pub environment_name: String,
    pub profile: String,
    /// The product id, which is the Helm release.
    pub product: String,
    #[serde(default)]
    pub commit: Option<String>,
    #[serde(default)]
    pub lock_hash: Option<String>,
    /// The images as Generate built them; the environment's registry is put
    /// in front of them when the chart is installed.
    #[serde(default)]
    pub images: Vec<DeployImage>,
    pub namespace: String,
    /// The chart's sha256, so a record says which chart it installed.
    pub chart_sha256: String,
    pub state: DeploymentState,
    #[serde(default)]
    pub run_id: Option<Uuid>,
    pub requested_by: String,
    #[serde(default)]
    pub requested_by_name: String,
    pub requested_at: String,
    #[serde(default)]
    pub decided_by: Option<String>,
    #[serde(default)]
    pub decided_by_name: Option<String>,
    #[serde(default)]
    pub decided_at: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    /// What the run said: its summary, or why it failed.
    #[serde(default)]
    pub outcome: Option<String>,
    /// The chart, base64, kept only while the deploy waits for approval; the
    /// run carries it from then on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_chart: Option<String>,
}

/// The organization's deployments: one metadata row on the organization,
/// newest first.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeploymentList {
    #[serde(default)]
    pub items: Vec<Deployment>,
}

impl DeploymentList {
    /// Put `d` first and trim the history to [`HISTORY`], keeping the latest
    /// deployment of every project and environment, and every one still
    /// waiting for a decision.
    pub fn record(&mut self, d: Deployment) {
        self.items.retain(|x| x.id != d.id);
        self.items.insert(0, d);
        let mut latest = std::collections::BTreeSet::new();
        let mut kept = 0usize;
        self.items.retain(|x| {
            let first = latest.insert((x.project_id, x.environment_id));
            let keep = first || x.state == DeploymentState::AwaitingApproval || kept < HISTORY;
            if keep {
                kept += 1;
            }
            keep
        });
    }
}

/// The values that point a chart's applications at the environment's images:
/// `{<app>: {image: {repository, tag}}}`, the keys Generate's charts read.
pub fn image_values(env: &Environment, images: &[DeployImage]) -> serde_json::Value {
    let mut values = serde_json::Map::new();
    for i in images {
        let (repository, tag) = split_image(&env.image(&i.image));
        let mut image = serde_json::Map::new();
        image.insert("repository".into(), repository.into());
        if let Some(tag) = tag {
            image.insert("tag".into(), tag.into());
        }
        values.insert(i.app.clone(), serde_json::json!({ "image": image }));
    }
    serde_json::Value::Object(values)
}

/// `repository:tag` split at the tag's colon, not at a registry's port.
pub fn split_image(image: &str) -> (String, Option<String>) {
    match image.rfind(':') {
        Some(at) if !image[at..].contains('/') => {
            (image[..at].to_owned(), Some(image[at + 1..].to_owned()))
        }
        _ => (image.to_owned(), None),
    }
}

/// An application name and an image as a deploy request may carry them.
pub fn check_images(images: &[DeployImage]) -> Result<(), Invalid> {
    for i in images {
        let app_ok = !i.app.is_empty()
            && i.app
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
        if !app_ok {
            return Err(invalid(
                "images",
                format!("'{}' is not an application", i.app),
            ));
        }
        let image_ok = !i.image.is_empty()
            && !i.image.contains("://")
            && i.image.bytes().all(|b| {
                b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b'/' | b':' | b'@')
            });
        if !image_ok {
            return Err(invalid("images", format!("'{}' is not an image", i.image)));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(name: &str) -> EnvironmentInput {
        EnvironmentInput {
            name: name.into(),
            description: String::new(),
            connection_id: Uuid::from_u128(7),
            registry: "ghcr.io/acme/".into(),
            namespace_pattern: None,
            database: DatabaseMode::None,
            protected: false,
            projects: None,
        }
    }

    fn env(name: &str) -> Environment {
        checked(
            &EnvironmentList::default(),
            None,
            input(name),
            String::new(),
            "t".into(),
        )
        .unwrap()
    }

    #[test]
    fn an_environment_gets_the_default_pattern_and_a_trimmed_registry() {
        let e = env("prod");
        assert_eq!(e.namespace_pattern, DEFAULT_NAMESPACE_PATTERN);
        assert_eq!(e.registry, "ghcr.io/acme");
    }

    #[test]
    fn two_environments_may_not_share_a_name_but_an_edit_keeps_its_own() {
        let list = EnvironmentList {
            items: vec![env("prod")],
        };
        let id = list.items[0].id;
        assert_eq!(
            checked(&list, None, input("prod"), String::new(), "t".into())
                .unwrap_err()
                .field,
            "name"
        );
        assert!(checked(&list, Some(id), input("prod"), String::new(), "t".into()).is_ok());
    }

    #[test]
    fn a_name_or_pattern_that_cannot_make_a_namespace_is_refused() {
        let list = EnvironmentList::default();
        assert!(checked(&list, None, input("Prod"), String::new(), "t".into()).is_err());
        let mut shared = input("prod");
        shared.namespace_pattern = Some("{environment}".into());
        assert_eq!(
            checked(&list, None, shared, String::new(), "t".into())
                .unwrap_err()
                .field,
            "namespace_pattern"
        );
        let mut scheme = input("prod");
        scheme.registry = "https://ghcr.io/acme".into();
        assert_eq!(
            checked(&list, None, scheme, String::new(), "t".into())
                .unwrap_err()
                .field,
            "registry"
        );
    }

    #[test]
    fn a_namespace_is_made_of_the_project_and_environment_names() {
        assert_eq!(
            namespace_for(DEFAULT_NAMESPACE_PATTERN, "Studio Web", "prod").unwrap(),
            "studio-web-prod"
        );
        assert!(namespace_for(DEFAULT_NAMESPACE_PATTERN, &"x".repeat(70), "prod").is_err());
    }

    #[test]
    fn an_environment_admits_the_projects_it_lists_or_all() {
        let mut e = env("prod");
        assert!(e.admits(Uuid::from_u128(1)));
        e.projects = Some(vec![Uuid::from_u128(2)]);
        assert!(!e.admits(Uuid::from_u128(1)));
        assert!(e.admits(Uuid::from_u128(2)));
    }

    #[test]
    fn image_values_point_each_application_at_the_registry() {
        let e = env("prod");
        let v = image_values(
            &e,
            &[DeployImage {
                app: "api".into(),
                image: "studio/api:0.1.0".into(),
            }],
        );
        assert_eq!(v["api"]["image"]["repository"], "ghcr.io/acme/studio/api");
        assert_eq!(v["api"]["image"]["tag"], "0.1.0");
        assert_eq!(
            split_image("localhost:5000/api"),
            ("localhost:5000/api".into(), None)
        );
    }

    #[test]
    fn a_profile_is_bound_once() {
        let b = |p: &str| Binding {
            profile: p.into(),
            environment_id: Uuid::nil(),
        };
        assert!(checked_bindings(vec![b("prod"), b("stage")]).is_ok());
        assert!(checked_bindings(vec![b("prod"), b("prod")]).is_err());
        assert!(checked_bindings(vec![b("pr od")]).is_err());
    }

    fn deployment(n: u128, project: u128, state: DeploymentState) -> Deployment {
        Deployment {
            id: Uuid::from_u128(n),
            project_id: Uuid::from_u128(project),
            project_name: String::new(),
            environment_id: Uuid::from_u128(9),
            environment_name: String::new(),
            profile: "prod".into(),
            product: "p".into(),
            commit: None,
            lock_hash: None,
            images: vec![],
            namespace: "p-prod".into(),
            chart_sha256: String::new(),
            state,
            run_id: None,
            requested_by: String::new(),
            requested_by_name: String::new(),
            requested_at: String::new(),
            decided_by: None,
            decided_by_name: None,
            decided_at: None,
            reason: None,
            outcome: None,
            pending_chart: None,
        }
    }

    #[test]
    fn the_history_keeps_the_latest_per_place_and_everything_waiting() {
        let mut list = DeploymentList::default();
        list.record(deployment(1, 1, DeploymentState::Succeeded));
        list.record(deployment(2, 2, DeploymentState::AwaitingApproval));
        for n in 0..(HISTORY as u128 + 10) {
            list.record(deployment(100 + n, 3, DeploymentState::Succeeded));
        }
        assert_eq!(list.items[0].id, Uuid::from_u128(100 + HISTORY as u128 + 9));
        assert!(list.items.iter().any(|d| d.id == Uuid::from_u128(1)));
        assert!(list.items.iter().any(|d| d.id == Uuid::from_u128(2)));
        assert!(list.items.len() <= HISTORY + 2);
    }

    #[test]
    fn recording_again_replaces_rather_than_duplicates() {
        let mut list = DeploymentList::default();
        list.record(deployment(1, 1, DeploymentState::AwaitingApproval));
        list.record(deployment(1, 1, DeploymentState::Queued));
        assert_eq!(list.items.len(), 1);
        assert_eq!(list.items[0].state, DeploymentState::Queued);
    }

    #[test]
    fn images_from_a_request_are_checked() {
        let ok = DeployImage {
            app: "api".into(),
            image: "acme/api:1".into(),
        };
        assert!(check_images(&[ok]).is_ok());
        let bad = DeployImage {
            app: "api".into(),
            image: "acme/api:1 --set x".into(),
        };
        assert!(check_images(&[bad]).is_err());
    }
}
