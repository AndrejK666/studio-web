//! The kit-runtime port (ADR-0079 §4): how a built-in kit's function joins
//! studio-kits without studio-kits naming it.
//!
//! A kit's function (ADR-0068 §9: compiled in until kit functions run in
//! Studio's function runtime) lives in its own module, `src/<kit>/`, and
//! registers a [`KitFunction`] there. studio-kits collects every registration
//! and names none:
//!
//! - **at init** it starts each one with a [`KitHost`]: the [`KitRuntime`]
//!   (whether the kit applies, the organization's model in step with its
//!   kits, the project's own object), the ClientHub and the organization
//!   access check. What the function registers on the hub for other gears
//!   (Project lifecycle's [`super::port::ProjectPhases`]) it registers there.
//! - **in `register_rest`** it mounts the routes each started function serves
//!   on its own router ([`mount`]), in [`KitFunction::order`], under the same
//!   `KIT_NOT_INSTALLED` layer as studio-kits' other claimed writes.
//!
//! **A kit serves only what its manifest claims.** [`mount`] records every
//! operation a function registers and holds it to the kit's compiled-in
//! `kit.json` ([`super::claims::kit_serves`]): a write its `gears` claim on
//! studio-kits, a read its `permissions.reads` names. One unclaimed route
//! stops studio-kits at start, naming it.
//!
//! The MCP tools a kit's function serves go through the core's MCP port
//! (`crate::mcp::sdk::ToolSet`), registered beside its [`KitFunction`].

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use axum::Router;
use serde_json::{Value, json};
use toolkit::api::OpenApiRegistry;
use toolkit::api::operation_builder::OperationSpec;
use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;
use utoipa::openapi::{RefOr, schema::Schema};
use uuid::Uuid;

use super::installed::KitInstaller;
pub use super::installed::Refusal;
use super::manifest::{builtin_manifest, overlay_of};
/// The REST answer to a [`Refusal`], with the codes a client branches on:
/// the one a kit's routes give, as studio-kits' own do.
pub use super::rest::{ProjectKitQuery, refused};
use crate::domain_model::port::{DomainObjects, KitOverlay};
use crate::org_scope::OrgAccess;

/// The gear a kit's function serves its routes and tools on.
pub const GEAR: &str = "studio-kits";

/// What studio-kits lends a kit's function: the kit's state where it acts.
#[async_trait]
pub trait KitRuntime: Send + Sync + 'static {
    /// Whether `kit` applies to `project`: a base kit, its organization's or
    /// its own.
    async fn applies_to_project(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        kit: &str,
    ) -> Result<bool, Refusal>;

    /// Whether `kit` applies to the organization `org`: a base kit or its
    /// own. The caller has been shown to reach `org`.
    async fn applies_to_organization(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        kit: &str,
    ) -> Result<bool, Refusal>;

    /// `project`'s organization, and the caller acting in it: where the
    /// organization's model is.
    async fn org_ctx(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
    ) -> Result<(Uuid, SecurityContext), Refusal>;

    /// Bring `org`'s model in step with the kits that apply to it, so a
    /// kit's types and fields are there before its function reads them
    /// (cheap when nothing changed).
    async fn models_in_step(&self, org: Uuid) -> Result<(), Refusal>;

    /// The domain model; `None` while it is not running.
    fn models(&self) -> Option<Arc<dyn DomainObjects>>;

    /// The project's own object, whole: its instance id and payload.
    async fn project_object(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
    ) -> Result<Option<(String, Value)>, Refusal>;

    /// Write the project's own object whole, as `ctx`. With
    /// [`Self::project_object`], the one place a kit's function reaches the
    /// type a project's object is stored as (ADR-0073 §6; studio-web#1118
    /// stores it as its kit's subtype of Project): a kit's fields go through
    /// these two, never through a query or a write of their own.
    async fn put_project_object(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        payload: Value,
    ) -> anyhow::Result<()>;
}

/// The model a built-in kit's compiled-in `kit.json` brings: what its
/// function reads its own vocabulary and lifecycles from.
pub fn builtin_overlay(kit: &str) -> Option<KitOverlay> {
    builtin_manifest(kit).and_then(|m| overlay_of(&m).ok().flatten())
}

/// Now, RFC 3339: what a kit's function stamps a write with.
pub fn now_rfc3339() -> anyhow::Result<String> {
    super::service::now_rfc3339()
}

/// What a kit's function is started with.
pub struct KitHost {
    pub runtime: Arc<dyn KitRuntime>,
    pub hub: Arc<ClientHub>,
    /// Whether the caller reaches a project or an organization.
    pub access: OrgAccess,
}

/// A started kit function: the routes it serves on studio-kits.
pub trait KitRoutes: Send + Sync {
    /// Add its routes to `router`, each registered in `openapi`, with what
    /// their handlers read layered on.
    fn register_rest(&self, router: Router, openapi: &dyn OpenApiRegistry) -> Router;
}

/// A built-in kit's function, registered in the kit's own module:
/// `inventory::submit! { crate::kit_registry::runtime::KitFunction { … } }`.
pub struct KitFunction {
    /// The kit's slug: the manifest its routes are held to.
    pub kit: &'static str,
    /// Where its routes are mounted, lowest first. Two functions never share
    /// an order.
    pub order: u16,
    /// Called once, in studio-kits' init.
    pub start: fn(&KitHost) -> anyhow::Result<Arc<dyn KitRoutes>>,
}

