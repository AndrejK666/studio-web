//! The platform's own roles, its resources granted to an organization, and
//! the terms a person accepts (ADR-0081).
//!
//! Three records kept beside memberships, because they are about people and
//! what they hold (ADR-0040):
//!
//! - **Platform roles** (`operator`, `code_owner`, `account_manager`): held by
//!   a person, never a membership, so never an administrator. A platform
//!   administrator holds every one of them.
//! - **Grants**: `(kind, resource, organization)`. The kind is a kit's word;
//!   this module keeps the grant and does not interpret it.
//! - **Terms**: published per audience (`organization_admin`, `member`), one
//!   row per version, and the version each person accepted in each
//!   organization. Nothing published, nothing pending.
//!
//! The rules live in [`PlatformAccess`]; who the caller is (their person id,
//! whether they administer the platform, their role in an organization) is
//! told to it by the caller of a method, so the rules are tested without a
//! database or an identity provider. Other gears ask through
//! [`PlatformAccessPort`] in the ClientHub. Every change is an audit event
//! (`crate::audit`).

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
#[cfg(test)]
use std::sync::Mutex;

use anyhow::{Result, anyhow};
use async_trait::async_trait;
use sea_orm::{ColumnTrait, Condition, EntityTrait, QueryFilter};
use time::OffsetDateTime;
use toolkit_db::secure::{SecureDeleteExt, SecureEntityExt, SecureInsertExt, SecureOnConflict};
use toolkit_security::{AccessScope, SecurityContext};
use uuid::Uuid;

use super::entity::{self, ROOT_TENANT};
use crate::audit::{Audit, AuditEvent};

/// Runs the instance (OP stories).
pub const ROLE_OPERATOR: &str = "operator";
/// Publishes the platform's code (CO stories).
pub const ROLE_CODE_OWNER: &str = "code_owner";
/// Runs the relationship with organizations (AM stories).
pub const ROLE_ACCOUNT_MANAGER: &str = "account_manager";
/// Every platform role, in the order they are listed.
pub const PLATFORM_ROLES: [&str; 3] = [ROLE_OPERATOR, ROLE_CODE_OWNER, ROLE_ACCOUNT_MANAGER];

/// An organization's owners and administrators.
pub const AUDIENCE_ORGANIZATION_ADMIN: &str = "organization_admin";
/// Every member of an organization.
pub const AUDIENCE_MEMBER: &str = "member";
/// Every audience terms are published for.
pub const AUDIENCES: [&str; 2] = [AUDIENCE_ORGANIZATION_ADMIN, AUDIENCE_MEMBER];

/// The gear these records belong to, as audit events name it.
const GEAR: &str = "studio-user";

/// The longest title and text terms may have.
const MAX_TITLE: usize = 200;
const MAX_BODY: usize = 200_000;
/// The longest kind and resource a grant may name.
const MAX_KIND: usize = 64;
const MAX_RESOURCE: usize = 512;

const ROLE_NS: Uuid = Uuid::from_u128(0x0d5c_6a1e_9b2f_4c71_8e3a_4f60_21b7_c9d4);
const GRANT_NS: Uuid = Uuid::from_u128(0x7a14_e2c9_3b58_4d06_9f1a_65c2_8e0b_d371);
const TERMS_NS: Uuid = Uuid::from_u128(0x52e8_0f3b_a7d4_4196_b2c5_3e9a_71f0_6d28);
const ACCEPTANCE_NS: Uuid = Uuid::from_u128(0xc3a9_517d_2e64_4b8f_a0d1_9c4e_6b27_f805);

/// A platform resource granted to one organization.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Grant {
    pub id: Uuid,
    pub kind: String,
    pub resource: String,
    pub organization_id: Uuid,
    pub granted_by: String,
    pub granted_at: OffsetDateTime,
}

/// One published version of an audience's terms.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Terms {
    pub audience: String,
    pub version: i32,
    pub title: String,
    pub body: String,
    pub published_by: String,
    pub published_at: OffsetDateTime,
}

