//! What a project's status is read from ([`super::status`]).
//!
//! The organization's own counts come from this gear in process (the
//! project's rollup and its line of the organization's health). The rest is
//! the kits' answers, read in process through the project status port
//! ([`super::status_port`]) -- the same reads their routes make -- as this
//! gear's service identity in the project's organization: the status is
//! computed in the background and kept (`status_view.rs`), with no reader's
//! credentials. A read that fails is `None`, which the status words as not
//! known.

use serde_json::Value;

use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::status::{BuildFacts, Deploy, PathFacts, ProductFacts, Pull, SpecQueues};

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
    let part = super::status_port::read_all(hub, ctx, project).await;
    Read {
        path: PathFacts {
            repositories: None,
            // Which repositories a sync read needs their graph nodes matched
            // to the config by connection and path; not read here.
            synced: None,
            specs: part.specs,
            model: part.model,
            findings: part.findings,
            // What the product is, proposed from the facts, is still the
            // portal's (product-kind.ts): the path leaves that step out.
            kind: None,
            product: part.product,
            build: part.build,
        },
        deployments: part.deployments,
        pulls: part.pulls,
        product_check: part.product_check,
        product_revision: part.product_revision,
        delivery: part.delivery,
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
    fn deployments_read_as_the_signals_need() {
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
