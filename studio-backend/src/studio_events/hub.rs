//! The local fan-out, and the seam between a producer and the durable log.
//!
//! WHAT CHANGED, AND WHY THE WIRE DID NOT
//!
//! This used to be the whole channel: a broadcaster per tenant, a `VecDeque`
//! of recent events, and a counter handing out `seq`. All three were per
//! process, which is exactly one replica's worth. Two replicas meant two
//! independent sequences for the same tenant — so an event published on one
//! never reached a subscriber on the other, and worse, `?after_seq=` meant
//! something different on each of them, so a reconnect that landed elsewhere
//! replayed the wrong window without erroring.
//!
//! The sequence and the window now live in Postgres ([`super::store`]). What
//! stays here is the part that genuinely is per process: the set of live SSE
//! subscribers this replica is holding open.
//!
//! **Every replica learns about an event the same way** — by reading the log —
//! including the one whose producer published it. There is no local shortcut,
//! deliberately: a shortcut would give local subscribers a different ordering
//! and a different latency from remote ones, and that difference would only
//! ever show up under load, in production, on one replica.
//!
//! `publish` stays synchronous and infallible, because its callers hold locks
//! and run in cleanup paths ([`super::api::StudioEventPublisher`]). It hands
//! the event to the writer task and returns; the writer takes the sequence and
//! appends.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::mpsc;
use toolkit::SseBroadcaster;
use tracing::warn;
use uuid::Uuid;

use super::api::{StudioEvent, StudioEventPublisher};
use super::dto::StudioEventDto;
use super::store::PendingEvent;

/// One tenant's live subscribers on this replica.
struct LocalChannel {
    live: SseBroadcaster<StudioEventDto>,
    /// The highest `seq` this process has already pushed into `live`.
    ///
    /// `None` means "not yet aligned with the log". The poller resolves it to
    /// the tenant's current mark **without delivering anything**, because a
    /// subscriber that has just connected wants what happens next; the gap
    /// before it is what the replay endpoint is for. Delivering the retained
    /// window into the live stream instead would hand every new subscriber a
    /// burst of history it did not ask for and cannot position.
    delivered: Option<i64>,
}

/// Fan-out for this replica, plus the producer seam.
pub struct StudioEventHub {
    tenants: Mutex<HashMap<Uuid, LocalChannel>>,
    /// Broadcast buffer per tenant. A subscriber that falls this far behind
    /// drops frames (tokio's broadcast semantics) — and then recovers by
    /// cursor, which is why the log exists.
    buffer: usize,
    to_writer: mpsc::Sender<PendingEvent>,
    /// Events `publish` could not hand over. Counted rather than logged one by
    /// one: the condition that produces them produces many.
    dropped: AtomicU64,
}

impl StudioEventHub {
    pub fn new(buffer: usize, to_writer: mpsc::Sender<PendingEvent>) -> Self {
        Self {
            tenants: Mutex::new(HashMap::new()),
            buffer: buffer.max(1),
            to_writer,
            dropped: AtomicU64::new(0),
        }
    }

    /// The tenant's live channel, created on first use.
    pub fn channel(&self, tenant_id: Uuid) -> SseBroadcaster<StudioEventDto> {
        self.lock()
            .entry(tenant_id)
            .or_insert_with(|| LocalChannel {
                live: SseBroadcaster::new(self.buffer),
                delivered: None,
            })
            .live
            .clone()
    }

    /// Every tenant this replica currently holds a channel for, with the
    /// watermark the poller last left. A snapshot: the poller must not hold
    /// this lock across a database read.
    pub(super) fn watermarks(&self) -> Vec<(Uuid, Option<i64>)> {
        self.lock()
            .iter()
            .map(|(tenant, channel)| (*tenant, channel.delivered))
            .collect()
    }

    /// Align a tenant's watermark without delivering — used once, when a
    /// channel is first opened.
    pub(super) fn align(&self, tenant_id: Uuid, seq: i64) {
        if let Some(channel) = self.lock().get_mut(&tenant_id) {
            // Only if still unaligned: a delivery may have raced ahead of the
            // read that produced `seq`, and moving the watermark backwards
            // would replay events the subscriber already has.
            if channel.delivered.is_none() {
                channel.delivered = Some(seq);
            }
        }
    }

    /// Push events read from the log into this replica's subscribers.
    ///
    /// `events` must be in ascending `seq` order, which is what the store
    /// returns. The watermark advances to the last one.
    pub(super) fn deliver(&self, tenant_id: Uuid, events: Vec<StudioEventDto>) {
        let Some(last) = events.last().map(|e| e.seq) else {
            return;
        };
        // Take the handle under the lock, send outside it: broadcasting never
        // blocks, but the lock has no business being held across it.
        let live = {
            let mut tenants = self.lock();
            let Some(channel) = tenants.get_mut(&tenant_id) else {
                return;
            };
            channel.delivered = Some(last);
            channel.live.clone()
        };
        for event in events {
            live.send(event);
        }
    }

