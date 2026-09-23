//! `spec_quality.analyze_batch` — one detector over many documents, as one run.
//!
//! ## What this replaces
//!
//! A sweep over a document set was a loop in the browser: submit, wait, submit
//! the next. Twenty documents meant twenty submits and twenty waits driven from
//! a tab that had to stay open, with the portal acting as the scheduler for
//! work that takes minutes. Closing it abandoned the sweep half-done, and
//! nothing recorded that it had happened.
//!
//! Here the sweep is one run. The queue owns it, progress says which document
//! it has reached, and the portal follows the same `task_run` it follows for
//! everything else.
//!
//! ## What it deliberately does NOT do
//!
//! Decide anything. It reports which analyses finished and which did not; what
//! a verdict *means* — the score a caller trusts, whether that clears a gate,
//! whether a type gets bound — stays with the caller. `documents::classify`
//! says the leftover set is the caller's to drive, and moving the fan-out is
//! not a reason to quietly move the policy with it.
//!
//! ## Why the result carries pointers, not verdicts
//!
//! A run's `result` is stored whole and broadcast to every subscriber in the
//! tenant. A detector's verdict is a sizeable document, and fifty of them in
//! one payload would push megabytes down a channel everyone in the
//! organization is reading. So the result names each document's upstream task
//! and how it ended; a caller reads the verdicts it actually wants through
//! `GET /spec-quality/v1/tasks/{task_id}`, which is a cheap finished read
//! rather than a wait.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tracing::warn;

use super::analyze_task::{Watched, watch_upstream};
use super::rest::{ProxyState, accepted_doc_types};
use crate::tasks::registry::{TaskContext, TaskHandler, TaskOutcome};

/// Stable task type. A wire contract: stored on every queued run.
pub const BATCH_TASK_TYPE: &str = "spec_quality.analyze_batch";

/// How long ONE document's analysis may take before the sweep gives up on it.
///
/// Per document rather than per sweep: a set of forty must not fail because it
/// is forty, and one document that hangs must not hold the rest hostage.
const PER_ITEM_DEADLINE: Duration = Duration::from_secs(5 * 60);

/// The most documents one run will accept.
///
/// A sweep is sequential and each item is an LLM round-trip, so two hundred is
/// already the better part of an hour. Refusing a larger set at the door beats
/// accepting a run nobody will wait for.
pub const MAX_ITEMS: usize = 200;

/// One document to analyse: the caller's own id for it, and the detector
/// payload it would have posted.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchItem {
    /// Whatever identifies this document to the caller — a graph node id, a
    /// path. Echoed back untouched, so the caller can join the results up.
    pub id: String,
    /// The body the detector expects for this document. Opaque here.
    pub payload: serde_json::Value,
}

/// What the run carries.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchPayload {
    /// `bloat` | `purpose` | `leak` | `traceability`.
    pub detector: String,
    pub items: Vec<BatchItem>,
}

