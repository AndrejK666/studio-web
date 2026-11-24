//! What a project's status is read from ([`super::status`]).
//!
//! The organization's own counts come from this gear in process (the
//! project's rollup and its line of the organization's health). The rest is
//! the other gears' answers, read in process through their ports -- the same
//! reads their routes make -- as this gear's service identity in the
//! project's organization: the status is computed in the background and kept
//! (`status_view.rs`), with no reader's credentials. A read that fails is
//! `None`, which the status words as not known.

use std::collections::BTreeMap;

use serde_json::Value;

use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::status::{
    BuildFacts, Deploy, FindingFacts, ModelFacts, PathFacts, ProductFacts, Pull, SpecQueues,
};

/// CI runs read for the last build, newest first.
const RUNS: u32 = 50;

fn u32_of(v: &Value) -> u32 {
    v.as_u64()
        .map_or(0, |n| u32::try_from(n).unwrap_or(u32::MAX))
}

fn len_of(v: &Value) -> u32 {
    v.as_array()
        .map_or(0, |a| u32::try_from(a.len()).unwrap_or(u32::MAX))
}

fn text(v: &Value) -> Option<String> {
    v.as_str().filter(|s| !s.is_empty()).map(str::to_string)
}

/// The spec rows' three queues, from their `(queue, count)`.
pub fn spec_queues(counts: &[(String, u32)]) -> SpecQueues {
    let n = |q: &str| counts.iter().find(|(k, _)| k == q).map_or(0, |(_, c)| *c);
    SpecQueues {
        bound: n("bound"),
        needs_review: n("needs-review"),
        not_scanned: n("not-scanned"),
    }
}

/// `GET /studio-product/v1/projects/{project_id}/product`: its record, or
/// nothing picked yet.
pub fn product_facts(page: &Value) -> ProductFacts {
    let v = &page["nodes"][0]["value"];
    let preview = &v["last_preview"];
    ProductFacts {
        gears: len_of(&v["gears"]),
        resolves: preview["ok"].as_bool(),
        errors: u32_of(&preview["errors"]),
        written: v["written"].as_bool().unwrap_or(false)
            || v["description"].as_str().is_some_and(|d| !d.is_empty())
            || v["description"].is_object(),
    }
}

/// A CI run's status in a build's words, from the provider's `status` and
/// `conclusion` (the portal's `buildStatus`).
pub fn build_status(status: Option<&str>, conclusion: Option<&str>) -> &'static str {
    if let Some(s) = status.filter(|s| !s.is_empty() && *s != "completed") {
        return if s == "in_progress" {
            "running"
        } else {
            "queued"
        };
    }
    match conclusion.filter(|c| !c.is_empty()) {
        None => "unknown",
        Some("success") => "passed",
        Some("cancelled") => "cancelled",
        Some("skipped" | "neutral") => "skipped",
        Some(_) => "failed",
    }
}

/// The newest finished run on the branch a product is built from — `main`
/// or `master` when the runs have one, else the branch with most runs —
/// from the `workflow_run` nodes (`buildsOf`, `mainBranch`,
/// `latestFinished`).
pub fn build_facts(page: &Value) -> BuildFacts {
    struct Run {
        branch: Option<String>,
        status: &'static str,
        short_sha: String,
        created_at: String,
    }
    let mut runs: Vec<Run> = page["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|n| {
            let v = &n["value"];
            let sha = text(&v["sha"]).unwrap_or_default();
            Run {
                branch: text(&v["branch"]),
                status: build_status(v["status"].as_str(), v["conclusion"].as_str()),
                short_sha: text(&v["short_sha"]).unwrap_or_else(|| sha.chars().take(7).collect()),
                created_at: text(&v["created_at"]).unwrap_or_default(),
            }
        })
        .collect();
    runs.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    let branches: Vec<&str> = runs.iter().filter_map(|r| r.branch.as_deref()).collect();
    let main = ["main", "master"]
        .into_iter()
        .find(|b| branches.contains(b))
        .map(str::to_string)
        .or_else(|| {
            // The branch with most runs; the first seen wins a tie.
            let mut counts: Vec<(&str, usize)> = Vec::new();
            for b in &branches {
                match counts.iter_mut().find(|(n, _)| n == b) {
                    Some((_, c)) => *c += 1,
                    None => counts.push((b, 1)),
                }
            }
            let mut best: Option<(&str, usize)> = None;
            for (b, c) in counts {
                if best.is_none_or(|(_, bc)| c > bc) {
                    best = Some((b, c));
                }
            }
            best.map(|(b, _)| b.to_string())
        });
    let last = runs
        .iter()
        .find(|r| r.branch == main && !matches!(r.status, "queued" | "running" | "unknown"));
    match last {
        Some(r) => BuildFacts::Last {
            status: r.status.to_string(),
            sha: r.short_sha.clone(),
        },
        None => BuildFacts::Never,
    }
}

