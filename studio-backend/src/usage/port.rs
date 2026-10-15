//! What Studio meters, in its own words, before it becomes the platform's
//! usage records (issue #781).
//!
//! A [`UsageRecord`] is one model call or one window of an IDE session. It is a
//! **quantity**, never an amount of money: tokens, or seconds of a pod of a
//! given size. What it cost is derived when it is read, from the
//! organization's price list, so changing a price never rewrites history.
//!
//! The records are kept by the platform's `usage-collector` gear (see
//! [`super::sdk::Usage`]), one collector record per quantity — a call's input
//! and output tokens are two — under the usage types in [`super::types`].
//! The collector deduplicates by idempotency key: a record sent again with the
//! same key and the same content is absorbed, so every key here is built from
//! what identifies the use and nothing that changes between two sends.

use time::OffsetDateTime;
use uuid::Uuid;

/// What was used.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// A call to a model provider through studio-llm-proxy.
    Llm,
    /// An IDE session's pod, for a window of time it ran.
    Session,
}

/// Whose money it was. A model call goes out on somebody's key (see
/// `llm_proxy::keys`); this is whose.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Payer {
    /// The person's own: a key in their profile, or their personal AI
    /// connection. Counted in the organization's total only when asked to.
    Personal,
    /// A workspace's AI connection.
    Workspace,
    /// The organization's AI connection, or the organization's own
    /// infrastructure (an IDE session).
    Organization,
}

impl Payer {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Personal => "personal",
            Self::Workspace => "workspace",
            Self::Organization => "organization",
        }
    }
}

/// Tokens of one model call, in the units a model's price is quoted in.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TokenCounts {
    /// Input neither read from nor written to the provider's cache.
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

/// How big a session's pod was asked to be, and how long of it this is.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Runtime {
    pub seconds: u64,
    pub cpu_millicores: u32,
    pub memory_mib: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UsageRecord {
    /// Idempotency key, the same every time this use is sent: the provider's
    /// request id for a model call, `session:{launch}:{window}` for a window
    /// of a session.
    pub key: String,
    /// Where it happened: the workspace or project a request named, else the
    /// caller's home tenant. An organization's costs are the records of every
    /// tenant in its tree.
    pub tenant_id: Uuid,
    /// Who: the caller of a model call. `None` for a session, which a person
    /// launched but the runtime does not say who.
    pub person_id: Option<Uuid>,
    pub source: Source,
    pub payer: Payer,
    /// `anthropic`, `openai`; the session driver (`kubernetes`, `docker`).
    pub provider: String,
    /// What a price is looked up by: the model that answered, or
    /// [`SESSION_ITEM`].
    pub item: String,
    /// When it happened — part of the collector's dedup identity, so a record
    /// sent again must carry the same instant.
    pub occurred_at: OffsetDateTime,
    pub tokens: TokenCounts,
    pub runtime: Runtime,
}

/// The item a session's records are priced under.
pub const SESSION_ITEM: &str = "ide-session";
