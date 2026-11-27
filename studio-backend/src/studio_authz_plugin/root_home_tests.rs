//! An organization's objects need its membership.
//!
//! A person whose token names the platform root reached every organization:
//! the clamp kept the token's tenant, and the root's subtree is everything.
//! So account-management answered `get_tenant` for any organization, and every
//! route that acts in the organization a request names (`?organization_id=`,
//! a project's scope) took that as reach. Here the root counts only for a
//! platform administrator (a membership of the root) and for a service.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::HashMap;

use account_management_sdk::{
    AccountManagementClient, CreateTenantRequest, IdpNewUser, IdpServiceAccountCredentials,
    IdpServiceAccountSummary, IdpUser, IdpUserPatch, ListUsersQuery, MetadataEntry, Tenant,
    UpdateTenantRequest, UpsertMetadataRequest,
};
use authz_resolver_sdk::{Action, EvaluationRequestContext, Resource, Subject, TenantContext};
use toolkit_canonical_errors::CanonicalError;
use toolkit_odata::{ODataQuery, Page};

use super::*;

const ROOT: Uuid = PLATFORM_ROOT;
const ORG: Uuid = Uuid::from_u128(0x0ee5);
const OTHER_ORG: Uuid = Uuid::from_u128(0x41c6);
const PERSON: Uuid = Uuid::from_u128(0xde0);

const AM_TENANT: &str = "gts.cf.core.am.tenant.v1~";

/// What studio-user answers: the caller's memberships, nothing else.
struct Members(Vec<Uuid>);

#[async_trait]
impl crate::user_profile::OrganizationReader for Members {
    async fn organizations_of(&self, _: &str) -> anyhow::Result<Vec<Uuid>> {
        Ok(self.0.clone())
    }
    async fn grant_keys_of(&self, subject: &str) -> anyhow::Result<Vec<String>> {
        Ok(vec![subject.to_owned()])
    }
    async fn is_platform_admin(&self, _: &str) -> anyhow::Result<bool> {
        Ok(self.0.contains(&ROOT))
    }
    async fn memberships_of_subject(
        &self,
        _: &str,
    ) -> anyhow::Result<Vec<crate::user_profile::SubjectMembership>> {
        Ok(Vec::new())
    }
    fn membership_generation(&self) -> u64 {
        0
    }
}

/// No organization has an access config: every one is on the tenant model,
/// as the stand's was.
struct NoConfigs;