/// Who asks, as studio-user knows them.
#[derive(Clone, Debug)]
pub struct Caller {
    /// The canonical person id (ADR-0025).
    pub person: Uuid,
    /// A platform administrator (a membership of the root, ADR-0018 §3).
    pub administrator: bool,
}

/// Why a request is refused.
#[derive(Debug)]
pub enum Refusal {
    /// The caller may not do it; the reason names what they lack.
    Forbidden(&'static str),
    /// The request itself is wrong.
    Invalid(String),
    /// Nothing by that id, or nothing the caller may see.
    NotFound,
    /// The terms moved on: the caller accepted a version that is not the
    /// latest.
    Stale(i32),
    Internal(anyhow::Error),
}

impl From<anyhow::Error> for Refusal {
    fn from(e: anyhow::Error) -> Self {
        Self::Internal(e)
    }
}

/// `PLATFORM_ADMIN_REQUIRED`: only an administrator gives platform roles.
pub const PLATFORM_ADMIN_REQUIRED: &str = "PLATFORM_ADMIN_REQUIRED";
/// `ACCOUNT_MANAGER_REQUIRED`: grants are an account manager's.
pub const ACCOUNT_MANAGER_REQUIRED: &str = "ACCOUNT_MANAGER_REQUIRED";
/// `OPERATOR_REQUIRED`: terms are published by an operator.
pub const OPERATOR_REQUIRED: &str = "OPERATOR_REQUIRED";
/// `ORG_MEMBER_REQUIRED`: a member reads only their organization's grants.
pub const ORG_MEMBER_REQUIRED: &str = "ORG_MEMBER_REQUIRED";

/// Where the records live.
#[async_trait]
pub(crate) trait PlatformAccessStore: Send + Sync {
    async fn roles_of(&self, person: Uuid) -> Result<Vec<String>>;
    /// Every person's roles, by person.
    async fn all_roles(&self) -> Result<BTreeMap<Uuid, Vec<String>>>;
    /// Replace `person`'s roles with `roles`.
    async fn set_roles(&self, person: Uuid, roles: &[String], by: &str) -> Result<()>;
    async fn grants(&self, organization: Option<Uuid>, kind: Option<&str>) -> Result<Vec<Grant>>;
    async fn find_grant(&self, id: Uuid) -> Result<Option<Grant>>;
    /// Keep `grant`; `false` when it was already there.
    async fn put_grant(&self, grant: &Grant) -> Result<bool>;
    /// `false` when there was nothing to remove.
    async fn remove_grant(&self, id: Uuid) -> Result<bool>;
    /// The latest version of each audience's terms.
    async fn latest_terms(&self) -> Result<Vec<Terms>>;
    /// Publish the next version of `audience`'s terms.
    async fn publish_terms(
        &self,
        audience: &str,
        title: &str,
        body: &str,
        by: &str,
    ) -> Result<Terms>;
    /// The version of each audience `person` accepted in `organization`.
    async fn accepted(&self, person: Uuid, organization: Uuid) -> Result<BTreeMap<String, i32>>;
    async fn accept(
        &self,
        person: Uuid,
        organization: Uuid,
        audience: &str,
        version: i32,
    ) -> Result<()>;
}

/// The id a grant of `(kind, resource, organization)` has.
pub fn grant_id(kind: &str, resource: &str, organization: Uuid) -> Uuid {
    Uuid::new_v5(
        &GRANT_NS,
        format!("{kind}\u{1f}{resource}\u{1f}{organization}").as_bytes(),
    )
}

/// The audiences whose terms apply to somebody holding `org_role` in an
/// organization.
pub fn audiences_for(org_role: &str) -> Vec<&'static str> {
    if matches!(org_role, "owner" | "admin") {
        vec![AUDIENCE_ORGANIZATION_ADMIN, AUDIENCE_MEMBER]
    } else {
        vec![AUDIENCE_MEMBER]
    }
}

/// The rules (ADR-0081), over a store and the audit.
pub struct PlatformAccess {
    store: Arc<dyn PlatformAccessStore>,
    audit: Option<Audit>,
}

impl PlatformAccess {
    pub(crate) fn new(store: Arc<dyn PlatformAccessStore>) -> Self {
        Self { store, audit: None }
    }

