//! The `artifact.ingest` task: one repository's issues, pull requests and
//! files into the artifact graph.
//!
//! ## Why this one moved
//!
//! Cloning a repository and walking it takes seconds to minutes, so this was
//! already a background job — `tokio::spawn` plus a `Mutex<HashMap<String,
//! TaskRecord>>` that died with the process. A poll arriving after a redeploy
//! answered "no such sync task" about a sync that had really run, a sync
//! interrupted mid-clone left nothing behind, and there was no way to cancel
//! one or to see the ones that failed yesterday.
//!
//! Now it is a run, and the poll endpoint reads that run.
//!
//! ## The token is not in the payload
//!
//! The old path resolved the connector token in the request handler and moved
//! it into the spawned job. A queued run is a database row, possibly read
//! minutes later by another process, and a bearer token has no business living
//! there. So the payload carries the credstore *reference* and the handler
//! resolves it per attempt — which also means a rotated token is picked up by
//! a retry instead of failing it.
//!
//! The route still resolves the token once, before enqueuing, so a wrong
//! `secret_ref` is answered with a 400 there rather than found by a poll.
//!
//! ## A sync too big for one attempt goes on in the next
//!
//! An attempt holds the queue's lease for fifteen minutes. A repository with
//! ten thousand merge requests and twenty thousand commits needs longer than
//! that just to list them, then to link each pull request to the files it
//! changed (one provider call apiece) -- and on GitLab to read each merge
//! request's and issue's comments, one call apiece too -- so an attempt works
//! to [`ATTEMPT_BUDGET`], stores what it has, and -- when some is left --
//! answers `Retry` with "listed … so far", "linked X of Y" or "read the
//! comments of X of Y". The next attempt asks only about what is not done
//! yet: where the listings got to is kept on the repository node
//! (`listing_cursor`), which items are done on their own nodes (`pr_links`,
//! `item_comments`) -- in the graph, not on the run, so a retry by hand and
//! the next scheduled sync go on from there too. An attempt that is the last
//! one ends `Done` with the count: what it stored is good, and the next sync
//! does the rest.

use crate::plural::plural;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::tasks::sdk::{TaskContext, TaskHandler, TaskOutcome};

use super::service::IngestService;

/// Task type. A wire contract: stored on every queued run.
pub const TASK_TYPE: &str = "artifact.ingest";

/// How many ingests this process runs at once: `ingest.parallel` in the
/// gear's config, set once at init ([`set_ingest_parallel`]).
///
/// The task queue runs eight handlers at once, and runs for different
/// repositories do not share a partition, so large repositories could ingest
/// side by side and peak together -- the shape of the OOM kills on studio-dev
/// (studio-web#561), after which #563 held it to one. Storing is chunked and
/// pull request linking runs in portions since, so an ingest peaks lower and
/// a deployment with the memory may run more. An ingest past the limit waits
/// here. Other task types are not held up: the wait occupies one worker, and
/// there are eight. Unset (tests, a gear that never ran init) is one.
static INGEST_SLOTS: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();

/// The most ingests one process runs at once: the queue's handler count.
/// More would only queue behind the handlers anyway.
const MAX_INGEST_PARALLEL: usize = 8;

/// The ingest slots for `parallel` from config, clamped to
/// `1..=MAX_INGEST_PARALLEL`: zero would stall every sync, and more than the
/// queue's handlers buys nothing.
fn ingest_slots_for(parallel: usize) -> tokio::sync::Semaphore {
    tokio::sync::Semaphore::new(parallel.clamp(1, MAX_INGEST_PARALLEL))
}

/// Size the ingest slots from config; returns how many this process runs.
/// The first call wins: the gear inits once per process, and a semaphore
/// already handed out must not change under the runs holding it.
pub(super) fn set_ingest_parallel(parallel: usize) -> usize {
    let slots = ingest_slots_for(parallel);
    let n = slots.available_permits();
    if INGEST_SLOTS.set(Arc::new(slots)).is_err() {
        tracing::warn!(
            parallel = n,
            "studio-artifact-ingest: ingest slots were already sized; keeping them"
        );
    }
    n
}

fn ingest_slots() -> &'static Arc<tokio::sync::Semaphore> {
    INGEST_SLOTS.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(1)))
}

