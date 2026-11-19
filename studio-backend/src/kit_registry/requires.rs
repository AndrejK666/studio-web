//! Declared dependencies between kits (ADR-0071 §5, answering ADR-0068 open
//! question 2): a kit that cannot work without another names it in
//! `requires`. The installer refuses an install where a required kit would
//! not apply (`KIT_REQUIRES_KIT`) and an uninstall that would leave a kit
//! that still applies without what it requires (`KIT_REQUIRED_BY`). Each
//! refusal names every kit involved, one violation each, so a client can
//! offer to install or uninstall both; nothing is installed or uninstalled
//! on the caller's behalf.
//!
//! Where: a base kit's requirements are met by base kits (they apply to
//! every organization); an organization's by its base and own kits; a
//! project's by what applies to it. An uninstall is checked on the level it
//! changes: a project kit of some project that requires an organization kit
//! being uninstalled is not found from the organization (it then shows the
//! kit's "not installed" state, as any kit whose requirement went away).

use uuid::Uuid;

use super::installed::{InstalledKit, KitInstaller, Refusal};
use super::manifest::builtin_manifest;
use super::service::{SHELF_BUILTIN, SHELF_ORGANIZATION};

impl KitInstaller {
    /// What kit `slug` at `version` requires, as its manifest declares it:
    /// a built-in kit's compiled-in `kit.json`, an organization's own kit's
    /// manifest at its pinned commit; an official kit declares none.
    pub(super) async fn requires_of(&self, org: Uuid, slug: &str, version: &str) -> Vec<String> {
        match self.kit_for(org, slug).await {
            Ok(kit) if kit.shelf == SHELF_BUILTIN => builtin_manifest(slug)
                .map(|m| m.requires)
                .unwrap_or_default(),
            Ok(kit) if kit.shelf == SHELF_ORGANIZATION => self
                .pinned_manifest(org, slug, version)
                .await
                .ok()
                .flatten()
                .map(|m| m.requires)
                .unwrap_or_default(),
            _ => Vec::new(),
        }
    }

    /// Refuse installing `slug` at `version` where `after`, what applies
    /// once it is installed, lacks a kit it requires.
    pub(super) async fn check_requires(
        &self,
        org: Uuid,
        slug: &str,
        version: &str,
        after: &[InstalledKit],
    ) -> Result<(), Refusal> {
        let missing: Vec<String> = self
            .requires_of(org, slug, version)
            .await
            .into_iter()
            .filter(|r| !requirement_met(after, r))
            .collect();
        if missing.is_empty() {
            Ok(())
        } else {
            Err(Refusal::RequiresKits {
                kit: slug.to_owned(),
                missing,
            })
        }
    }

    /// Refuse uninstalling `slug` where a kit of `after`, what still applies
    /// once it is gone, requires it.
    pub(super) async fn check_required_by(
        &self,
        org: Uuid,
        slug: &str,
        after: &[InstalledKit],
    ) -> Result<(), Refusal> {
        if requirement_met(after, slug) {
            return Ok(());
        }
        let mut by = Vec::new();
        for kit in after {
            if self
                .requires_of(org, &kit.kit_slug, &kit.version)
                .await
                .iter()
                .any(|r| r == slug)
            {
                by.push(kit.kit_slug.clone());
            }
        }
        if by.is_empty() {
            Ok(())
        } else {
            Err(Refusal::RequiredBy {
                kit: slug.to_owned(),
                by,
            })
        }
    }
}

/// Whether the required kit `slug` applies among `kits`.
pub fn requirement_met(kits: &[InstalledKit], slug: &str) -> bool {
    kits.iter().any(|k| k.kit_slug == slug)
}

#[cfg(test)]
#[path = "requires_tests.rs"]
mod tests;
