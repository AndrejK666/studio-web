//! The model part of a kit (ADR-0067 §6, ADR-0068 §5): installing a kit for
//! an organization imports its overlay into the organization's Studio domain
//! model; uninstalling removes it; installing another version applies the
//! difference. Done through the domain model's port
//! (`DomainObjects::sync_kit_model`), as this gear's service identity in the
//! organization, after the installer has checked the caller.
//!
//! Which overlay a kit has: a built-in kit's compiled-in `kit.json`
//! ([`super::manifest::builtin_manifest`]), an organization's own kit's
//! manifest at the commit its shelf pins, and none for an official kit
//! (`.cf-studio-kit.toml` brings working material only).
//!
//! The model is the organization's, so only kits that apply to the whole
//! organization — base kits and the organization's own — bring theirs
//! ([`KitInstaller::reconcile_models`]). A kit that brings a model is not
//! installed for one project (`MODEL_KIT_NOT_FOR_PROJECT`).
//!
//! **The overlay is copied into each organization's stored model** (marked
//! with its origin), not layered over a shared one. See
//! `docs/design/studio-kits.md` §3.10 for why, and for the gap it leaves.

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::installed::{InstalledKit, KitInstaller, PLATFORM_TENANT, Refusal, service_context};
use super::manifest::{builtin_manifest, overlay_of};
use super::service::{KitDescriptor, SHELF_BUILTIN, SHELF_ORGANIZATION};
use crate::domain_model::port::{DomainObjects, KitModelError, KitOverlay};

/// The `failed_precondition` kind for an overlay the organization's model
/// already has parts of from somebody else.
pub const KIT_MODEL_CONFLICT: &str = "KIT_MODEL_CONFLICT";
/// The `failed_precondition` kind for installing a model-bearing kit in one
/// project: the model is the organization's.
pub const MODEL_KIT_NOT_FOR_PROJECT: &str = "MODEL_KIT_NOT_FOR_PROJECT";

/// Where the domain model's port is.
pub trait ModelPort: Send + Sync {
    fn get(&self) -> Option<Arc<dyn DomainObjects>>;
}

/// The port the domain model publishes on the ClientHub, looked up when
/// used: it registers in its REST phase.
pub struct HubModels(pub Arc<ClientHub>);

impl ModelPort for HubModels {
    fn get(&self) -> Option<Arc<dyn DomainObjects>> {
        self.0.get::<dyn DomainObjects>().ok()
    }
}

/// One port, always (tests).
#[cfg(test)]
pub struct FixedModels(pub Arc<dyn DomainObjects>);

#[cfg(test)]
impl ModelPort for FixedModels {
    fn get(&self) -> Option<Arc<dyn DomainObjects>> {
        Some(self.0.clone())
    }
}

/// What a kit at one version brings into the model.
pub enum KitModel {
    /// This overlay.
    Overlay(KitOverlay),
    /// Nothing.
    Nothing,
    /// Not known here (an organization's kit whose shelf now pins another
    /// commit than the one installed): what the model carries stays.
    Unknown,
}

/// How long an organization's model counts as in step with the kits it was
/// last reconciled for, when that reconciliation applied everything. A
/// backstop for a model changed some other way (an upload, a revert): after
/// this long the next read reconciles again.
pub const IN_STEP_FOR: Duration = Duration::from_secs(30 * 60);

/// The same, when something could not be applied: a conflict stays until
/// somebody resolves it, and a timeout under load is worth another try, but
/// neither on every read.
pub const RETRY_AFTER: Duration = Duration::from_secs(5 * 60);

/// The kits as [`InStep::key`] names them, when they were reconciled, and
/// whether everything was applied.
type Reconciled = (Vec<(String, String)>, Instant, bool);

/// Which kits each organization's model was last reconciled for, in this
/// process: the cheap check before a read reads the model or writes to it.
#[derive(Default)]
pub struct InStep {
    /// Per organization.
    done: StdMutex<HashMap<Uuid, Reconciled>>,
    /// One reconciliation per organization at a time.
    flights: StdMutex<HashMap<Uuid, Arc<tokio::sync::Mutex<()>>>>,
}

