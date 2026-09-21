//! Configuration for the studio-events channel. All defaults are usable; a
//! deployment only touches these to trade memory or database traffic for a
//! longer replay window or a shorter delivery delay.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct StudioEventsConfig {
    /// Per-tenant broadcast buffer. A subscriber further behind than this
    /// drops frames and recovers by cursor.
    #[serde(default = "default_buffer")]
    pub buffer: usize,
    /// How many events per tenant stay replayable through `?after_seq=`.
    /// Sized for a reconnect, not for history — the log is pruned to it.
    #[serde(default = "default_backlog")]
    pub backlog: usize,
    /// How many published events may wait to be written before the channel
    /// starts losing them.
    ///
    /// It is a bound on memory, and losing events at the bound is deliberate:
    /// `publish` is infallible by contract, so the alternatives are to block a
    /// producer that is holding a lock or to grow without limit. A full queue
    /// means the database is slow or gone, and neither of those is improved by
    /// this process holding more of it.
    #[serde(default = "default_queue")]
    pub queue: usize,
    /// How often this replica reads the log for its subscribers, in
    /// milliseconds. This is the delivery delay: an event is visible to a
    /// browser somewhere between zero and this long after it was written.
    #[serde(default = "default_poll_ms")]
    pub poll_ms: u64,
}

fn default_buffer() -> usize {
    256
}

fn default_backlog() -> usize {
    500
}

fn default_queue() -> usize {
    1024
}

/// Half a second: below the threshold where a progress bar looks stuck, and
/// one indexed read per subscribed tenant at that rate is not a load worth
/// optimizing before it is measured.
fn default_poll_ms() -> u64 {
    500
}

impl Default for StudioEventsConfig {
    fn default() -> Self {
        Self {
            buffer: default_buffer(),
            backlog: default_backlog(),
            queue: default_queue(),
            poll_ms: default_poll_ms(),
        }
    }
}
