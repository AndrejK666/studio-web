//! The publisher seam: what another gear needs to emit a studio event.
//!
//! Deliberately free of any producer's vocabulary. A producer states *what
//! happened* (`kind`), *to what* (`subject_type` + `subject_id`) and *who says
//! so* (`source`); the hub owns ordering (`seq`) and time. Nothing here knows
//! about tasks, repositories or IDE sessions — those are payload.

use serde_json::Value;
use uuid::Uuid;

/// One thing that happened, as its producer sees it.
///
/// `seq` and the timestamp are NOT here: they are assigned by the hub on
/// publish, so a producer cannot forge ordering or backdate an event.
#[derive(Debug, Clone)]
pub struct StudioEvent {
    /// Who may see it. The stream never crosses this boundary.
    pub tenant_id: Uuid,
    /// What happened, dotted and past-tense: `task.running`, `task.succeeded`.
    /// Clients filter on the prefix, so keep the first segment stable.
    pub kind: String,
    /// What it happened to — `task`, `repository`, `document`.
    pub subject_type: String,
    /// The subject's id within `subject_type`.
    pub subject_id: String,
    /// The gear that observed it, for debugging and for filtering by origin.
    pub source: String,
    /// Everything type-specific. Shape is the producer's business; the channel
    /// passes it through verbatim.
    pub payload: Value,
}

impl StudioEvent {
    /// A payload-less event. Add one with [`StudioEvent::with_payload`].
    pub fn new(
        tenant_id: Uuid,
        kind: impl Into<String>,
        subject_type: impl Into<String>,
        subject_id: impl Into<String>,
        source: impl Into<String>,
    ) -> Self {
        Self {
            tenant_id,
            kind: kind.into(),
            subject_type: subject_type.into(),
            subject_id: subject_id.into(),
            source: source.into(),
            payload: Value::Null,
        }
    }

    #[must_use]
    pub fn with_payload(mut self, payload: Value) -> Self {
        self.payload = payload;
        self
    }
}

/// Published to the ClientHub by the `studio-events` gear.
///
/// `publish` is deliberately **synchronous and infallible**: producers call it
/// from inside locks and from `Drop`-shaped cleanup paths, and an event that
/// cannot be delivered must never fail the operation that produced it. A
/// future broker-backed implementation spawns its own send; the caller still
/// does not wait and still cannot fail.
pub trait StudioEventPublisher: Send + Sync {
    fn publish(&self, event: StudioEvent);
}

/// How many events about `subject_type` this process has published since it
/// started: a number that moves when such a thing happened here. A reader
/// that keeps answers for a few seconds (the Inbox) compares it with the one
/// its answer was computed under and computes again when it moved. Another
/// replica's events do not move it; the answer's own TTL covers those.
pub fn published(subject_type: &str) -> u64 {
    counts()
        .lock()
        .ok()
        .and_then(|c| c.get(subject_type).copied())
        .unwrap_or(0)
}

pub(super) fn note_published(subject_type: &str) {
    if let Ok(mut c) = counts().lock() {
        *c.entry(subject_type.to_owned()).or_insert(0) += 1;
    }
}

type Counts = std::sync::Mutex<std::collections::HashMap<String, u64>>;

fn counts() -> &'static Counts {
    static COUNTS: std::sync::OnceLock<Counts> = std::sync::OnceLock::new();
    COUNTS.get_or_init(Default::default)
}
