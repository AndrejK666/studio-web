//! The spec pipeline's rules: when a proposal is confirmed without a person,
//! when a step runs again, how a build without a key stops the chain, and
//! that a build that ended hands the pipeline its next turn.
#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{Value, json};
use time::OffsetDateTime;
use toolkit::client_hub::{ClientHub, ClientScope};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::*;
use crate::llm_proxy::port::{CompletionError, CompletionRequest, ModelInfo, ModelProviders};
use crate::tasks::sdk::NewRun;
use crate::tasks::{RunView, TASK_QUEUE_INSTANCE_ID, TaskQueue};

fn settings(enabled: bool, threshold: f32) -> PipelineSettings {
    PipelineSettings {
        enabled,
        auto_confirm_threshold: threshold,
    }
}

// ── settings ─────────────────────────────────────────────────────────────

#[test]
fn a_project_without_settings_runs_the_pipeline_at_eighty_percent() {
    assert_eq!(
        PipelineSettings::from_config(&json!({})),
        settings(true, 0.8)
    );
    assert_eq!(
        PipelineSettings::from_config(&json!({ "sources": [] })),
        settings(true, 0.8)
    );
}

#[test]
fn settings_are_read_from_the_project_config_and_nonsense_is_the_default() {
    let read = |v: Value| PipelineSettings::from_config(&json!({ (CONFIG_KEY): v }));
    assert_eq!(
        read(json!({ "enabled": false, "auto_confirm_threshold": 0.9 })),
        settings(false, 0.9)
    );
    assert_eq!(
        read(json!({ "auto_confirm_threshold": 1.5 })),
        settings(true, 0.8)
    );
    assert_eq!(
        read(json!({ "auto_confirm_threshold": "high" })),
        settings(true, 0.8)
    );
    assert_eq!(read(json!({ "enabled": "yes" })), settings(true, 0.8));
}

#[test]
fn writing_settings_keeps_the_rest_of_the_config_and_says_whether_it_changed() {
    let mut config = json!({ "sources": [{ "full_path": "acme/api" }] });
    assert!(PipelineSettings::write(&mut config, Some(false), None));
    assert_eq!(config["sources"][0]["full_path"], "acme/api");
    assert_eq!(PipelineSettings::from_config(&config), settings(false, 0.8));
    assert!(!PipelineSettings::write(&mut config, Some(false), None));
    assert!(PipelineSettings::write(&mut config, None, Some(0.95)));
    assert_eq!(
        PipelineSettings::from_config(&config),
        settings(false, 0.95)
    );
    // A threshold out of range is not written.
    assert!(!PipelineSettings::write(&mut config, None, Some(2.0)));
}

// ── auto-confirm ─────────────────────────────────────────────────────────

#[test]
fn a_proposal_at_or_over_the_threshold_is_confirmed_by_auto() {
    let s = settings(true, 0.8);
    for (confidence, confirmed) in [
        (Some(0.95), true),
        (Some(0.8), true),
        (Some(0.79), false),
        (None, false),
    ] {
        let (state, by) = auto_settle(BindingState::Detected, confidence, Some(&s));
        if confirmed {
            assert_eq!(state, BindingState::Confirmed, "{confidence:?}");
            assert_eq!(by.as_deref(), Some(CONFIRMED_BY_AUTO));
        } else {
            assert_eq!(state, BindingState::Detected, "{confidence:?}");
            assert_eq!(by, None);
        }
    }
}

#[test]
fn a_threshold_of_one_or_a_pipeline_turned_off_confirms_nothing() {
    for s in [settings(true, 1.0), settings(false, 0.5)] {
        assert_eq!(
            auto_settle(BindingState::Detected, Some(1.0), Some(&s)),
            (BindingState::Detected, None),
            "{s:?}"
        );
    }
    // A workspace-level scan has no project settings.
    assert_eq!(
        auto_settle(BindingState::Detected, Some(0.99), None),
        (BindingState::Detected, None)
    );
}

