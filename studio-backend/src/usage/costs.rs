//! An organization's costs over a period: the collector's sums, priced and
//! grouped (issue #781, step 2). Pure — `super::service` reads the facts.

use std::collections::BTreeMap;

use uuid::Uuid;

use super::port::{Payer, TokenCounts};
use super::prices::PriceList;

/// One summed slice of usage, as the collector's aggregation returns it for a
/// tenant: everything that shares a tenant, a person, a provider and model (or
/// session driver) and a payer.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Fact {
    pub tenant: Uuid,
    /// The caller of a model call; `None` for a session.
    pub person: Option<Uuid>,
    pub kind: FactKind,
    /// `anthropic`, `openai`; the session driver.
    pub provider: String,
    /// The model; `ide-session` for a session.
    pub item: String,
    pub payer: Option<Payer>,
    pub tokens: TokenCounts,
    pub session_seconds: u64,
    pub cpu_millicore_seconds: u64,
    pub memory_mib_seconds: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FactKind {
    #[default]
    Llm,
    Session,
}

/// What a report's rows are.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GroupBy {
    Person,
    Project,
    Model,
    Source,
    Payer,
}

impl GroupBy {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "person" => Self::Person,
            "project" => Self::Project,
            "model" => Self::Model,
            "source" => Self::Source,
            "payer" => Self::Payer,
            _ => return None,
        })
    }
}

/// One row of the report.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Row {
    /// What the row is: a person's or tenant's id, `provider/model`, `llm` or
    /// `session`, a payer. Empty for a session in a by-person report.
    pub key: String,
    pub tokens: TokenCounts,
    pub session_seconds: u64,
    /// What the priced part cost.
    pub cost: f64,
    /// Whether part of this row had no price — its quantity is counted, its
    /// cost is not.
    pub unpriced: bool,
}

/// The report.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Report {
    pub rows: Vec<Row>,
    pub total: f64,
    /// `provider/model` (or `session`) for everything that had no price.
    pub unpriced: Vec<String>,
}

