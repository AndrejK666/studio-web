//! Studio AuthZ plugin — the Studio PDP (ADR-0006).
//!
//! Reads the org access config from AM tenant metadata
//! (`cf.studio.access.config.v1`) and switches on `model`:
//!   - `tenant` (or no config / unreadable) → tenant clamp (behaviour == static);
//!   - `roles` → for a Studio resource it maps (resource_type, action) to a
//!     privilege, matches the subject's MEMBER grants, expands roles → privileges,
//!     and allows iff an in-scope grant carries the privilege; else denies.
//!
//! Roles sit ON TOP OF the tenant model, they do not replace it (ADR-0009). The
//! tenant clamp is the invariant outer boundary: every allow the role path emits
//! is AND-ed with tenant isolation, so a grant can only ever NARROW access within
//! the caller's tenant subtree — never widen it or reach across tenants. An
//! org-scoped grant resolves to the full tenant clamp; a project-scoped grant
//! intersects the clamp with the granted scope ids (owner-tenant), which the
//! subtree bound keeps inside the tenant. A mapped Studio resource with no
//! matching grant is denied — membership alone does not confer Work access.
//!
//! Safety: only Studio resources we explicitly map are role-gated. Every other
//! resource (AM tenants/metadata, RG, …) takes the tenant clamp, so selecting
//! this PDP — even with `model = "roles"` — never breaks platform operations.
//! The metadata read is itself PEP-gated, so a recursion guard short-circuits
//! authorizing reads of AM tenant-metadata to the tenant clamp.
//!
//! Patterns (client fetch, `GtsTypeId::new(<&str>)`, `resolve_metadata`) mirror
//! the in-crate `connectors` gear, which already reads tenant metadata.

use std::sync::{Arc, OnceLock};

use account_management_sdk::AccountManagementClient;
use async_trait::async_trait;
use authz_resolver_sdk::{
    AuthZResolverError, AuthZResolverPluginClient, AuthZResolverPluginSpecV1, Capability,
    Constraint, EvaluationRequest, EvaluationResponse, EvaluationResponseContext, InPredicate,
    InTenantSubtreePredicate, Predicate,
};
use gts::GtsTypeId;
use serde::Deserialize;
use toolkit::Gear;
use toolkit::client_hub::ClientScope;
use toolkit::context::GearCtx;
use toolkit::gts::PluginV1;
use toolkit_security::SecurityContext;
use toolkit_security::pep_properties;
use tracing::info;
use types_registry_sdk::{RegisterResult, TypesRegistryClient};
use uuid::Uuid;

pub(crate) const INSTANCE_ID: &str = "cf.studio.authz_resolver.plugin.v1";
/// AM tenant-metadata type holding the org access config (portal writes it).
pub(crate) const ACCESS_METADATA_TYPE: &str =
    "gts.cf.core.am.tenant_metadata.v1~cf.studio.access.config.v1~";

/* ── Config ── */

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct StudioAuthZPluginConfig {
    pub vendor: String,
    pub priority: i16,
}
impl Default for StudioAuthZPluginConfig {
    fn default() -> Self {
        Self {
            vendor: "constructorfabric".to_owned(),
            priority: 40,
        }
    }
}

/* ── Gear ── */

#[toolkit::gear(
    name = "studio-authz-plugin",
    deps = [types_registry, account_management]
)]
pub struct StudioAuthZPlugin {
    service: OnceLock<Arc<Service>>,
}
impl Default for StudioAuthZPlugin {
    fn default() -> Self {
        Self {
            service: OnceLock::new(),
        }
    }
}

#[async_trait]
impl Gear for StudioAuthZPlugin {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let cfg: StudioAuthZPluginConfig = ctx.config_or_default()?;
        info!(vendor = %cfg.vendor, priority = cfg.priority, "Loaded Studio AuthZ plugin config");

