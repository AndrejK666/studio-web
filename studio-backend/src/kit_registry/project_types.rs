//! An organization's project types (ADR-0073 Amendment 2, studio-web#1119).
//!
//! A project type is a kit whose model derives a type of its own from the
//! core Project type. An organization's types are the built-in ones plus the
//! kits installed in that organization (its own, from its shelf) whose
//! overlay declares such a subtype: the administrator installing one is the
//! trust decision.
//!
//! Such a kit runs no code of its own at creation. Its `project_creation`
//! names only steps of Studio's fixed vocabulary
//! ([`super::manifest::PROJECT_CREATION_STEPS`]), checked when its manifest is
//! read, and its `next_steps` routes must be screens Studio has: the shell's
//! own sections, a built-in kit's screens, or the kit's own. Both are checked
//! again when it is installed ([`check_project_type`]), and an install that
//! fails them is refused with the reason.
//!
//! A project created with it gets the kit at the version its organization
//! installed, not whatever the shelf moved on to since.

use std::collections::BTreeSet;

use uuid::Uuid;

use super::installed::{KitInstaller, PLATFORM_TENANT, Refusal, service_context};
use super::manifest::{KitManifest, PROJECT_CREATION_STEPS, project_type_kit, project_type_kits};
use super::service::{SHELF_BUILTIN, SHELF_ORGANIZATION};

/// The shell's own screens a next step may open: the sections no kit brings
/// (`studio-frontend-prototype/src-app/mfe_packages/*/mfe.json`; a test holds the two
/// together).
pub const SHELL_ROUTES: [&str; 13] = [
    "/projects/overview",
    "/projects/sources",
    "/projects/sources/connect",
    "/projects/settings",
    "/projects/team",
    "/projects/artifacts",
    "/projects/activity",
    "/connections",
    "/kits",
    "/people",
    "/organization/settings",
    "/organization/workspaces",
    "/search",
];

/// One project type an organization offers: the kit's manifest and the
/// version it comes at (Studio's own for a built-in kit, the version the
/// organization installed for one of its own).
#[derive(Clone, Debug)]
pub struct OrgProjectType {
    pub manifest: KitManifest,
    pub version: Option<String>,
    /// `builtin` or `organization`.
    pub shelf: &'static str,
}

/// Every screen route a project type's next step may open: the shell's
/// sections, each built-in kit's screens, and `kit`'s own screens.
pub fn known_routes(kit: &KitManifest) -> BTreeSet<String> {
    let mut out: BTreeSet<String> = SHELL_ROUTES.iter().map(|r| (*r).to_owned()).collect();
    out.extend(super::contents::builtin_screen_routes());
    out.extend(kit.screens.iter().filter_map(|s| s.route.clone()));
    out
}

/// Is `kit`, as a project type, one Studio can create projects of? Its
/// creation steps are Studio's fixed ones and each next step opens a screen
/// Studio has. A kit that is no project type passes.
pub fn check_project_type(kit: &KitManifest) -> Result<(), String> {
    if kit.project_subtype().is_none() {
        return Ok(());
    }
    let Some(creation) = &kit.project_creation else {
        return Ok(());
    };
    if let Some(step) = creation
        .steps
        .iter()
        .find(|s| !PROJECT_CREATION_STEPS.contains(&s.as_str()))
    {
        return Err(format!(
            "`{}` is a project type whose creation step `{step}` is not one of Studio's ({})",
            kit.slug,
            PROJECT_CREATION_STEPS.join(", ")
        ));
    }
    let known = known_routes(kit);
    if let Some(n) = creation
        .next_steps
        .iter()
        .find(|n| !known.contains(&n.route))
    {
        return Err(format!(
            "`{}` is a project type whose next step `{}` opens `{}`, which is no screen of \
             Studio's or of the kit's own; a next step opens one of {}",
            kit.slug,
            n.id,
            n.route,
            known.into_iter().collect::<Vec<_>>().join(", ")
        ));
    }
    Ok(())
}

impl KitInstaller {
    /// The project types `org` offers: the built-in ones, in the library's
    /// order, then the organization's own installed kits that are one, by
    /// slug, each at the version the organization installed.
    pub(super) async fn project_types(&self, org: Uuid) -> Result<Vec<OrgProjectType>, Refusal> {
        let mut out: Vec<OrgProjectType> = project_type_kits()
            .map(|manifest| OrgProjectType {
                manifest,
                version: None,
                shelf: SHELF_BUILTIN,
            })
            .collect();
        if org == PLATFORM_TENANT || org.is_nil() {
            return Ok(out);
        }
        let doc = self.store().read(&service_context(org)?, org).await?;
        let mut own: Vec<_> = doc
            .kits
            .iter()
            .filter(|r| r.shelf == SHELF_ORGANIZATION)
            .collect();
        own.sort_by(|a, b| a.kit_slug.cmp(&b.kit_slug));
        for record in own {
            let Some(manifest) = self
                .pinned_manifest(org, &record.kit_slug, &record.version)
                .await?
            else {
                continue;
            };
            // One that no longer passes is not offered (it was checked when
            // installed; the rules can tighten since).
            if manifest.project_subtype().is_some() && check_project_type(&manifest).is_ok() {
                out.push(OrgProjectType {
                    manifest,
                    version: Some(record.version.clone()),
                    shelf: SHELF_ORGANIZATION,
                });
            }
        }
        Ok(out)
    }

    /// `org`'s project type `slug`, if it offers one.
    pub(super) async fn project_type(
        &self,
        org: Uuid,
        slug: &str,
    ) -> Result<Option<OrgProjectType>, Refusal> {
        if let Some(manifest) = project_type_kit(slug) {
            // A built-in type the organization installed itself comes at
            // that version; otherwise at Studio's.
            let version = self.organization_version(org, slug).await?;
            return Ok(Some(OrgProjectType {
                manifest,
                version,
                shelf: SHELF_BUILTIN,
            }));
        }
        Ok(self
            .project_types(org)
            .await?
            .into_iter()
            .find(|t| t.manifest.slug == slug))
    }

    /// The version `org` itself installed `slug` at, if it did.
    async fn organization_version(&self, org: Uuid, slug: &str) -> Result<Option<String>, Refusal> {
        if org == PLATFORM_TENANT || org.is_nil() {
            return Ok(None);
        }
        let doc = self.store().read(&service_context(org)?, org).await?;
        Ok(doc
            .kits
            .into_iter()
            .find(|r| r.kit_slug == slug)
            .map(|r| r.version))
    }
}

#[cfg(test)]
#[path = "project_types_tests.rs"]
mod tests;
