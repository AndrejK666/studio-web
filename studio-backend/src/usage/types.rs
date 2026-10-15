//! The usage types Studio records under, and how one [`UsageRecord`] becomes
//! the collector's records.
//!
//! Every type is a **counter**: each record adds its value, and an
//! organization's total over a period is their sum. One quantity per type,
//! because a collector query aggregates one type at a time:
//!
//! | Type | Value | Metadata |
//! |---|---|---|
//! | `llm.input_tokens` | uncached input tokens | `provider`, `model`, `payer` |
//! | `llm.output_tokens` | output tokens | same |
//! | `llm.cache_read_tokens` | input read from the provider's cache | same |
//! | `llm.cache_write_tokens` | input written to it | same |
//! | `session.seconds` | seconds a session's pod ran | `driver`, `payer` |
//! | `session.cpu_millicore_seconds` | seconds × requested millicores | same |
//! | `session.memory_mib_seconds` | seconds × requested MiB | same |
//!
//! A quantity of zero is not recorded.

use std::collections::{BTreeMap, BTreeSet};

use rust_decimal::Decimal;
use usage_collector_sdk::{
    CreateUsageRecord, IdempotencyKey, MetadataKey, ResourceRef, SubjectRef, UsageCollectorError,
    UsageKind, UsageType, UsageTypeGtsId,
};

use super::port::{Source, UsageRecord};

/// The collector's base type every usage type derives from.
const BASE: &str = "gts.cf.core.uc.usage_record.v1~";

pub const LLM_INPUT: &str = "cf.studio.llm.input_tokens.v1";
pub const LLM_OUTPUT: &str = "cf.studio.llm.output_tokens.v1";
pub const LLM_CACHE_READ: &str = "cf.studio.llm.cache_read_tokens.v1";
pub const LLM_CACHE_WRITE: &str = "cf.studio.llm.cache_write_tokens.v1";
pub const SESSION_SECONDS: &str = "cf.studio.session.seconds.v1";
pub const SESSION_CPU: &str = "cf.studio.session.cpu_millicore_seconds.v1";
pub const SESSION_MEMORY: &str = "cf.studio.session.memory_mib_seconds.v1";

const LLM_FIELDS: [&str; 3] = ["provider", "model", "payer"];
const SESSION_FIELDS: [&str; 2] = ["driver", "payer"];

/// What a record is attributed to: a model of a provider, or one launch of an
/// IDE session.
const LLM_RESOURCE: &str = "cf.studio.llm.model";
const SESSION_RESOURCE: &str = "cf.studio.ide.session";

/// A type's full GTS id.
pub fn gts_id(name: &str) -> Result<UsageTypeGtsId, UsageCollectorError> {
    UsageTypeGtsId::new(format!("{BASE}{name}"))
}

fn fields(names: &[&str]) -> Result<BTreeSet<MetadataKey>, UsageCollectorError> {
    names.iter().map(|n| MetadataKey::new(*n)).collect()
}

/// Every usage type Studio records under, as the collector's catalogue holds
/// them.
pub fn catalogue() -> Result<Vec<UsageType>, UsageCollectorError> {
    let mut out = Vec::new();
    for name in [LLM_INPUT, LLM_OUTPUT, LLM_CACHE_READ, LLM_CACHE_WRITE] {
        out.push(UsageType {
            gts_id: gts_id(name)?,
            kind: UsageKind::Counter,
            metadata_fields: fields(&LLM_FIELDS)?,
        });
    }
    for name in [SESSION_SECONDS, SESSION_CPU, SESSION_MEMORY] {
        out.push(UsageType {
            gts_id: gts_id(name)?,
            kind: UsageKind::Counter,
            metadata_fields: fields(&SESSION_FIELDS)?,
        });
    }
    Ok(out)
}

