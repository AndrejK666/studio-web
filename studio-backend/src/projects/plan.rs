//! A resumable sequence of writes, and what it is for.
//!
//! Creating a project is not one call. It is a tenant, then its configuration,
//! then a repository created or attached, then — for a gear project — a
//! starter gear written into it, and — for a product — the one document the
//! assembly reads. Four gears, four-to-five non-atomic writes (ADR-0010).
//!
//! ── The failure this exists to stop ──────────────────────────────────────────
//!
//! A sequence that stops halfway leaves a ZOMBIE: a tenant with no
//! configuration, or a configuration with no source. Nothing is wrong enough
//! to notice and nothing is right enough to use.
//!
//! The answer is not a transaction — there is no transaction across four gears
//! — but IDEMPOTENCE. Every step may first ask whether it is already
//! satisfied, by reading real state rather than remembering what it did, and
//! only act when it is not. Running the same plan again then HEALS a
//! half-finished project instead of building a second one beside it.
//!
//! ── Why it is not in the browser any more ────────────────────────────────────
//!
//! It was, in `provision.ts`, and the resumption was real: the card re-ran the
//! plan and the probes short-circuited. What it could not survive was the
//! browser going away. A person who closed the tab on step three had no way to
//! finish — the sequence existed only while the page did, and the zombie it
//! left was the page's to clean up, from the same form.
//!
//! Here it is a run: enqueued, executed by the server, resumable by anyone who
//! has the run id, and reporting its progress the way every other long job in
//! this assembly does.
//!
//! This module is the ENGINE and the shape of a plan. What each step actually
//! does is [`super::steps`], because the engine must not know which gears exist
//! in order to be testable without any of them.

use std::collections::BTreeMap;

use serde::Serialize;

/// Where a step got to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StepStatus {
    /// Not reached. A step after the one that failed stays here.
    Pending,
    Running,
    Done,
    Failed,
}

impl StepStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            StepStatus::Pending => "pending",
            StepStatus::Running => "running",
            StepStatus::Done => "done",
            StepStatus::Failed => "failed",
        }
    }
}

/// One step's progress, as a caller watching the run sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepState {
    /// Stable across retries, so a watcher can match a row to the one before.
    pub key: String,
    /// What to call it on a checklist.
    pub label: String,
    pub status: StepStatus,
    /// Present only when the status is `Failed`.
    pub error: Option<String>,
}

/// What the steps write into and read out of as they go.
///
/// A map rather than a struct because the plan differs by project kind — a
/// gear project has a scaffold, a product has a spec — and a struct with every
/// kind's fields on it would be a struct that is mostly absent. The keys are
/// the contract between one step and the next, and they are named in
/// [`super::steps`].
pub type Context = BTreeMap<String, String>;

/// What a step is, without saying what it does.
#[async_trait::async_trait]
pub trait Step: Send + Sync {
    fn key(&self) -> &str;
    fn label(&self) -> String;

    /// Is this already done — and if so, what did you find?
    ///
    /// Answered by READING the world, never by remembering: a run that was
    /// interrupted remembers nothing, and that is exactly the run this has to
    /// serve. A step whose `run` is itself idempotent — an overwriting PUT —
    /// may say `false` always and simply do it again.
    ///
    /// TAKES THE CONTEXT MUTABLY, and that is not a convenience. A probe that
    /// finds the tenant a previous attempt created has to RECORD it: every
    /// step after this one is about that id, and a satisfied probe that writes
    /// nothing leaves them blind. Skipping the work and dropping what the work
    /// would have produced is worse than not skipping it.
    ///
    /// An error here is NOT a failure of the step. It means the question could
    /// not be asked, and the engine then does the work rather than skipping
    /// it: doing it twice is recoverable when the work is idempotent, and
    /// skipping it wrongly leaves the hole this whole module exists to stop.
    async fn satisfied(&self, ctx: &mut Context) -> anyhow::Result<bool> {
        let _ = ctx;
        Ok(false)
    }

    /// Do the work. An error stops the plan at this step.
    async fn run(&self, ctx: &mut Context) -> anyhow::Result<()>;
}

/// What a plan did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    /// True when every step finished. False when one failed.
    pub ok: bool,
    pub ctx: Context,
    pub states: Vec<StepState>,
}

impl Outcome {
    /// The step that stopped the plan, if one did.
    #[must_use]
    pub fn failure(&self) -> Option<&StepState> {
        self.states.iter().find(|s| s.status == StepStatus::Failed)
    }
}