        let (instance_id, instance_json) =
            PluginV1::<AuthZResolverPluginSpecV1>::build_registration(
                INSTANCE_ID,
                cfg.vendor.clone(),
                cfg.priority,
            )?;
        let registry = ctx.client_hub().get::<dyn TypesRegistryClient>()?;
        let results = registry.register(vec![instance_json]).await?;
        RegisterResult::ensure_all_ok(&results)?;

        let am = ctx.client_hub().get::<dyn AccountManagementClient>()?;
        let service = Arc::new(Service::new(am));
        self.service
            .set(service.clone())
            .map_err(|_| anyhow::anyhow!("{} gear already initialized", Self::MODULE_NAME))?;

        let api: Arc<dyn AuthZResolverPluginClient> = service;
        ctx.client_hub()
            .register_scoped::<dyn AuthZResolverPluginClient>(
                ClientScope::gts_id(&instance_id),
                api,
            );
        info!(instance_id = %instance_id, "Studio AuthZ plugin registered");
        Ok(())
    }
}

/* ── Access config (mirrors the portal's access.ts) ── */

#[derive(Debug, Clone, Deserialize, Default)]
struct AccessConfig {
    #[serde(default)]
    model: String,
    #[serde(default)]
    roles: Vec<RoleDef>,
    #[serde(default)]
    grants: Vec<GrantDef>,
}
#[derive(Debug, Clone, Deserialize)]
struct RoleDef {
    key: String,
    #[serde(default)]
    privileges: Vec<String>,
}
#[derive(Debug, Clone, Deserialize)]
struct GrantDef {
    #[serde(rename = "subjectType")]
    subject_type: String,
    #[serde(rename = "subjectId")]
    subject_id: String,
    #[serde(rename = "roleKey")]
    role_key: String,
    #[serde(rename = "scopeType")]
    scope_type: String,
    #[serde(rename = "scopeId")]
    scope_id: String,
}

/* ── Service ── */

pub struct Service {
    am: Arc<dyn AccountManagementClient>,
}

impl Service {
    #[must_use]
    pub fn new(am: Arc<dyn AccountManagementClient>) -> Self {
        Self { am }
    }

    fn tenant_of(request: &EvaluationRequest) -> Option<Uuid> {
        request
            .context
            .tenant_context
            .as_ref()
            .and_then(|t| t.root_id)
            .or_else(|| {
                request
                    .subject
                    .properties
                    .get("tenant_id")
                    .and_then(|v| v.as_str())
                    .and_then(|s| Uuid::parse_str(s).ok())
            })
    }

    /// SecurityContext for the metadata read. Forwards the caller's identity +
    /// bearer token; the read is authorized by this same plugin's tenant clamp
    /// (see the recursion guard), so a caller-scoped context is sufficient.
    fn read_ctx(request: &EvaluationRequest, tid: Uuid) -> SecurityContext {
        let mut b = SecurityContext::builder()
            .subject_id(request.subject.id)
            .subject_tenant_id(tid)
            .token_scopes(request.context.token_scopes.clone());
        if let Some(tok) = request.context.bearer_token.as_ref() {
            b = b.bearer_token(tok.clone());
        }
        b.build().unwrap_or_else(|_| SecurityContext::anonymous())
    }

    async fn read_access_config(&self, sec: &SecurityContext, tid: Uuid) -> Option<AccessConfig> {
        match self
            .am
            .resolve_metadata(sec, tid, GtsTypeId::new(ACCESS_METADATA_TYPE))
            .await
        {
            Ok(Some(e)) => serde_json::from_value::<AccessConfig>(e.value).ok(),
            _ => None,
        }
    }
}