    /// Audit every change through `audit`.
    #[must_use]
    pub fn with_audit(mut self, audit: Audit) -> Self {
        self.audit = Some(audit);
        self
    }

    async fn audit(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        action: &str,
        subject: String,
        detail: serde_json::Value,
    ) {
        if let Some(audit) = &self.audit {
            audit
                .note(
                    ctx,
                    AuditEvent::new(ctx, tenant, GEAR, action)
                        .on(subject)
                        .with(detail),
                )
                .await;
        }
    }

    /// The caller's platform roles: every one for an administrator.
    pub async fn roles(&self, caller: &Caller) -> Result<Vec<String>> {
        if caller.administrator {
            return Ok(PLATFORM_ROLES.iter().map(|r| (*r).to_owned()).collect());
        }
        let held: BTreeSet<String> = self
            .store
            .roles_of(caller.person)
            .await?
            .into_iter()
            .collect();
        Ok(PLATFORM_ROLES
            .iter()
            .filter(|r| held.contains(**r))
            .map(|r| (*r).to_owned())
            .collect())
    }

    /// Whether the caller holds `role` (an administrator holds every one).
    pub async fn holds(&self, caller: &Caller, role: &str) -> Result<bool> {
        Ok(self.roles(caller).await?.iter().any(|r| r == role))
    }

    /// Whether the caller is one of the platform's people: an administrator or
    /// the holder of any platform role.
    pub async fn is_platform_staff(&self, caller: &Caller) -> Result<bool> {
        Ok(!self.roles(caller).await?.is_empty())
    }

    /// Every person who holds a platform role, with their roles. An
    /// administrator's.
    pub async fn list_roles(
        &self,
        caller: &Caller,
    ) -> Result<BTreeMap<Uuid, Vec<String>>, Refusal> {
        if !caller.administrator {
            return Err(Refusal::Forbidden(PLATFORM_ADMIN_REQUIRED));
        }
        Ok(self.store.all_roles().await?)
    }

    /// Give `person` exactly `roles`. An administrator's.
    pub async fn set_roles(
        &self,
        ctx: &SecurityContext,
        caller: &Caller,
        person: Uuid,
        roles: &[String],
    ) -> Result<Vec<String>, Refusal> {
        if !caller.administrator {
            return Err(Refusal::Forbidden(PLATFORM_ADMIN_REQUIRED));
        }
        let mut wanted: Vec<String> = Vec::new();
        for role in roles {
            let role = role.trim();
            if !PLATFORM_ROLES.contains(&role) {
                return Err(Refusal::Invalid(format!(
                    "`{role}` is not a platform role; the roles are {PLATFORM_ROLES:?}"
                )));
            }
            if !wanted.iter().any(|w| w == role) {
                wanted.push(role.to_owned());
            }
        }
        wanted.sort_by_key(|r| PLATFORM_ROLES.iter().position(|p| p == r));
        self.store
            .set_roles(person, &wanted, &caller.person.to_string())
            .await?;
        self.audit(
            ctx,
            ROOT_TENANT,
            "platform_role.set",
            person.to_string(),
            serde_json::json!({ "roles": wanted }),
        )
        .await;
        Ok(wanted)
    }

    /// Grant `resource` of `kind` to `organization`. An administrator's or an
    /// account manager's.
    pub async fn grant(
        &self,
        ctx: &SecurityContext,
        caller: &Caller,
        kind: &str,
        resource: &str,
        organization: Uuid,
    ) -> Result<Grant, Refusal> {
        if !self.holds(caller, ROLE_ACCOUNT_MANAGER).await? {
            return Err(Refusal::Forbidden(ACCOUNT_MANAGER_REQUIRED));
        }
        let kind = kind.trim();
        let resource = resource.trim();
        let kind_ok = !kind.is_empty()
            && kind.len() <= MAX_KIND
            && kind
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
        if !kind_ok {
            return Err(Refusal::Invalid(format!(
                "a grant's kind is a short lowercase word (`repository`), not `{kind}`"
            )));
        }
        if resource.is_empty() || resource.len() > MAX_RESOURCE {
            return Err(Refusal::Invalid(format!(
                "a grant names a resource of 1 to {MAX_RESOURCE} characters"
            )));
        }
        if organization.is_nil() || organization == ROOT_TENANT {
            return Err(Refusal::Invalid(
                "a grant is made to an organization, not to the platform".to_owned(),
            ));
        }
        let grant = Grant {
            id: grant_id(kind, resource, organization),
            kind: kind.to_owned(),
            resource: resource.to_owned(),
            organization_id: organization,
            granted_by: caller.person.to_string(),
            granted_at: OffsetDateTime::now_utc(),
        };
        if self.store.put_grant(&grant).await? {
            self.audit(
                ctx,
                organization,
                "platform_grant.made",
                format!("{kind}:{resource}"),
                serde_json::json!({ "grant_id": grant.id }),
            )
            .await;
            return Ok(grant);
        }
        // Granted before: the first grant stands, with who made it and when.
        self.store
            .find_grant(grant.id)
            .await?
            .ok_or(Refusal::NotFound)
    }

