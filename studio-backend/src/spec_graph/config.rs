use std::sync::OnceLock;

use serde::Deserialize;
use uuid::Uuid;

/// `gears.studio-spec-graph.config`: where the spec-graph service is and how to
/// reach it. Every value has an environment override, the literal-or-env
/// convention of `studio-spec-quality` and `studio-insight`, so wiring a
/// deployment is a restart:
///
///   STUDIO_SPEC_GRAPH_URL      the service, e.g. `http://spec-graph:8099`
///   STUDIO_SPEC_GRAPH_SECRET   its API key (`nsq_…`, scopes read and run)
///   STUDIO_SPEC_GRAPH_SUBJECT  the subject of the service's own client
///                              (`spec-graph`, client credentials), for the
///                              PDP rule that lets it work in projects' graphs
///   STUDIO_SPEC_GRAPH_GIT_URL  how the service reaches this backend's gateway,
///                              with its prefix (`http://studio-backend:8090/cf`):
///                              it clones a project's sources through the Git
///                              proxy there
///
/// Unconfigured is a valid state: the gear loads, and every call answers 503
/// naming what to set.
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct SpecGraphConfig {
    pub base_url: String,
    pub base_url_env: String,
    pub secret: String,
    pub secret_env: String,
    pub git_url: String,
    pub git_url_env: String,
    pub service_subject: String,
    pub service_subject_env: String,
}

impl Default for SpecGraphConfig {
    fn default() -> Self {
        Self {
            base_url: String::new(),
            base_url_env: "STUDIO_SPEC_GRAPH_URL".into(),
            secret: String::new(),
            secret_env: "STUDIO_SPEC_GRAPH_SECRET".into(),
            git_url: String::new(),
            git_url_env: "STUDIO_SPEC_GRAPH_GIT_URL".into(),
            service_subject: String::new(),
            service_subject_env: "STUDIO_SPEC_GRAPH_SUBJECT".into(),
        }
    }
}

fn env_non_empty(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

/// The variable when it is set and not blank, the literal otherwise.
fn resolve(literal: &str, env: &str) -> String {
    env_non_empty(env)
        .unwrap_or_else(|| literal.trim().to_owned())
        .trim_end_matches('/')
        .to_owned()
}

impl SpecGraphConfig {
    pub fn resolve_base_url(&self) -> String {
        resolve(&self.base_url, &self.base_url_env)
    }

    /// The literal wins over the variable for the secret, as in
    /// `studio-spec-quality`: a literal is a deliberate choice in a test config.
    pub fn resolve_secret(&self) -> Option<String> {
        let literal = self.secret.trim();
        if !literal.is_empty() {
            return Some(literal.to_owned());
        }
        env_non_empty(&self.secret_env)
    }

    pub fn resolve_git_url(&self) -> String {
        resolve(&self.git_url, &self.git_url_env)
    }

    /// The subject of the service's own client (`spec-graph`, client
    /// credentials): its Keycloak service account's id. `None` when unset;
    /// an error when set to something that is not an id.
    pub fn resolve_service_subject(&self) -> Result<Option<Uuid>, uuid::Error> {
        let value = resolve(&self.service_subject, &self.service_subject_env);
        if value.is_empty() {
            return Ok(None);
        }
        Uuid::parse_str(&value).map(Some)
    }
}

/// graph-storage's PDP resource types (`weftgraph-sdk` `gts::NODE_RESOURCE`,
/// `EDGE_RESOURCE`, `TYPE_RESOURCE`): everything the service calls — ingest,
/// nodes, edges, search, neighborhood, traverse, types and their
/// compatibility — is authorized as one of these.
pub const GRAPH_RESOURCES: [&str; 3] = [
    "gts.cf.core.graph.node.v1~",
    "gts.cf.core.graph.edge.v1~",
    "gts.cf.core.graph.type.v1~",
];

static SERVICE_SUBJECT: OnceLock<Uuid> = OnceLock::new();

/// Set once, by the gear's `init`.
pub(super) fn set_service_subject(subject: Uuid) {
    let _ = SERVICE_SUBJECT.set(subject);
}

/// The service's subject, for the PDP's rule (`studio_authz_plugin::ServiceRule`).
pub fn service_subject() -> Option<Uuid> {
    SERVICE_SUBJECT.get().copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_literal_is_used_when_no_variable_is_set() {
        let c = SpecGraphConfig {
            base_url: "http://svc:8099/".into(),
            base_url_env: "STUDIO_SPEC_GRAPH_TEST_UNSET_URL".into(),
            secret: "nsq_literal".into(),
            git_url: " http://gw/cf/ ".into(),
            git_url_env: "STUDIO_SPEC_GRAPH_TEST_UNSET_GIT".into(),
            ..SpecGraphConfig::default()
        };
        assert_eq!(c.resolve_base_url(), "http://svc:8099");
        assert_eq!(c.resolve_secret().as_deref(), Some("nsq_literal"));
        assert_eq!(c.resolve_git_url(), "http://gw/cf");
    }

    #[test]
    fn unconfigured_is_empty_not_an_error() {
        let c = SpecGraphConfig {
            base_url_env: "STUDIO_SPEC_GRAPH_TEST_UNSET_URL".into(),
            secret_env: "STUDIO_SPEC_GRAPH_TEST_UNSET_SECRET".into(),
            git_url_env: "STUDIO_SPEC_GRAPH_TEST_UNSET_GIT".into(),
            ..SpecGraphConfig::default()
        };
        assert!(c.resolve_base_url().is_empty());
        assert!(c.resolve_secret().is_none());
    }

    /// The rule's resource types are graph-storage's own; a rename there
    /// would otherwise leave the service refused everywhere without a word.
    #[cfg(feature = "graph")]
    #[test]
    fn the_graph_resources_are_graph_storages() {
        use graph_storage_sdk::gts::{EDGE_RESOURCE, NODE_RESOURCE, TYPE_RESOURCE};
        assert_eq!(GRAPH_RESOURCES, [NODE_RESOURCE, EDGE_RESOURCE, TYPE_RESOURCE]);
    }

    #[test]
    fn a_service_subject_is_an_id_or_nothing() {
        let unset = SpecGraphConfig {
            service_subject_env: "STUDIO_SPEC_GRAPH_TEST_UNSET_SUBJECT".into(),
            ..SpecGraphConfig::default()
        };
        assert_eq!(unset.resolve_service_subject().ok(), Some(None));
        let id = SpecGraphConfig {
            service_subject: "00000000-0000-4000-8000-000005ec9a4f".into(),
            ..unset.clone()
        };
        assert!(matches!(id.resolve_service_subject(), Ok(Some(_))));
        let bad = SpecGraphConfig {
            service_subject: "spec-graph".into(),
            ..unset
        };
        assert!(bad.resolve_service_subject().is_err());
    }
}