/// What a request can be answered with before anything is read.
///
/// Reading the org access config is a call into account-management, and the
/// only thing that consumes it is the role path. Deciding the shape of the
/// answer first means a request that cannot reach that path never pays for it
/// — which is every request until [`privilege_for`] maps a resource type.
///
/// It is a type rather than an early return so the property is structural: a
/// future edit that wants the config a little sooner has to move it into a
/// branch that says it needs one.
#[derive(Debug, PartialEq, Eq)]
enum Plan {
    /// Nothing identifies the caller's tenant, so nothing can be allowed.
    Deny,
    /// Answerable from the request alone: scope the caller to their tenant.
    Clamp(Uuid),
    /// A resource this deployment role-gates. Only this needs the config.
    Roles { tid: Uuid, privilege: &'static str },
}

impl Plan {
    fn for_request(request: &EvaluationRequest) -> Self {
        let Some(tid) = Service::tenant_of(request) else {
            return Self::Deny;
        };
        if tid == Uuid::default() {
            return Self::Deny;
        }

        // First-party / unrestricted token (`token_scopes` contains "*"): a
        // platform / service caller is never role-gated — anti-lockout backstop.
        if request.context.token_scopes.iter().any(|s| s == "*") {
            return Self::Clamp(tid);
        }

        // RECURSION GUARD: authorizing a read of AM tenant-metadata must not
        // read the config to decide (that read is itself PEP-gated → would
        // recurse).
        let rt = request.resource.resource_type.as_str();
        if rt.contains("tenant_metadata") || rt.contains("am.tenant") {
            return Self::Clamp(tid);
        }

        // Only Studio resources we map are role-gated; everything else keeps
        // tenant scoping, so the platform is never denied.
        match privilege_for(rt, &request.action.name) {
            Some(privilege) => Self::Roles { tid, privilege },
            None => Self::Clamp(tid),
        }
    }
}

#[async_trait]
impl AuthZResolverPluginClient for Service {
    async fn evaluate(
        &self,
        request: EvaluationRequest,
    ) -> Result<EvaluationResponse, AuthZResolverError> {
        let (tid, privilege) = match Plan::for_request(&request) {
            Plan::Deny => return Ok(deny()),
            Plan::Clamp(tid) => return Ok(tenant_clamp(&request, tid)),
            Plan::Roles { tid, privilege } => (tid, privilege),
        };

        // Read the org access config. Missing/unreadable OR non-roles model →
        // tenant clamp (behaviour == today, fail-safe).
        let sec = Service::read_ctx(&request, tid);
        let Some(cfg) = self.read_access_config(&sec, tid).await else {
            return Ok(tenant_clamp(&request, tid));
        };
        if cfg.model != "roles" {
            return Ok(tenant_clamp(&request, tid));
        }

        let subject_id = request.subject.id.to_string();
        // TODO(step 4): resolve the subject's Teams (RG groups) for team grants.
        let subject_teams: Vec<String> = Vec::new();

        // Walk the subject's grants that carry this privilege. An org-scoped
        // grant means "the whole tenant" (== the tenant clamp); project-scoped
        // grants collect the specific scope ids to narrow to.
        let mut org_grant = false;
        let mut project_scopes: Vec<Uuid> = Vec::new();
        for g in &cfg.grants {
            let subject_matches = match g.subject_type.as_str() {
                "member" => g.subject_id == subject_id,
                "team" => subject_teams.iter().any(|t| t == &g.subject_id),
                _ => false,
            };
            if !subject_matches {
                continue;
            }
            let role_has = cfg
                .roles
                .iter()
                .find(|r| r.key == g.role_key)
                .is_some_and(|r| r.privileges.iter().any(|p| p == privilege));
            if !role_has {
                continue;
            }
            match g.scope_type.as_str() {
                "org" => org_grant = true,
                "project" => {
                    if let Ok(pid) = Uuid::parse_str(&g.scope_id) {
                        project_scopes.push(pid);
                    }
                }
                _ => {}
            }
        }

        // An org-scoped grant carries the privilege across the whole tenant:
        // that is exactly the tenant clamp (incl. the hierarchy subtree).
        if org_grant {
            return Ok(tenant_clamp(&request, tid));
        }

        // No grant at all → deny. Roles NARROW: tenant membership by itself does
        // not confer access to a mapped Work resource.
        if project_scopes.is_empty() {
            return Ok(deny());
        }

        // Project-scoped grants: start from the tenant clamp (the invariant
        // outer boundary) and AND the granted scope ids into every branch of it.
        // Because the clamp already bounds owner-tenant to `tid` + its subtree,
        // intersecting with the scope ids can only keep those that live inside
        // the tenant — a scope id outside the subtree drops out at evaluation,
        // so a grant can never reach across tenants.
        let mut constraints = tenant_constraints(&request, tid);
        for c in &mut constraints {
            c.predicates.push(Predicate::In(InPredicate::new(
                pep_properties::OWNER_TENANT_ID,
                project_scopes.clone(),
            )));
        }
        Ok(EvaluationResponse {
            decision: true,
            context: EvaluationResponseContext {
                constraints,
                ..Default::default()
            },
        })
    }
}

/* ── Helpers ── */

/// The tenant-isolation constraint set: owner-tenant is `tid`, plus the
/// hierarchy subtree branches when the caller supports them. Returned as a bare
/// `Vec<Constraint>` so the role path can AND further narrowing into each branch
/// (constraints are OR-combined; predicates within one are AND-combined).
fn tenant_constraints(request: &EvaluationRequest, tid: Uuid) -> Vec<Constraint> {
    let mut constraints = vec![Constraint {
        predicates: vec![Predicate::In(InPredicate::new(
            pep_properties::OWNER_TENANT_ID,
            [tid],
        ))],
    }];
    let hierarchy = request
        .context
        .capabilities
        .iter()
        .any(|c| matches!(c, Capability::TenantHierarchy));
    if hierarchy {
        for prop in [pep_properties::OWNER_TENANT_ID, pep_properties::RESOURCE_ID] {
            if request
                .context
                .supported_properties
                .iter()
                .any(|p| p == prop)
            {
                constraints.push(Constraint {
                    predicates: vec![Predicate::InTenantSubtree(InTenantSubtreePredicate::new(
                        prop, tid,
                    ))],
                });
            }
        }
    }
    constraints
}

/// static-authz behaviour: allow, clamped to the context tenant (+ subtree).
fn tenant_clamp(request: &EvaluationRequest, tid: Uuid) -> EvaluationResponse {
    EvaluationResponse {
        decision: true,
        context: EvaluationResponseContext {
            constraints: tenant_constraints(request, tid),
            ..Default::default()
        },
    }
}

fn deny() -> EvaluationResponse {
    EvaluationResponse {
        decision: false,
        context: EvaluationResponseContext::default(),
    }
}

/// Map a platform request `(resource_type, action)` to a Studio privilege id
/// (the portal's `access.ts` catalogue). TODO(step 4): complete the table and
/// key off the real Studio GTS resource-type ids.
/// The privilege a resource type and action need, when this deployment
/// role-gates them.
///
/// **Returns `None` for everything today**, which is worth knowing before
/// reading further: `studio-project` (the portal's "Work") has been retired —
/// projects are AM tenants now, and their access is governed by tenant
/// membership rather than by a Studio privilege grant. Nothing is role-mapped,
/// so every request is answered by the tenant clamp and the grant evaluation in
/// [`AuthZResolverPluginClient::evaluate`] is unreachable.
///
/// That is a stage, not a leftover: the roles, grants and scopes it walks are
/// the model the access config already carries. Mapping the first resource type
/// here is what turns it on — and, through [`Plan`], what makes the config
/// worth reading.
fn privilege_for(_resource_type: &str, _action: &str) -> Option<&'static str> {
    None
}

