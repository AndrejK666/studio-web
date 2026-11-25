//! studio-llm-proxy — Studio's one way out to a model provider, on a person's
//! key.
//!
//! The agents in an IDE session (Claude Code, Codex) and the IDE's built-in
//! chat (Theia AI) reach their providers through this gear, under the Studio
//! gateway (`/studio-llm/v1/*`), authenticated with the member's own Studio
//! token. The call leaves with that member's key — their profile key, else an
//! AI connection they reach ([`keys`]) — so no provider key ever enters the
//! IDE container, and Studio holds none of its own.
//!
//! It is also Studio's one way out to a model provider (ADR-0039): another
//! gear that needs a provider takes [`port::ModelProviders`] from the
//! ClientHub rather than calling one itself.

pub mod config;
/// The model providers' connector drivers, contributed through
/// studio-connector's driver port (ADR-0079).
mod connector_drivers;
pub mod gear;
pub mod keys;
pub mod port;
pub mod providers;
pub mod rest;
pub mod usage_tap;

// One module per plugin gear: `#[toolkit::gear]` aliases its dependencies at
// module scope, so two gears in one module collide (see connectors/plugin.rs).
/// Anthropic — the credential `@theia/ai-claude-code` authenticates with. Its
/// key test goes out through this gear's provider layer.
#[path = "plugins/anthropic/mod.rs"]
mod anthropic_connector_plugin;
/// OpenAI — what `@theia/ai-codex` uses.
#[path = "plugins/openai/mod.rs"]
mod openai_connector_plugin;