/// How long one attempt works before it stops to store what it has.
///
/// The queue's lease is fifteen minutes, less ten seconds for the ack
/// (`tasks::LEASE`); an attempt still running then is cut off and everything
/// it had not stored is lost. Twelve minutes leaves the rest for the writes
/// that close a sync -- the relations, the repository's record -- which a
/// large repository needs a minute or two for. Counted from when the attempt
/// was handed over, because waiting for an ingest slot ([`INGEST_SLOTS`])
/// spends the lease too.
const ATTEMPT_BUDGET: Duration = Duration::from_secs(12 * 60);

/// Attempts a run gets. More than the queue's default five: an attempt that
/// stops with pull requests still to link hands on to the next, and a large
/// repository's first sync can take a few of those besides a real failure.
const ATTEMPTS: i16 = 8;

/// What a partial sync got through of the work it does in portions, in
/// words: the listings read so far, the pull requests linked to their files
/// and the items whose comments were read, each only when some of it is left.
fn left_over(counts: &super::service::SyncSummary, noun: &dyn Fn(usize) -> String) -> String {
    let mut parts: Vec<String> = Vec::new();
    if counts.listings_left > 0 {
        parts.push(format!(
            "listed {}, {}, {} and {} so far, {} not read to the end yet",
            plural(counts.issues, "issue", "issues"),
            noun(counts.pull_requests),
            plural(counts.comments, "comment", "comments"),
            plural(counts.commits, "commit", "commits"),
            plural(counts.listings_left, "listing", "listings"),
        ));
    } else if counts.rest_left {
        parts.push(format!(
            "listed all {}, {}, {} and {}; the files, the links and the comments are left",
            plural(counts.issues, "issue", "issues"),
            noun(counts.pull_requests),
            plural(counts.comments, "comment", "comments"),
            plural(counts.commits, "commit", "commits"),
        ));
    }
    if counts.links_left > 0 {
        parts.push(format!(
            "linked {} of {} to their files, {} left",
            counts.links_done,
            noun(counts.links_total),
            counts.links_left
        ));
    }
    if counts.comment_items_left > 0 {
        parts.push(format!(
            "read the comments of {} of {}, {} left",
            counts.comment_items_done,
            plural(counts.comment_items_total, "item", "items"),
            counts.comment_items_left
        ));
    }
    parts.join("; ")
}

/// What the REST route puts on the queue.
///
/// `Serialize` as well as `Deserialize`: the route builds one and the poll
/// endpoint reads it back off the run to answer with the repository it names,
/// so the two cannot drift.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IngestPayload {
    pub provider: String,
    #[serde(default)]
    pub base_url: Option<String>,
    /// credstore reference for the connector token — not the token.
    pub secret_ref: String,
    pub repo_full_path: String,
    #[serde(default)]
    pub since: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub repo_dir: Option<String>,
    /// The organization the run is filed under and writes in: the project's
    /// (`IngestService::run_tenant`). For the record: the sync resolves it
    /// again from the project, which also covers a run queued before this
    /// field, in whichever tenant that was filed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization_id: Option<Uuid>,
    /// The home tenant of whoever asked, for the token check: whose rights
    /// the sync reads with is decided as the caller
    /// (`connectors::sdk::ownership`), not as the organization the run is
    /// filed under. Absent: the run's own tenant, as before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_in: Option<Uuid>,
}

impl IngestPayload {
    /// The tenant the sync is for: its project, else its workspace, else
    /// `run_tenant` (the run's own). An id that does not parse is the run's
    /// tenant too: the ownership check then asks about that.
    pub fn tenant(&self, run_tenant: Uuid) -> Uuid {
        self.project_id
            .as_deref()
            .or(self.workspace_id.as_deref())
            .and_then(|id| Uuid::parse_str(id.trim()).ok())
            .unwrap_or(run_tenant)
    }

    /// Two syncs that would write the same graph keys must not run at once.
    /// Those keys are built from exactly these four things (see `gts::*_node`),
    /// so the same four make the partition key: the same repository under a
    /// different project is a different set of nodes and may run in parallel.
    ///
    /// Both enqueues of this task — the portal's sync and a push through
    /// `studio-git` — take the key from here, so the two queue behind each
    /// other instead of racing on one checkout.
    pub fn partition_key(&self) -> String {
        let scope = self
            .project_id
            .as_deref()
            .or(self.workspace_id.as_deref())
            .unwrap_or("unscoped");
        format!(
            "{}:{}:{scope}:{}",
            self.provider, self.secret_ref, self.repo_full_path
        )
    }
}