impl InStep {
    /// The kits that apply, as what their models depend on: slug and
    /// version, in a stable order.
    pub fn key(effective: &[InstalledKit]) -> Vec<(String, String)> {
        let mut key: Vec<(String, String)> = effective
            .iter()
            .map(|k| (k.kit_slug.clone(), k.version.clone()))
            .collect();
        key.sort();
        key
    }

    /// Whether `org`'s model was reconciled for exactly `key`, recently
    /// enough.
    pub fn holds(&self, org: Uuid, key: &[(String, String)]) -> bool {
        self.done
            .lock()
            .ok()
            .and_then(|d| {
                d.get(&org).map(|(k, at, clean)| {
                    let fresh_for = if *clean { IN_STEP_FOR } else { RETRY_AFTER };
                    k.as_slice() == key && at.elapsed() < fresh_for
                })
            })
            .unwrap_or(false)
    }

    pub fn record(&self, org: Uuid, key: Vec<(String, String)>, clean: bool) {
        if let Ok(mut d) = self.done.lock() {
            d.insert(org, (key, Instant::now(), clean));
        }
    }

    fn flight(&self, org: Uuid) -> Arc<tokio::sync::Mutex<()>> {
        self.flights
            .lock()
            .map(|mut f| f.entry(org).or_default().clone())
            .unwrap_or_default()
    }
}

/// Turn a model refusal into the installer's.
fn refusal(e: anyhow::Error) -> Refusal {
    match e.downcast_ref::<KitModelError>() {
        Some(KitModelError::Conflict(m)) => Refusal::ModelConflict(m.clone()),
        Some(KitModelError::Invalid(m)) => Refusal::Invalid(m.clone()),
        None => Refusal::Internal(e),
    }
}

impl KitInstaller {
    /// What `kit` at `version` brings into `org`'s model.
    pub(super) async fn model_of(
        &self,
        org: Uuid,
        kit: &KitDescriptor,
        version: &str,
    ) -> Result<KitModel, Refusal> {
        let manifest = match kit.shelf.as_str() {
            SHELF_BUILTIN => builtin_manifest(&kit.slug),
            SHELF_ORGANIZATION => match self.pinned_manifest(org, &kit.slug, version).await? {
                Some(manifest) => Some(manifest),
                None => return Ok(KitModel::Unknown),
            },
            _ => None,
        };
        Ok(match manifest.map(|m| overlay_of(&m)).transpose() {
            Ok(Some(Some(overlay))) => KitModel::Overlay(overlay),
            Ok(_) => KitModel::Nothing,
            Err(e) => return Err(Refusal::Invalid(e)),
        })
    }

    /// Apply `kit`'s overlay at `version` to `org`'s model before the
    /// installation is recorded: a conflict refuses the install and nothing
    /// is recorded.
    pub(super) async fn apply_model(
        &self,
        org: Uuid,
        kit: &KitDescriptor,
        version: &str,
    ) -> Result<(), Refusal> {
        let Some(port) = self.models() else {
            return Ok(());
        };
        if let KitModel::Overlay(overlay) = self.model_of(org, kit, version).await? {
            port.sync_kit_model(&service_context(org)?, &kit.slug, version, Some(&overlay))
                .await
                .map_err(refusal)?;
        }
        Ok(())
    }

    /// Make `org`'s model carry the overlays of the kits that apply to the
    /// whole organization (base and its own), at their versions, and nothing
    /// of a kit that no longer applies. Answers what could not be applied,
    /// one sentence each: a read of the installed kits does not fail for it.
    ///
    /// Always reads the model and syncs every kit: for an install, an
    /// uninstall and the tests. A read of the kits asks
    /// [`Self::models_in_step`] instead.
    pub async fn reconcile_models(&self, org: Uuid) -> Result<Vec<String>, Refusal> {
        self.reconcile(org, false).await
    }

