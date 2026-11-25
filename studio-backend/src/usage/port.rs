//! What Studio meters, in its own words, before it becomes the platform's
//! usage records (issue #781): the core's metering vocabulary
//! (`crate::metering`), which this gear prices.
//!
//! The records are kept by the platform's `usage-collector` gear (see
//! [`super::sdk`]), one collector record per quantity — a call's input and
//! output tokens are two — under the usage types in [`super::types`].

pub use crate::metering::{Payer, Runtime, SESSION_ITEM, Source, TokenCounts, UsageRecord};