/// Run `steps` in order against a shared context.
///
/// Sequential on purpose: each step may depend on ids the one before wrote.
/// A step that reports itself satisfied is marked done without running. The
/// first step to fail stops the plan, and every later step stays `Pending` —
/// running the same plan again resumes, because the satisfied ones
/// short-circuit.
///
/// `on_progress` is called on every transition with the whole state list, so a
/// watcher always has the complete picture rather than a delta it has to
/// accumulate.
pub async fn run(
    steps: &[Box<dyn Step>],
    ctx: &mut Context,
    on_progress: &(dyn Fn(&[StepState]) + Send + Sync),
) -> Outcome {
    let mut states: Vec<StepState> = steps
        .iter()
        .map(|step| StepState {
            key: step.key().to_owned(),
            label: step.label(),
            status: StepStatus::Pending,
            error: None,
        })
        .collect();
    on_progress(&states);

    for (i, step) in steps.iter().enumerate() {
        // A probe that cannot answer is not a step that failed: do the work.
        if step.satisfied(ctx).await.unwrap_or(false) {
            states[i].status = StepStatus::Done;
            on_progress(&states);
            continue;
        }
        states[i].status = StepStatus::Running;
        on_progress(&states);

        match step.run(ctx).await {
            Ok(()) => {
                states[i].status = StepStatus::Done;
                on_progress(&states);
            }
            Err(e) => {
                states[i].status = StepStatus::Failed;
                states[i].error = Some(format!("{e:#}"));
                on_progress(&states);
                return Outcome {
                    ok: false,
                    ctx: ctx.clone(),
                    states,
                };
            }
        }
    }

    Outcome {
        ok: true,
        ctx: ctx.clone(),
        states,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A step that records that it ran, and can be told what to answer.
    struct Fake {
        key: &'static str,
        satisfied: Option<bool>,
        /// `None` succeeds; `Some(message)` fails.
        fails: Option<&'static str>,
        /// Probe errors instead of answering.
        probe_errors: bool,
        ran: AtomicUsize,
        writes: Option<(&'static str, &'static str)>,
    }

    impl Fake {
        fn new(key: &'static str) -> Self {
            Self {
                key,
                satisfied: Some(false),
                fails: None,
                probe_errors: false,
                ran: AtomicUsize::new(0),
                writes: None,
            }
        }

        fn already_done(mut self) -> Self {
            self.satisfied = Some(true);
            self
        }

        fn failing(mut self, why: &'static str) -> Self {
            self.fails = Some(why);
            self
        }

        fn unaskable(mut self) -> Self {
            self.probe_errors = true;
            self
        }

        fn writing(mut self, key: &'static str, value: &'static str) -> Self {
            self.writes = Some((key, value));
            self
        }
    }

    #[async_trait::async_trait]
    impl Step for Fake {
        fn key(&self) -> &str {
            self.key
        }
        fn label(&self) -> String {
            self.key.to_owned()
        }
        async fn satisfied(&self, _ctx: &mut Context) -> anyhow::Result<bool> {
            if self.probe_errors {
                anyhow::bail!("cannot ask");
            }
            Ok(self.satisfied.unwrap_or(false))
        }
        async fn run(&self, ctx: &mut Context) -> anyhow::Result<()> {
            self.ran.fetch_add(1, Ordering::SeqCst);
            if let Some((key, value)) = self.writes {
                ctx.insert(key.to_owned(), value.to_owned());
            }
            match self.fails {
                Some(why) => anyhow::bail!("{why}"),
                None => Ok(()),
            }
        }
    }

    fn silent() -> impl Fn(&[StepState]) + Send + Sync {
        |_: &[StepState]| {}
    }

    async fn run_plan(steps: Vec<Box<dyn Step>>) -> (Outcome, Context) {
        let mut ctx = Context::new();
        let outcome = run(&steps, &mut ctx, &silent()).await;
        (outcome, ctx)
    }

    #[tokio::test]
    async fn every_step_runs_in_order_and_the_plan_says_it_is_done() {
        let steps: Vec<Box<dyn Step>> = vec![Box::new(Fake::new("a")), Box::new(Fake::new("b"))];
        let (outcome, _) = run_plan(steps).await;
        assert!(outcome.ok);
        assert_eq!(
            outcome.states.iter().map(|s| s.status).collect::<Vec<_>>(),
            vec![StepStatus::Done, StepStatus::Done]
        );
        assert!(outcome.failure().is_none());
    }

    #[tokio::test]
    async fn a_step_that_is_already_satisfied_is_not_done_again() {
        // This is what makes a second run heal rather than duplicate.
        let already = Box::new(Fake::new("a").already_done());
        let steps: Vec<Box<dyn Step>> = vec![already];
        let mut ctx = Context::new();
        let outcome = run(&steps, &mut ctx, &silent()).await;
        assert!(outcome.ok);
        assert_eq!(outcome.states[0].status, StepStatus::Done);
    }

    #[tokio::test]
    async fn a_probe_that_cannot_answer_makes_the_step_run_rather_than_be_skipped() {
        // Doing idempotent work twice is recoverable; skipping it wrongly
        // leaves the hole this module exists to stop.
        let steps: Vec<Box<dyn Step>> = vec![Box::new(Fake::new("a").unaskable())];
        let (outcome, _) = run_plan(steps).await;
        assert!(outcome.ok);
        assert_eq!(outcome.states[0].status, StepStatus::Done);
    }

    #[tokio::test]
    async fn the_first_failure_stops_the_plan_and_leaves_the_rest_pending() {
        let steps: Vec<Box<dyn Step>> = vec![
            Box::new(Fake::new("a")),
            Box::new(Fake::new("b").failing("no connection")),
            Box::new(Fake::new("c")),
        ];
        let (outcome, _) = run_plan(steps).await;
        assert!(!outcome.ok);
        assert_eq!(
            outcome.states.iter().map(|s| s.status).collect::<Vec<_>>(),
            vec![StepStatus::Done, StepStatus::Failed, StepStatus::Pending]
        );
        let failed = outcome.failure().expect("one failed");
        assert_eq!(failed.key, "b");
        assert!(failed.error.as_deref().unwrap().contains("no connection"));
    }

    #[tokio::test]
    async fn only_the_step_that_failed_carries_a_reason() {
        let steps: Vec<Box<dyn Step>> = vec![
            Box::new(Fake::new("a")),
            Box::new(Fake::new("b").failing("nope")),
        ];
        let (outcome, _) = run_plan(steps).await;
        assert!(outcome.states[0].error.is_none());
        assert!(outcome.states[1].error.is_some());
    }

    #[tokio::test]
    async fn a_step_reads_what_the_step_before_it_wrote() {
        // Sequential on purpose: the tenant id the first step creates is what
        // every later one is about.
        struct Reader;
        #[async_trait::async_trait]
        impl Step for Reader {
            fn key(&self) -> &str {
                "reader"
            }
            fn label(&self) -> String {
                "reader".to_owned()
            }
            async fn run(&self, ctx: &mut Context) -> anyhow::Result<()> {
                anyhow::ensure!(ctx.get("tenant") == Some(&"t-1".to_owned()), "not written");
                Ok(())
            }
        }
        let steps: Vec<Box<dyn Step>> = vec![
            Box::new(Fake::new("writer").writing("tenant", "t-1")),
            Box::new(Reader),
        ];
        let (outcome, ctx) = run_plan(steps).await;
        assert!(outcome.ok, "{:?}", outcome.failure());
        assert_eq!(ctx.get("tenant").map(String::as_str), Some("t-1"));
    }

    #[tokio::test]
    async fn what_a_failed_step_wrote_is_kept_so_a_resume_can_use_it() {
        // The tenant really was created; forgetting its id would make the next
        // attempt create a second one.
        let steps: Vec<Box<dyn Step>> = vec![Box::new(
            Fake::new("half")
                .writing("tenant", "t-1")
                .failing("died after writing"),
        )];
        let (outcome, ctx) = run_plan(steps).await;
        assert!(!outcome.ok);
        assert_eq!(ctx.get("tenant").map(String::as_str), Some("t-1"));
        assert_eq!(outcome.ctx.get("tenant").map(String::as_str), Some("t-1"));
    }

    #[tokio::test]
    async fn progress_is_reported_as_a_whole_picture_on_every_transition() {
        // A watcher joining late, or one that dropped a message, still has the
        // complete state rather than a delta it has to accumulate.
        let seen: Mutex<Vec<Vec<StepStatus>>> = Mutex::new(Vec::new());
        let steps: Vec<Box<dyn Step>> = vec![Box::new(Fake::new("a")), Box::new(Fake::new("b"))];
        let mut ctx = Context::new();
        run(&steps, &mut ctx, &|states: &[StepState]| {
            seen.lock()
                .expect("not poisoned")
                .push(states.iter().map(|s| s.status).collect());
        })
        .await;

        let seen = seen.lock().expect("not poisoned");
        // One on entry, then running/done for each step.
        assert_eq!(seen.first().unwrap(), &vec![StepStatus::Pending; 2]);
        assert_eq!(seen.last().unwrap(), &vec![StepStatus::Done; 2]);
        assert!(
            seen.iter().all(|snapshot| snapshot.len() == 2),
            "every report is the whole list"
        );
    }

    #[tokio::test]
    async fn a_plan_with_no_steps_is_done_rather_than_an_error() {
        // A project kind that needs nothing extra is not a failure.
        let (outcome, _) = run_plan(Vec::new()).await;
        assert!(outcome.ok);
        assert!(outcome.states.is_empty());
    }
    #[tokio::test]
    async fn a_satisfied_probe_records_what_it_found() {
        // The step is skipped, but every step after it is about the id this
        // probe just read. Skipping the work and dropping what the work would
        // have produced leaves them blind — which is how a resumed run failed
        // at the step AFTER the one that was already done.
        struct Finder;
        #[async_trait::async_trait]
        impl Step for Finder {
            fn key(&self) -> &str {
                "finder"
            }
            fn label(&self) -> String {
                "finder".to_owned()
            }
            async fn satisfied(&self, ctx: &mut Context) -> anyhow::Result<bool> {
                ctx.insert("tenant".to_owned(), "found-1".to_owned());
                Ok(true)
            }
            async fn run(&self, _ctx: &mut Context) -> anyhow::Result<()> {
                anyhow::bail!("must not run")
            }
        }
        let steps: Vec<Box<dyn Step>> = vec![Box::new(Finder)];
        let mut ctx = Context::new();
        let outcome = run(&steps, &mut ctx, &silent()).await;
        assert!(outcome.ok, "{:?}", outcome.failure());
        assert_eq!(ctx.get("tenant").map(String::as_str), Some("found-1"));
    }
}