#[test]
fn only_a_proposal_is_confirmed_automatically() {
    let s = settings(true, 0.5);
    for state in [
        BindingState::Unknown,
        BindingState::Manual,
        BindingState::NotADocument,
        BindingState::Confirmed,
    ] {
        assert_eq!(auto_settle(state, Some(0.99), Some(&s)), (state, None));
    }
}

// ── idempotency ──────────────────────────────────────────────────────────

fn step(state: StepState, input: &str) -> Step {
    Step {
        step: "domain_model".to_owned(),
        state,
        input: Some(input.to_owned()),
        reason: Some("no key".to_owned()),
        ..Step::default()
    }
}

fn idle() -> BuildState {
    BuildState::default()
}

#[test]
fn the_digest_does_not_depend_on_order() {
    assert_eq!(
        digest(["b@2".to_owned(), "a@1".to_owned()]),
        digest(["a@1".to_owned(), "b@2".to_owned()])
    );
    assert_ne!(digest(["a@1".to_owned()]), digest(["a@2".to_owned()]));
}

#[test]
fn the_model_is_not_built_again_while_its_documents_are_unchanged() {
    for state in [StepState::Done, StepState::Unchanged] {
        assert_eq!(
            domain_action(Some(&step(state, "d1")), "d1", &idle()),
            DomainAction::Unchanged
        );
        assert_eq!(
            domain_action(Some(&step(state, "d1")), "d2", &idle()),
            DomainAction::Start,
            "a changed document is read"
        );
    }
    assert_eq!(domain_action(None, "d1", &idle()), DomainAction::Start);
}

#[test]
fn a_build_somebody_runs_is_waited_for_not_doubled() {
    let running = BuildState {
        running: true,
        ..BuildState::default()
    };
    assert_eq!(domain_action(None, "d1", &running), DomainAction::Running);
    assert_eq!(
        domain_action(Some(&step(StepState::Running, "d1")), "d1", &running),
        DomainAction::Running
    );
}

#[test]
fn a_build_lost_with_its_process_starts_again() {
    assert_eq!(
        domain_action(Some(&step(StepState::Running, "d1")), "d1", &idle()),
        DomainAction::Start
    );
}

#[test]
fn product_and_mapping_run_once_per_input() {
    let done = Step {
        step: "product".to_owned(),
        state: StepState::Done,
        input: Some("p1".to_owned()),
        ..Step::default()
    };
    assert!(!due(Some(&done), "p1"));
    assert!(due(Some(&done), "p2"));
    assert!(due(None, "p1"));
    let waiting = Step {
        state: StepState::Waiting,
        ..done.clone()
    };
    assert!(
        due(Some(&waiting), "p1"),
        "a step that only waited never ran"
    );
}

// ── no key: the chain stops with a reason ────────────────────────────────

/// A model client for an organization with no AI connection.
struct Keyless;

#[async_trait]
impl ModelProviders for Keyless {
    async fn list_models(
        &self,
        _: &str,
        _: Option<&str>,
        _: &str,
    ) -> anyhow::Result<Vec<ModelInfo>> {
        Ok(Vec::new())
    }

    async fn complete(
        &self,
        _: &SecurityContext,
        _: &CompletionRequest,
    ) -> Result<Completion, CompletionError> {
        Err(CompletionError::NoKey(
            "no AI connection with a chat model is set up".to_owned(),
        ))
    }
}

use crate::llm_proxy::port::Completion;

fn worker() -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(0x5e))
        .subject_type("service")
        .subject_tenant_id(Uuid::from_u128(0x0a))
        .build()
        .expect("security context")
}