/// `GET /studio-environments/v1/deployments`.
pub fn deploys(page: &Value) -> Vec<Deploy> {
    page["items"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|d| Deploy {
            action: text(&d["action"]),
            preview: d["preview"].as_bool().unwrap_or(false),
            state: text(&d["state"]).unwrap_or_default(),
            environment_name: text(&d["environment_name"]).unwrap_or_default(),
            reason: text(&d["reason"]),
            outcome: text(&d["outcome"]),
            at: text(&d["decided_at"])
                .or_else(|| text(&d["requested_at"]))
                .unwrap_or_default(),
        })
        .collect()
}

/// The open pull requests as the signals read them.
pub fn pulls(open: &[crate::artifact_ingest::port::OpenPull]) -> Vec<Pull> {
    named_pulls(open, &BTreeMap::new())
}

/// The open pull requests with whom each waits on said as "Name (login)" when
/// the login is a confirmed account of one of the organization's people, else
/// as the login alone.
pub fn named_pulls(
    open: &[crate::artifact_ingest::port::OpenPull],
    names: &BTreeMap<String, String>,
) -> Vec<Pull> {
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
async fn account_names(
    hub: &ClientHub,
    org: Uuid,
    open: &[crate::artifact_ingest::port::OpenPull],
) -> BTreeMap<String, String> {
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
        super::overview::ACCOUNT_KINDS
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
fn run_value(r: &crate::artifact_ingest::port::CiRun) -> Value {
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
pub fn last_build(mut runs: Vec<crate::artifact_ingest::port::CiRun>) -> BuildFacts {
    runs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    runs.truncate(RUNS as usize);
    let nodes: Vec<Value> = runs.iter().map(run_value).collect();
    build_facts(&serde_json::json!({ "nodes": nodes }))
}

/// The product record as the path reads it: its facts, and the engine's
/// last verdict kept on it (`checks.<profile>`).
pub fn product_record_facts(
    record: Option<&Value>,
) -> (ProductFacts, Option<crate::project_path::CheckFacts>) {
    let page = match record {
        Some(value) => serde_json::json!({"nodes": [{"value": value}]}),
        None => serde_json::json!({"nodes": []}),
    };
    (
        product_facts(&page),
        record.and_then(crate::project_path::check_facts),
    )
}

/// The reads of the path and the other gears' signals, side by side.
pub struct Read {
    pub path: PathFacts,
    pub pulls: Option<Vec<Pull>>,
    pub deployments: Option<Vec<Deploy>>,
    /// The engine's last verdict kept on the product record.
    pub product_check: Option<crate::project_path::CheckFacts>,
    /// The saved description's revision; `Some(0)` for one in the
    /// repository only; `None` before one, or when it could not be read.
    pub product_revision: Option<i64>,
    /// Stages 5-9 as studio-environments decides them (`project_path.rs`),
    /// read as this gear; `None` when they could not be read.
    pub delivery: Option<Vec<crate::project_path::Stage>>,
}

/// The service identity this gear reads a project's status with: its own
/// principal, scoped to the project's organization (`org`).
pub fn service_ctx(org: Uuid) -> anyhow::Result<SecurityContext> {
    SecurityContext::builder()
        .subject_id(super::logo::SERVICE_SUBJECT_ID)
        .subject_type("service")
        .subject_tenant_id(org)
        .token_scopes(vec!["*".to_owned()])
        .build()
        .map_err(|e| anyhow::anyhow!("studio-organizations: cannot build a service context: {e}"))
}

/// Every read of the path and the signals, side by side, through the other
/// gears' ports, as `ctx`.
pub async fn read(hub: &ClientHub, ctx: &SecurityContext, project: Uuid) -> Read {
    use crate::artifact_ingest::port::{DeliveryEvidence, OpenPullRequests};
    let scope = project.to_string();
    let documents = async {
        let port = hub
            .get::<dyn crate::documents::port::ProjectStatusFacts>()
            .ok()?;
        port.status_facts(ctx, project).await.ok()
    };
    let product = async {
        let port = hub
            .get::<dyn crate::product::port::ProjectProducts>()
            .ok()?;
        let record = port.product_record(ctx, &scope).await.ok()?;
        Some(product_record_facts(record.as_ref()))
    };
    // The saved description's revision, as the delivery path reads it.
    let revision = async {
        let port = hub
            .get::<dyn crate::product::port::ProjectProducts>()
            .ok()?;
        match port.latest_description(ctx, project).await.ok()? {
            Some(d) => Some(d.revision.max(1)),
            None => port
                .saved_description(ctx, &scope)
                .await
                .ok()
                .flatten()
                .map(|_| 0),
        }
    };
    let runs = async {
        let port = hub.get::<dyn DeliveryEvidence>().ok()?;
        let runs = port.ci_runs(ctx, &scope).await.ok()?;
        Some(last_build(runs))
    };
    // Stages 5-9 as Releases says them, read as this gear.
    let delivery = async {
        let port = hub
            .get::<dyn crate::environments::port::ProjectDeliveryStages>()
            .ok()?;
        port.delivery_stages(ctx, project).await.ok()
    };
    let deployments = async {
        let port = hub
            .get::<dyn crate::environments::port::ProjectDeployments>()
            .ok()?;
        port.deployments_page(ctx, project)
            .await
            .ok()
            .map(|page| deploys(&page))
    };
    let open = async {
        let port = hub.get::<dyn OpenPullRequests>().ok()?;
        let open = port.open_pulls(ctx, &scope).await.ok()?;
        let names = account_names(hub, ctx.subject_tenant_id(), &open).await;
        Some(named_pulls(&open, &names))
    };
    let (documents, product, revision, build, deployments, pulls, delivery) = tokio::join!(
        documents,
        product,
        revision,
        runs,
        deployments,
        open,
        delivery
    );
    let (product, product_check) = match product {
        Some((facts, check)) => (Some(facts), check),
        None => (None, None),
    };
    let (specs, model, findings) = match documents {
        Some(d) => (
            d.queues.as_deref().map(spec_queues),
            d.model.map(|m| ModelFacts {
                documents: m.documents,
                extracted: m.extracted,
                facts: m.facts,
                running: m.running,
            }),
            d.findings.map(|f| FindingFacts {
                open: f.open,
                high: f.high,
            }),
        ),
        None => (None, None, None),
    };
    Read {
        path: PathFacts {
            repositories: None,
            // Which repositories a sync read needs their graph nodes matched
            // to the config by connection and path; not read here.
            synced: None,
            specs,
            model,
            findings,
            // What the product is, proposed from the facts, is still the
            // portal's (product-kind.ts): the path leaves that step out.
            kind: None,
            product,
            build,
        },
        deployments,
        pulls,
        product_check,
        product_revision: revision,
        delivery,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_path_reads_what_each_port_answers() {
        let counts = vec![
            ("bound".to_owned(), 74),
            ("needs-review".to_owned(), 1),
            ("all".to_owned(), 90),
        ];
        assert_eq!(
            spec_queues(&counts),
            SpecQueues {
                bound: 74,
                needs_review: 1,
                not_scanned: 0
            }
        );
        assert_eq!(
            product_facts(&json!({"nodes": []})),
            ProductFacts::default()
        );
        let product = json!({"nodes": [{"value": {"gears": ["a", "b"],
            "last_preview": {"ok": false, "errors": 2}, "written": true}}]});
        assert_eq!(
            product_facts(&product),
            ProductFacts {
                gears: 2,
                resolves: Some(false),
                errors: 2,
                written: true
            }
        );
    }

    #[test]
    fn the_last_build_is_the_newest_finished_run_on_the_main_branch() {
        let page = json!({"nodes": [
            {"value": {"branch": "feature", "status": "completed", "conclusion": "failure",
                "sha": "ffffffffff", "created_at": "2026-11-05T00:00:00Z"}},
            {"value": {"branch": "main", "status": "in_progress",
                "sha": "eeeeeeeeee", "created_at": "2026-11-04T00:00:00Z"}},
            {"value": {"branch": "main", "status": "completed", "conclusion": "success",
                "sha": "abcdef1234", "created_at": "2026-11-03T00:00:00Z"}}]});
        assert_eq!(
            build_facts(&page),
            BuildFacts::Last {
                status: "passed".into(),
                sha: "abcdef1".into()
            }
        );
        assert_eq!(build_facts(&json!({"nodes": []})), BuildFacts::Never);
        assert_eq!(build_status(Some("queued"), None), "queued");
        assert_eq!(build_status(Some("completed"), Some("timed_out")), "failed");
        assert_eq!(build_status(None, None), "unknown");
    }

    #[test]
    fn whom_a_pull_waits_on_reads_as_name_and_login_when_the_login_is_one_of_ours() {
        let open = vec![crate::artifact_ingest::port::OpenPull {
            waiting: "review".into(),
            waiting_on: vec!["Ann-GH".into(), "stranger".into()],
            ..Default::default()
        }];
        let names = std::collections::BTreeMap::from([("ann-gh".to_owned(), "Ann Lee".to_owned())]);
        let p = &named_pulls(&open, &names)[0];
        assert_eq!(p.waiting_on, ["Ann Lee (Ann-GH)", "stranger"]);
    }

    #[test]
    fn pulls_and_deployments_read_as_the_signals_need() {
        let open = vec![crate::artifact_ingest::port::OpenPull {
            waiting: "draft".into(),
            waiting_on: vec!["ann".into()],
            days_since_update: Some(9),
            ..Default::default()
        }];
        let p = &pulls(&open)[0];
        assert!(p.draft);
        assert_eq!(p.waiting_on, ["ann"]);
        assert_eq!(p.days_since_update, Some(9));
        let page = json!({"items": [{"state": "failed", "environment_name": "dev",
            "requested_at": "2026-11-01T00:00:00Z", "decided_at": null, "reason": ""}]});
        let d = &deploys(&page)[0];
        assert_eq!(
            (d.at.as_str(), d.reason.as_deref()),
            ("2026-11-01T00:00:00Z", None)
        );
    }

    #[test]
    fn the_product_record_gives_its_facts_and_its_kept_check() {
        let record = json!({"gears": ["a", "b", "c"], "last_preview": {"ok": true, "errors": 0},
            "checks": {"prod": {"ok": false, "errors": 1, "revision": 2,
                "checked_at": "2026-11-20T00:00:00Z"}}});
        let (facts, check) = product_record_facts(Some(&record));
        assert_eq!(facts.gears, 3);
        assert_eq!(facts.resolves, Some(true));
        assert_eq!(
            check,
            Some(crate::project_path::CheckFacts {
                ok: false,
                errors: 1,
                revision: Some(2)
            })
        );
        assert_eq!(product_record_facts(None), (ProductFacts::default(), None));
    }
}
