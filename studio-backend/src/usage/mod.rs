//! Usage metering: what Studio's model calls and IDE sessions use, recorded
//! with the platform's `usage-collector` gear (issue #781).
//!
//! Not a gear. The records are the collector's, kept by its storage plugin
//! (`plugins/postgres-usage-collector-plugin`); this module is the Studio side
//! of it — the shape of a use ([`port`]), the usage types it becomes
//! ([`types`]) and the handle the recording gears hold ([`sdk`]):
//! studio-llm-proxy for every model call, studio-session for every running
//! IDE session.
//!
//! Prices and costs are not here yet: they are read from these records later,
//! against an organization's price list.

pub mod port;
pub mod sdk;
pub mod types;
