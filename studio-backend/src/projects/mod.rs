//! Creating a project: the sequence, made durable.
//!
//! A project is a tenant, a configuration, a repository, and — depending on
//! what kind it is — a starter gear or the one document an assembly reads.
//! Four gears and four-to-five non-atomic writes (ADR-0010), which until now
//! ran in the browser and lived only as long as the page did.
//!
//! See [`plan`] for what the engine guarantees and why idempotence rather than
//! a transaction is the answer.

pub mod plan;
pub mod provision_task;
pub mod steps;
pub mod tenants;
