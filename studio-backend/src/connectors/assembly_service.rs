//! An assembly strategy's service (ADR-0074, amendment): the endpoint and the
//! secret of a service an organization's kit declares a product is assembled
//! by (`assembly_strategy.service` in its manifest). The kit names the
//! strategy and the contract; the organization binds the address and the
//! secret here, as a connection, so neither is ever in a manifest.
//!
//! One option, `strategy`: the id of the strategy the service runs. The
//! contract is `gears-matcher/v1` (the gears-matcher's API, a bearer):
//! verifying a connection asks `GET /v1/info` with the secret, which proves
//! the service answers and speaks it. studio-product reads the connection
//! when it runs or reads a match of that strategy (`gear_match`).

use std::collections::BTreeMap;

use anyhow::{Context, anyhow};
use async_trait::async_trait;

use super::driver::{
    ConnectionAuth, ConnectorCategory, ConnectorDriver, DriverIdentity, FieldKind, FormField,
    Holder,
};

pub const PROVIDER: &str = "assembly-service";

/// The option naming the strategy a connection serves.
pub const STRATEGY_OPTION: &str = "strategy";

pub struct AssemblyServiceDriver {
    http: reqwest::Client,
}

impl AssemblyServiceDriver {
    pub fn new(http: reqwest::Client) -> Self {
        Self { http }
    }
}

/// [`strategy_ok`] as the form's pattern, for a client to check as it is typed.
const STRATEGY_PATTERN: &str = "^[a-z][a-z0-9_]{0,39}$";

/// A strategy id as a kit's manifest writes one: `snake_case`, at most 40.
fn strategy_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 40
        && id.starts_with(|c: char| c.is_ascii_lowercase())
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// The options as stored: exactly `strategy`, a strategy id.
pub fn normalize_options(
    options: &BTreeMap<String, String>,
) -> anyhow::Result<BTreeMap<String, String>> {
    if let Some(k) = options.keys().find(|k| *k != STRATEGY_OPTION) {
        return Err(anyhow!(
            "an assembly service connection takes only `{STRATEGY_OPTION}` (`{k}` was given)"
        ));
    }
    let id = options
        .get(STRATEGY_OPTION)
        .map(|s| s.trim())
        .unwrap_or_default();
    if !strategy_ok(id) {
        return Err(anyhow!(
            "`{STRATEGY_OPTION}` names the assembly strategy the service runs, as its kit \
             declares it (snake_case, at most 40 characters)"
        ));
    }
    Ok(BTreeMap::from([(
        STRATEGY_OPTION.to_owned(),
        id.to_owned(),
    )]))
}

#[async_trait]
impl ConnectorDriver for AssemblyServiceDriver {
    fn provider(&self) -> &'static str {
        PROVIDER
    }

    fn display_name(&self) -> &'static str {
        "Assembly strategy service"
    }

    fn default_base_url(&self) -> &'static str {
        ""
    }

    fn category(&self) -> ConnectorCategory {
        ConnectorCategory::Service
    }

    fn credential_hint(&self) -> &'static str {
        "The service's shared secret (a bearer)"
    }

    /// The strategy the service runs first, then its address (it has no
    /// default) and its secret.
    fn form_fields(&self) -> Vec<FormField> {
        vec![
            FormField::option(STRATEGY_OPTION, "Strategy ID", FieldKind::Text)
                .required()
                .hint("Enter the ID from the kit manifest in snake_case.")
                .pattern(STRATEGY_PATTERN)
                .max_length(40),
            FormField::base_url(self.default_base_url()),
            FormField::token(self.credential_label(), self.credential_hint(), true),
        ]
    }

    /// A kit's service is the organization's, and only its.
    fn holder(&self) -> Holder {
        Holder::Organization
    }

    fn holder_fixed(&self) -> bool {
        true
    }

    fn check_options(
        &self,
        _base_url: &str,
        options: &BTreeMap<String, String>,
    ) -> anyhow::Result<BTreeMap<String, String>> {
        normalize_options(options)
    }

    async fn test(&self, auth: &ConnectionAuth) -> anyhow::Result<DriverIdentity> {
        let url = format!("{}/v1/info", auth.root().trim_end_matches('/'));
        let res = self
            .http
            .get(&url)
            .bearer_auth(&auth.token)
            .send()
            .await
            .map_err(|e| anyhow!("the service did not answer: {}", e.without_url()))?;
        let status = res.status();
        if !status.is_success() {
            return Err(anyhow!(
                "the service answered {status} to GET /v1/info: check the address and the secret"
            ));
        }
        let info: serde_json::Value = res.json().await.context(
            "GET /v1/info did not answer JSON: the service does not speak gears-matcher/v1",
        )?;
        let version = info["service_version"].as_str().unwrap_or("unknown");
        let commit = info["catalogue"]["gear_gdl_commit"]
            .as_str()
            .or(info["catalogue"]["gears_md_commit"].as_str())
            .map(|c| c.chars().take(8).collect::<String>());
        Ok(DriverIdentity {
            avatar_url: None,
            account: match commit {
                Some(c) => format!("service {version}, catalogue {c}"),
                None => format!("service {version}"),
            },
            display_name: None,
            checks: Vec::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_connection_names_the_strategy_it_serves_and_nothing_else() {
        let ok = normalize_options(&BTreeMap::from([(
            "strategy".to_owned(),
            " acme_matcher ".to_owned(),
        )]))
        .unwrap();
        assert_eq!(ok["strategy"], "acme_matcher");
        assert!(normalize_options(&BTreeMap::new()).is_err());
        assert!(normalize_options(&BTreeMap::from([("strategy".into(), "Acme".into())])).is_err());
        assert!(
            normalize_options(&BTreeMap::from([
                ("strategy".into(), "acme".into()),
                ("secret".into(), "x".into())
            ]))
            .is_err()
        );
    }
}
