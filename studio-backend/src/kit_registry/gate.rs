//! One shared `KIT_NOT_INSTALLED` (ADR-0071 §4, step 2).
//!
//! What a kit claims of a gear (`claims.rs`) is refused where the kit does
//! not apply to the project or organization a call acts in:
//!
//! - **a claimed write route**: [`with_claimed_routes`], the layer a gear puts
//!   on its router, maps the request to its claim and answers
//!   `failed_precondition` `KIT_NOT_INSTALLED` naming the kit before the
//!   handler runs. Reads are never claimed: shell summaries and other kits'
//!   screens keep reading.
//! - **a claimed MCP tool**: studio-mcp asks [`tool_refusal`] before a call.
//! - **what only a kit brings inside a gear** (Constructor Research in
//!   studio-environments, a project's phase): the gear asks [`require_kit`]
//!   and answers with the same [`KitRefusal`].
//!
//! No gear writes the answer itself. A gear may also skip an expensive sync
//! of a type whose claim opts in (`sync_only_with_kit`): [`sync_wanted`].
//!
//! Where the call acts: the most specific tenant it names -- a project, a
//! workspace, an organization (`project_id`, `workspace_id`,
//! `organization_id`/`org_id` in the path, the query or a JSON body) -- else
//! the caller's own. A named tenant the caller cannot reach is not answered
//! here: the handler says it is not there, so nobody learns from this check
//! which kits another organization has.

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::extract::Request;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value};
use toolkit::client_hub::ClientHub;
use toolkit_canonical_errors::CanonicalError;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::claims::Claims;
use super::port::KitPresence;
use super::rest::KitRegistryError;
use super::service::builtin_catalogue;
use crate::studio_session::sdk::{TenantMembership, WorkspaceAccess};

/// The `failed_precondition` kind: something a kit brings is used where the
/// kit does not apply. The violation's `subject` is the kit's slug.
pub const KIT_NOT_INSTALLED: &str = "KIT_NOT_INSTALLED";

/// The most a claimed write's JSON body is read for the tenant it names.
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;

/// Why a call is refused for its kit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KitRefusal {
    /// The kit does not apply where the call acts.
    NotInstalled { kit: String },
    /// Whether it applies could not be read.
    Unavailable(String),
}

impl KitRefusal {
    /// The sentence a person reads: which kit, and where it is installed.
    pub fn detail(&self) -> String {
        match self {
            Self::NotInstalled { kit } => {
                let name = builtin_catalogue()
                    .into_iter()
                    .find(|k| &k.slug == kit)
                    .map(|k| k.name);
                let named = match name {
                    Some(name) => format!("the {name} kit (`{kit}`)"),
                    None => format!("the kit `{kit}`"),
                };
                if !crate::composition::kit_on(kit) {
                    return format!(
                        "this comes with {named}, which this deployment does not run: its \
                         operator switches it on in the configuration (`vendor.studio.kits`)"
                    );
                }
                format!(
                    "this comes with {named}, which is not installed here: an administrator \
                     installs it for the organization under Organization › Kits, or for one \
                     project under Project › Kits"
                )
            }
            Self::Unavailable(why) => why.clone(),
        }
    }

    /// The REST answer: 400 `failed_precondition`, `KIT_NOT_INSTALLED`, the
    /// kit's slug as the violation's subject; or 503 when the kits could not
    /// be read.
    pub fn problem(&self) -> CanonicalError {
        match self {
            Self::NotInstalled { kit } => KitRegistryError::failed_precondition()
                .with_precondition_violation(kit.clone(), self.detail(), KIT_NOT_INSTALLED)
                .create(),
            Self::Unavailable(why) => CanonicalError::service_unavailable()
                .with_detail(why.clone())
                .create(),
        }
    }

    /// The text an MCP tool answers with, marked as its error.
    pub fn tool_text(&self) -> String {
        match self {
            Self::NotInstalled { kit } => {
                format!("{KIT_NOT_INSTALLED} (kit {kit}): {}", self.detail())
            }
            Self::Unavailable(why) => format!("Studio answered 503: {why}"),
        }
    }
}