    /// Take grant `id` back. An administrator's or an account manager's.
    pub async fn revoke(
        &self,
        ctx: &SecurityContext,
        caller: &Caller,
        id: Uuid,
    ) -> Result<(), Refusal> {
        if !self.holds(caller, ROLE_ACCOUNT_MANAGER).await? {
            return Err(Refusal::Forbidden(ACCOUNT_MANAGER_REQUIRED));
        }
        let Some(grant) = self.store.find_grant(id).await? else {
            return Err(Refusal::NotFound);
        };
        if self.store.remove_grant(id).await? {
            self.audit(
                ctx,
                grant.organization_id,
                "platform_grant.removed",
                format!("{}:{}", grant.kind, grant.resource),
                serde_json::json!({ "grant_id": id }),
            )
            .await;
        }
        Ok(())
    }

    /// The grants the caller may read: any, for the platform's people; their
    /// own organization's, for a member of it (`member_of`).
    pub async fn grants(
        &self,
        caller: &Caller,
        member_of: &[Uuid],
        organization: Option<Uuid>,
        kind: Option<&str>,
    ) -> Result<Vec<Grant>, Refusal> {
        let kind = kind.map(str::trim).filter(|k| !k.is_empty());
        if self.is_platform_staff(caller).await? {
            return Ok(self.store.grants(organization, kind).await?);
        }
        match organization {
            Some(org) if member_of.contains(&org) => Ok(self.store.grants(Some(org), kind).await?),
            _ => Err(Refusal::Forbidden(ORG_MEMBER_REQUIRED)),
        }
    }

    /// Publish the next version of `audience`'s terms. An administrator's or
    /// an operator's.
    pub async fn publish_terms(
        &self,
        ctx: &SecurityContext,
        caller: &Caller,
        audience: &str,
        title: &str,
        body: &str,
    ) -> Result<Terms, Refusal> {
        if !self.holds(caller, ROLE_OPERATOR).await? {
            return Err(Refusal::Forbidden(OPERATOR_REQUIRED));
        }
        let audience = audience.trim();
        if !AUDIENCES.contains(&audience) {
            return Err(Refusal::Invalid(format!(
                "`{audience}` is not an audience; the audiences are {AUDIENCES:?}"
            )));
        }
        let title = title.trim();
        if title.is_empty() || title.chars().count() > MAX_TITLE {
            return Err(Refusal::Invalid(format!(
                "terms have a title of 1 to {MAX_TITLE} characters"
            )));
        }
        if body.trim().is_empty() || body.len() > MAX_BODY {
            return Err(Refusal::Invalid(format!(
                "terms have a text of 1 to {MAX_BODY} bytes"
            )));
        }
        let terms = self
            .store
            .publish_terms(audience, title, body, &caller.person.to_string())
            .await?;
        self.audit(
            ctx,
            ROOT_TENANT,
            "terms.published",
            audience.to_owned(),
            serde_json::json!({ "version": terms.version }),
        )
        .await;
        Ok(terms)
    }

    /// The latest version of each audience's terms.
    pub async fn latest_terms(&self) -> Result<Vec<Terms>> {
        self.store.latest_terms().await
    }

