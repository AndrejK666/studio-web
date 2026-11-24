//! A project's build records, read and written in its organization's model.
//!
//! The records live in the domain model of the organization that owns the
//! project (ADR-0066 §8a), whoever asks. They used to go to the caller's own
//! tenant: for a platform administrator that is the platform root. The
//! start-up sweep (`studio-domain-model rehome`) then moved them into the
//! organization and marked the root's copies deleted, and every later read
//! in the root answered "no build" -- on the stand (2026-11-24) the passed
//! Research build `research-7a977fac4b5a` was deployed at 09:49 UTC and was
//! gone at 09:50, when the sweep moved 19 439 objects of the project.
//!
//! So every read and write of a build record goes through [`OrgBuilds`],
//! which acts in the organization: the same caller, the organization's
//! tenant.

use std::sync::Arc;

use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use crate::artifact_ingest::port::{BuildOutcome, BuildRecord, BuildRecords};

/// The build records of the projects of organization `org`.
#[derive(Clone)]
pub(crate) struct OrgBuilds {
    records: Arc<dyn BuildRecords>,
    org: Uuid,
}

impl OrgBuilds {
    pub(crate) fn new(records: Arc<dyn BuildRecords>, org: Uuid) -> Self {
        Self { records, org }
    }

    /// The deployment's build records, for organization `org`; an error
    /// where the deployment keeps none.
    pub(crate) fn of(hub: &ClientHub, org: Uuid) -> anyhow::Result<Self> {
        hub.get::<dyn BuildRecords>()
            .map(|records| Self::new(records, org))
            .map_err(|_| anyhow::anyhow!("builds are not available in this deployment"))
    }

    /// `ctx`, acting in the organization.
    fn there(&self, ctx: &SecurityContext) -> anyhow::Result<SecurityContext> {
        if ctx.subject_tenant_id() == self.org {
            return Ok(ctx.clone());
        }
        crate::org_scope::acting_in(ctx, self.org).map_err(|e| {
            anyhow::anyhow!(
                "the build records of organization {} cannot be reached: {e}",
                self.org
            )
        })
    }

    pub(crate) async fn build(
        &self,
        ctx: &SecurityContext,
        project: &str,
        build_id: &str,
    ) -> anyhow::Result<Option<BuildRecord>> {
        self.records
            .build(&self.there(ctx)?, project, build_id)
            .await
    }

    pub(crate) async fn builds(
        &self,
        ctx: &SecurityContext,
        project: &str,
        limit: usize,
    ) -> anyhow::Result<Vec<BuildRecord>> {
        self.records.builds(&self.there(ctx)?, project, limit).await
    }

    pub(crate) async fn record(
        &self,
        ctx: &SecurityContext,
        project: &str,
        outcome: &BuildOutcome,
    ) -> anyhow::Result<()> {
        self.records
            .record(&self.there(ctx)?, project, outcome)
            .await
    }
}

#[cfg(test)]
#[path = "build_records_tests.rs"]
mod tests;
