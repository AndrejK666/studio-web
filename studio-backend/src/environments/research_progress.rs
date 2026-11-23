//! How far a Research build and its deploy are, counted (#1053): the step
//! out of the known steps, and within the upload the files and bytes, within
//! the image builds the images. The counts go into the run's `result` (and its
//! `task.progress` event) under `progress`, beside the text line the run
//! already reports as its phase; a person sees a bar drawn from them and the
//! lines as a log under it.
//!
//! An update is one UPDATE and one event, so it is throttled: it goes out
//! when the step changes, when the share done moved by a whole percent, or
//! when two seconds passed and anything moved.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::connectors::sdk::research::Measured;
use crate::tasks::sdk::TaskContext;

/// The steps from a build to an application that runs, in order. The build
/// run reports the first four, the deploy run the last two.
pub const STEPS: [&str; 6] = ["prepare", "desk", "upload", "images", "deploy", "ready"];

/// The least time between two updates of the same step whose share moved by
/// less than a percent.
const EVERY: Duration = Duration::from_secs(2);

/// One count, done of total.
fn count(done: u64, total: u64) -> Value {
    json!({ "done": done, "total": total })
}

/// The step `m` belongs to.
fn step_of(m: Measured) -> &'static str {
    match m {
        Measured::Desk => "desk",
        Measured::Upload { .. } => "upload",
        Measured::Images { .. } => "images",
    }
}

/// The share of `m` done, in whole percent; `None` where no total is known.
fn percent(m: Measured) -> Option<u64> {
    let (done, total) = match m {
        Measured::Desk => return None,
        // Bytes say it best; a tree of empty files has only its file count.
        Measured::Upload {
            files_done,
            files_total,
            bytes_done,
            bytes_total,
        } => {
            if bytes_total > 0 {
                (bytes_done, bytes_total)
            } else {
                (files_done, files_total)
            }
        }
        Measured::Images { done, total } => (done, total),
    };
    (total > 0).then(|| done.min(total) * 100 / total)
}

/// The run's `result` while it works: `{"progress": {...}}`.
pub fn detail(step: &str, m: Option<Measured>) -> Value {
    let index = STEPS.iter().position(|s| *s == step).unwrap_or(0);
    let mut p = json!({ "step": step, "index": index, "steps": STEPS });
    match m {
        Some(Measured::Upload {
            files_done,
            files_total,
            bytes_done,
            bytes_total,
        }) => {
            p["files"] = count(files_done, files_total);
            p["bytes"] = count(bytes_done, bytes_total);
        }
        Some(Measured::Images { done, total }) => p["images"] = count(done, total),
        Some(Measured::Desk) | None => {}
    }
    json!({ "progress": p })
}

/// When an update is due: what went out last.
#[derive(Debug, Default)]
pub struct Meter {
    last: Option<(&'static str, Option<u64>, Instant, Option<Measured>)>,
}

impl Meter {
    /// Whether `step` at `m` goes out `now`.
    pub fn due(&mut self, step: &'static str, m: Option<Measured>, now: Instant) -> bool {
        let pct = m.and_then(percent);
        let go = match self.last {
            None => true,
            Some((was, _, _, _)) if was != step => true,
            // A whole percent more -- the last of a count too, so a bar ends full.
            Some((_, was_pct, _, _)) if pct.is_some() && was_pct != pct => true,
            Some((_, _, at, was_m)) => was_m != m && now.duration_since(at) >= EVERY,
        };
        if go {
            self.last = Some((step, pct, now, m));
        }
        go
    }
}

/// A run's progress: its text lines, and the counts beside them.
pub struct Reporter<'a> {
    ctx: &'a TaskContext,
    line: Mutex<String>,
    meter: Mutex<Meter>,
}

impl<'a> Reporter<'a> {
    pub fn new(ctx: &'a TaskContext) -> Self {
        Self {
            ctx,
            line: Mutex::new(String::new()),
            meter: Mutex::new(Meter::default()),
        }
    }

