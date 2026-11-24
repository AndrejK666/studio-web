//! Before a deploy: every configuration secret the product's description
//! reads is set, made, or the deploy is refused.
//!
//! A `${NAME}` the description reads and nothing sets used to be found by
//! the service that read it, crashing at start: Research DEV, 2026-11-24,
//! "configuration /etc/gearbox/api-gateway.yaml reads environment variables
//! that are not set: MINI_CHAT_CLIENT_SECRET, PLATFORM_INTERNAL_SECRET",
//! forty minutes after the build was asked for. Now, for each one missing
//! ([`super::secret_needs`]):
//!
//! - a secret the deployment itself owns is made once per environment and
//!   kept in credstore like any configuration secret: the gears' shared
//!   internal secret (a gear's `internal_auth.secret`, `PLATFORM_INTERNAL_SECRET`
//!   in the stock description) and the client secret of a gear the product's
//!   realm gives a client of its own ([`super::realm`],
//!   `client_credentials.client_secret`, `MINI_CHAT_CLIENT_SECRET`). Nobody
//!   but the product's own services holds either, so any value works as long
//!   as it stays the same. A value already kept is never replaced;
//! - any other is the project's to give: the deploy is refused with
//!   [`SECRET_MISSING`], naming each key.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use super::secret_needs::SecretNeed;

/// The cause of a deploy refused for a configuration secret nobody set.
pub const SECRET_MISSING: &str = "SECRET_MISSING";

/// A value made for a secret the deployment owns: 64 hex characters.
pub fn new_value() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// The single `${VAR}` a value is, when it is one.
fn reference(v: &Value) -> Option<&str> {
    let inner = v.as_str()?.trim().strip_prefix("${")?.strip_suffix('}')?;
    (!inner.is_empty()
        && inner
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'))
    .then_some(inner)
}

/// Every `internal_auth.secret` under `v`, as the variable it reads.
fn internal_secrets(v: &Value, out: &mut BTreeSet<String>) {
    match v {
        Value::Object(m) => {
            if let Some(var) = m
                .get("internal_auth")
                .and_then(|a| a.get("secret"))
                .and_then(reference)
            {
                out.insert(var.to_owned());
            }
            for child in m.values() {
                internal_secrets(child, out);
            }
        }
        Value::Array(items) => {
            for child in items {
                internal_secrets(child, out);
            }
        }
        _ => {}
    }
}

/// The variables the deployment owns, out of the description's gear
/// configurations (by gear id): what a deploy makes rather than asks for.
pub fn owned(configs: &BTreeMap<String, Value>) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for config in configs.values() {
        internal_secrets(config, &mut out);
        // As the realm makes the gear's client: a literal client id, the
        // secret one `${VAR}`.
        let Some(cc) = config.get("client_credentials") else {
            continue;
        };
        let literal_id = cc
            .get("client_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .is_some_and(|id| !id.is_empty() && !id.contains("${"));
        if let (true, Some(var)) = (literal_id, cc.get("client_secret").and_then(reference)) {
            out.insert(var.to_owned());
        }
    }
    out
}

/// What the deploy needs and nobody gives, split into what the deployment
/// makes (`owned`) and what it must refuse without.
pub fn split<'a>(
    needs: &'a [SecretNeed],
    owned: &BTreeSet<String>,
) -> (Vec<&'a SecretNeed>, Vec<&'a SecretNeed>) {
    needs
        .iter()
        .filter(|n| n.missing())
        .partition(|n| owned.contains(&n.key))
}

/// Why a deploy to `environment` is refused for the secrets in `missing`.
pub fn refusal_message(environment: &str, missing: &[&SecretNeed]) -> String {
    let keys: Vec<String> = missing
        .iter()
        .map(|n| {
            if n.needed_by.is_empty() {
                n.key.clone()
            } else {
                format!("{} (read by {})", n.key, n.needed_by.join(", "))
            }
        })
        .collect();
    let (them, it) = if missing.len() == 1 {
        ("secret is", "it")
    } else {
        ("secrets are", "each")
    };
    format!(
        "the product reads configuration {them} not set in environment '{environment}': {}. \
         Set {it} in the environment's Configuration, then deploy again",
        keys.join(", ")
    )
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// Studioweb's description, as `gear_configs` reads it (2026-11-24).
    fn studioweb() -> BTreeMap<String, Value> {
        [
            (
                "api-gateway".to_owned(),
                json!({"internal_auth": {"secret": "${PLATFORM_INTERNAL_SECRET}"}}),
            ),
            (
                "grpc-hub".to_owned(),
                json!({"internal_auth": {"secret": "${PLATFORM_INTERNAL_SECRET}"}}),
            ),
            (
                "mini-chat".to_owned(),
                json!({"client_credentials": {
                    "client_id": "mini-chat",
                    "client_secret": "${MINI_CHAT_CLIENT_SECRET}"
                }}),
            ),
            (
                "notify".to_owned(),
                json!({"smtp": {"password": "${SMTP_PASSWORD}"}}),
            ),
        ]
        .into()
    }

    fn need(key: &str, set: bool) -> SecretNeed {
        SecretNeed {
            key: key.into(),
            needed_by: vec!["description".into()],
            provided_by: None,
            set,
        }
    }

    #[test]
    fn the_internal_secret_and_a_realm_client_secret_are_the_deployments() {
        let owned = owned(&studioweb());
        assert_eq!(
            owned.into_iter().collect::<Vec<_>>(),
            ["MINI_CHAT_CLIENT_SECRET", "PLATFORM_INTERNAL_SECRET"]
        );
    }

    #[test]
    fn a_client_whose_id_is_a_variable_or_whose_secret_is_not_one_is_not() {
        let configs: BTreeMap<String, Value> = [
            (
                "a".to_owned(),
                json!({"client_credentials": {"client_id": "${ID}", "client_secret": "${A_SECRET}"}}),
            ),
            (
                "b".to_owned(),
                json!({"client_credentials": {"client_id": "b", "client_secret": "pre-${B}"}}),
            ),
            ("c".to_owned(), json!({"internal_auth": {"secret": "literal"}})),
        ]
        .into();
        assert!(owned(&configs).is_empty());
    }

    #[test]
    fn what_is_missing_is_made_or_refused_and_what_is_set_is_neither() {
        // As on the stand before the secrets were set by hand: both
        // internal ones missing, plus one only the project can give.
        let needs = vec![
            need("MINI_CHAT_CLIENT_SECRET", false),
            need("PLATFORM_INTERNAL_SECRET", true),
            need("SMTP_PASSWORD", false),
            SecretNeed {
                provided_by: Some("database".into()),
                ..need("DB_PASSWORD", false)
            },
        ];
        let (made, refused) = split(&needs, &owned(&studioweb()));
        let keys = |v: &[&SecretNeed]| v.iter().map(|n| n.key.clone()).collect::<Vec<_>>();
        // A value set by hand is never made again.
        assert_eq!(keys(&made), ["MINI_CHAT_CLIENT_SECRET"]);
        assert_eq!(keys(&refused), ["SMTP_PASSWORD"]);
        let why = refusal_message("research-hyp3099", &refused);
        assert!(why.contains("SMTP_PASSWORD (read by description)"), "{why}");
        assert!(why.contains("environment's Configuration"), "{why}");
        assert!(why.contains("'research-hyp3099'"), "{why}");
    }
}