#[tokio::test]
async fn without_a_usable_key_the_build_stops_and_the_step_says_why_and_stays_stopped() {
    use super::super::spec_model::build;
    let stop = build::read_document(
        &Keyless,
        &worker(),
        "docs/prd.md",
        Some("prd"),
        "# PRD\n\nText.\n",
    )
    .await
    .err()
    .expect("no key stops the build");
    let reason = stop.0;
    assert!(reason.contains("no AI connection"), "{reason}");

    // The run after the build ended records the stop, with the reason.
    let ended = BuildState {
        error: Some(reason.clone()),
        finished_at: Some(OffsetDateTime::now_utc()),
        ..BuildState::default()
    };
    let action = domain_action(Some(&step(StepState::Running, "d1")), "d1", &ended);
    assert_eq!(action, DomainAction::Finished(Some(reason.clone())));
    let shown = stopped_reason(&reason);
    assert!(
        shown.contains(&reason) && shown.contains("AI connection"),
        "{shown}"
    );
    assert!(!StepState::Stopped.passed(), "the chain goes no further");

    // The next sync with the same documents does not try again.
    let stopped = Step {
        reason: Some(shown.clone()),
        ..step(StepState::Stopped, "d1")
    };
    assert_eq!(
        domain_action(Some(&stopped), "d1", &ended),
        DomainAction::Held(shown)
    );
    // Changed documents do.
    assert_eq!(
        domain_action(Some(&stopped), "d2", &ended),
        DomainAction::Start
    );
}

// ── the chain goes on ────────────────────────────────────────────────────

#[derive(Default)]
/// One queued call: kind, payload, dedup key, and whether it was a replace.
type Queued = (String, Value, Option<String>, bool);

struct RecordingQueue(Mutex<Vec<Queued>>);

#[async_trait]
impl TaskQueue for RecordingQueue {
    async fn enqueue(&self, _: &SecurityContext, run: NewRun<'_>) -> anyhow::Result<Uuid> {
        self.0.lock().unwrap().push((
            run.task_type.to_owned(),
            run.payload,
            run.partition_key.map(str::to_owned),
            run.coalesce_queued,
        ));
        Ok(Uuid::new_v4())
    }
    async fn run(&self, _: Uuid, _: Uuid) -> anyhow::Result<Option<RunView>> {
        Ok(None)
    }
    async fn request_cancel(&self, _: Uuid, _: Uuid) -> anyhow::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn a_build_that_ended_queues_the_next_turn_of_the_pipeline_once() {
    let queue = Arc::new(RecordingQueue::default());
    let hub = ClientHub::new();
    hub.register_scoped::<dyn TaskQueue>(
        ClientScope::gts_id(TASK_QUEUE_INSTANCE_ID),
        queue.clone(),
    );
    let project = Uuid::from_u128(0x77);

    after_build(&hub, &worker(), project).await;

    let runs = queue.0.lock().unwrap().clone();
    assert_eq!(runs.len(), 1);
    let (task_type, payload, partition, coalesce) = &runs[0];
    assert_eq!(task_type, VIEW.task_type);
    assert_eq!(payload["project_id"], project.to_string());
    assert_eq!(
        partition.as_deref(),
        Some(format!("spec-pipeline:{project}").as_str())
    );
    assert!(
        coalesce,
        "a burst of syncs and builds runs the pipeline once"
    );
}

#[tokio::test]
async fn a_build_that_ended_without_a_queue_does_not_fail() {
    after_build(&ClientHub::new(), &worker(), Uuid::from_u128(0x78)).await;
}

#[test]
fn the_steps_read_back_from_the_view_rows() {
    let rows = vec![
        json!({ "project_id": "p", "step": "specs", "state": "done", "summary": "2 bound" }),
        json!({ "project_id": "p", "step": "product", "state": "stopped", "reason": "no matcher", "input": "x" }),
        json!({ "project_id": "p", "state": "done" }),
    ];
    let steps = steps_of(rows);
    assert_eq!(steps.len(), 2);
    assert_eq!(steps["specs"].state, StepState::Done);
    assert_eq!(steps["product"].reason.as_deref(), Some("no matcher"));
    assert!(!due(Some(&steps["product"]), "x"));
}