pub struct IngestTask {
    service: Arc<IngestService>,
}

impl IngestTask {
    pub fn new(service: Arc<IngestService>) -> Self {
        Self { service }
    }
}

#[async_trait]
impl TaskHandler for IngestTask {
    fn task_type(&self) -> &'static str {
        TASK_TYPE
    }

    fn max_attempts(&self) -> i16 {
        ATTEMPTS
    }

    async fn run(&self, ctx: &TaskContext) -> TaskOutcome {
        let deadline = Instant::now() + ATTEMPT_BUDGET;
        let payload: IngestPayload = match serde_json::from_value(ctx.payload.clone()) {
            Ok(payload) => payload,
            // Written by a different version of this route; a retry cannot make
            // it readable.
            Err(e) => {
                return TaskOutcome::Failed(format!(
                    "studio-artifact-ingest: this run's payload is not a repository sync ({e})"
                ));
            }
        };

        // The token must be the organization's own, whoever enqueued the run
        // (`connectors::sdk::ownership`), decided as the caller: the run is
        // filed under the organization, the caller's home may be another.
        // Permanent: retrying cannot change whose connection it is.
        if let Err(refused) = self
            .service
            .ensure_token_owned(
                &ctx.security,
                payload.requested_in.unwrap_or(ctx.tenant),
                payload.tenant(ctx.tenant),
                &payload.secret_ref,
            )
            .await
        {
            return TaskOutcome::Failed(format!(
                "studio-artifact-ingest: {repo} is not read with this token: {refused}",
                repo = payload.repo_full_path
            ));
        }

        // Per attempt, as the module note says. The worker's own identity: the
        // caller's is long gone, and a scheduled sync never had one.
        let token = match self
            .service
            .resolve_token(&ctx.security, &payload.secret_ref)
            .await
        {
            Ok(Some(token)) => token,
            // Nothing stored under that reference. A public repository does not
            // need one, so the run proceeds unauthenticated rather than
            // dead-lettering; a private one will fail at the provider, which
            // says more about what is wrong than we can from here.
            Ok(None) => {
                tracing::warn!(
                    secret_ref = %payload.secret_ref,
                    repo = %payload.repo_full_path,
                    "studio-artifact-ingest: no readable token — syncing without credentials"
                );
                String::new()
            }
            Err(e) => {
                let error = format!("{e:#}");
                // A malformed reference will not become well-formed on the
                // fourth attempt. A credstore that is down will come back.
                if permanent_token_error(&error) {
                    return TaskOutcome::Failed(error);
                }
                return TaskOutcome::Retry(error);
            }
        };

        let platform_base_url = if self
            .service
            .platform_auth(
                &ctx.security,
                payload.tenant(ctx.tenant),
                &payload.secret_ref,
            )
            .await
        {
            match self.service.platform_base_url() {
                Ok(url) => Some(url),
                Err(e) => return TaskOutcome::Failed(format!("{e:#}")),
            }
        } else {
            None
        };
        let base_url = platform_base_url.as_deref().or(payload.base_url.as_deref());

        let (progress, drain) = ctx.progress_bridge();
        // Held until the sync returns. A closed semaphore cannot happen -- it is
        // a static nobody closes -- so an error just runs unguarded. A run that
        // has to wait (every slot taken) says so, rather than sitting at
        // "queued" looking stuck.
        let slots = ingest_slots();
        let _slot = match slots.try_acquire() {
            Ok(slot) => Some(slot),
            Err(_) => {
                progress.set("waiting for another repository's sync to finish…");
                slots.acquire().await.ok()
            }
        };
        let platform_token = if platform_base_url.is_some() {
            match self.service.platform_token().await {
                Ok(t) => Some(t),
                Err(e) => {
                    drop(progress);
                    let _ = drain.await;
                    return TaskOutcome::Retry(format!("{e:#}"));
                }
            }
        } else {
            None
        };
        let outcome = self
            .service
            .run_sync_until(
                Some(deadline),
                &ctx.security,
                &payload.provider,
                base_url,
                &payload.secret_ref,
                &payload.repo_full_path,
                payload.since.as_deref(),
                &token,
                platform_token.as_deref(),
                payload.workspace_id.as_deref(),
                payload.project_id.as_deref(),
                payload.repo_dir.as_deref(),
                &progress,
            )
            .await;
        // A partial sync's counts stay on the run while it waits for its
        // next attempt: the last tick before this was "storing…", without them.
        let noun = |n: usize| {
            if payload.provider == "gitlab" {
                plural(n, "merge request", "merge requests")
            } else {
                plural(n, "pull request", "pull requests")
            }
        };
        if let Ok(counts) = &outcome
            && counts.is_partial()
        {
            progress.set_with(
                format!(
                    "{}; the rest is for the next attempt",
                    left_over(counts, &noun)
                ),
                serde_json::to_value(counts).unwrap_or_default(),
            );
        }
        // Drop the sender so the drain ends, then let it finish the queue.
        drop(progress);
        let _ = drain.await;

        if outcome.is_ok() {
            // What others derive from the repository follows it now; they
            // only queue their work, so the run is not held up.
            crate::repository_synced::notify(
                &ctx.security,
                &crate::repository_synced::SyncedRepository {
                    run_tenant: ctx.tenant,
                    project_id: payload.project_id.clone(),
                    workspace_id: payload.workspace_id.clone(),
                    repo_full_path: payload.repo_full_path.clone(),
                },
            )
            .await;
        }
        match outcome {
            // Out of time with pull requests still to link or comments still
            // to read: what it stored stands, and the next attempt goes on
            // from there -- unless this was the last one, which ends below
            // with the count.
            Ok(counts) if counts.is_partial() && ctx.attempt < self.max_attempts() => {
                TaskOutcome::Retry(format!(
                    "{}: partial -- {} before the attempt's time ran out; the next attempt continues from there",
                    payload.repo_full_path,
                    left_over(&counts, &noun)
                ))
            }
            Ok(counts) => {
                let mut summary = format!(
                    "{}: {}, {}, {}, {}, {}, {} stored",
                    payload.repo_full_path,
                    plural(counts.issues, "issue", "issues"),
                    plural(counts.pull_requests, "pull request", "pull requests"),
                    plural(counts.files, "file", "files"),
                    plural(counts.comments, "comment", "comments"),
                    plural(counts.commits, "commit", "commits"),
                    plural(counts.stored, "node", "nodes"),
                );
                // Only when it happened: most syncs forget nothing, and "0
                // deleted files forgotten" on every one of them is noise.
                if counts.pruned > 0 {
                    summary.push_str(&format!(
                        ", {} forgotten",
                        plural(counts.pruned, "deleted file", "deleted files")
                    ));
                }
                if counts.links_total > 0 {
                    summary.push_str(&format!(
                        ", {} of {} linked to their files",
                        counts.links_done,
                        noun(counts.links_total)
                    ));
                }
                if counts.comment_items_total > 0 {
                    summary.push_str(&format!(
                        ", comments of {} of {} read",
                        counts.comment_items_done,
                        plural(counts.comment_items_total, "item", "items")
                    ));
                }
                if counts.is_partial() {
                    summary.push_str(&format!(
                        " (partial: {}; the next sync goes on from there)",
                        left_over(&counts, &noun)
                    ));
                }
                match serde_json::to_value(counts) {
                    Ok(result) => TaskOutcome::done_with(summary, result),
                    // The sync happened; failing the run over a serialization
                    // problem would be a lie about the world.
                    Err(e) => {
                        tracing::warn!(
                            "studio-artifact-ingest: could not record the sync counts: {e}"
                        );
                        TaskOutcome::done(summary)
                    }
                }
            }
            Err(e) => {
                let error = format!("{e:#}");
                // A provider rate limit, a graph-storage blip, a clone the
                // network killed: all worth another attempt. A driver that is
                // not linked into this deployment is not — and a *scheduled*
                // sync naming a provider whose plugin was removed is the
                // ordinary way that happens.
                if error.contains("no driver for provider") {
                    TaskOutcome::Failed(error)
                } else {
                    TaskOutcome::Retry(error)
                }
            }
        }
    }
}

