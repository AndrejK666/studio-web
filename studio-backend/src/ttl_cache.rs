//! A short-lived answer cache with single-flight, for reads that are allowed
//! to be a few seconds stale (the Inbox, an organization's overview).
//!
//! Two things a plain `HashMap` of answers does not do:
//! - **Single-flight.** Callers that miss on the same key at the same time
//!   share one computation: the header badge, the Inbox screen and the
//!   Overview used to start three identical reads of every source on one
//!   page load.
//! - **An epoch.** A caller passes a number that moves when something the
//!   answer depends on changed (an event was published); an answer computed
//!   under another epoch is not served.
//!
//! The cache is per process. With two replicas each keeps its own, which is
//! what a TTL this short allows: the owner accepted 30 s of staleness.

use std::collections::HashMap;
use std::future::Future;
use std::hash::Hash;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::OnceCell;

/// One key's answer, or the computation still producing it.
struct Slot<V> {
    epoch: u64,
    cell: Arc<OnceCell<(Instant, V)>>,
}

pub struct TtlCache<K, V> {
    ttl: Duration,
    capacity: usize,
    slots: Mutex<HashMap<K, Slot<V>>>,
}

impl<K: Eq + Hash + Clone, V: Clone> TtlCache<K, V> {
    /// Answers live `ttl`; past `capacity` keys the expired ones go, and if
    /// that is not enough, everything.
    pub fn new(ttl: Duration, capacity: usize) -> Self {
        Self {
            ttl,
            capacity: capacity.max(1),
            slots: Mutex::new(HashMap::new()),
        }
    }

    /// The kept answer for `key`, when it is fresh and was computed under
    /// `epoch`; the running computation's, when one is running under it;
    /// otherwise `compute`'s. An answer `keep` refuses is handed to everyone
    /// who waited for it but not kept for the next caller (a read that could
    /// not reach a source should be retried, not served for the whole TTL).
    pub async fn get_or_compute<F, Fut>(
        &self,
        key: K,
        epoch: u64,
        compute: F,
        keep: impl FnOnce(&V) -> bool,
    ) -> V
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = V>,
    {
        let cell = self.slot(&key, epoch);
        let (_, value) = cell
            .get_or_init(|| async {
                let started = Instant::now();
                (started, compute().await)
            })
            .await;
        let value = value.clone();
        if !keep(&value) {
            self.forget_cell(&key, &cell);
        }
        value
    }

    /// The cell to wait on: the existing one when it is usable, else a new
    /// one put in its place.
    fn slot(&self, key: &K, epoch: u64) -> Arc<OnceCell<(Instant, V)>> {
        let Ok(mut slots) = self.slots.lock() else {
            // A poisoned lock: compute without caching rather than fail.
            return Arc::new(OnceCell::new());
        };
        if let Some(slot) = slots.get(key)
            && slot.epoch == epoch
        {
            match slot.cell.get() {
                // In flight under the same epoch: join it.
                None => return Arc::clone(&slot.cell),
                Some((at, _)) if at.elapsed() < self.ttl => return Arc::clone(&slot.cell),
                Some(_) => {}
            }
        }
        if slots.len() >= self.capacity && !slots.contains_key(key) {
            let ttl = self.ttl;
            slots.retain(|_, s| s.cell.get().is_none_or(|(at, _)| at.elapsed() < ttl));
            if slots.len() >= self.capacity {
                slots.clear();
            }
        }
        let cell = Arc::new(OnceCell::new());
        slots.insert(
            key.clone(),
            Slot {
                epoch,
                cell: Arc::clone(&cell),
            },
        );
        cell
    }

    /// Remove `key` only while it still holds `cell`: a newer computation
    /// that replaced it stays.
    fn forget_cell(&self, key: &K, cell: &Arc<OnceCell<(Instant, V)>>) {
        if let Ok(mut slots) = self.slots.lock()
            && slots.get(key).is_some_and(|s| Arc::ptr_eq(&s.cell, cell))
        {
            slots.remove(key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn counting(
        calls: &Arc<AtomicUsize>,
        value: u32,
        wait: Duration,
    ) -> impl FnOnce() -> std::pin::Pin<Box<dyn Future<Output = u32> + Send>> + use<> {
        let calls = Arc::clone(calls);
        move || {
            Box::pin(async move {
                calls.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(wait).await;
                value
            })
        }
    }

    #[tokio::test]
    async fn concurrent_misses_share_one_computation() {
        let cache: Arc<TtlCache<&str, u32>> = Arc::new(TtlCache::new(Duration::from_secs(30), 8));
        let calls = Arc::new(AtomicUsize::new(0));
        let mut joins = Vec::new();
        for _ in 0..5 {
            let cache = Arc::clone(&cache);
            let f = counting(&calls, 7, Duration::from_millis(50));
            joins.push(tokio::spawn(async move {
                cache.get_or_compute("k", 0, f, |_| true).await
            }));
        }
        for j in joins {
            assert_eq!(j.await.unwrap(), 7);
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // And the next caller is served the kept answer.
        let again = cache
            .get_or_compute("k", 0, counting(&calls, 8, Duration::ZERO), |_| true)
            .await;
        assert_eq!(again, 7);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn an_expired_answer_is_computed_again() {
        let cache: TtlCache<&str, u32> = TtlCache::new(Duration::from_millis(20), 8);
        let calls = Arc::new(AtomicUsize::new(0));
        let first = cache
            .get_or_compute("k", 0, counting(&calls, 1, Duration::ZERO), |_| true)
            .await;
        tokio::time::sleep(Duration::from_millis(40)).await;
        let second = cache
            .get_or_compute("k", 0, counting(&calls, 2, Duration::ZERO), |_| true)
            .await;
        assert_eq!((first, second), (1, 2));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn another_epoch_computes_again() {
        let cache: TtlCache<&str, u32> = TtlCache::new(Duration::from_secs(30), 8);
        let calls = Arc::new(AtomicUsize::new(0));
        cache
            .get_or_compute("k", 0, counting(&calls, 1, Duration::ZERO), |_| true)
            .await;
        let moved = cache
            .get_or_compute("k", 1, counting(&calls, 2, Duration::ZERO), |_| true)
            .await;
        assert_eq!(moved, 2);
        let same = cache
            .get_or_compute("k", 1, counting(&calls, 3, Duration::ZERO), |_| true)
            .await;
        assert_eq!(same, 2);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn an_answer_keep_refuses_is_not_served_again() {
        let cache: TtlCache<&str, u32> = TtlCache::new(Duration::from_secs(30), 8);
        let calls = Arc::new(AtomicUsize::new(0));
        let first = cache
            .get_or_compute("k", 0, counting(&calls, 1, Duration::ZERO), |v| *v != 1)
            .await;
        let second = cache
            .get_or_compute("k", 0, counting(&calls, 2, Duration::ZERO), |v| *v != 1)
            .await;
        assert_eq!((first, second), (1, 2));
    }

    #[tokio::test]
    async fn a_full_cache_makes_room() {
        let cache: TtlCache<u32, u32> = TtlCache::new(Duration::from_secs(30), 2);
        let calls = Arc::new(AtomicUsize::new(0));
        for k in 0..5 {
            let v = cache
                .get_or_compute(k, 0, counting(&calls, k, Duration::ZERO), |_| true)
                .await;
            assert_eq!(v, k);
        }
        assert!(cache.slots.lock().unwrap().len() <= 2);
    }
}
