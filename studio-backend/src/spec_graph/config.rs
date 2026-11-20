use serde::Deserialize;

/// `gears.studio-spec-graph.config`: where the spec-graph service is and how to
/// reach it. Every value has an environment override, the literal-or-env
/// convention of `studio-spec-quality` and `studio-insight`, so wiring a
/// deployment is a restart:
///
///   STUDIO_SPEC_GRAPH_URL      the service, e.g. `http://spec-graph:8099`
///   STUDIO_SPEC_GRAPH_SECRET   its API key (`nsq_…`, scopes read and run)
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
}