inventory::collect!(KitFunction);

/// Every registered kit function, in [`KitFunction::order`].
pub fn functions() -> Vec<&'static KitFunction> {
    let mut found: Vec<&KitFunction> = inventory::iter::<KitFunction>.into_iter().collect();
    found.sort_by_key(|f| (f.order, f.kit));
    found
}

/// The started functions: what `register_rest` mounts.
pub struct Started(pub Vec<(&'static str, Arc<dyn KitRoutes>)>);

/// Start every registered kit function with `host`.
pub fn start_all(host: &KitHost) -> anyhow::Result<Started> {
    let mut out = Vec::new();
    for f in functions() {
        let routes = (f.start)(host)
            .map_err(|e| anyhow::anyhow!("the kit `{}`'s function did not start: {e:#}", f.kit))?;
        out.push((f.kit, routes));
    }
    Ok(Started(out))
}

/// `kit`'s routes on `router`, refused when one of them is not the kit's to
/// serve (the claimed-route gate).
pub fn mount(
    kit: &str,
    routes: &dyn KitRoutes,
    router: Router,
    openapi: &dyn OpenApiRegistry,
) -> anyhow::Result<Router> {
    let recording = Recording {
        inner: openapi,
        seen: Mutex::new(Vec::new()),
    };
    let router = routes.register_rest(router, &recording);
    let seen = recording
        .seen
        .into_inner()
        .unwrap_or_else(|e| e.into_inner());
    let unclaimed: Vec<String> = seen
        .into_iter()
        .filter(|(method, path)| !super::claims::kit_serves(kit, GEAR, method, path))
        .map(|(method, path)| format!("{method} {path}"))
        .collect();
    if unclaimed.is_empty() {
        Ok(router)
    } else {
        Err(anyhow::anyhow!(
            "the kit `{kit}` serves routes its kit.json does not claim: {}. A kit's function \
             serves only a write its `gears` claim on {GEAR} or a read its `permissions.reads` \
             names (ADR-0071 §4, ADR-0079 §4)",
            unclaimed.join(", ")
        ))
    }
}

/// The OpenAPI registry a kit's routes are registered through: every
/// operation is passed on, and its method and path kept for the gate.
struct Recording<'a> {
    inner: &'a dyn OpenApiRegistry,
    seen: Mutex<Vec<(String, String)>>,
}

impl OpenApiRegistry for Recording<'_> {
    fn register_operation(&self, spec: &OperationSpec) {
        self.seen
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push((spec.method.as_str().to_owned(), spec.path.clone()));
        self.inner.register_operation(spec);
    }

    fn ensure_schema_raw(&self, name: &str, schemas: Vec<(String, RefOr<Schema>)>) -> String {
        self.inner.ensure_schema_raw(name, schemas)
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self.inner.as_any()
    }
}

/// studio-kits' [`KitRuntime`]: the installer's answer.
pub(super) struct InstallerRuntime(pub(super) Arc<KitInstaller>);

#[async_trait]
impl KitRuntime for InstallerRuntime {
    async fn applies_to_project(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        kit: &str,
    ) -> Result<bool, Refusal> {
        Ok(self
            .0
            .applies_to_project(ctx, project, kit)
            .await?
            .is_some())
    }

    async fn applies_to_organization(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        kit: &str,
    ) -> Result<bool, Refusal> {
        Ok(self
            .0
            .installed(ctx, org)
            .await?
            .effective
            .iter()
            .any(|k| k.kit_slug == kit))
    }

    async fn org_ctx(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
    ) -> Result<(Uuid, SecurityContext), Refusal> {
        let org = self.0.store().organization_of(ctx, project).await;
        let at = crate::org_scope::acting_in(ctx, org)
            .map_err(|e| Refusal::Internal(anyhow::anyhow!("{e}")))?;
        Ok((org, at))
    }

    async fn models_in_step(&self, org: Uuid) -> Result<(), Refusal> {
        self.0.models_in_step(org).await.map(|_| ())
    }

    fn models(&self) -> Option<Arc<dyn DomainObjects>> {
        self.0.models()
    }

    async fn project_object(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
    ) -> Result<Option<(String, Value)>, Refusal> {
        let port = self
            .models()
            .ok_or_else(|| Refusal::Internal(anyhow::anyhow!("the domain model is not running")))?;
        let (rows, _) = port
            .query(
                ctx,
                json!({
                    "type": "project",
                    "project_id": project.to_string(),
                    "where": { "tenant_id": { "_eq": project.to_string() } },
                    "limit": 1,
                }),
            )
            .await
            .map_err(Refusal::Internal)?;
        Ok(rows.into_iter().next().map(|r| (r.instance_id, r.payload)))
    }

    async fn put_project_object(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        payload: Value,
    ) -> anyhow::Result<()> {
        let port = self
            .models()
            .ok_or_else(|| anyhow::anyhow!("the domain model is not running"))?;
        port.upsert_in(ctx, "project", "self", &project.to_string(), payload)
            .await
            .map(|_| ())
    }
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
