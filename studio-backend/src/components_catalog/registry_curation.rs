//! Publication requests and the platform's gear curators (ADR-0042 §4).
//!
//! Giving a gear to the platform is two people's decision. An organization
//! administrator asks (`request_publication`, recorded on the entry), and the
//! request joins the platform's queue. A platform curator -- a platform
//! administrator, or a person the platform's administrators named
//! (`platform-gear-curator`) -- publishes it, which opens the pull request
//! into the platform's gear repository (`registry_publish.rs`), or declines
//! it with a reason. Either answer leaves the queue.
//!
//! Both lists live in the platform's (root) tenant, in its registry settings
//! record: the queue spans every organization, and the curators are the
//! platform's. They are read and written acting in the root
//! (`registry::in_tenant`), whoever asks; who may ask is the routes' check.
//!
//! The list rules are pure ([`with_request`], [`without_request`],
//! [`normalize_curators`], [`is_curator`]) and tested with tables.

use serde::{Deserialize, Serialize};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::gts;
use super::registry;
use super::service::CatalogService;
use super::tiers::PLATFORM_TENANT;

/// One organization's request that the platform take one of its gears.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicationRequest {
    pub organization_id: Uuid,
    /// The organization's name when it asked, for a curator who cannot read
    /// the organization.
    #[serde(default)]
    pub organization_name: Option<String>,
    /// The registry entry's name.
    pub name: String,
    /// The version the organization asks to give, when it named one.
    #[serde(default)]
    pub version: Option<String>,
    /// Why the platform should take it.
    #[serde(default)]
    pub reason: Option<String>,
    /// The person who asked: their Studio id, else the token's subject.
    pub requested_by: String,
    #[serde(default)]
    pub requested_by_name: Option<String>,
    /// RFC 3339.
    pub at: String,
}

/// A person who may publish into the platform beside its administrators.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Curator {
    /// Their Studio person id.
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
}

fn same_request(r: &PublicationRequest, organization_id: Uuid, name: &str) -> bool {
    r.organization_id == organization_id && r.name.eq_ignore_ascii_case(name)
}

/// The queue with `request` in it: a second request for the same entry
/// replaces the first, oldest first otherwise.
pub fn with_request(
    mut queue: Vec<PublicationRequest>,
    request: PublicationRequest,
) -> Vec<PublicationRequest> {
    queue.retain(|r| !same_request(r, request.organization_id, &request.name));
    queue.push(request);
    queue.sort_by(|a, b| a.at.cmp(&b.at));
    queue
}

/// The queue without the request for one entry, and whether it was there.
pub fn without_request(
    mut queue: Vec<PublicationRequest>,
    organization_id: Uuid,
    name: &str,
) -> (Vec<PublicationRequest>, bool) {
    let before = queue.len();
    queue.retain(|r| !same_request(r, organization_id, name));
    let removed = queue.len() != before;
    (queue, removed)
}

/// Curators once each, by id, without blank ids, in the order given.
pub fn normalize_curators(curators: Vec<Curator>) -> Vec<Curator> {
    let mut out: Vec<Curator> = Vec::new();
    for mut c in curators {
        c.id = c.id.trim().to_owned();
        c.name = c
            .name
            .map(|n| n.trim().to_owned())
            .filter(|n| !n.is_empty());
        if c.id.is_empty() || out.iter().any(|o| o.id == c.id) {
            continue;
        }
        out.push(c);
    }
    out
}

/// Whether the person `id` is one of `curators`.
pub fn is_curator(curators: &[Curator], id: &str) -> bool {
    curators.iter().any(|c| c.id == id)
}

impl CatalogService {
    async fn root_settings(
        &self,
        ctx: &SecurityContext,
    ) -> anyhow::Result<(SecurityContext, registry::SettingsRecord)> {
        let root = registry::in_tenant(ctx, PLATFORM_TENANT)?;
        let settings = self.settings(&root).await?;
        Ok((root, settings))
    }

    async fn save_root_settings(
        &self,
        root: &SecurityContext,
        mut settings: registry::SettingsRecord,
    ) -> anyhow::Result<()> {
        self.sink.register_types(root).await?;
        settings.organization_id = Some(PLATFORM_TENANT);
        self.sink
            .upsert(
                root,
                &[gts::registry_settings_node(
                    &PLATFORM_TENANT.to_string(),
                    serde_json::to_value(settings)?,
                )],
                &[],
            )
            .await
    }

    /// An organization's name as `ctx` reads it, for the queue.
    pub async fn tenant_name(&self, ctx: &SecurityContext, tenant: Uuid) -> Option<String> {
        let am = self.account_management.get()?;
        am.get_tenant(ctx, tenant).await.ok().map(|t| t.name)
    }

    /// Every organization's open publication requests, oldest first.
    pub async fn publication_requests(
        &self,
        ctx: &SecurityContext,
    ) -> anyhow::Result<Vec<PublicationRequest>> {
        Ok(self.root_settings(ctx).await?.1.publication_requests)
    }

    /// The open request for one entry, if there is one.
    pub async fn publication_request(
        &self,
        ctx: &SecurityContext,
        organization_id: Uuid,
        name: &str,
    ) -> anyhow::Result<Option<PublicationRequest>> {
        Ok(self
            .publication_requests(ctx)
            .await?
            .into_iter()
            .find(|r| same_request(r, organization_id, name)))
    }

    /// Put a request in the platform's queue.
    pub async fn put_publication_request(
        &self,
        ctx: &SecurityContext,
        request: PublicationRequest,
    ) -> anyhow::Result<()> {
        let (root, mut settings) = self.root_settings(ctx).await?;
        settings.publication_requests =
            with_request(std::mem::take(&mut settings.publication_requests), request);
        self.save_root_settings(&root, settings).await
    }

    /// Take one entry's request out of the queue; `false` when it had none.
    pub async fn drop_publication_request(
        &self,
        ctx: &SecurityContext,
        organization_id: Uuid,
        name: &str,
    ) -> anyhow::Result<bool> {
        let (root, mut settings) = self.root_settings(ctx).await?;
        let (queue, removed) = without_request(
            std::mem::take(&mut settings.publication_requests),
            organization_id,
            name,
        );
        if !removed {
            return Ok(false);
        }
        settings.publication_requests = queue;
        self.save_root_settings(&root, settings).await?;
        Ok(true)
    }

    /// The platform's gear curators.
    pub async fn gear_curators(&self, ctx: &SecurityContext) -> anyhow::Result<Vec<Curator>> {
        Ok(self.root_settings(ctx).await?.1.gear_curators)
    }

    /// Replace the platform's gear curators.
    pub async fn set_gear_curators(
        &self,
        ctx: &SecurityContext,
        curators: Vec<Curator>,
    ) -> anyhow::Result<Vec<Curator>> {
        let (root, mut settings) = self.root_settings(ctx).await?;
        settings.gear_curators = normalize_curators(curators);
        let out = settings.gear_curators.clone();
        self.save_root_settings(&root, settings).await?;
        Ok(out)
    }
}

#[cfg(test)]
#[path = "registry_curation_tests.rs"]
mod tests;
