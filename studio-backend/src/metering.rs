//! Cost metering: what Studio meters, in its own words, and the port a use is
//! recorded through (issue #781, ADR-0079 §4 "Cost metering").
//!
//! A [`UsageRecord`] is one model call or one window of an IDE session. It is a
//! **quantity**, never an amount of money: tokens, or seconds of a pod of a
//! given size. What it cost is derived when it is read, from the
//! organization's price list, so changing a price never rewrites history.
//!
//! A gear that meters holds a [`Usage`] handle. Where the records go is a
//! [`UsageRecorder`] the costs kit registers in the `ClientHub`, resolved when
//! a record is made, not when the handle is: Studio gears share one crate, so
//! the toolkit's `deps` cannot order a metering gear after the recorder. An
//! assembly without one records nothing. The core never names the kit.
//!
//! Every key is built from what identifies the use and nothing that changes
//! between two sends: the recorder deduplicates by it, so a record sent again
//! with the same key and the same content is absorbed.

use std::sync::Arc;

use async_trait::async_trait;
use time::OffsetDateTime;
use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;
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

/// Where records go: the costs kit's recorder, or a test's.
#[async_trait]
pub trait UsageRecorder: Send + Sync {
    /// Keep `records`, as `ctx`: the recorder may ask the PDP whether `ctx`
    /// may record in each record's tenant.
    async fn record(&self, ctx: &SecurityContext, records: Vec<UsageRecord>) -> anyhow::Result<()>;
}

/// What a metering gear holds to record usage.
#[derive(Clone)]
pub struct Usage(Recorder);

#[derive(Clone)]
enum Recorder {
    /// The [`UsageRecorder`] registered in the hub, looked up per record.
    Hub(Arc<ClientHub>),
    /// A given recorder: what a test reads back.
    #[cfg(test)]
    Fixed(Arc<dyn UsageRecorder>),
}

impl Usage {
    /// The recorder registered in the hub, looked up per record.
    pub fn new(hub: Arc<ClientHub>) -> Self {
        Self(Recorder::Hub(hub))
    }

    /// A given recorder — what a test reads back.
    #[cfg(test)]
    pub fn fixed(recorder: Arc<dyn UsageRecorder>) -> Self {
        Self(Recorder::Fixed(recorder))
    }

    /// Records nothing.
    #[cfg(test)]
    pub fn none() -> Self {
        Self(Recorder::Hub(Arc::new(ClientHub::new())))
    }

    pub async fn record(
        &self,
        ctx: &SecurityContext,
        records: Vec<UsageRecord>,
    ) -> anyhow::Result<()> {
        if records.is_empty() {
            return Ok(());
        }
        match &self.0 {
            Recorder::Hub(hub) => {
                let Ok(recorder) = hub.get::<dyn UsageRecorder>() else {
                    tracing::debug!("no usage recorder in this assembly: usage is not recorded");
                    return Ok(());
                };
                recorder.record(ctx, records).await
            }
            #[cfg(test)]
            Recorder::Fixed(recorder) => recorder.record(ctx, records).await,
        }
    }
}

#[cfg(test)]
#[path = "metering_tests.rs"]
mod tests;