/// Whether `kit` applies where `tenant` is: the one check behind every
/// `KIT_NOT_INSTALLED`. `presence` absent (an assembly without studio-kits)
/// holds nothing back: there are no kits to install there.
pub async fn require_kit_with(
    presence: Option<&dyn KitPresence>,
    ctx: &SecurityContext,
    tenant: Uuid,
    kit: &str,
) -> Result<(), KitRefusal> {
    // A kit this deployment does not run applies nowhere (ADR-0079 §5).
    if !crate::composition::kit_on(kit) {
        return Err(KitRefusal::NotInstalled {
            kit: kit.to_owned(),
        });
    }
    let Some(presence) = presence else {
        return Ok(());
    };
    match presence.applies(ctx, tenant, kit).await {
        Ok(true) => Ok(()),
        Ok(false) => Err(KitRefusal::NotInstalled {
            kit: kit.to_owned(),
        }),
        Err(e) => Err(KitRefusal::Unavailable(format!(
            "whether the kit `{kit}` is installed could not be read: {e:#}"
        ))),
    }
}

/// [`require_kit_with`] through the ClientHub, for a gear that has already
/// shown the caller reaches `tenant`.
pub async fn require_kit(
    hub: &ClientHub,
    ctx: &SecurityContext,
    tenant: Uuid,
    kit: &str,
) -> Result<(), KitRefusal> {
    let presence = hub.get::<dyn KitPresence>().ok();
    require_kit_with(presence.as_deref(), ctx, tenant, kit).await
}

/// The tenants a call names, the most specific first.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Named {
    pub project: Option<Uuid>,
    pub workspace: Option<Uuid>,
    pub organization: Option<Uuid>,
}

impl Named {
    /// Take `name = value` where `name` says which tenant it is; a value that
    /// is not a UUID names nothing.
    pub fn take(&mut self, name: &str, value: &str) {
        let Ok(id) = Uuid::parse_str(value.trim()) else {
            return;
        };
        let slot = match name {
            "project_id" => &mut self.project,
            "workspace_id" => &mut self.workspace,
            "organization_id" | "org_id" => &mut self.organization,
            _ => return,
        };
        slot.get_or_insert(id);
    }

    /// Take the top-level fields of a JSON object (an MCP tool's arguments,
    /// a request's body).
    pub fn take_object(&mut self, object: &Map<String, Value>) {
        for (k, v) in object {
            if let Some(s) = v.as_str() {
                self.take(k, s);
            }
        }
    }

    pub fn is_empty(&self) -> bool {
        self.most_specific().is_none()
    }

    /// The tenant the call acts in, when it names one.
    pub fn most_specific(&self) -> Option<Uuid> {
        self.project.or(self.workspace).or(self.organization)
    }
}

/// The check for a call of something `kit` claims, named `named`: where the
/// caller's own tenant, or the tenant it names and may reach, does not have
/// the kit, the refusal. A tenant the caller cannot reach passes, for the
/// handler to answer.
pub async fn claimed_call(
    presence: Option<&dyn KitPresence>,
    access: Option<&dyn WorkspaceAccess>,
    ctx: &SecurityContext,
    kit: &str,
    named: &Named,
) -> Result<(), KitRefusal> {
    let home = ctx.subject_tenant_id();
    let tenant = named.most_specific().unwrap_or(home);
    if tenant != home {
        match access {
            Some(access) if access.may_reach(ctx, tenant).await => {}
            _ => return Ok(()),
        }
    }
    require_kit_with(presence, ctx, tenant, kit).await
}

/// [`claimed_call`] through the ClientHub.
async fn claimed_call_in(
    hub: &ClientHub,
    ctx: &SecurityContext,
    kit: &str,
    named: &Named,
) -> Result<(), KitRefusal> {
    let presence = hub.get::<dyn KitPresence>().ok();
    let access = hub
        .get::<dyn account_management_sdk::AccountManagementClient>()
        .ok()
        .map(TenantMembership::new);
    claimed_call(
        presence.as_deref(),
        access.as_ref().map(|a| a as &dyn WorkspaceAccess),
        ctx,
        kit,
        named,
    )
    .await
}