    /// How many events were dropped before reaching the writer, total.
    #[cfg(test)]
    pub(super) fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    /// Poisoned-lock recovery: a panic while holding this lock would otherwise
    /// take the whole channel down for the rest of the process, and the state
    /// behind it is a set of subscribers, not a ledger.
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<Uuid, LocalChannel>> {
        self.tenants
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl StudioEventPublisher for StudioEventHub {
    fn publish(&self, event: StudioEvent) {
        let at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as i64);

        let pending = PendingEvent {
            tenant_id: event.tenant_id,
            at_ms,
            kind: event.kind,
            subject_type: event.subject_type,
            subject_id: event.subject_id,
            source: event.source,
            payload: event.payload,
        };

        // `try_send`, never `send`: this is called from inside locks and from
        // cleanup paths, so it must not await and must not fail the caller.
        // A full queue means the writer is not keeping up with a database that
        // is slow or gone, and the honest response to that is to lose the
        // event rather than the operation that produced it — which is what the
        // publisher contract has always promised.
        if self.to_writer.try_send(pending).is_err() {
            let dropped = self.dropped.fetch_add(1, Ordering::Relaxed) + 1;
            // Only the first, and then powers of ten: the condition is bursty
            // and a line per event would bury the reason in its own symptom.
            if dropped == 1 || is_power_of_ten(dropped) {
                warn!(
                    dropped,
                    "studio-events: the writer queue is full or closed — events are being lost"
                );
            }
        }
    }
}

/// `n` is 1, 10, 100, … — used to thin a log line that would otherwise repeat
/// once per lost event.
fn is_power_of_ten(mut n: u64) -> bool {
    if n == 0 {
        return false;
    }
    while n.is_multiple_of(10) {
        n /= 10;
    }
    n == 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;
    use serde_json::json;

    fn dto(seq: i64, kind: &str) -> StudioEventDto {
        StudioEventDto {
            seq,
            at_ms: 0,
            kind: kind.to_owned(),
            subject_type: "task".to_owned(),
            subject_id: "t-1".to_owned(),
            source: "test".to_owned(),
            payload: json!({ "ok": true }),
        }
    }

    fn hub(capacity: usize) -> (StudioEventHub, mpsc::Receiver<PendingEvent>) {
        let (tx, rx) = mpsc::channel(capacity);
        (StudioEventHub::new(8, tx), rx)
    }

    #[test]
    fn publish_hands_the_event_to_the_writer_without_blocking() {
        let (hub, mut rx) = hub(4);
        let tenant = Uuid::new_v4();
        hub.publish(StudioEvent::new(
            tenant,
            "task.succeeded",
            "task",
            "t-1",
            "test",
        ));

        let queued = rx.try_recv().expect("the event should reach the writer");
        assert_eq!(queued.tenant_id, tenant);
        assert_eq!(queued.kind, "task.succeeded");
        assert_eq!(hub.dropped(), 0);
    }

    /// The publisher contract: an event that cannot be delivered must never
    /// fail the operation that produced it. A full queue therefore loses
    /// events and says so — it does not block and it does not panic.
    #[test]
    fn a_full_queue_loses_the_event_and_not_the_caller() {
        let (hub, _rx) = hub(1);
        let tenant = Uuid::new_v4();
        for _ in 0..5 {
            hub.publish(StudioEvent::new(tenant, "task.progress", "task", "t", "x"));
        }
        assert_eq!(hub.dropped(), 4, "one fits, the rest are counted");
    }

    /// A new subscriber is aligned to the tenant's current mark rather than
    /// handed the retained window: what came before is the replay endpoint's
    /// job.
    #[test]
    fn a_new_channel_is_aligned_without_delivering() {
        let (hub, _rx) = hub(4);
        let tenant = Uuid::new_v4();
        let _ = hub.channel(tenant);
        assert_eq!(hub.watermarks(), vec![(tenant, None)]);

        hub.align(tenant, 42);
        assert_eq!(hub.watermarks(), vec![(tenant, Some(42))]);

        // Aligning again must not move it backwards.
        hub.align(tenant, 7);
        assert_eq!(hub.watermarks(), vec![(tenant, Some(42))]);
    }

    #[tokio::test]
    async fn delivered_events_reach_a_subscriber_and_advance_the_watermark() {
        let (hub, _rx) = hub(4);
        let tenant = Uuid::new_v4();
        // Subscribe first: the broadcaster only delivers what is sent after.
        let mut stream = Box::pin(hub.channel(tenant).subscribe_stream());

        hub.deliver(
            tenant,
            vec![dto(7, "task.running"), dto(8, "task.succeeded")],
        );

        for expected in ["task.running", "task.succeeded"] {
            let received = tokio::time::timeout(std::time::Duration::from_secs(2), stream.next())
                .await
                .expect("an event should arrive on the live channel")
                .expect("the stream should not end");
            assert_eq!(received.kind, expected);
        }
        assert_eq!(
            hub.watermarks(),
            vec![(tenant, Some(8))],
            "the watermark follows the last seq delivered"
        );
    }

    /// One tenant's delivery must never reach another's subscribers — the
    /// property that was structural when each tenant had its own broadcaster,
    /// and still is.
    #[tokio::test]
    async fn one_tenants_events_do_not_reach_another() {
        let (hub, _rx) = hub(4);
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let mut theirs = Box::pin(hub.channel(b).subscribe_stream());

        hub.deliver(a, vec![dto(1, "task.queued")]);

        let nothing =
            tokio::time::timeout(std::time::Duration::from_millis(200), theirs.next()).await;
        assert!(nothing.is_err(), "b's stream stays silent");
    }
}
