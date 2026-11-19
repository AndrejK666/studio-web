//! Where the gears-matcher service is, and the secret it takes.
//!
//! The same literal-or-env convention as `studio-insight` and
//! `studio-spec-quality`: the address is named in `config/*.yaml` (or
//! overridden by `base_url_env`), and only the shared secret comes from the
//! environment, so it is never in the repository. Unset, the gear match says
//! so (503 naming what is missing) and nothing else of the product changes.

use serde::Deserialize;

/// `studio-product`'s own `config:` block.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ProductConfig {
    pub gears_matcher: MatcherConfig,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct MatcherConfig {
    /// The service's root, e.g. `http://gears-matcher:8080`. `base_url_env`,
    /// when set and not empty, wins over it.
    pub base_url: String,
    pub base_url_env: String,
    /// The variable holding the shared secret the service takes as a bearer.
    pub secret_env: String,
    /// The most model calls one run may spend on reading documents that are
    /// not in the Constructor Fabric spec format (the matcher's free-form
    /// reading, `options.extract_max_calls`). `None`: such documents are not
    /// read, and a spec made only of them is refused by the matcher.
    pub extract_max_calls: Option<u32>,
    /// A lower per-run call bound than the service's own (`options.max_calls`).
    pub max_calls: Option<u32>,
    /// One HTTP request's timeout. A run itself is polled, not waited on.
    pub request_timeout_secs: u64,
}

impl Default for MatcherConfig {
    fn default() -> Self {
        Self {
            base_url: String::new(),
            base_url_env: "STUDIO_GEARS_MATCHER_URL".into(),
            secret_env: "STUDIO_GEARS_MATCHER_SECRET".into(),
            extract_max_calls: None,
            max_calls: None,
            request_timeout_secs: 60,
        }
    }
}

fn env_non_empty(name: &str) -> Option<String> {
    if name.trim().is_empty() {
        return None;
    }
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

impl MatcherConfig {
    /// The service's root without a trailing slash; empty when unset.
    pub fn resolve_base_url(&self) -> String {
        env_non_empty(&self.base_url_env)
            .unwrap_or_else(|| self.base_url.trim().to_owned())
            .trim_end_matches('/')
            .to_owned()
    }

    pub fn resolve_secret(&self) -> Option<String> {
        env_non_empty(&self.secret_env)
    }

    /// What is missing, in a sentence; `None` when the matcher can be called.
    pub fn missing(&self) -> Option<String> {
        match (self.resolve_base_url().is_empty(), self.resolve_secret()) {
            (true, None) => Some(format!(
                "the gears-matcher service is not configured: set studio-product's \
                 gears_matcher.base_url (or {}) and the shared secret in {}",
                self.base_url_env, self.secret_env
            )),
            (true, Some(_)) => Some(format!(
                "the gears-matcher service has no address: set studio-product's \
                 gears_matcher.base_url (or {})",
                self.base_url_env
            )),
            (false, None) => Some(format!(
                "the gears-matcher service's shared secret is not set ({})",
                self.secret_env
            )),
            (false, Some(_)) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_env::with_var;

    fn config(suffix: &str) -> MatcherConfig {
        MatcherConfig {
            base_url_env: format!("STUDIO_TEST_GEARS_MATCHER_URL_{suffix}"),
            secret_env: format!("STUDIO_TEST_GEARS_MATCHER_SECRET_{suffix}"),
            ..MatcherConfig::default()
        }
    }

    #[test]
    fn an_unconfigured_matcher_says_what_is_missing() {
        let cfg = config("unset");
        assert_eq!(cfg.resolve_base_url(), "");
        let why = cfg.missing().expect("unconfigured");
        assert!(
            why.contains("STUDIO_TEST_GEARS_MATCHER_SECRET_unset"),
            "{why}"
        );
    }

    #[test]
    fn the_environment_beats_the_yaml_address_and_the_slash_goes() {
        let cfg = MatcherConfig {
            base_url: "http://from-yaml:8080".into(),
            ..config("url")
        };
        assert_eq!(cfg.resolve_base_url(), "http://from-yaml:8080");
        let got = with_var(&cfg.base_url_env, "http://gears-matcher:8080/", || {
            cfg.resolve_base_url()
        });
        assert_eq!(got, "http://gears-matcher:8080");
    }

    #[test]
    fn an_address_without_a_secret_is_not_enough() {
        let cfg = MatcherConfig {
            base_url: "http://gears-matcher:8080".into(),
            ..config("nosecret")
        };
        assert!(cfg.missing().is_some_and(|m| m.contains("shared secret")));
        let ok = with_var(&cfg.secret_env, "s3cret", || cfg.missing());
        assert_eq!(ok, None);
    }
}