#[async_trait]
impl AccountManagementClient for NoConfigs {
    async fn create_tenant(
        &self,
        _: &SecurityContext,
        _: CreateTenantRequest,
    ) -> Result<Tenant, CanonicalError> {
        unimplemented!()
    }
    async fn get_tenant(&self, _: &SecurityContext, _: Uuid) -> Result<Tenant, CanonicalError> {
        unimplemented!()
    }
    async fn list_children(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: &ODataQuery,
    ) -> Result<Page<Tenant>, CanonicalError> {
        unimplemented!()
    }
    async fn update_tenant(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: UpdateTenantRequest,
    ) -> Result<Tenant, CanonicalError> {
        unimplemented!()
    }
    async fn suspend_tenant(&self, _: &SecurityContext, _: Uuid) -> Result<Tenant, CanonicalError> {
        unimplemented!()
    }
    async fn unsuspend_tenant(
        &self,
        _: &SecurityContext,
        _: Uuid,
    ) -> Result<Tenant, CanonicalError> {
        unimplemented!()
    }
    async fn delete_tenant(&self, _: &SecurityContext, _: Uuid) -> Result<Tenant, CanonicalError> {
        unimplemented!()
    }
    async fn create_user(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: IdpNewUser,
    ) -> Result<IdpUser, CanonicalError> {
        unimplemented!()
    }
    async fn get_user(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: Uuid,
    ) -> Result<IdpUser, CanonicalError> {
        unimplemented!()
    }
    async fn list_users(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: ListUsersQuery,
    ) -> Result<Page<IdpUser>, CanonicalError> {
        unimplemented!()
    }
    async fn delete_user(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: Uuid,
    ) -> Result<(), CanonicalError> {
        unimplemented!()
    }
    async fn update_user(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: Uuid,
        _: IdpUserPatch,
    ) -> Result<IdpUser, CanonicalError> {
        unimplemented!()
    }
    async fn create_service_account(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: String,
        _: Vec<String>,
    ) -> Result<IdpServiceAccountCredentials, CanonicalError> {
        unimplemented!()
    }
    async fn list_service_accounts(
        &self,
        _: &SecurityContext,
        _: Uuid,
    ) -> Result<Vec<IdpServiceAccountSummary>, CanonicalError> {
        unimplemented!()
    }
    async fn rotate_service_account_secret(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: &str,
    ) -> Result<IdpServiceAccountCredentials, CanonicalError> {
        unimplemented!()
    }
    async fn revoke_service_account(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: &str,
    ) -> Result<(), CanonicalError> {
        unimplemented!()
    }
    async fn get_metadata(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: GtsTypeId,
    ) -> Result<MetadataEntry, CanonicalError> {
        unimplemented!()
    }
    async fn resolve_metadata(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: GtsTypeId,
    ) -> Result<Option<MetadataEntry>, CanonicalError> {
        Ok(None)
    }
    async fn list_metadata(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: &ODataQuery,
    ) -> Result<Page<MetadataEntry>, CanonicalError> {
        unimplemented!()
    }
    async fn upsert_metadata(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: UpsertMetadataRequest,
    ) -> Result<MetadataEntry, CanonicalError> {
        unimplemented!()
    }
    async fn delete_metadata(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: GtsTypeId,
    ) -> Result<(), CanonicalError> {
        unimplemented!()
    }
}

fn pdp(memberships: &[Uuid]) -> Service {
    let hub = Arc::new(ClientHub::new());
    hub.register_scoped::<dyn crate::user_profile::OrganizationReader>(
        ClientScope::gts_id(crate::user_profile::IDENTITY_INSTANCE_ID),
        Arc::new(Members(memberships.to_vec())),
    );
    Service::new(Arc::new(NoConfigs), hub)
}

/// A request from `home`, about `resource_type`, as a tenant-scoped PEP with
/// the hierarchy capability sends it (account-management's `get_tenant`, the
/// domain model's object read).
fn asked(
    resource_type: &str,
    action: &str,
    home: Uuid,
    subject_type: Option<&str>,
) -> EvaluationRequest {
    let mut properties = HashMap::new();
    properties.insert("tenant_id".to_owned(), serde_json::json!(home.to_string()));
    EvaluationRequest {
        subject: Subject {
            id: PERSON,
            subject_type: subject_type.map(str::to_owned),
            properties,
        },
        action: Action {
            name: action.to_owned(),
        },
        resource: Resource {
            resource_type: resource_type.to_owned(),
            id: None,
            properties: HashMap::new(),
        },
        context: EvaluationRequestContext {
            tenant_context: Some(TenantContext {
                root_id: Some(home),
                ..TenantContext::default()
            }),
            token_scopes: vec!["*".to_owned()],
            require_constraints: true,
            capabilities: vec![Capability::TenantHierarchy],
            supported_properties: vec![pep_properties::OWNER_TENANT_ID.to_owned()],
            bearer_token: None,
        },
    }
}

/// Every tenant the answer's constraints admit, by value or as a subtree.
fn admitted(answer: &EvaluationResponse) -> Vec<Uuid> {
    let mut out = Vec::new();
    for c in &answer.context.constraints {
        for p in &c.predicates {
            let ids: Vec<Uuid> = match p {
                Predicate::In(inp) => inp
                    .values
                    .iter()
                    .filter_map(|v| v.as_str().and_then(|s| Uuid::parse_str(s).ok()))
                    .collect(),
                Predicate::InTenantSubtree(t) => t
                    .root_tenant_id
                    .as_str()
                    .and_then(|s| Uuid::parse_str(s).ok())
                    .into_iter()
                    .collect(),
                _ => Vec::new(),
            };
            for id in ids {
                if !out.contains(&id) {
                    out.push(id);
                }
            }
        }
    }
    out
}

