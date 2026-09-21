//! The two background tasks that connect this replica to the log.
//!
//! **The writer** drains what `publish` handed over and appends it, taking the
//! tenant's sequence as it goes. It is the only thing that writes.
//!
//! **The poller** reads the log for the tenants this replica currently holds a
//! subscriber for, and pushes what is new into their channels. It is how an
//! event reaches a browser — including one connected to the very replica that
//! published it, because a local shortcut would give local subscribers a
//! different ordering and latency from remote ones.
//!
//! A poll rather than `LISTEN`/`NOTIFY`, for now and on purpose. `NOTIFY`
//! needs a connection held outside the pool for the lifetime of the process,
//! which is a connection per replica taken out of a budget that is already the
//! second thing standing between this deployment and two replicas. A poll of
//! tenants that have a subscriber costs one indexed read per tenant per
//! interval, the interval is the latency, and swapping it for `LISTEN` later
//! changes this file and nothing else.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use super::hub::StudioEventHub;
use super::store::{EventStore, PendingEvent};

/// How many events one poll may carry per tenant. Above this the next tick
/// takes the rest: a burst is delivered a beat later rather than in one frame
/// storm that a slow subscriber would drop anyway.
const POLL_PAGE: u64 = 500;

/// Drain the publish queue into the log.
pub fn spawn_writer(
    mut rx: mpsc::Receiver<PendingEvent>,
    store: Arc<EventStore>,
    cancel: CancellationToken,
) {
    tokio::spawn(async move {
        loop {
            let pending = tokio::select! {
                () = cancel.cancelled() => break,
                received = rx.recv() => match received {
                    Some(event) => event,
                    // Every sender is gone, which means the hub is gone.
                    None => break,
                },
            };

            if let Err(error) = store.append(&pending).await {
                // Not fatal and not retried: the publisher contract is
                // best-effort, and a retry loop here would hold the queue
                // against a database that is already struggling, turning lost
                // events into lost events plus back-pressure.
                warn!(
                    kind = %pending.kind,
                    tenant = %pending.tenant_id,
                    "studio-events: could not append an event: {error:#}"
                );
            }
        }
        info!("studio-events: writer stopped");
    });
}

/// Read the log for locally-subscribed tenants and fan out what is new.
pub fn spawn_poller(
    hub: Arc<StudioEventHub>,
    store: Arc<EventStore>,
    interval: Duration,
    backlog: i64,
    cancel: CancellationToken,
) {
    tokio::spawn(async move {
        let mut ticks: u64 = 0;
        loop {
            tokio::select! {
                () = cancel.cancelled() => break,
                () = tokio::time::sleep(interval) => {}
            }
            ticks += 1;

            for (tenant, mark) in hub.watermarks() {
                match mark {
                    // A channel nobody has aligned yet: take the tenant's
                    // current mark and deliver nothing. A subscriber that just
                    // connected wants what happens next; the gap behind it is
                    // what the replay endpoint answers.
                    None => match store.latest_seq(tenant).await {
                        Ok(latest) => hub.align(tenant, latest),
                        Err(error) => {
                            warn!(%tenant, "studio-events: cannot read the mark: {error:#}");
                        }
                    },
                    Some(after) => match store.after(tenant, after, POLL_PAGE).await {
                        Ok((events, _)) if !events.is_empty() => hub.deliver(tenant, events),
                        Ok(_) => {}
                        Err(error) => {
                            warn!(%tenant, "studio-events: cannot read the log: {error:#}");
                        }
                    },
                }
            }

            // Pruning rides along rather than having a task of its own: the
            // set of tenants worth pruning is the set this replica is already
            // iterating, and the window only needs to be approximately the
            // configured depth.
            //
            // Every replica prunes, which is safe — the delete is bounded by
            // the tenant's own mark, so two replicas doing it at once remove
            // the same rows and the second removes none.
            if ticks.is_multiple_of(PRUNE_EVERY) {
                for (tenant, _) in hub.watermarks() {
                    match store.prune(tenant, backlog).await {
                        Ok(0) => {}
                        Ok(removed) => {
                            info!(%tenant, removed, "studio-events: pruned the replay window");
                        }
                        Err(error) => {
                            warn!(%tenant, "studio-events: cannot prune: {error:#}");
                        }
                    }
                }
            }
        }
        info!("studio-events: poller stopped");
    });
}

/// Polls between prunes. At the default half-second interval this is about
/// once every five minutes per tenant — often enough that the window does not
/// grow without bound, rare enough that it is not part of the read path's
/// cost.
const PRUNE_EVERY: u64 = 600;
