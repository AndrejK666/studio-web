//! A small in-process memo for reads that are slow and change rarely.
//!
//! The catalogue's listings are several graph walks each, and the delivery
//! numbers several warehouse round trips; screens ask for them on every
//! open. A value is kept under a key that names whose answer it is (the
//! tenant first, so nothing is served across tenants) and the catalogue
//! generation it was built at (`CatalogService::generation`), so a write
//! through this replica is never followed by the old answer. The time to
//! live bounds what this replica cannot see: a write on the other replica,
//! or a node another gear wrote of a type marked as a component.
//!
//! A memo is asked only after the caller has been authorised for the key's
//! tenant; it holds answers, never permissions.

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub(crate) struct Memo<K, V> {
    ttl: Duration,
    /// Keys remembered at most; past it, the memo starts over rather than
    /// keep an eviction order, as `project_gears::Cache` does.
    capacity: usize,
    entries: Mutex<HashMap<K, (u64, Instant, V)>>,
}

impl<K: Eq + Hash, V: Clone> Memo<K, V> {
    pub(crate) fn new(ttl: Duration, capacity: usize) -> Self {
        Self {
            ttl,
            capacity,
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// The value kept under `key`, when it was built at `generation` and is
    /// younger than the time to live.
    pub(crate) fn get(&self, key: &K, generation: u64) -> Option<V> {
        let entries = self.entries.lock().ok()?;
        entries
            .get(key)
            .filter(|(g, at, _)| *g == generation && at.elapsed() < self.ttl)
            .map(|(_, _, v)| v.clone())
    }

    pub(crate) fn put(&self, key: K, generation: u64, value: V) {
        if let Ok(mut entries) = self.entries.lock() {
            if entries.len() >= self.capacity && !entries.contains_key(&key) {
                entries.clear();
            }
            entries.insert(key, (generation, Instant::now(), value));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn memo() -> Memo<(Uuid, u32), String> {
        Memo::new(Duration::from_secs(60), 4)
    }

    #[test]
    fn a_kept_value_is_served_while_the_generation_holds() {
        let m = memo();
        let t = Uuid::new_v4();
        m.put((t, 30), 7, "answer".to_owned());
        assert_eq!(m.get(&(t, 30), 7).as_deref(), Some("answer"));
    }

    #[test]
    fn a_write_since_the_value_was_built_makes_it_old() {
        let m = memo();
        let t = Uuid::new_v4();
        m.put((t, 30), 7, "answer".to_owned());
        assert!(m.get(&(t, 30), 8).is_none());
    }

    #[test]
    fn one_tenants_answer_is_not_anothers() {
        let m = memo();
        m.put((Uuid::new_v4(), 30), 7, "answer".to_owned());
        assert!(m.get(&(Uuid::new_v4(), 30), 7).is_none());
    }

    #[test]
    fn another_window_is_another_answer() {
        let m = memo();
        let t = Uuid::new_v4();
        m.put((t, 30), 7, "answer".to_owned());
        assert!(m.get(&(t, 90), 7).is_none());
    }

    #[test]
    fn a_value_past_its_time_to_live_is_not_served() {
        let m: Memo<Uuid, String> = Memo::new(Duration::ZERO, 4);
        let t = Uuid::new_v4();
        m.put(t, 7, "answer".to_owned());
        assert!(m.get(&t, 7).is_none());
    }

    #[test]
    fn a_full_memo_starts_over_rather_than_grow() {
        let m: Memo<u32, u32> = Memo::new(Duration::from_secs(60), 2);
        m.put(1, 0, 1);
        m.put(2, 0, 2);
        m.put(3, 0, 3);
        assert!(m.get(&1, 0).is_none());
        assert_eq!(m.get(&3, 0), Some(3));
    }
}
