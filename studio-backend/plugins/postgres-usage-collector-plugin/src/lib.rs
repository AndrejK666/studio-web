#![cfg_attr(coverage_nightly, feature(coverage_attribute))]

//! Plain `PostgreSQL` storage backend plugin for the Usage Collector storage
//! Plugin SPI, vendored from the `TimescaleDB` plugin (see `README.md`).
//!
//! Implements [`usage_collector_sdk::UsageCollectorPluginV1`] on `PostgreSQL`. Layered DDD-light: [`gear`] performs the GTS registration
//! handshake, [`domain`] holds the SPI adapter and store port traits, and
//! [`infra`] holds the `sqlx`-backed Postgres implementations.

pub mod gear;

pub use gear::PostgresUsageCollectorPlugin;

// === INTERNAL MODULES ===
// Implementation detail of the plugin. Exposed `pub` only so the crate's
// integration tests (separate `tests/*.rs` crates) can construct the stores,
// config, and metrics directly — NOT public API. External consumers depend on
// `PostgresUsageCollectorPlugin` and resolve everything else through the
// plugin host. `#[doc(hidden)]` keeps these off the rendered API surface.
#[doc(hidden)]
pub mod config;
#[doc(hidden)]
pub mod domain;
#[doc(hidden)]
pub mod infra;