#[cfg(test)]
mod tests {
    //! What the PDP can answer before it reads anything.
    //!
    //! Every request through the gateway reaches this plugin, and the org
    //! access config it may need is a call into account-management. So the
    //! question worth pinning is not only what the answer is, but whether
    //! arriving at it costs a round trip.

    use std::collections::HashMap;

    use authz_resolver_sdk::{Action, EvaluationRequestContext, Resource, Subject, TenantContext};

    use super::*;

    const TENANT: Uuid = Uuid::from_u128(0x7e1a);
    const SUBJECT: Uuid = Uuid::from_u128(0x5ab1);

    fn request(resource_type: &str) -> EvaluationRequest {
        EvaluationRequest {
            subject: Subject {
                id: SUBJECT,
                subject_type: Some("user".to_string()),
                properties: HashMap::new(),
            },
            action: Action {
                name: "list".to_string(),
            },
            resource: Resource {
                resource_type: resource_type.to_string(),
                id: None,
                properties: HashMap::new(),
            },
            context: EvaluationRequestContext {
                tenant_context: Some(TenantContext {
                    root_id: Some(TENANT),
                    ..TenantContext::default()
                }),
                token_scopes: Vec::new(),
                require_constraints: true,
                capabilities: Vec::new(),
                supported_properties: Vec::new(),
                bearer_token: None,
            },
        }
    }

