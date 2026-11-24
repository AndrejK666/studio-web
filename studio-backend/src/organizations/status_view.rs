//! A project's status kept as a derived view (`crate::derived_view`).
//!
//! `GET /project-status` composed its answer from seven of the other gears'
//! routes on every open of the Overview (spec rows 614 KB, the project
//! domain model 526 KB with its documents parsed again, findings, product,
//! CI runs, deployments, open pull requests): 3.5-5.4 s on the local stand
//! (2026-11-24). Those reads are made AS THE CALLER, through their routes,
//! so the status shows no more than they would; a background run has no
//! caller to make them as. So this view is kept the other way round from
//! the components': stale-while-revalidate.
//!
//! - A read answers the kept status at once, with when it was computed.
//! - A kept status older than [`FRESH_FOR`] is computed again in the
//!   background with the reader's own credentials, once per project at a
//!   time in this process, and the next read has it.
//! - `?refresh=true` (the screen's ↻), and a project with nothing kept yet,
//!   compute it now, as before.
//!
//! One status is kept per project: a member who reaches the project sees
//! the one the last reader computed. The routes it reads answer every member
//! of a project alike today (they check the project, not the person); a
//! read that came to depend on the person would have to key this by reader.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use serde_json::Value;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use crate::derived_view::{Derived, ViewInput, ViewSpec, ViewState};
use crate::domain_model::port::DomainObjects;

/// A kept status younger than this is answered as it is.
pub const FRESH_FOR: time::Duration = time::Duration::seconds(30);

/// The key of the one row the view keeps per project.
const ROW: &str = "status";

pub(crate) static VIEW: ViewSpec = ViewSpec {
    gear: "studio-organizations",
    view: "project-status",
    task_type: "organizations.project-status",
    item_entity: "project-status",
    item_name: "Project Status",
    item_description: "Where a project stands, as its Overview last computed it: the verdict, \
                       its signals and the path to a build.",
    item_fields: &[("verdict", "string")],
    state_entity: "project-status-view",
    state_name: "Project Status View",
};

/// The kept status of `project` and its state, when there is one.
pub async fn read(
    port: &dyn DomainObjects,
    ctx: &SecurityContext,
    project: Uuid,
) -> anyhow::Result<Option<(ViewState, Value)>> {
    crate::derived_view::ensure_types(port, ctx, &VIEW).await?;
    let (state, rows) = VIEW.read(port, ctx, project).await?;
    Ok(match (state, rows.into_iter().next()) {
        (Some(state), Some(row)) if state.computed_at.is_some() => Some((state, row)),
        _ => None,
    })
}

/// Keep `status` as the project's, computed now.
pub async fn keep(
    port: &dyn DomainObjects,
    ctx: &SecurityContext,
    project: Uuid,
    status: Value,
) -> anyhow::Result<ViewState> {
    crate::derived_view::ensure_types(port, ctx, &VIEW).await?;
    VIEW.store(
        port,
        ctx,
        project,
        Derived {
            inputs: vec![ViewInput {
                source: "studio-organizations/project-status".to_owned(),
                ..ViewInput::default()
            }],
            items: vec![(ROW.to_owned(), status)],
            detail: Value::Null,
        },
    )
    .await
}

/// Whether a kept status should be computed again.
pub fn stale(state: &ViewState, now: time::OffsetDateTime) -> bool {
    state
        .computed_at
        .as_deref()
        .and_then(|t| {
            time::OffsetDateTime::parse(t, &time::format_description::well_known::Rfc3339).ok()
        })
        .is_none_or(|at| now - at > FRESH_FOR)
}

/// Claim the right to compute `project` again in the background; `None`
/// when a computation of it is already running in this process. The claim
/// is let go when the guard drops.
pub fn claim(project: Uuid) -> Option<Claim> {
    let running = running();
    let mut set = running.lock().ok()?;
    set.insert(project).then_some(Claim(project))
}

fn running() -> &'static Mutex<HashSet<Uuid>> {
    static RUNNING: OnceLock<Mutex<HashSet<Uuid>>> = OnceLock::new();
    RUNNING.get_or_init(Mutex::default)
}

pub struct Claim(Uuid);

impl Drop for Claim {
    fn drop(&mut self) {
        if let Ok(mut set) = running().lock() {
            set.remove(&self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;

    fn ctx() -> SecurityContext {
        SecurityContext::builder()
            .subject_id(Uuid::from_u128(1))
            .subject_tenant_id(Uuid::from_u128(7))
            .token_scopes(vec!["*".to_string()])
            .build()
            .expect("test security context")
    }

    #[tokio::test]
    async fn a_kept_status_is_read_back_with_when_it_was_computed() {
        let port = crate::domain_model::port::in_memory();
        let project = Uuid::from_u128(9);
        assert!(
            read(port.as_ref(), &ctx(), project)
                .await
                .unwrap()
                .is_none()
        );
        keep(
            port.as_ref(),
            &ctx(),
            project,
            serde_json::json!({"verdict": "on_track", "signals": []}),
        )
        .await
        .unwrap();
        let (state, row) = read(port.as_ref(), &ctx(), project).await.unwrap().unwrap();
        assert_eq!(row["verdict"], "on_track");
        assert!(!stale(&state, time::OffsetDateTime::now_utc()));
        assert!(stale(
            &state,
            time::OffsetDateTime::now_utc() + time::Duration::minutes(5)
        ));
    }

    #[test]
    fn one_computation_per_project_at_a_time() {
        let p = Uuid::from_u128(77);
        let first = claim(p).expect("free");
        assert!(claim(p).is_none());
        drop(first);
        assert!(claim(p).is_some());
    }
}
