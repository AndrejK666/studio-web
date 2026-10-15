//! An organization's price list, and what a quantity costs under it
//! (issue #781, step 2).
//!
//! Records are quantities (`super::port`); money is derived here when costs
//! are read, so a price changed today reprices the past too — the list is the
//! organization's current view of what things cost, not a ledger. A quantity
//! with no price is *unpriced*, reported as such, and never guessed at.

use serde::{Deserialize, Serialize};

use super::port::TokenCounts;

/// The organization's price list, kept as one account-management metadata row
/// on the organization (`super::PRICES_METADATA_TYPE`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PriceList {
    /// ISO 4217 code every price is in. Empty means `USD`.
    pub currency: String,
    pub models: Vec<ModelPrice>,
    /// What an IDE session's pod costs; `None` leaves sessions unpriced.
    pub session: Option<SessionPrice>,
}

/// A model's price, per million tokens of each kind.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ModelPrice {
    /// `anthropic`, `openai`.
    pub provider: String,
    /// The model as the provider names it in its answers. A trailing `*`
    /// matches every model that starts with the rest (`claude-sonnet-5-5*`
    /// for its dated snapshots).
    pub model: String,
    pub input_per_mtok: f64,
    pub output_per_mtok: f64,
    pub cache_read_per_mtok: f64,
    pub cache_write_per_mtok: f64,
}

/// What a session's pod costs per hour of what it requested.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SessionPrice {
    pub cpu_core_hour: f64,
    pub memory_gib_hour: f64,
}

/// Why a price list was refused.
#[derive(Debug, PartialEq, Eq)]
pub struct Invalid(pub String);

impl PriceList {
    pub fn currency(&self) -> &str {
        if self.currency.trim().is_empty() {
            "USD"
        } else {
            self.currency.trim()
        }
    }

    /// A list that can be stored: a currency code, every model named once,
    /// and no negative or non-finite price.
    pub fn validate(&self) -> Result<(), Invalid> {
        let code = self.currency();
        if code.len() != 3 || !code.bytes().all(|b| b.is_ascii_uppercase()) {
            return Err(Invalid(format!(
                "currency {code:?} is not an ISO 4217 code"
            )));
        }
        let mut seen = std::collections::HashSet::new();
        for m in &self.models {
            if m.provider.trim().is_empty() || m.model.trim().is_empty() {
                return Err(Invalid(
                    "every model price names a provider and a model".into(),
                ));
            }
            if !seen.insert((m.provider.trim(), m.model.trim())) {
                return Err(Invalid(format!(
                    "{}/{} is priced twice",
                    m.provider, m.model
                )));
            }
            for (what, v) in [
                ("input", m.input_per_mtok),
                ("output", m.output_per_mtok),
                ("cache read", m.cache_read_per_mtok),
                ("cache write", m.cache_write_per_mtok),
            ] {
                if !v.is_finite() || v < 0.0 {
                    return Err(Invalid(format!(
                        "{}/{}: the {what} price is not a price",
                        m.provider, m.model
                    )));
                }
            }
        }
        if let Some(s) = self.session
            && [s.cpu_core_hour, s.memory_gib_hour]
                .iter()
                .any(|v| !v.is_finite() || *v < 0.0)
        {
            return Err(Invalid("a session price is not a price".into()));
        }
        Ok(())
    }

    /// The price of `model` at `provider`: an exact name first, then the
    /// longest matching `*` prefix.
    pub fn model(&self, provider: &str, model: &str) -> Option<&ModelPrice> {
        let of_provider = || self.models.iter().filter(move |m| m.provider == provider);
        of_provider().find(|m| m.model == model).or_else(|| {
            of_provider()
                .filter_map(|m| {
                    let prefix = m.model.strip_suffix('*')?;
                    model.starts_with(prefix).then_some((prefix.len(), m))
                })
                .max_by_key(|(len, _)| *len)
                .map(|(_, m)| m)
        })
    }

