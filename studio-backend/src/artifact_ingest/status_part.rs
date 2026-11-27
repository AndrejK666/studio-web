//! The Git kit's part of a project's status (the core's project status port,
//! ADR-0079 §4): the last build on the main branch and the open pull
//! requests, with whom each waits on said by name.

use std::collections::BTreeMap;

use async_trait::async_trait;
use serde_json::Value;
use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::port::{CiRun, DeliveryEvidence, OpenPull, OpenPullRequests};
use crate::organizations::port::{
    BuildFacts, ProjectKitParts, Pull, StatusContributor, StatusPart, StatusSource, build_facts,
};

/// CI runs read for the last build, newest first.
const RUNS: u32 = 50;

inventory::submit! {
    StatusContributor {
        gear: "studio-artifact-ingest",
        order: 30,
        source: &GitStatus,
    }
}

// The parts of a project's status the Git kit owns: its pull requests and
// its activity (ADR-0071 §6).
inventory::submit! {
    ProjectKitParts {
        kit: super::overview_block::GIT_KIT,
        steps: &[],
        signals: &["stuck", "nobody", "threads", "quiet"],
        stages: &[],
    }
}

struct GitStatus;

#[async_trait]
impl StatusSource for GitStatus {
    async fn read(&self, hub: &ClientHub, ctx: &SecurityContext, project: Uuid) -> StatusPart {
        let scope = project.to_string();
        let runs = async {
            let port = hub.get::<dyn DeliveryEvidence>().ok()?;
            let runs = port.ci_runs(ctx, &scope).await.ok()?;
            Some(last_build(runs))
        };
        let open = async {
            let port = hub.get::<dyn OpenPullRequests>().ok()?;
            let open = port.open_pulls(ctx, &scope).await.ok()?;
            let names = account_names(hub, ctx.subject_tenant_id(), &open).await;
            Some(named_pulls(&open, &names))
        };
        let (build, pulls) = tokio::join!(runs, open);
        StatusPart {
            build,
            pulls,
            ..StatusPart::default()
        }
    }
}

/// The open pull requests with whom each waits on said as "Name (login)" when
/// the login is a confirmed account of one of the organization's people, else
/// as the login alone.
pub fn named_pulls(open: &[OpenPull], names: &BTreeMap<String, String>) -> Vec<Pull> {
    open.iter()
        .map(|p| Pull {
            draft: p.waiting == "draft",
            waiting: p.waiting.clone(),
            waiting_on: p
                .waiting_on
                .iter()
                .map(|login| match names.get(&login.to_ascii_lowercase()) {
                    Some(name) if name != login => format!("{name} ({login})"),
                    _ => login.clone(),
                })
                .collect(),
            days_since_update: p.days_since_update,
        })
        .collect()
}

/// The names of the organization's people behind the logins the pull
/// requests wait on, keyed by the login lowercased, read the way the
/// organization overview reads them (confirmed accounts of active members).
async fn account_names(hub: &ClientHub, org: Uuid, open: &[OpenPull]) -> BTreeMap<String, String> {
    use crate::user_profile::MemberAliases;
    let mut out = BTreeMap::new();
    let logins: Vec<String> = open
        .iter()
        .flat_map(|p| p.waiting_on.iter().cloned())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    if logins.is_empty() {
        return out;
    }
    let Ok(directory) = hub.get_scoped::<dyn MemberAliases>(
        &toolkit::client_hub::ClientScope::gts_id(crate::user_profile::IDENTITY_INSTANCE_ID),
    ) else {
        return out;
    };
    let found = futures_util::future::join_all(
        super::overview_block::ACCOUNT_KINDS
            .iter()
            .map(|kind| directory.members_by_alias(org, kind, &logins)),
    )
    .await;
    for found in found.into_iter().filter_map(Result::ok) {
        for (login, member) in found {
            if let Some(name) = member.display_name {
                out.entry(login).or_insert(name);
            }
        }
    }
    out
}

/// A CI run as `build_facts` reads a node's value.
fn run_value(r: &CiRun) -> Value {
    serde_json::json!({"value": {
        "branch": r.branch,
        "status": r.status,
        "conclusion": r.conclusion,
        "sha": r.sha,
        "created_at": r.created_at,
    }})
}

/// The newest finished run on the main branch of `runs`, as the CI runs
/// route reads them (`sort=updated&limit=50`): what the project's status
/// and the delivery path (`project_path.rs`) both call the last build.
pub fn last_build(mut runs: Vec<CiRun>) -> BuildFacts {
    runs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    runs.truncate(RUNS as usize);
    let nodes: Vec<Value> = runs.iter().map(run_value).collect();
    build_facts(&serde_json::json!({ "nodes": nodes }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whom_a_pull_waits_on_reads_as_name_and_login_when_the_login_is_one_of_ours() {
        let open = vec![OpenPull {
            waiting: "review".into(),
            waiting_on: vec!["Ann-GH".into(), "stranger".into()],
            ..Default::default()
        }];
        let names = BTreeMap::from([("ann-gh".to_owned(), "Ann Lee".to_owned())]);
        let p = &named_pulls(&open, &names)[0];
        assert_eq!(p.waiting_on, ["Ann Lee (Ann-GH)", "stranger"]);
    }

    #[test]
    fn pulls_read_as_the_signals_need() {
        let open = vec![OpenPull {
            waiting: "draft".into(),
            waiting_on: vec!["ann".into()],
            days_since_update: Some(9),
            ..Default::default()
        }];
        let p = &named_pulls(&open, &BTreeMap::new())[0];
        assert!(p.draft);
        assert_eq!(p.waiting_on, ["ann"]);
        assert_eq!(p.days_since_update, Some(9));
    }
}