    /// The terms `person`, holding `org_role` in `organization`, has yet to
    /// accept: the latest version of each audience that applies to them, when
    /// it is newer than what they accepted.
    pub async fn pending(
        &self,
        person: Uuid,
        organization: Uuid,
        org_role: &str,
    ) -> Result<Vec<Terms>> {
        let latest = self.store.latest_terms().await?;
        if latest.is_empty() {
            return Ok(Vec::new());
        }
        let accepted = self.store.accepted(person, organization).await?;
        let applies = audiences_for(org_role);
        Ok(latest
            .into_iter()
            .filter(|t| applies.contains(&t.audience.as_str()))
            .filter(|t| accepted.get(&t.audience).is_none_or(|v| *v < t.version))
            .collect())
    }

    /// `person`, holding `org_role` in `organization`, accepts `version` of
    /// `audience`'s terms. Only the latest version is accepted.
    pub async fn accept(
        &self,
        ctx: &SecurityContext,
        person: Uuid,
        organization: Uuid,
        org_role: &str,
        audience: &str,
        version: i32,
    ) -> Result<(), Refusal> {
        let audience = audience.trim();
        if !audiences_for(org_role).contains(&audience) {
            return Err(Refusal::Invalid(format!(
                "the `{audience}` terms are not yours to accept in this organization"
            )));
        }
        let latest = self
            .store
            .latest_terms()
            .await?
            .into_iter()
            .find(|t| t.audience == audience)
            .ok_or(Refusal::NotFound)?;
        if latest.version != version {
            return Err(Refusal::Stale(latest.version));
        }
        self.store
            .accept(person, organization, audience, version)
            .await?;
        self.audit(
            ctx,
            organization,
            "terms.accepted",
            audience.to_owned(),
            serde_json::json!({ "version": version }),
        )
        .await;
        Ok(())
    }
}

// ── The port other gears ask ────────────────────────────────────────────────

/// Terms a person has yet to accept, as another gear needs them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingTerms {
    pub audience: String,
    pub version: i32,
    pub title: String,
}

/// What studio-user answers about ADR-0081's records, for other gears. It
/// grows a method when a gear needs one: the kits' access rules on grants
/// (ADR-0081 phase 3) add theirs.
#[async_trait]
pub trait PlatformAccessPort: Send + Sync {
    /// The terms the caller has yet to accept in `organization`; none when
    /// they are not a member of it.
    async fn pending_terms(
        &self,
        ctx: &SecurityContext,
        organization: Uuid,
    ) -> Result<Vec<PendingTerms>>;
}

/// The port over the rules and the identity service.
pub struct HubPlatformAccess {
    pub(super) access: Arc<PlatformAccess>,
    pub(super) identity: Arc<super::service::IdentityService>,
}

#[async_trait]
impl PlatformAccessPort for HubPlatformAccess {
    async fn pending_terms(
        &self,
        ctx: &SecurityContext,
        organization: Uuid,
    ) -> Result<Vec<PendingTerms>> {
        let person = self.identity.resolve_caller(ctx).await?;
        let membership = self
            .identity
            .list_memberships(&person)
            .await?
            .into_iter()
            .find(|m| m.org_id == organization.to_string() && m.status == "active");
        let Some(membership) = membership else {
            return Ok(Vec::new());
        };
        let person = Uuid::parse_str(&person).map_err(|e| anyhow!("person id `{person}`: {e}"))?;
        Ok(self
            .access
            .pending(person, organization, &membership.role)
            .await?
            .into_iter()
            .map(|t| PendingTerms {
                audience: t.audience,
                version: t.version,
                title: t.title,
            })
            .collect())
    }
}

// ── Postgres ────────────────────────────────────────────────────────────────

fn scope() -> AccessScope {
    AccessScope::for_tenant(ROOT_TENANT)
}

#[async_trait]
impl PlatformAccessStore for super::store::PgStore {
    async fn roles_of(&self, person: Uuid) -> Result<Vec<String>> {
        let conn = self
            .db()
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        Ok(entity::platform_role::Entity::find()
            .filter(Condition::all().add(entity::platform_role::Column::PersonId.eq(person)))
            .secure()
            .scope_with(&scope())
            .all(&conn)
            .await?
            .into_iter()
            .map(|m| m.role)
            .collect())
    }