/// Price `facts` and fold them into rows, largest cost first. Spend on a
/// person's own key is left out unless `include_personal`.
pub fn report(
    facts: &[Fact],
    prices: &PriceList,
    group: GroupBy,
    include_personal: bool,
) -> Report {
    let mut rows: BTreeMap<String, Row> = BTreeMap::new();
    let mut unpriced = std::collections::BTreeSet::new();
    for f in facts {
        if !include_personal && f.payer == Some(Payer::Personal) {
            continue;
        }
        let cost = match f.kind {
            FactKind::Llm => prices.tokens_cost(&f.provider, &f.item, f.tokens),
            FactKind::Session => prices.session_cost(f.cpu_millicore_seconds, f.memory_mib_seconds),
        };
        if cost.is_none() {
            unpriced.insert(match f.kind {
                FactKind::Llm => format!("{}/{}", f.provider, f.item),
                FactKind::Session => "session".to_owned(),
            });
        }
        let key = match group {
            GroupBy::Person => f.person.map(|p| p.to_string()).unwrap_or_default(),
            GroupBy::Project => f.tenant.to_string(),
            GroupBy::Model => match f.kind {
                FactKind::Llm => format!("{}/{}", f.provider, f.item),
                FactKind::Session => f.item.clone(),
            },
            GroupBy::Source => match f.kind {
                FactKind::Llm => "llm".to_owned(),
                FactKind::Session => "session".to_owned(),
            },
            GroupBy::Payer => f.payer.map(|p| p.as_str().to_owned()).unwrap_or_default(),
        };
        let row = rows.entry(key.clone()).or_insert_with(|| Row {
            key,
            ..Row::default()
        });
        row.tokens.input += f.tokens.input;
        row.tokens.output += f.tokens.output;
        row.tokens.cache_read += f.tokens.cache_read;
        row.tokens.cache_write += f.tokens.cache_write;
        row.session_seconds += f.session_seconds;
        match cost {
            Some(c) => row.cost += c,
            None => row.unpriced = true,
        }
    }
    let mut rows: Vec<Row> = rows.into_values().collect();
    rows.sort_by(|a, b| b.cost.total_cmp(&a.cost).then_with(|| a.key.cmp(&b.key)));
    Report {
        total: rows.iter().map(|r| r.cost).sum(),
        rows,
        unpriced: unpriced.into_iter().collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::prices::{ModelPrice, SessionPrice};

    const WS: Uuid = Uuid::from_u128(0xD2);
    const ADA: Uuid = Uuid::from_u128(0xADA);

    fn prices() -> PriceList {
        PriceList {
            models: vec![ModelPrice {
                provider: "anthropic".into(),
                model: "claude-sonnet-5-5".into(),
                input_per_mtok: 1_000_000.0,
                output_per_mtok: 2_000_000.0,
                ..ModelPrice::default()
            }],
            session: Some(SessionPrice {
                cpu_core_hour: 3600.0,
                memory_gib_hour: 0.0,
            }),
            ..PriceList::default()
        }
    }

    fn call(payer: Payer, model: &str, input: u64, output: u64) -> Fact {
        Fact {
            tenant: WS,
            person: Some(ADA),
            kind: FactKind::Llm,
            provider: "anthropic".into(),
            item: model.into(),
            payer: Some(payer),
            tokens: TokenCounts {
                input,
                output,
                ..TokenCounts::default()
            },
            ..Fact::default()
        }
    }

    fn session() -> Fact {
        Fact {
            tenant: WS,
            kind: FactKind::Session,
            provider: "kubernetes".into(),
            item: "ide-session".into(),
            payer: Some(Payer::Organization),
            session_seconds: 300,
            cpu_millicore_seconds: 1000,
            ..Fact::default()
        }
    }

    /// The switch the issue asked for: the same facts with and without what
    /// people spent on their own keys.
    #[test]
    fn personal_keys_are_counted_only_when_asked() {
        let facts = [
            call(Payer::Personal, "claude-sonnet-5-5", 1, 0),
            call(Payer::Organization, "claude-sonnet-5-5", 0, 1),
        ];
        let with = report(&facts, &prices(), GroupBy::Payer, true);
        let without = report(&facts, &prices(), GroupBy::Payer, false);
        assert_eq!(with.total, 3.0);
        assert_eq!(without.total, 2.0);
        assert_eq!(without.rows.len(), 1);
        assert_eq!(without.rows[0].key, "organization");
    }

    /// A model with no price is counted and named, never priced at zero
    /// silently; sessions are priced by what they requested.
    #[test]
    fn what_has_no_price_is_named_and_left_out_of_the_cost() {
        let facts = [
            call(Payer::Organization, "claude-sonnet-5-5", 1, 0),
            call(Payer::Organization, "claude-opus-9", 5, 5),
            session(),
        ];
        let r = report(&facts, &prices(), GroupBy::Model, true);
        assert_eq!(r.unpriced, vec!["anthropic/claude-opus-9".to_owned()]);
        let opus = r
            .rows
            .iter()
            .find(|row| row.key == "anthropic/claude-opus-9")
            .unwrap();
        assert!(opus.unpriced);
        assert_eq!(opus.tokens.input, 5);
        let s = r.rows.iter().find(|row| row.key == "ide-session").unwrap();
        assert_eq!(s.cost, 1.0);
        assert_eq!(s.session_seconds, 300);
        assert_eq!(r.total, 2.0);
        // Largest cost first.
        assert!(r.rows[0].cost >= r.rows[1].cost);
    }

    #[test]
    fn by_person_a_session_has_nobody_and_by_project_everything_is_its_tenant() {
        let facts = [
            call(Payer::Organization, "claude-sonnet-5-5", 1, 0),
            session(),
        ];
        let people = report(&facts, &prices(), GroupBy::Person, true);
        let keys: Vec<&str> = people.rows.iter().map(|r| r.key.as_str()).collect();
        assert!(keys.contains(&ADA.to_string().as_str()) && keys.contains(&""));
        let projects = report(&facts, &prices(), GroupBy::Project, true);
        assert_eq!(projects.rows.len(), 1);
        assert_eq!(projects.rows[0].key, WS.to_string());
        assert_eq!(GroupBy::parse("nope"), None);
    }
}