/// The collector's records of one use: one per non-zero quantity.
pub fn collector_records(
    record: &UsageRecord,
) -> Result<Vec<CreateUsageRecord>, UsageCollectorError> {
    let mut metadata = BTreeMap::new();
    metadata.insert(MetadataKey::new("payer")?, record.payer.as_str().to_owned());
    let (resource, quantities): (ResourceRef, Vec<(&str, u64)>) = match record.source {
        Source::Llm => {
            metadata.insert(MetadataKey::new("provider")?, record.provider.clone());
            metadata.insert(MetadataKey::new("model")?, record.item.clone());
            let t = record.tokens;
            (
                ResourceRef::new(format!("{}:{}", record.provider, record.item), LLM_RESOURCE)?,
                vec![
                    (LLM_INPUT, t.input),
                    (LLM_OUTPUT, t.output),
                    (LLM_CACHE_READ, t.cache_read),
                    (LLM_CACHE_WRITE, t.cache_write),
                ],
            )
        }
        Source::Session => {
            metadata.insert(MetadataKey::new("driver")?, record.provider.clone());
            let r = record.runtime;
            (
                ResourceRef::new(record.key.clone(), SESSION_RESOURCE)?,
                vec![
                    (SESSION_SECONDS, r.seconds),
                    (
                        SESSION_CPU,
                        r.seconds.saturating_mul(u64::from(r.cpu_millicores)),
                    ),
                    (
                        SESSION_MEMORY,
                        r.seconds.saturating_mul(u64::from(r.memory_mib)),
                    ),
                ],
            )
        }
    };
    let subject = record
        .person_id
        .map(|p| SubjectRef::new(p.to_string(), Some("user")))
        .transpose()?;
    quantities
        .into_iter()
        .filter(|(_, value)| *value > 0)
        .map(|(name, value)| {
            Ok(CreateUsageRecord {
                gts_id: gts_id(name)?,
                tenant_id: record.tenant_id,
                resource_ref: resource.clone(),
                subject_ref: subject.clone(),
                metadata: metadata.clone(),
                value: Decimal::from(value),
                // One key per use; the type tells the quantities of one use
                // apart, and it is part of the collector's dedup identity.
                idempotency_key: IdempotencyKey::new(record.key.clone())?,
                corrects_id: None,
                created_at: record.occurred_at,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use time::macros::datetime;
    use uuid::Uuid;

    use super::*;
    use crate::usage::port::{Payer, Runtime, TokenCounts};

    fn call() -> UsageRecord {
        UsageRecord {
            key: "llm:anthropic:req_1".into(),
            tenant_id: Uuid::from_u128(0xD2),
            person_id: Some(Uuid::from_u128(0x7A5)),
            source: Source::Llm,
            payer: Payer::Personal,
            provider: "anthropic".into(),
            item: "claude-sonnet-5-5".into(),
            occurred_at: datetime!(2026-10-15 12:00 UTC),
            tokens: TokenCounts {
                input: 12,
                output: 57,
                cache_read: 4000,
                cache_write: 0,
            },
            runtime: Runtime::default(),
        }
    }

    #[test]
    fn every_type_is_a_counter_under_the_collectors_base() {
        let types = catalogue().unwrap();
        assert_eq!(types.len(), 7);
        for t in &types {
            assert_eq!(t.kind, UsageKind::Counter);
            assert!(t.gts_id.as_ref().starts_with(BASE), "{}", t.gts_id.as_ref());
        }
    }

    /// A call becomes one record per non-zero token count, all under the same
    /// key, with whose money it was and which model answered.
    #[test]
    fn a_call_is_recorded_once_per_quantity_it_used() {
        let records = collector_records(&call()).unwrap();
        let types: Vec<String> = records
            .iter()
            .map(|r| r.gts_id.as_ref().to_owned())
            .collect();
        assert_eq!(
            types,
            [LLM_INPUT, LLM_OUTPUT, LLM_CACHE_READ].map(|n| format!("{BASE}{n}"))
        );
        let values: Vec<Decimal> = records.iter().map(|r| r.value).collect();
        assert_eq!(values, [12, 57, 4000].map(Decimal::from));
        for r in &records {
            assert_eq!(r.idempotency_key.as_ref(), "llm:anthropic:req_1");
            assert_eq!(r.tenant_id, Uuid::from_u128(0xD2));
            assert_eq!(
                r.metadata.get(&MetadataKey::new("payer").unwrap()).unwrap(),
                "personal"
            );
            assert_eq!(
                r.metadata.get(&MetadataKey::new("model").unwrap()).unwrap(),
                "claude-sonnet-5-5"
            );
            assert!(r.subject_ref.is_some());
        }
    }

    /// A session window is seconds, and seconds times its requested size.
    #[test]
    fn a_session_window_is_time_and_time_times_size() {
        let window = UsageRecord {
            key: "session:L1:2026-10-15T12:00:00Z".into(),
            person_id: None,
            source: Source::Session,
            payer: Payer::Organization,
            provider: "kubernetes".into(),
            item: crate::usage::port::SESSION_ITEM.into(),
            tokens: TokenCounts::default(),
            runtime: Runtime {
                seconds: 300,
                cpu_millicores: 250,
                memory_mib: 512,
            },
            ..call()
        };
        let records = collector_records(&window).unwrap();
        let values: Vec<Decimal> = records.iter().map(|r| r.value).collect();
        assert_eq!(values, [300, 75_000, 153_600].map(Decimal::from));
        assert!(records.iter().all(|r| r.subject_ref.is_none()));
    }
}