    async fn all_roles(&self) -> Result<BTreeMap<Uuid, Vec<String>>> {
        let conn = self
            .db()
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        let mut out: BTreeMap<Uuid, Vec<String>> = BTreeMap::new();
        for m in entity::platform_role::Entity::find()
            .secure()
            .scope_with(&scope())
            .all(&conn)
            .await?
        {
            out.entry(m.person_id).or_default().push(m.role);
        }
        Ok(out)
    }

    async fn set_roles(&self, person: Uuid, roles: &[String], by: &str) -> Result<()> {
        use sea_orm::IntoActiveModel;
        let conn = self
            .db()
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        // The person's roles are replaced as a set: every row goes, the
        // wanted ones come back.
        entity::platform_role::Entity::delete_many()
            .secure()
            .scope_with(&scope())
            .filter(Condition::all().add(entity::platform_role::Column::PersonId.eq(person)))
            .exec(&conn)
            .await?;
        for role in roles {
            let model = entity::platform_role::Model {
                id: Uuid::new_v5(&ROLE_NS, format!("{person}\u{1f}{role}").as_bytes()),
                tenant_id: ROOT_TENANT,
                person_id: person,
                role: role.clone(),
                granted_by: by.to_owned(),
                granted_at: OffsetDateTime::now_utc(),
            };
            entity::platform_role::Entity::insert(model.into_active_model())
                .secure()
                .scope_unchecked(&scope())?
                .exec(&conn)
                .await?;
        }
        Ok(())
    }

    async fn grants(&self, organization: Option<Uuid>, kind: Option<&str>) -> Result<Vec<Grant>> {
        let conn = self
            .db()
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        let mut filter = Condition::all();
        if let Some(org) = organization {
            filter = filter.add(entity::platform_grant::Column::OrgId.eq(org));
        }
        if let Some(kind) = kind {
            filter = filter.add(entity::platform_grant::Column::Kind.eq(kind));
        }
        let mut out: Vec<Grant> = entity::platform_grant::Entity::find()
            .filter(filter)
            .secure()
            .scope_with(&scope())
            .all(&conn)
            .await?
            .into_iter()
            .map(grant_of)
            .collect();
        out.sort_by(|a, b| {
            (a.organization_id, &a.kind, &a.resource).cmp(&(
                b.organization_id,
                &b.kind,
                &b.resource,
            ))
        });
        Ok(out)
    }

    async fn find_grant(&self, id: Uuid) -> Result<Option<Grant>> {
        let conn = self
            .db()
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        Ok(entity::platform_grant::Entity::find()
            .filter(Condition::all().add(entity::platform_grant::Column::Id.eq(id)))
            .secure()
            .scope_with(&scope())
            .all(&conn)
            .await?
            .into_iter()
            .next()
            .map(grant_of))
    }

    async fn put_grant(&self, grant: &Grant) -> Result<bool> {
        use sea_orm::IntoActiveModel;
        if self.find_grant(grant.id).await?.is_some() {
            return Ok(false);
        }
        let conn = self
            .db()
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        let model = entity::platform_grant::Model {
            id: grant.id,
            tenant_id: ROOT_TENANT,
            kind: grant.kind.clone(),
            resource: grant.resource.clone(),
            org_id: grant.organization_id,
            granted_by: grant.granted_by.clone(),
            granted_at: grant.granted_at,
        };
        entity::platform_grant::Entity::insert(model.into_active_model())
            .secure()
            .scope_unchecked(&scope())?
            .exec(&conn)
            .await?;
        Ok(true)
    }

    async fn remove_grant(&self, id: Uuid) -> Result<bool> {
        let conn = self
            .db()
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        let res = entity::platform_grant::Entity::delete_many()
            .secure()
            .scope_with(&scope())
            .filter(Condition::all().add(entity::platform_grant::Column::Id.eq(id)))
            .exec(&conn)
            .await?;
        Ok(res.rows_affected > 0)
    }

