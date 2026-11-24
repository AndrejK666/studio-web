//! A project's status kept as a derived view (`crate::derived_view`).
//!
//! `GET /project-status` composed its answer from seven of the other gears'
//! routes on every open of the Overview (spec rows 614 KB, the project
//! domain model 526 KB with its documents parsed again, findings, product,
//! CI runs, deployments, open pull requests): 3.5-5.4 s on the local stand
//! (2026-11-24). Now it is computed by this gear as itself and kept:
//!
//! - **Who computes it.** This gear's service principal
//!   (`logo::SERVICE_SUBJECT_ID`) in the project's organization
//!   (`status_read::service_ctx`), reading the other gears in process
//!   through their ports (`status_read::read`). Never a reader's token: a
//!   status computed with one reader's rights is never served to another.
//! - **When.** A `organizations.project-status` run ([`StatusDerive`], a
//!   `derived_view::DeriveTask`) computes it: queued when a kept status is
//!   older than [`FRESH_FOR`] (one run per project waits, the rest join it),
//!   and after every sync of one of the project's repositories. A project
//!   with nothing kept, and `?refresh=true`, compute it in the request, as
//!   the same service identity.
//! - **Who sees it.** A read first checks that the caller reaches the
//!   project (account-management's `get_tenant` as the caller, as the route
//!   always did); only then is the kept status read ([`read_for`]). A caller
//!   who does not reach it gets the same 404 as before.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use crate::derived_view::{Derive, Derived, ViewInput, ViewSpec, ViewState};
use crate::domain_model::port::DomainObjects;

/// A kept status younger than this is answered without queueing another.
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

/// What a read may show a caller.
#[derive(Debug, PartialEq)]
pub enum Shown {
    /// The caller does not reach the project: nothing is read for them.
    NotReached,
    /// Nothing kept yet.
    Nothing,
    Kept(Box<ViewState>, Value),
}

/// The kept status of `project` for a caller who `reaches` it (checked by
/// the route before, as the caller); [`Shown::NotReached`] without reading
/// anything otherwise.
pub async fn read_for(
    reaches: bool,
    port: &dyn DomainObjects,
    ctx: &SecurityContext,
    project: Uuid,
) -> anyhow::Result<Shown> {
    if !reaches {
        return Ok(Shown::NotReached);
    }
    crate::derived_view::ensure_types(port, ctx, &VIEW).await?;
    let (state, rows) = VIEW.read(port, ctx, project).await?;
    Ok(match (state, rows.into_iter().next()) {
        (Some(state), Some(row)) if state.computed_at.is_some() => {
            Shown::Kept(Box::new(state), row)
        }
        _ => Shown::Nothing,
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
    VIEW.store(port, ctx, project, derived(status)).await
}

fn derived(status: Value) -> Derived {
    Derived {
        inputs: vec![ViewInput {
            source: "studio-organizations/project-status".to_owned(),
            ..ViewInput::default()
        }],
        items: vec![(ROW.to_owned(), status)],
        detail: Value::Null,
    }
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

/// The `organizations.project-status` run: the status computed as this
/// gear's service identity in the project's organization.
pub struct StatusDerive {
    pub sources: Arc<super::rollups::Sources>,
    pub overview: Arc<super::overview::Overview>,
}

#[async_trait]
impl Derive for StatusDerive {
    fn spec(&self) -> &'static ViewSpec {
        &VIEW
    }

    async fn derive(
        &self,
        _ctx: &SecurityContext,
        org: &SecurityContext,
        project: Uuid,
    ) -> anyhow::Result<Derived> {
        let org_id = org.subject_tenant_id();
        let service = super::status_read::service_ctx(org_id)?;
        let dto = super::rest::compute_project_status(
            service,
            Arc::clone(&self.sources),
            Some(Arc::clone(&self.overview)),
            project,
            org_id,
        )
        .await
        .map_err(|e| anyhow::anyhow!("{e:?}"))?;
        Ok(derived(serde_json::to_value(&dto)?))
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
        assert_eq!(
            read_for(true, port.as_ref(), &ctx(), project)
                .await
                .unwrap(),
            Shown::Nothing
        );
        keep(
            port.as_ref(),
            &ctx(),
            project,
            serde_json::json!({"verdict": "on_track", "signals": []}),
        )
        .await
        .unwrap();
        let Shown::Kept(state, row) = read_for(true, port.as_ref(), &ctx(), project)
            .await
            .unwrap()
        else {
            panic!("the status was kept");
        };
        assert_eq!(row["verdict"], "on_track");
        assert!(!stale(&state, time::OffsetDateTime::now_utc()));
        assert!(stale(
            &state,
            time::OffsetDateTime::now_utc() + time::Duration::minutes(5)
        ));
    }

    #[tokio::test]
    async fn a_kept_status_is_never_shown_to_a_caller_who_does_not_reach_the_project() {
        let port = crate::domain_model::port::in_memory();
        let project = Uuid::from_u128(10);
        keep(
            port.as_ref(),
            &ctx(),
            project,
            serde_json::json!({"verdict": "blocked", "reason": "secret"}),
        )
        .await
        .unwrap();
        assert_eq!(
            read_for(false, port.as_ref(), &ctx(), project)
                .await
                .unwrap(),
            Shown::NotReached
        );
        // The same project, for a caller who reaches it.
        assert!(matches!(
            read_for(true, port.as_ref(), &ctx(), project)
                .await
                .unwrap(),
            Shown::Kept(..)
        ));
    }
}
