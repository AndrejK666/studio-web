//! What a running IDE session uses, as usage records (issue #781).
//!
//! A session is metered by sweeping, not by its ending. A pod ends in too many
//! ways for its ending to be the moment it is counted — stopped, reaped,
//! evicted, lost with a node, outliving a backend that restarted — and most of
//! them say nothing to this process. So each reaper pass (every five minutes,
//! `reap_task::CRON`) lists the runtime and records, for every running session,
//! the **five-minute windows** it has completed.
//!
//! A window is the unit because the usage collector deduplicates exactly: a
//! record sent again under the same key with the same content is absorbed, one
//! with different content is a conflict. A window that has ended never changes,
//! so its record — keyed by the launch and the window's start, dated at that
//! start — is the same from every pass and every replica. Each pass sends the
//! windows of the last [`LOOKBACK`], so a pass that was missed is made good by
//! the next; the window a session ends in is lost, at most five minutes.
//!
//! The size recorded is what the pod **requested** (`k8s_session_cpu_request`,
//! `k8s_session_memory_request`): what the cluster holds for it whether it is
//! busy or not, which is what it costs.

use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use crate::usage::sdk::{Payer, Runtime, SESSION_ITEM, Source, TokenCounts, UsageRecord};

/// One metering window.
pub const WINDOW: Duration = Duration::minutes(5);
/// How far back a pass looks for windows to (re)send: six passes.
pub const LOOKBACK: Duration = Duration::minutes(30);

/// A Kubernetes CPU quantity in millicores: `250m`, `2`, `1.5`. `None` when it
/// is not one.
pub fn millicores(quantity: &str) -> Option<u32> {
    let q = quantity.trim();
    if let Some(m) = q.strip_suffix('m') {
        return m.parse().ok();
    }
    let cores: f64 = q.parse().ok()?;
    (cores >= 0.0).then(|| (cores * 1000.0).round() as u32)
}

/// A Kubernetes memory quantity in MiB: `512Mi`, `2Gi`, `1G`, `536870912`.
/// `None` when it is not one.
pub fn mebibytes(quantity: &str) -> Option<u32> {
    let q = quantity.trim();
    let (number, unit) = q
        .find(|c: char| c.is_ascii_alphabetic())
        .map_or((q, ""), |i| q.split_at(i));
    let n: f64 = number.parse().ok()?;
    let bytes = n * match unit {
        "" => 1.0,
        "Ki" => 1024.0,
        "Mi" => 1024.0 * 1024.0,
        "Gi" => 1024.0 * 1024.0 * 1024.0,
        "Ti" => 1024.0_f64.powi(4),
        "k" | "K" => 1e3,
        "M" => 1e6,
        "G" => 1e9,
        "T" => 1e12,
        _ => return None,
    };
    (bytes >= 0.0).then(|| (bytes / (1024.0 * 1024.0)).round() as u32)
}

/// The start of the window `at` falls in.
fn window_of(at: OffsetDateTime) -> OffsetDateTime {
    let secs = at.unix_timestamp();
    let width = WINDOW.whole_seconds();
    OffsetDateTime::from_unix_timestamp(secs - secs.rem_euclid(width)).unwrap_or(at)
}

/// The windows a session started at `created` has completed by `now`, within
/// the last [`LOOKBACK`]: each window's start and the seconds of it the session
/// ran — all of it, except in the window it started in.
pub fn completed_windows(
    created: OffsetDateTime,
    now: OffsetDateTime,
) -> Vec<(OffsetDateTime, u64)> {
    let mut out = Vec::new();
    let mut start = window_of(created.max(now - LOOKBACK));
    while start + WINDOW <= now {
        let end = start + WINDOW;
        let from = created.max(start);
        let seconds = (end - from).whole_seconds().max(0) as u64;
        if seconds > 0 {
            out.push((start, seconds));
        }
        start = end;
    }
    out
}

/// One running session, as the sweep sees it.
pub struct Running {
    pub tenant_id: Uuid,
    /// The launch, or — for a session launched before launches had ids — its
    /// handle and creation time, which name it just as uniquely.
    pub launch: String,
    pub created_at: OffsetDateTime,
}

/// The records of `session`'s completed windows as of `now`.
pub fn records_of(
    session: &Running,
    now: OffsetDateTime,
    driver: &str,
    size: Runtime,
) -> Vec<UsageRecord> {
    completed_windows(session.created_at, now)
        .into_iter()
        .map(|(start, seconds)| UsageRecord {
            key: format!("session:{}:{}", session.launch, start.unix_timestamp()),
            tenant_id: session.tenant_id,
            person_id: None,
            source: Source::Session,
            // The organization's infrastructure, whoever opened it.
            payer: Payer::Organization,
            provider: driver.to_owned(),
            item: SESSION_ITEM.to_owned(),
            occurred_at: start,
            tokens: TokenCounts::default(),
            runtime: Runtime { seconds, ..size },
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use time::macros::datetime;

    use super::*;

    #[test]
    fn cpu_and_memory_quantities_read_as_kubernetes_writes_them() {
        assert_eq!(millicores("250m"), Some(250));
        assert_eq!(millicores("2"), Some(2000));
        assert_eq!(millicores("1.5"), Some(1500));
        assert_eq!(millicores("lots"), None);
        assert_eq!(mebibytes("512Mi"), Some(512));
        assert_eq!(mebibytes("2Gi"), Some(2048));
        assert_eq!(mebibytes("1G"), Some(954));
        assert_eq!(mebibytes("536870912"), Some(512));
        assert_eq!(mebibytes("12Xi"), None);
    }

    /// Only windows that have ended; the first one only from the start.
    #[test]
    fn a_session_counts_its_completed_windows_from_when_it_started() {
        let windows = completed_windows(
            datetime!(2026-10-15 10:02 UTC),
            datetime!(2026-10-15 10:13 UTC),
        );
        assert_eq!(
            windows,
            vec![
                (datetime!(2026-10-15 10:00 UTC), 180),
                (datetime!(2026-10-15 10:05 UTC), 300),
            ]
        );
    }

    /// A long session is looked at only over the lookback: what lies before
    /// was sent by earlier passes.
    #[test]
    fn a_pass_looks_back_only_so_far() {
        let windows = completed_windows(
            datetime!(2026-10-15 06:00 UTC),
            datetime!(2026-10-15 10:00 UTC),
        );
        assert_eq!(windows.len(), 6);
        assert_eq!(windows[0], (datetime!(2026-10-15 09:30 UTC), 300));
    }

    /// Two passes send the same window identically — the collector absorbs the
    /// second — and a later pass adds the windows completed since.
    #[test]
    fn two_passes_send_the_same_windows_the_same_way() {
        let session = Running {
            tenant_id: Uuid::from_u128(7),
            launch: "L1".into(),
            created_at: datetime!(2026-10-15 10:00 UTC),
        };
        let size = Runtime {
            seconds: 0,
            cpu_millicores: 250,
            memory_mib: 512,
        };
        let first = records_of(
            &session,
            datetime!(2026-10-15 10:06 UTC),
            "kubernetes",
            size,
        );
        let later = records_of(
            &session,
            datetime!(2026-10-15 10:11 UTC),
            "kubernetes",
            size,
        );
        assert_eq!(first.len(), 1);
        assert_eq!(later.len(), 2);
        assert_eq!(first[0], later[0]);
        assert_eq!(later[1].runtime.seconds, 300);
        assert_eq!(later[1].runtime.cpu_millicores, 250);
        assert_eq!(later[1].payer, Payer::Organization);
    }
}