/// How one document's analysis ended.
#[derive(Debug, Clone, Serialize)]
struct ItemOutcome {
    id: String,
    /// The upstream task to read the verdict from, when there is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    task_id: Option<String>,
    /// `succeeded` | `failed` | `unreachable` | `timed_out` | `not_submitted`.
    status: &'static str,
    /// Why it did not succeed. Absent when it did.
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Runs one detector across a document set.
pub struct AnalyzeBatchTask {
    state: Arc<ProxyState>,
}

impl AnalyzeBatchTask {
    pub fn new(state: Arc<ProxyState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl TaskHandler for AnalyzeBatchTask {
    fn task_type(&self) -> &'static str {
        BATCH_TASK_TYPE
    }

    async fn run(&self, ctx: &TaskContext) -> TaskOutcome {
        let payload: BatchPayload = match serde_json::from_value(ctx.payload.clone()) {
            Ok(p) => p,
            Err(e) => return TaskOutcome::Failed(format!("unreadable batch payload: {e}")),
        };
        if payload.items.is_empty() {
            return TaskOutcome::done_with(
                "nothing to analyse".to_owned(),
                json!({ "detector": payload.detector, "items": [] }),
            );
        }

        let total = payload.items.len();
        let mut outcomes = Vec::with_capacity(total);
        let mut succeeded = 0usize;

        // Asked once, before any submit: the workspace offers more document
        // types than this service analyses -- it owns the templates, the
        // service owns what it can judge -- and a document bound to one of the
        // others used to be found out by posting it and reading
        // `422 Input should be 'prd', 'design', ...` back. That is a round trip
        // to be told something the service publishes, and a failure where the
        // truthful word is "skipped".
        let accepted = accepted_doc_types(&self.state).await;

        for (index, item) in payload.items.iter().enumerate() {
            if ctx.cancelled() {
                // Everything analysed so far is real and worth keeping: report
                // it rather than throwing away an hour of finished work.
                return TaskOutcome::done_with(
                    format!("stopped after {} of {total} — {succeeded} analysed", index),
                    json!({
                        "detector": payload.detector,
                        "stopped": true,
                        "items": outcomes,
                    }),
                );
            }

            ctx.progress(format!("{}/{total} · {}", index + 1, item.id))
                .await;

            if let Some(why) = unanalysable(accepted.as_deref(), &item.payload) {
                outcomes.push(ItemOutcome {
                    id: item.id.clone(),
                    task_id: None,
                    status: "not_submitted",
                    error: Some(why),
                });
                continue;
            }

            // Submitted here rather than up front: submitting all two hundred
            // at once would queue an hour of upstream work that a Stop could no
            // longer call off.
            let submitted = self
                .state
                .upstream_json(
                    reqwest::Method::POST,
                    &format!("/v1/analyze/{}", payload.detector),
                    Some(serde_json::to_vec(&item.payload).unwrap_or_default().into()),
                )
                .await;

            let task_id = match submitted.as_ref().map(|created| {
                created
                    .get("task_id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            }) {
                Ok(Some(task_id)) => task_id,
                Ok(None) => {
                    outcomes.push(ItemOutcome {
                        id: item.id.clone(),
                        task_id: None,
                        status: "not_submitted",
                        error: Some("upstream accepted the analysis without a task_id".to_owned()),
                    });
                    continue;
                }
                Err(e) => {
                    // One document's submit failing is that document's problem.
                    // The sweep carries on — a set of forty must not be lost to
                    // one bad payload.
                    outcomes.push(ItemOutcome {
                        id: item.id.clone(),
                        task_id: None,
                        status: "not_submitted",
                        error: Some(format!("{e:#}")),
                    });
                    continue;
                }
            };

            let watched =
                watch_upstream(&self.state, ctx, &task_id, PER_ITEM_DEADLINE, |_| {}).await;
            outcomes.push(match watched {
                Watched::Succeeded(_) => {
                    succeeded += 1;
                    ItemOutcome {
                        id: item.id.clone(),
                        task_id: Some(task_id),
                        status: "succeeded",
                        error: None,
                    }
                }
                Watched::Failed(message) => ItemOutcome {
                    id: item.id.clone(),
                    task_id: Some(task_id),
                    status: "failed",
                    error: Some(message),
                },
                Watched::Unreachable(why) => {
                    warn!(detector = %payload.detector, item = %item.id, "studio-spec-quality: {why}");
                    ItemOutcome {
                        id: item.id.clone(),
                        task_id: Some(task_id),
                        status: "unreachable",
                        error: Some(why),
                    }
                }
                Watched::Deadline(why) => ItemOutcome {
                    id: item.id.clone(),
                    task_id: Some(task_id),
                    status: "timed_out",
                    error: Some(why),
                },
                Watched::Cancelled => {
                    return TaskOutcome::done_with(
                        format!("stopped after {} of {total} — {succeeded} analysed", index),
                        json!({
                            "detector": payload.detector,
                            "stopped": true,
                            "items": outcomes,
                        }),
                    );
                }
            });
        }

        TaskOutcome::done_with(
            format!("{succeeded} of {total} analysed"),
            json!({
                "detector": payload.detector,
                "items": outcomes,
            }),
        )
    }

    /// One attempt. A sweep is not idempotent in any useful sense — a retry
    /// resubmits every document, paying for the whole set again to recover the
    /// few that failed — and each item already survives its own failure.
    fn max_attempts(&self) -> i16 {
        1
    }
}

/// Why this document cannot be analysed, or `None` to go ahead.
///
/// Only one reason exists: the payload names a `doc_type` the service does not
/// have. The message says what it accepts, because the person reading it is
/// looking at a document type their workspace defines and the upstream has
/// never heard of, and "unsupported" alone would not tell them which half to
/// change.
///
/// `accepted: None` means the service did not say what it takes, and then
/// nothing is refused here: being wrong in that direction costs one 422,
/// while being wrong the other way would silently skip work the service would
/// happily have done.
fn unanalysable(accepted: Option<&[String]>, payload: &serde_json::Value) -> Option<String> {
    let accepted = accepted?;
    let doc_type = payload.get("doc_type")?.as_str()?;
    if accepted.iter().any(|t| t == doc_type) {
        return None;
    }
    Some(format!(
        "Spec Quality does not analyse `{doc_type}` documents; it accepts {}",
        accepted.join(", ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_outcome_omits_the_fields_it_has_nothing_for() {
        let done = ItemOutcome {
            id: "node-1".to_owned(),
            task_id: Some("t-1".to_owned()),
            status: "succeeded",
            error: None,
        };
        let json = serde_json::to_value(&done).unwrap();
        assert_eq!(json["status"], "succeeded");
        assert_eq!(json["task_id"], "t-1");
        assert!(
            json.get("error").is_none(),
            "a succeeded item carries no error: {json}"
        );
    }

    #[test]
    fn a_submit_that_never_happened_names_no_upstream_task() {
        let lost = ItemOutcome {
            id: "node-2".to_owned(),
            task_id: None,
            status: "not_submitted",
            error: Some("upstream refused".to_owned()),
        };
        let json = serde_json::to_value(&lost).unwrap();
        assert!(json.get("task_id").is_none(), "{json}");
        assert_eq!(json["error"], "upstream refused");
    }
    /// The case that sent this: a workspace type the service has no name for.
    #[test]
    fn a_document_type_the_service_does_not_have_is_skipped_rather_than_posted() {
        let accepted = ["prd".to_owned(), "design".to_owned(), "adr".to_owned()];
        let why = unanalysable(
            Some(&accepted),
            &serde_json::json!({ "doc_type": "app_spec", "text": "..." }),
        )
        .expect("app_spec is not one of the three");
        assert!(why.contains("app_spec"), "{why}");
        assert!(why.contains("prd, design, adr"), "{why}");
    }

    #[test]
    fn a_document_type_the_service_has_goes_through() {
        let accepted = ["prd".to_owned(), "design".to_owned()];
        assert!(
            unanalysable(
                Some(&accepted),
                &serde_json::json!({ "doc_type": "prd", "text": "..." })
            )
            .is_none()
        );
    }

    /// Nothing is refused on a guess: a service that did not say what it takes
    /// has not said it takes nothing, and the two detectors that need no type
    /// send none.
    #[test]
    fn nothing_is_refused_when_the_service_did_not_say_or_the_payload_has_no_type() {
        let payload = serde_json::json!({ "doc_type": "app_spec" });
        assert!(unanalysable(None, &payload).is_none());
        let accepted = ["prd".to_owned()];
        assert!(unanalysable(Some(&accepted), &serde_json::json!({ "text": "..." })).is_none());
        assert!(unanalysable(Some(&accepted), &serde_json::json!({ "doc_type": null })).is_none());
    }
}
