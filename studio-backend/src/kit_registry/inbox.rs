//! Inbox sources from kits (ADR-0068 §6, phase 4).
//!
//! A kit declares, in its manifest's `inbox`, queries over its objects that
//! say what waits on whom: `query` is the body `POST
//! /studio-domain-model/v1/query` takes, with the string `"$me"` standing for
//! the person whose Inbox is read; `title` names an item (`{field}` is a field
//! of the row); `workspace_field` names the field that holds the workspace an
//! item is in. This gear only says which sources apply to an organization —
//! those of the kits installed for the whole of it (base and its own), at the
//! version installed. studio-user's Inbox runs them as the person
//! (`GET /studio-user/v1/me/inbox`), so the PDP decides what each person sees.

use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::installed::{KitInstaller, Refusal};
use super::manifest::{ManifestInboxSource, builtin_manifest};
use super::service::{SHELF_BUILTIN, SHELF_ORGANIZATION};

/// One source, with the kit it comes from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KitInboxSource {
    pub kit_slug: String,
    pub kit_name: String,
    pub kit_version: String,
    pub source: ManifestInboxSource,
}

impl KitInstaller {
    /// The Inbox sources of the kits that apply to the organization `org`.
    /// The caller has been shown to reach it. The kits' models are brought
    /// up to date first, so the fields the sources query exist.
    pub async fn inbox_sources(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
    ) -> Result<Vec<KitInboxSource>, Refusal> {
        let installed = self.installed(ctx, org).await?;
        let org = installed.organization_id;
        self.reconcile_models(org).await?;
        let mut out = Vec::new();
        for kit in &installed.effective {
            let Ok(descriptor) = self.kit_for(org, &kit.kit_slug).await else {
                continue;
            };
            let manifest = match descriptor.shelf.as_str() {
                SHELF_BUILTIN => builtin_manifest(&kit.kit_slug),
                SHELF_ORGANIZATION => {
                    self.pinned_manifest(org, &kit.kit_slug, &kit.version)
                        .await?
                }
                _ => None,
            };
            for source in manifest.into_iter().flat_map(|m| m.inbox) {
                if source.query.is_none() {
                    continue;
                }
                out.push(KitInboxSource {
                    kit_slug: kit.kit_slug.clone(),
                    kit_name: descriptor.name.clone(),
                    kit_version: kit.version.clone(),
                    source,
                });
            }
        }
        Ok(out)
    }
}