/// Whether a `resolve_token` failure is about the reference rather than about
/// credstore being reachable.
///
/// An absent secret is no longer in here: it does not fail the run at all, it
/// runs it unauthenticated. What remains is a reference that cannot be parsed,
/// which no number of attempts will fix.
fn permanent_token_error(error: &str) -> bool {
    error.contains("bad secret reference")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ingest_slots_follow_config_within_bounds() {
        assert_eq!(ingest_slots_for(1).available_permits(), 1);
        assert_eq!(ingest_slots_for(3).available_permits(), 3);
        assert_eq!(ingest_slots_for(8).available_permits(), 8);
        // Zero would stall every sync; past the queue's handlers buys nothing.
        assert_eq!(ingest_slots_for(0).available_permits(), 1);
        assert_eq!(
            ingest_slots_for(64).available_permits(),
            MAX_INGEST_PARALLEL
        );
    }

    #[test]
    fn ingest_parallel_defaults_to_one() {
        let config: super::super::ArtifactIngestConfig =
            serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(config.ingest.parallel, 1);
        let config: super::super::ArtifactIngestConfig =
            serde_json::from_value(serde_json::json!({ "ingest": { "parallel": 3 } })).unwrap();
        assert_eq!(config.ingest.parallel, 3);
    }

    #[test]
    fn a_payload_round_trips_through_the_queue() {
        let payload = IngestPayload {
            provider: "github".to_owned(),
            base_url: None,
            secret_ref: "secret://tenant/github-token".to_owned(),
            repo_full_path: "org/repo".to_owned(),
            since: None,
            workspace_id: None,
            project_id: Some("11111111-1111-1111-1111-111111111111".to_owned()),
            repo_dir: Some("repo".to_owned()),
            organization_id: None,
            requested_in: None,
        };
        let back: IngestPayload =
            serde_json::from_value(serde_json::to_value(&payload).unwrap()).unwrap();
        assert_eq!(back.repo_full_path, "org/repo");
        assert_eq!(back.provider, "github");
        assert_eq!(back.repo_dir.as_deref(), Some("repo"));
    }

    #[test]
    fn a_payload_missing_the_repository_is_refused_where_it_is_read() {
        // A run that named no repository could only dead-letter, so serde is
        // the right place to say no.
        let json = serde_json::json!({ "provider": "github", "secret_ref": "s" });
        assert!(serde_json::from_value::<IngestPayload>(json).is_err());
    }

    #[test]
    fn the_payload_never_carries_the_token_itself() {
        // The reason this task type has a `secret_ref` and no `token` field:
        // the run is a row somebody can read.
        let json = serde_json::to_value(IngestPayload {
            provider: "github".to_owned(),
            base_url: None,
            secret_ref: "secret://tenant/github-token".to_owned(),
            repo_full_path: "org/repo".to_owned(),
            since: None,
            workspace_id: None,
            project_id: None,
            repo_dir: None,
            organization_id: None,
            requested_in: None,
        })
        .unwrap();
        assert!(json.get("token").is_none(), "{json}");
    }

    #[test]
    fn a_run_is_for_its_project_else_its_workspace_else_its_own_tenant() {
        let run = Uuid::from_u128(1);
        let project = Uuid::from_u128(2);
        let workspace = Uuid::from_u128(3);
        let mut payload = IngestPayload {
            provider: "github".to_owned(),
            base_url: None,
            secret_ref: "s".to_owned(),
            repo_full_path: "org/repo".to_owned(),
            since: None,
            workspace_id: Some(workspace.to_string()),
            project_id: Some(project.to_string()),
            repo_dir: None,
            organization_id: None,
            requested_in: None,
        };
        assert_eq!(payload.tenant(run), project);
        payload.project_id = None;
        assert_eq!(payload.tenant(run), workspace);
        payload.workspace_id = Some("not-a-tenant".to_owned());
        assert_eq!(payload.tenant(run), run);
    }

    #[test]
    fn a_malformed_reference_is_permanent_but_a_credstore_outage_is_not() {
        assert!(permanent_token_error("bad secret reference: empty"));
        assert!(!permanent_token_error("credstore: connection refused"));
    }
}