    /// What `tokens` of `model` cost, or `None` when the model has no price.
    pub fn tokens_cost(&self, provider: &str, model: &str, tokens: TokenCounts) -> Option<f64> {
        let p = self.model(provider, model)?;
        let per = |count: u64, price: f64| count as f64 / 1_000_000.0 * price;
        Some(
            per(tokens.input, p.input_per_mtok)
                + per(tokens.output, p.output_per_mtok)
                + per(tokens.cache_read, p.cache_read_per_mtok)
                + per(tokens.cache_write, p.cache_write_per_mtok),
        )
    }

    /// What a session's requested CPU and memory over time cost, given as
    /// millicore-seconds and MiB-seconds; `None` without a session price.
    pub fn session_cost(&self, cpu_millicore_seconds: u64, memory_mib_seconds: u64) -> Option<f64> {
        let p = self.session?;
        let core_hours = cpu_millicore_seconds as f64 / 1000.0 / 3600.0;
        let gib_hours = memory_mib_seconds as f64 / 1024.0 / 3600.0;
        Some(core_hours * p.cpu_core_hour + gib_hours * p.memory_gib_hour)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list() -> PriceList {
        PriceList {
            currency: String::new(),
            models: vec![
                ModelPrice {
                    provider: "anthropic".into(),
                    model: "claude-sonnet-5-5*".into(),
                    input_per_mtok: 3.0,
                    output_per_mtok: 15.0,
                    cache_read_per_mtok: 0.3,
                    cache_write_per_mtok: 3.75,
                },
                ModelPrice {
                    provider: "anthropic".into(),
                    model: "claude-sonnet-5-5-fast".into(),
                    input_per_mtok: 6.0,
                    ..ModelPrice::default()
                },
            ],
            session: Some(SessionPrice {
                cpu_core_hour: 0.04,
                memory_gib_hour: 0.005,
            }),
        }
    }

    #[test]
    fn a_model_is_priced_by_its_name_then_by_the_longest_prefix() {
        let l = list();
        assert_eq!(
            l.model("anthropic", "claude-sonnet-5-5-fast")
                .unwrap()
                .input_per_mtok,
            6.0
        );
        assert_eq!(
            l.model("anthropic", "claude-sonnet-5-5-20261001")
                .unwrap()
                .input_per_mtok,
            3.0
        );
        assert!(l.model("openai", "claude-sonnet-5-5").is_none());
        assert!(l.model("anthropic", "claude-haiku-5-5").is_none());
    }

    /// The stand's call: 120 in, 42 out, 3000 read from cache, 50 written.
    #[test]
    fn tokens_cost_each_kind_at_its_own_price() {
        let cost = list()
            .tokens_cost(
                "anthropic",
                "claude-sonnet-5-5",
                TokenCounts {
                    input: 120,
                    output: 42,
                    cache_read: 3000,
                    cache_write: 50,
                },
            )
            .unwrap();
        let expected = (120.0 * 3.0 + 42.0 * 15.0 + 3000.0 * 0.3 + 50.0 * 3.75) / 1e6;
        assert!((cost - expected).abs() < 1e-12, "{cost} vs {expected}");
        assert_eq!(
            list().tokens_cost("openai", "gpt-x", TokenCounts::default()),
            None
        );
    }

    /// An hour of a 250m / 512Mi pod.
    #[test]
    fn a_session_costs_what_it_requested_over_time() {
        let cost = list().session_cost(250 * 3600, 512 * 3600).unwrap();
        assert!((cost - (0.25 * 0.04 + 0.5 * 0.005)).abs() < 1e-12);
        assert_eq!(PriceList::default().session_cost(1, 1), None);
    }

    #[test]
    fn a_list_that_is_not_one_is_refused() {
        assert!(list().validate().is_ok());
        assert_eq!(list().currency(), "USD");
        let mut l = list();
        l.currency = "dollars".into();
        assert!(l.validate().is_err());
        let mut l = list();
        l.models.push(l.models[0].clone());
        assert!(l.validate().is_err());
        let mut l = list();
        l.models[0].output_per_mtok = -1.0;
        assert!(l.validate().is_err());
        let mut l = list();
        l.session = Some(SessionPrice {
            cpu_core_hour: f64::NAN,
            memory_gib_hour: 0.0,
        });
        assert!(l.validate().is_err());
    }
}
