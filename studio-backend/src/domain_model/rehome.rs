//! Objects a platform administrator wrote in the root's model, moved into
//! the organization that owns their scope (ADR-0066 §8a): part of the
//! start-up sweep, and before every gear's own move, so a gear finds its
//! records — and its move markers — where it now looks.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::service::DomainModelService;

pub struct Rehome(pub Arc<DomainModelService>);

/// The platform's root tenant.
const ROOT: Uuid = Uuid::from_u128(1);

#[async_trait]
impl crate::model_sweep::TenantMover for Rehome {
    fn name(&self) -> &str {
        "studio-domain-model rehome"
    }
    fn early(&self) -> bool {
        true
    }
    async fn prepare(&self, ctx: &SecurityContext, tenant: Uuid) -> anyhow::Result<()> {
        if ctx.subject_tenant_id() == ROOT {
            return Ok(());
        }
        let root =
            crate::org_scope::acting_in(ctx, ROOT).map_err(|e| anyhow::anyhow!("rehome: {e}"))?;
        self.0.rehome_scope(&root, ctx, &tenant.to_string()).await?;
        Ok(())
    }
}

/// Whether the root's copy of an object replaces the organization's: yes when
/// the organization holds none. When it holds one, the copy that is further
/// on stays -- an ended status (`passed`, `failed`, `cancelled`,
/// `succeeded`) over one still going, else the later of the times the
/// object says it last moved (`updated_at`, `finished_at`, `started_at`).
/// Equal ones keep the organization's, which is where writers write now;
/// copies that say nothing of either are the root's, as before.
///
/// On the stand (2026-11-24) the first sweep copied build
/// `research-e684c390ab39` into the organization while it ran; the build
/// went on in the root and passed, the next sweep stopped half way, and the
/// organization's copy said `running`. A sweep after the build is recorded
/// in the organization must not do the opposite.
pub(super) fn root_copy_wins(root: &Value, held: Option<&Value>) -> bool {
    let Some(held) = held else {
        return true;
    };
    if held == root {
        return false;
    }
    let ended = |v: &Value| {
        matches!(
            v.get("status").and_then(Value::as_str),
            Some("passed" | "failed" | "cancelled" | "succeeded")
        )
    };
    match (ended(root), ended(held)) {
        (true, false) => return true,
        (false, true) => return false,
        _ => {}
    }
    let moved = |v: &Value| {
        ["updated_at", "finished_at", "started_at"]
            .iter()
            .find_map(|k| v.get(*k).and_then(Value::as_str).map(str::to_owned))
    };
    match (moved(root), moved(held)) {
        // RFC 3339 in UTC sorts as text.
        (Some(r), Some(h)) => r > h,
        (None, Some(_)) => false,
        _ => true,
    }
}

/// The types Studio's own screens need, added to every organization's stored
/// model at start (a model on the seed has them already).
pub struct StudioTypes(pub Arc<DomainModelService>);

#[async_trait]
impl crate::model_sweep::TenantMover for StudioTypes {
    fn name(&self) -> &str {
        "studio-domain-model studio types"
    }
    fn early(&self) -> bool {
        true
    }
    async fn prepare(&self, ctx: &SecurityContext, tenant: Uuid) -> anyhow::Result<()> {
        // Once per model: the organization itself, not each of its tenants.
        if ctx.subject_tenant_id() != tenant {
            return Ok(());
        }
        self.0.ensure_studio_types(ctx).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::root_copy_wins;
    use serde_json::json;

    fn build(status: &str, started: &str, finished: Option<&str>) -> serde_json::Value {
        let mut v = json!({
            "build_id": "research-e684c390ab39",
            "where": "research",
            "status": status,
            "started_at": started,
        });
        if let Some(f) = finished {
            v["finished_at"] = json!(f);
        }
        v
    }

    #[test]
    fn an_object_the_organization_lacks_is_moved() {
        assert!(root_copy_wins(&json!({"name": "x"}), None));
    }

    #[test]
    fn an_ended_build_is_never_put_back_to_running() {
        let running = build("running", "2026-11-24T10:08:43Z", None);
        let passed = build(
            "passed",
            "2026-11-24T10:08:43Z",
            Some("2026-11-24T10:09:26Z"),
        );
        // The stand's case: the root's copy passed, the organization's ran.
        assert!(root_copy_wins(&passed, Some(&running)));
        // The opposite: the build ended in the organization since.
        assert!(!root_copy_wins(&running, Some(&passed)));
        // Even when the stale copy says it started later (a retry).
        let later = build("running", "2026-11-24T11:00:00Z", None);
        assert!(!root_copy_wins(&later, Some(&passed)));
    }

    #[test]
    fn otherwise_the_copy_that_moved_last_stays() {
        let a = build(
            "failed",
            "2026-11-24T10:00:00Z",
            Some("2026-11-24T10:05:00Z"),
        );
        let b = build(
            "passed",
            "2026-11-24T11:00:00Z",
            Some("2026-11-24T11:05:00Z"),
        );
        assert!(root_copy_wins(&b, Some(&a)));
        assert!(!root_copy_wins(&a, Some(&b)));
        // The same copy: nothing to write.
        assert!(!root_copy_wins(&a, Some(&a)));
        // Copies that say nothing of when: the root's, as before.
        assert!(root_copy_wins(
            &json!({"name": "new"}),
            Some(&json!({"name": "old"}))
        ));
        // Only the organization's says when: it stays.
        assert!(!root_copy_wins(
            &json!({"name": "new"}),
            Some(&json!({"name": "old", "updated_at": "2026-11-24T10:00:00Z"}))
        ));
    }
}