    async fn latest_terms(&self) -> Result<Vec<Terms>> {
        let conn = self
            .db()
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        let mut latest: BTreeMap<String, Terms> = BTreeMap::new();
        for m in entity::terms::Entity::find()
            .secure()
            .scope_with(&scope())
            .all(&conn)
            .await?
        {
            let t = terms_of(m);
            match latest.get(&t.audience) {
                Some(have) if have.version >= t.version => {}
                _ => {
                    latest.insert(t.audience.clone(), t);
                }
            }
        }
        Ok(ordered(latest.into_values().collect()))
    }

    async fn publish_terms(
        &self,
        audience: &str,
        title: &str,
        body: &str,
        by: &str,
    ) -> Result<Terms> {
        use sea_orm::IntoActiveModel;
        let conn = self
            .db()
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        let version = entity::terms::Entity::find()
            .filter(Condition::all().add(entity::terms::Column::Audience.eq(audience)))
            .secure()
            .scope_with(&scope())
            .all(&conn)
            .await?
            .into_iter()
            .map(|m| m.version)
            .max()
            .unwrap_or(0)
            + 1;
        let model = entity::terms::Model {
            id: Uuid::new_v5(&TERMS_NS, format!("{audience}\u{1f}{version}").as_bytes()),
            tenant_id: ROOT_TENANT,
            audience: audience.to_owned(),
            version,
            title: title.to_owned(),
            body: body.to_owned(),
            published_by: by.to_owned(),
            published_at: OffsetDateTime::now_utc(),
        };
        // Two publications at once compute the same version; the primary key
        // refuses the second, which then fails rather than overwriting.
        entity::terms::Entity::insert(model.clone().into_active_model())
            .secure()
            .scope_unchecked(&scope())?
            .exec(&conn)
            .await?;
        Ok(terms_of(model))
    }

    async fn accepted(&self, person: Uuid, organization: Uuid) -> Result<BTreeMap<String, i32>> {
        let conn = self
            .db()
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        Ok(entity::terms_acceptance::Entity::find()
            .filter(
                Condition::all()
                    .add(entity::terms_acceptance::Column::PersonId.eq(person))
                    .add(entity::terms_acceptance::Column::OrgId.eq(organization)),
            )
            .secure()
            .scope_with(&scope())
            .all(&conn)
            .await?
            .into_iter()
            .map(|m| (m.audience, m.version))
            .collect())
    }

    async fn accept(
        &self,
        person: Uuid,
        organization: Uuid,
        audience: &str,
        version: i32,
    ) -> Result<()> {
        use sea_orm::IntoActiveModel;
        let conn = self
            .db()
            .conn()
            .map_err(|e| anyhow!("identity db connect: {e}"))?;
        let model = entity::terms_acceptance::Model {
            id: Uuid::new_v5(
                &ACCEPTANCE_NS,
                format!("{person}\u{1f}{organization}\u{1f}{audience}").as_bytes(),
            ),
            tenant_id: ROOT_TENANT,
            person_id: person,
            org_id: organization,
            audience: audience.to_owned(),
            version,
            accepted_at: OffsetDateTime::now_utc(),
        };
        let on_conflict = SecureOnConflict::<entity::terms_acceptance::Entity>::columns([
            entity::terms_acceptance::Column::Id,
        ])
        .update_columns([
            entity::terms_acceptance::Column::Version,
            entity::terms_acceptance::Column::AcceptedAt,
        ])?;
        entity::terms_acceptance::Entity::insert(model.into_active_model())
            .secure()
            .scope_unchecked(&scope())?
            .on_conflict(on_conflict)
            .exec(&conn)
            .await?;
        Ok(())
    }
}

fn grant_of(m: entity::platform_grant::Model) -> Grant {
    Grant {
        id: m.id,
        kind: m.kind,
        resource: m.resource,
        organization_id: m.org_id,
        granted_by: m.granted_by,
        granted_at: m.granted_at,
    }
}

fn terms_of(m: entity::terms::Model) -> Terms {
    Terms {
        audience: m.audience,
        version: m.version,
        title: m.title,
        body: m.body,
        published_by: m.published_by,
        published_at: m.published_at,
    }
}

