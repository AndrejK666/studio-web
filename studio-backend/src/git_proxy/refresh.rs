//! What a push through the proxy asks of the server (ADR-0027 §3, phase 2).
//!
//! The backend learns about a desktop's code when it is pushed, not before. So
//! when a push has gone through, the server's copy follows it: every project
//! that was seeded from the pushed repository gets the same `artifact.ingest`
//! run its Re-sync button would queue, under the same partition key, so the two
//! never race on one checkout.
//!
//! The run is built from the project's record of its repositories
//! (`project_sources`), with the connection by id, exactly as the portal builds
//! it. A push to a repository through a connection the member cannot see
//! refreshes nothing. The push itself has already succeeded.

use std::collections::HashMap;

use uuid::Uuid;

use crate::artifact_ingest::IngestPayload;
use crate::project_sources::{ProjectSource, same_repository};

/// What a sync needs of a connection. Its token stays behind its reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Upstream {
    pub provider: String,
    pub base_url: String,
    pub secret_ref: String,
}

/// The syncs a push to `pushed_url` asks for: one per source of the project
/// that names that repository through a connection the member can see — the
/// same payload the portal's Re-sync sends for it.
pub fn runs_for_push(
    project_id: Uuid,
    workspace_id: Option<Uuid>,
    sources: &[ProjectSource],
    connections: &HashMap<Uuid, Upstream>,
    pushed_url: &str,
) -> Vec<IngestPayload> {
    sources
        .iter()
        .filter(|source| same_repository(&source.clone_url, pushed_url))
        .filter_map(|source| {
            let upstream = connections.get(&source.connection_id?)?;
            Some(run_for(
                project_id,
                workspace_id,
                &source.full_path,
                upstream,
            ))
        })
        .collect()
}

/// Whether an upstream answer is the report of a push that went through.
///
/// Only the `git-receive-pack` POST is: a push first asks for
/// `info/refs?service=git-receive-pack`, which names the same service but
/// moves nothing, and a sync queued on it would read the tree from before.
pub fn reports_a_push(protocol_path: &str, status: u16) -> bool {
    protocol_path == "git-receive-pack" && (200..300).contains(&status)
}

/// The sync the portal's Re-sync queues for one repository of a project.
pub fn run_for(
    project_id: Uuid,
    workspace_id: Option<Uuid>,
    repo_full_path: &str,
    upstream: &Upstream,
) -> IngestPayload {
    IngestPayload {
        provider: upstream.provider.clone(),
        base_url: Some(upstream.base_url.trim())
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
        secret_ref: upstream.secret_ref.clone(),
        repo_full_path: repo_full_path.to_owned(),
        since: None,
        workspace_id: workspace_id.map(|id| id.to_string()),
        project_id: Some(project_id.to_string()),
        repo_dir: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_sources::parse;
    use serde_json::json;

    const CONNECTION: &str = "7b0d4c4e-8a51-4f7e-9a53-2f3c1c1f5a10";

    fn connections() -> HashMap<Uuid, Upstream> {
        HashMap::from([(
            Uuid::parse_str(CONNECTION).unwrap(),
            Upstream {
                provider: "github".into(),
                base_url: String::new(),
                secret_ref: "studio/github-token".into(),
            },
        )])
    }

    fn config() -> serde_json::Value {
        json!({
            "mode": "modernize",
            "sources": [
                { "connection_id": CONNECTION, "full_path": "acme/api",
                  "clone_url": "https://github.com/acme/api.git" },
                { "connection_id": CONNECTION, "full_path": "acme/web",
                  "clone_url": "https://github.com/acme/web.git" },
                { "connection_id": "not-a-uuid", "full_path": "acme/x",
                  "clone_url": "https://github.com/acme/x.git" },
                { "connection_id": CONNECTION, "full_path": "acme/y" }
            ]
        })
    }

    #[test]
    fn only_the_pack_a_push_uploads_reports_one() {
        assert!(reports_a_push("git-receive-pack", 200));
        // The advertisement `git push` asks for first moves nothing.
        assert!(!reports_a_push("info/refs", 200));
        assert!(!reports_a_push("git-upload-pack", 200));
        assert!(!reports_a_push("git-receive-pack", 500));
    }

    #[test]
    fn a_push_syncs_the_source_it_went_to_as_the_portal_would() {
        let project = Uuid::new_v4();
        let workspace = Uuid::new_v4();
        let runs = runs_for_push(
            project,
            Some(workspace),
            &parse(&config()),
            &connections(),
            "https://github.com/acme/web",
        );
        assert_eq!(runs.len(), 1);
        let run = &runs[0];
        assert_eq!(run.provider, "github");
        assert_eq!(run.base_url, None);
        assert_eq!(run.secret_ref, "studio/github-token");
        assert_eq!(run.repo_full_path, "acme/web");
        assert_eq!(
            run.project_id.as_deref(),
            Some(project.to_string().as_str())
        );
        assert_eq!(
            run.workspace_id.as_deref(),
            Some(workspace.to_string().as_str())
        );
        // The key the portal's Re-sync of the same source queues under.
        assert_eq!(
            run.partition_key(),
            format!("github:studio/github-token:{project}:acme/web")
        );
    }

    #[test]
    fn a_push_nobody_seeded_from_or_through_an_unseen_connection_syncs_nothing() {
        let sources = parse(&config());
        let project = Uuid::new_v4();
        assert!(
            runs_for_push(
                project,
                None,
                &sources,
                &connections(),
                "https://github.com/acme/other"
            )
            .is_empty()
        );
        assert!(
            runs_for_push(
                project,
                None,
                &sources,
                &HashMap::new(),
                "https://github.com/acme/api"
            )
            .is_empty()
        );
        // A source whose connection id does not read names no connection.
        assert!(
            runs_for_push(
                project,
                None,
                &sources,
                &connections(),
                "https://github.com/acme/x"
            )
            .is_empty()
        );
    }
}
