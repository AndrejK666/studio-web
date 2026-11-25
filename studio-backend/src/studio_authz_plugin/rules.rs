//! The access-rules port (ADR-0079 §4): a gear vouches for a service identity
//! of its own, and the PDP reads the registrations instead of naming the gear.
//!
//! A service beside Studio that works in projects' tenants on nobody's behalf
//! (the spec-graph service indexing a project's documents) signs in with a
//! client-credentials token of its own. Its token's tenant is the platform
//! root, whose subtree is every tenant, so without a rule of its own it would
//! reach every project of every organization. A [`ServiceRule`] narrows that
//! subject to:
//! - the resource types the rule lists, and nothing else of the platform;
//! - a target tenant the request names (`?tenant=`), never its own home;
//! - a target where the rule's kit applies (base ∪ organization ∪ project).
//!
//! The gear registers the rule in its own module:
//!
//! ```ignore
//! inventory::submit! {
//!     crate::studio_authz_plugin::ServiceRule {
//!         gear: "studio-spec-graph",
//!         subject: config::service_subject,
//!         resource_types: &[...],
//!         kit: "spec-graph",
//!     }
//! }
//! ```

use authz_resolver_sdk::EvaluationRequest;
use uuid::Uuid;

/// One service identity a gear vouches for.
pub struct ServiceRule {
    /// The gear that registered it, for the logs.
    pub gear: &'static str,
    /// The subject the service's token carries, when this deployment
    /// configures one. `None` means the rule names nobody and admits nothing.
    pub subject: fn() -> Option<Uuid>,
    /// The PDP resource types the service may touch, every action on them.
    pub resource_types: &'static [&'static str],
    /// The kit that has to apply where the service acts.
    pub kit: &'static str,
}

inventory::collect!(ServiceRule);

/// The rule whose subject made this request, if any.
pub(super) fn rule_for(request: &EvaluationRequest) -> Option<&'static ServiceRule> {
    // A person is never a service rule's subject, whatever id they carry.
    if request.subject.subject_type.as_deref() == Some("user") {
        return None;
    }
    inventory::iter::<ServiceRule>
        .into_iter()
        .find(|rule| (rule.subject)() == Some(request.subject.id))
}

/// What a rule answers before the kit is read.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum RuleDecision {
    /// Not a resource the rule lists, or no target tenant named.
    Deny,
    /// Allowed in `target` alone, if the rule's kit applies there.
    IfKit { target: Uuid },
}

/// `target` is the tenant the request names when it is not the subject's
/// home ([`super::foreign_target`]).
pub(super) fn decide(
    rule: &ServiceRule,
    request: &EvaluationRequest,
    target: Option<Uuid>,
) -> RuleDecision {
    if !rule
        .resource_types
        .contains(&request.resource.resource_type.as_str())
    {
        return RuleDecision::Deny;
    }
    match target {
        Some(target) => RuleDecision::IfKit { target },
        None => RuleDecision::Deny,
    }
}

/// Metadata documents a gear writes alone (ADR-0079 §4, access rules).
///
/// The gear checks who may change them and then writes as the service; the
/// generic metadata route would answer a member's write with the tenant
/// clamp, so the PDP refuses every caller's own write of a type listed here,
/// and lets reads through as before. The gear registers its types in its own
/// module:
///
/// ```ignore
/// inventory::submit! {
///     crate::studio_authz_plugin::GearHeldMetadata {
///         gear: "studio-environments",
///         type_ids: &[ENVIRONMENTS_METADATA_TYPE, DEPLOYMENTS_METADATA_TYPE],
///     }
/// }
/// ```
pub struct GearHeldMetadata {
    /// The gear that registered it, for the logs.
    pub gear: &'static str,
    /// Full GTS ids of the tenant-metadata types only that gear writes.
    pub type_ids: &'static [&'static str],
}

inventory::collect!(GearHeldMetadata);

/// Is `type_id` held by some gear's registration?
pub(super) fn is_gear_held(type_id: &str) -> bool {
    inventory::iter::<GearHeldMetadata>
        .into_iter()
        .any(|held| held.type_ids.contains(&type_id))
}

/// Who the artifact sync is when it reads through the GitHub mirror (#1094).
///
/// The gear that runs the sync registers this in the ClientHub as
/// `dyn MirrorSyncSubject`; the PDP asks it per request. No registration, or
/// `None`, means nobody is the sync and every mirror request is refused.
#[async_trait::async_trait]
pub trait MirrorSyncSubject: Send + Sync {
    /// The subject the sync's client-credentials token carries.
    async fn subject_id(&self) -> Option<Uuid>;
}