/// Terms in the audiences' order.
fn ordered(mut terms: Vec<Terms>) -> Vec<Terms> {
    terms.sort_by_key(|t| AUDIENCES.iter().position(|a| *a == t.audience));
    terms
}

// ── In memory, for tests ────────────────────────────────────────────────────

/// The records in memory: what the rules' tests run over.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct MemoryStore {
    roles: Mutex<BTreeMap<Uuid, Vec<String>>>,
    grants: Mutex<BTreeMap<Uuid, Grant>>,
    terms: Mutex<Vec<Terms>>,
    accepted: Mutex<BTreeMap<(Uuid, Uuid, String), i32>>,
}

#[cfg(test)]
#[async_trait]
impl PlatformAccessStore for MemoryStore {
    async fn roles_of(&self, person: Uuid) -> Result<Vec<String>> {
        Ok(self
            .roles
            .lock()
            .unwrap()
            .get(&person)
            .cloned()
            .unwrap_or_default())
    }

    async fn all_roles(&self) -> Result<BTreeMap<Uuid, Vec<String>>> {
        Ok(self
            .roles
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, r)| !r.is_empty())
            .map(|(p, r)| (*p, r.clone()))
            .collect())
    }

    async fn set_roles(&self, person: Uuid, roles: &[String], _: &str) -> Result<()> {
        self.roles.lock().unwrap().insert(person, roles.to_vec());
        Ok(())
    }

    async fn grants(&self, organization: Option<Uuid>, kind: Option<&str>) -> Result<Vec<Grant>> {
        Ok(self
            .grants
            .lock()
            .unwrap()
            .values()
            .filter(|g| organization.is_none_or(|o| g.organization_id == o))
            .filter(|g| kind.is_none_or(|k| g.kind == k))
            .cloned()
            .collect())
    }

    async fn find_grant(&self, id: Uuid) -> Result<Option<Grant>> {
        Ok(self.grants.lock().unwrap().get(&id).cloned())
    }

    async fn put_grant(&self, grant: &Grant) -> Result<bool> {
        let mut grants = self.grants.lock().unwrap();
        if grants.contains_key(&grant.id) {
            return Ok(false);
        }
        grants.insert(grant.id, grant.clone());
        Ok(true)
    }

    async fn remove_grant(&self, id: Uuid) -> Result<bool> {
        Ok(self.grants.lock().unwrap().remove(&id).is_some())
    }

    async fn latest_terms(&self) -> Result<Vec<Terms>> {
        let mut latest: BTreeMap<String, Terms> = BTreeMap::new();
        for t in self.terms.lock().unwrap().iter() {
            if latest
                .get(&t.audience)
                .is_none_or(|have| have.version < t.version)
            {
                latest.insert(t.audience.clone(), t.clone());
            }
        }
        Ok(ordered(latest.into_values().collect()))
    }

    async fn publish_terms(
        &self,
        audience: &str,
        title: &str,
        body: &str,
        by: &str,
    ) -> Result<Terms> {
        let mut terms = self.terms.lock().unwrap();
        let version = terms
            .iter()
            .filter(|t| t.audience == audience)
            .map(|t| t.version)
            .max()
            .unwrap_or(0)
            + 1;
        let t = Terms {
            audience: audience.to_owned(),
            version,
            title: title.to_owned(),
            body: body.to_owned(),
            published_by: by.to_owned(),
            published_at: OffsetDateTime::now_utc(),
        };
        terms.push(t.clone());
        Ok(t)
    }

    async fn accepted(&self, person: Uuid, organization: Uuid) -> Result<BTreeMap<String, i32>> {
        Ok(self
            .accepted
            .lock()
            .unwrap()
            .iter()
            .filter(|((p, o, _), _)| *p == person && *o == organization)
            .map(|((_, _, a), v)| (a.clone(), *v))
            .collect())
    }

    async fn accept(
        &self,
        person: Uuid,
        organization: Uuid,
        audience: &str,
        version: i32,
    ) -> Result<()> {
        self.accepted
            .lock()
            .unwrap()
            .insert((person, organization, audience.to_owned()), version);
        Ok(())
    }
}

#[cfg(test)]
#[path = "platform_access_tests.rs"]
mod tests;