/// Why MCP tool `tool`, called with `args`, is refused for its kit: `None`
/// when no kit claims it or the kit applies.
pub async fn tool_refusal(
    hub: &ClientHub,
    ctx: &SecurityContext,
    tool: &str,
    args: &Map<String, Value>,
) -> Option<KitRefusal> {
    let claim = Claims::builtin().tool_claim(tool)?;
    let mut named = Named::default();
    named.take_object(args);
    claimed_call_in(hub, ctx, &claim.kit, &named).await.err()
}

/// `router` with `gear`'s claimed write routes checked on the way in: where
/// the claiming kit does not apply, `KIT_NOT_INSTALLED` before the handler
/// runs. Put on a gear's router after its routes, as the last thing its
/// `register_rest` does; only that gear's claims are looked at, so a layer
/// that also wraps another gear's routes leaves them alone.
pub fn with_claimed_routes(
    router: axum::Router,
    hub: Arc<ClientHub>,
    gear: &'static str,
) -> axum::Router {
    router.layer(axum::middleware::from_fn(
        move |request: Request, next: Next| {
            let hub = Arc::clone(&hub);
            async move { claimed_route(&hub, gear, request, next).await }
        },
    ))
}

async fn claimed_route(hub: &ClientHub, gear: &str, request: Request, next: Next) -> Response {
    let Some((claim, params)) =
        Claims::builtin().route_match(request.method().as_str(), request.uri().path())
    else {
        return next.run(request).await;
    };
    if claim.gear != gear {
        return next.run(request).await;
    }
    let Some(ctx) = request.extensions().get::<SecurityContext>().cloned() else {
        return next.run(request).await;
    };
    let (named, request) = match named_by(params, request).await {
        Ok(read) => read,
        Err(response) => return response,
    };
    match claimed_call_in(hub, &ctx, &claim.kit, &named).await {
        Ok(()) => next.run(request).await,
        Err(refusal) => refusal.problem().into_response(),
    }
}

/// The tenants a request names: its path's parameters, its query, and -- when
/// neither names one -- its JSON body's top-level fields. The request comes
/// back whole.
async fn named_by(
    params: BTreeMap<String, String>,
    request: Request,
) -> Result<(Named, Request), Response> {
    let mut named = Named::default();
    for (k, v) in &params {
        named.take(k, v);
    }
    for pair in request.uri().query().unwrap_or_default().split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            named.take(k, v);
        }
    }
    let json = request
        .headers()
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("application/json"));
    if !named.is_empty() || !json {
        return Ok((named, request));
    }
    let (parts, body) = request.into_parts();
    let bytes = axum::body::to_bytes(body, MAX_BODY_BYTES)
        .await
        .map_err(|e| {
            KitRegistryError::invalid_argument()
                .with_constraint(format!("the request body could not be read: {e}"))
                .create()
                .into_response()
        })?;
    if let Ok(Value::Object(object)) = serde_json::from_slice::<Value>(&bytes) {
        named.take_object(&object);
    }
    Ok((
        named,
        Request::from_parts(parts, axum::body::Body::from(bytes)),
    ))
}

/// Whether `gear` should run its expensive sync of `type_id` where `tenant`
/// is: always, unless the type's claim opts in (`sync_only_with_kit`) and its
/// kit does not apply there. Reading the kits failing keeps the sync going:
/// skipping is an optimisation, never a refusal.
pub async fn sync_wanted(
    claims: &Claims,
    presence: Option<&dyn KitPresence>,
    ctx: &SecurityContext,
    tenant: Uuid,
    gear: &str,
    type_id: &str,
) -> bool {
    let Some(kit) = claims.sync_kit(gear, type_id) else {
        return true;
    };
    // A kit this deployment does not run wants nothing synced for it.
    if !crate::composition::kit_on(kit) {
        return false;
    }
    let Some(presence) = presence else {
        return true;
    };
    match presence.applies(ctx, tenant, kit).await {
        Ok(applies) => applies,
        Err(e) => {
            tracing::warn!(
                gear,
                kit,
                type_id,
                error = %format!("{e:#}"),
                "studio-kits: whether a kit applies could not be read; the sync goes on"
            );
            true
        }
    }
}

#[cfg(test)]
#[path = "gate_tests.rs"]
mod tests;