/// What the stand showed: a person whose token names the root, a member of
/// nothing, read another organization's tenant (so `?organization_id=` and a
/// project's scope resolved) and its domain objects. Now neither.
#[tokio::test]
async fn a_root_home_alone_reaches_no_organization() {
    let pdp = pdp(&[]);
    for subject_type in [
        None,
        Some("user"),
        Some("gts.cf.core.security.subject_user.v1~"),
    ] {
        let tenant = pdp
            .evaluate(asked(AM_TENANT, "get", ROOT, subject_type))
            .await
            .unwrap();
        assert!(!tenant.decision, "{subject_type:?} reached the tenant tree");
        let objects = pdp
            .evaluate(asked(
                crate::domain_model::DOMAIN_OBJECT_RESOURCE,
                "read",
                ROOT,
                subject_type,
            ))
            .await
            .unwrap();
        assert!(!objects.decision, "{subject_type:?} read domain objects");
    }
}

/// A member of one organization, home the root, reaches that organization
/// and not the root's subtree: not another organization.
#[tokio::test]
async fn a_root_home_reaches_only_the_organizations_it_is_a_member_of() {
    let answer = pdp(&[OTHER_ORG])
        .evaluate(asked(AM_TENANT, "get", ROOT, None))
        .await
        .unwrap();
    assert!(answer.decision);
    let reach = admitted(&answer);
    assert!(reach.contains(&OTHER_ORG));
    assert!(
        !reach.contains(&ROOT),
        "the root's subtree is every organization"
    );
    assert!(!reach.contains(&ORG));
}

/// A platform administrator is a member of the root, and reaches through it.
#[tokio::test]
async fn a_platform_administrator_reaches_through_the_root_membership() {
    let answer = pdp(&[ROOT])
        .evaluate(asked(AM_TENANT, "get", ROOT, None))
        .await
        .unwrap();
    assert!(answer.decision);
    assert!(admitted(&answer).contains(&ROOT));
}

/// A service has a tenant and no memberships: its root stays.
#[tokio::test]
async fn a_service_keeps_its_root() {
    for service in ["service", SERVICE_SUBJECT_TYPE] {
        let answer = pdp(&[])
            .evaluate(asked(AM_TENANT, "get", ROOT, Some(service)))
            .await
            .unwrap();
        assert!(answer.decision, "{service}");
        assert!(admitted(&answer).contains(&ROOT), "{service}");
    }
}

/// A home that is an organization is unchanged: it reaches itself.
#[tokio::test]
async fn an_organization_home_still_reaches_itself() {
    let answer = pdp(&[])
        .evaluate(asked(AM_TENANT, "get", ORG, None))
        .await
        .unwrap();
    assert!(answer.decision);
    assert_eq!(admitted(&answer), vec![ORG]);
}

#[test]
fn only_the_root_home_is_conditional() {
    assert!(home_in_reach(ORG, None, false));
    assert!(home_in_reach(ORG, Some("user"), false));
    assert!(!home_in_reach(ROOT, None, false));
    assert!(!home_in_reach(ROOT, Some("user"), false));
    assert!(home_in_reach(ROOT, None, true));
    assert!(home_in_reach(ROOT, Some("service"), false));
    assert!(home_in_reach(ROOT, Some(SERVICE_SUBJECT_TYPE), false));
}

/// A clamp over no tenant admits nothing a tenant owns, and still leaves a
/// platform-global resource (no tenant property) alone.
#[test]
fn a_clamp_over_no_tenant_is_a_refusal() {
    let owned = asked(AM_TENANT, "get", ROOT, None);
    assert!(!tenant_clamp(&owned, &[]).decision);
    let mut global = asked("gts.cf.core.uc.usage_type.v1~", "list", ROOT, None);
    global.context.supported_properties = Vec::new();
    global.context.capabilities = Vec::new();
    assert!(tenant_clamp(&global, &[]).decision);
}