    /// A text line: the run's phase, the log under the bar.
    pub async fn say(&self, line: String) {
        if let Ok(mut l) = self.line.lock() {
            l.clone_from(&line);
        }
        self.ctx.progress(line).await;
    }

    /// A step begins, with nothing counted yet.
    pub async fn step(&self, step: &'static str) {
        self.report(step, None).await;
    }

    /// How far the desk build is.
    pub async fn measured(&self, m: Measured) {
        self.report(step_of(m), Some(m)).await;
    }

    async fn report(&self, step: &'static str, m: Option<Measured>) {
        let due = self
            .meter
            .lock()
            .map(|mut meter| meter.due(step, m, Instant::now()))
            .unwrap_or(false);
        if !due {
            return;
        }
        // The phase stays the last line said: the count goes beside it.
        let line = self.line.lock().map(|l| l.clone()).unwrap_or_default();
        let line = if line.is_empty() {
            step.to_owned()
        } else {
            line
        };
        self.ctx.progress_with(line, detail(step, m)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn upload(files_done: u64, bytes_done: u64) -> Measured {
        Measured::Upload {
            files_done,
            files_total: 3812,
            bytes_done,
            bytes_total: 120_000_000,
        }
    }

    #[test]
    fn the_detail_names_the_step_among_the_steps_and_its_counts() {
        let d = detail("upload", Some(upload(1240, 46_000_000)));
        assert_eq!(d["progress"]["step"], "upload");
        assert_eq!(d["progress"]["index"], 2);
        assert_eq!(d["progress"]["steps"].as_array().map(Vec::len), Some(6));
        assert_eq!(d["progress"]["files"], json!({"done": 1240, "total": 3812}));
        assert_eq!(
            d["progress"]["bytes"],
            json!({"done": 46_000_000, "total": 120_000_000})
        );
        let i = detail("images", Some(Measured::Images { done: 1, total: 3 }));
        assert_eq!(i["progress"]["images"], json!({"done": 1, "total": 3}));
        let desk = detail("desk", Some(Measured::Desk));
        assert!(
            desk["progress"].get("files").is_none(),
            "no total at the desk"
        );
    }

    #[test]
    fn an_update_goes_out_per_step_per_percent_or_every_two_seconds() {
        let mut m = Meter::default();
        let t = Instant::now();
        assert!(m.due("desk", Some(Measured::Desk), t), "the first one");
        assert!(
            !m.due("desk", Some(Measured::Desk), t + EVERY * 5),
            "nothing moved"
        );
        assert!(m.due("upload", Some(upload(0, 0)), t), "a new step");
        // 0.5 % in a second: held back.
        assert!(!m.due(
            "upload",
            Some(upload(10, 600_000)),
            t + Duration::from_secs(1)
        ));
        // A whole percent: out at once.
        assert!(m.due(
            "upload",
            Some(upload(40, 1_200_000)),
            t + Duration::from_secs(1)
        ));
        // Less than a percent, but two seconds later: out.
        assert!(!m.due(
            "upload",
            Some(upload(41, 1_300_000)),
            t + Duration::from_secs(2)
        ));
        assert!(m.due(
            "upload",
            Some(upload(42, 1_400_000)),
            t + Duration::from_secs(4)
        ));
        assert!(
            m.due(
                "upload",
                Some(upload(3812, 120_000_000)),
                t + Duration::from_secs(4)
            ),
            "the end"
        );
        assert!(m.due(
            "images",
            Some(Measured::Images { done: 0, total: 2 }),
            t + Duration::from_secs(4)
        ));
    }

    #[test]
    fn a_share_is_by_bytes_and_by_files_when_every_file_is_empty() {
        assert_eq!(percent(upload(1906, 60_000_000)), Some(50));
        let empty = Measured::Upload {
            files_done: 1,
            files_total: 4,
            bytes_done: 0,
            bytes_total: 0,
        };
        assert_eq!(percent(empty), Some(25));
        assert_eq!(percent(Measured::Desk), None);
        assert_eq!(percent(Measured::Images { done: 0, total: 0 }), None);
    }
}