    /// Every resource type this deployment actually serves, near enough: one
    /// per gear that has a REST surface worth authorizing.
    const STUDIO_RESOURCES: [&str; 6] = [
        "gts.cf.studio.doc.document.v1~",
        "gts.cf.studio.session.session.v1~",
        "gts.cf.studio.connector.connection.v1~",
        "gts.cf.studio.artifact.issue.v1~",
        "gts.cf.core.rg.group.v1~",
        "gts.cf.core.users.user.v1~",
    ];

    #[test]
    fn a_request_with_no_tenant_is_denied() {
        let mut req = request(STUDIO_RESOURCES[0]);
        req.context.tenant_context = None;
        assert_eq!(Plan::for_request(&req), Plan::Deny);
    }

    /// The nil uuid is what an unset tenant deserialises to, and it addresses
    /// nothing — treating it as a tenant would clamp to a scope that matches
    /// every row whose tenant was never set.
    #[test]
    fn the_nil_tenant_is_denied() {
        let mut req = request(STUDIO_RESOURCES[0]);
        req.context.tenant_context = Some(TenantContext {
            root_id: Some(Uuid::nil()),
            ..TenantContext::default()
        });
        assert_eq!(Plan::for_request(&req), Plan::Deny);
    }

    /// The anti-lockout backstop: a first-party caller is never role-gated, so
    /// a broken access config can never lock the platform out of itself.
    #[test]
    fn an_unrestricted_token_is_clamped_without_a_config_read() {
        let mut req = request(STUDIO_RESOURCES[0]);
        req.context.token_scopes = vec!["*".to_string()];
        assert_eq!(Plan::for_request(&req), Plan::Clamp(TENANT));
    }

    /// The recursion guard. Reading the access config is itself an
    /// account-management metadata read, which this plugin authorizes — so
    /// deciding that read by reading the config would not terminate.
    #[test]
    fn a_tenant_metadata_read_is_answered_without_reading_the_config() {
        for resource_type in [
            "gts.cf.core.am.tenant_metadata.v1~cf.studio.access.config.v1~",
            "gts.cf.core.am.tenant.v1~",
        ] {
            assert_eq!(
                Plan::for_request(&request(resource_type)),
                Plan::Clamp(TENANT),
                "{resource_type} must not need the config to be authorized"
            );
        }
    }

    /// The property this restructure exists for. `privilege_for` maps nothing
    /// today, so no request can reach the role path — and therefore none pays
    /// for the config read that only the role path consumes.
    ///
    /// When the first resource type is mapped this test fails, which is the
    /// point: it is the reminder that the config read has just become live,
    /// and that a cache in front of it is then worth having.
    #[test]
    fn nothing_is_role_gated_yet_so_no_request_reaches_the_config() {
        for resource_type in STUDIO_RESOURCES {
            for action in ["list", "get", "create", "update", "delete"] {
                let mut req = request(resource_type);
                req.action.name = action.to_string();
                assert_eq!(
                    Plan::for_request(&req),
                    Plan::Clamp(TENANT),
                    "{action} on {resource_type} reached the role path — `privilege_for` now \
                     maps something, so revisit the config read in `evaluate` (it happens on \
                     every one of these requests) before deleting this test"
                );
            }
        }
    }
}