    /// [`Self::reconcile_models`] for a read of the kits (`GET
    /// /installed-kits`, the Inbox's sources, a project's phase): nothing is
    /// read from the model or written to it while the kits that apply to
    /// `org` are the ones its model was last brought in step with, within
    /// [`IN_STEP_FOR`]. A base kit's model still reaches every organization
    /// (ADR-0070): the first read after the platform installs it finds
    /// another set of kits.
    ///
    /// Reconciling on every read made `installed-kits` 1 s at the median and
    /// 6 s at p95 on Dev, logging a warning per kit per call (#1077).
    pub async fn models_in_step(&self, org: Uuid) -> Result<Vec<String>, Refusal> {
        self.reconcile(org, true).await
    }

    async fn reconcile(&self, org: Uuid, unless_in_step: bool) -> Result<Vec<String>, Refusal> {
        let Some(port) = self.models() else {
            return Ok(Vec::new());
        };
        if org == PLATFORM_TENANT {
            return Ok(Vec::new());
        }
        let ctx = service_context(org)?;
        let installed = self.installed(&ctx, org).await?;
        let applied = InStep::key(&installed.effective);
        if unless_in_step && self.in_step().holds(org, &applied) {
            return Ok(Vec::new());
        }
        // One reconciliation of an organization at a time: the shell reads
        // the kits, the Inbox's sources and a project's phase at once, and
        // the ones that waited find the model in step.
        let flight = self.in_step().flight(org);
        let _flight = flight.lock().await;
        if unless_in_step && self.in_step().holds(org, &applied) {
            return Ok(Vec::new());
        }
        let problems = self
            .reconcile_with(port.as_ref(), &ctx, org, &installed.effective)
            .await?;
        self.in_step().record(org, applied, problems.is_empty());
        Ok(problems)
    }

    async fn reconcile_with(
        &self,
        port: &dyn DomainObjects,
        ctx: &SecurityContext,
        org: Uuid,
        effective: &[InstalledKit],
    ) -> Result<Vec<String>, Refusal> {
        let carried = port.kit_models(ctx).await.map_err(Refusal::Internal)?;
        let mut keep: Vec<String> = Vec::new();
        let mut problems = Vec::new();
        for kit in effective {
            let Ok(descriptor) = self.kit_for(org, &kit.kit_slug).await else {
                continue;
            };
            match self.model_of(org, &descriptor, &kit.version).await? {
                KitModel::Overlay(overlay) => {
                    keep.push(kit.kit_slug.clone());
                    // Same-version sync is idempotent and adopts the known
                    // legacy property source before any future upgrade.
                    // It also captures organization tombstones after edits.
                    if let Err(e) = port
                        .sync_kit_model(ctx, &kit.kit_slug, &kit.version, Some(&overlay))
                        .await
                    {
                        problems.push(format!("{}: {e:#}", kit.kit_slug));
                    }
                }
                KitModel::Unknown => keep.push(kit.kit_slug.clone()),
                KitModel::Nothing => {}
            }
        }
        for slug in carried.keys().filter(|s| !keep.contains(*s)) {
            if let Err(e) = port.sync_kit_model(ctx, slug, "", None).await {
                problems.push(format!("{slug}: {e:#}"));
            }
        }
        for p in &problems {
            tracing::warn!(organization_id = %org, problem = %p, "studio-kits: a kit's model was not applied");
        }
        Ok(problems)
    }

    /// Whether a kit applies to `project` (base, its organization's or its
    /// own), and at which version.
    pub async fn applies_to_project(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        slug: &str,
    ) -> Result<Option<InstalledKit>, Refusal> {
        Ok(self
            .installed_in_project(ctx, project)
            .await?
            .effective
            .into_iter()
            .find(|k| k.kit_slug == slug))
    }
}

#[cfg(test)]
impl KitInstaller {
    /// Import kits' models through `port`: for a test outside this gear,
    /// which cannot name [`ModelPort`].
    pub fn with_model_port(self, port: Arc<dyn DomainObjects>) -> Self {
        self.with_models(Arc::new(FixedModels(port)))
    }
}
