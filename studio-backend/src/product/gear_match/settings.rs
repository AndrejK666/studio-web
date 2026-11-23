//! A strategy's service's run settings: the provider and models a match uses
//! and its call bounds (`GET`/`PUT /v1/settings` of `gears-matcher/v1`,
//! `docs/design/product-gear-match.md` §10).
//!
//! The service keeps and checks them; Studio passes them through and decides
//! who may change them. Whose service it is decides that:
//!
//! - the organization's own (an `assembly-service` connection): an
//!   administrator of that organization (`kit.manage`, as for its default
//!   strategy);
//! - the deployment's (`config.gears_matcher`), which every organization
//!   without a connection shares: a platform administrator only, since a
//!   change reaches every one of them.
//!
//! Keys are never settings: they stay in the service's own configuration
//! (ADR-0075 §6), and nothing here takes or shows one. Who changed them is the
//! caller, never what a client says.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Value, json};
use toolkit::client_hub::{ClientHub, ClientScope};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::client::MatcherError;
use super::{GearMatches, Refusal};
use crate::product::assembly::DEFAULT_PRIVILEGE;

/// Whose service runs a strategy for an organization.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ServiceScope {
    /// The organization connected it.
    Organization,
    /// The deployment's own, shared by every organization without one.
    Deployment,
}

impl ServiceScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Organization => "organization",
            Self::Deployment => "deployment",
        }
    }
}

/// The reason a caller who may not change the settings is refused with (403).
pub const ADMIN_REQUIRED: &str = "MATCHER_SETTINGS_ADMIN_REQUIRED";
/// The settings changed since the caller read them (409).
pub const CONFLICT: &str = "MATCHER_SETTINGS_CONFLICT";
/// The provider asked for has no key in the service's configuration.
pub const PROVIDER_UNAVAILABLE: &str = "MATCHER_PROVIDER_UNAVAILABLE";
/// A model id or a bound the service refuses.
pub const BAD_SETTINGS: &str = "MATCHER_BAD_SETTINGS";

/// Who administers what, as the settings ask it.
#[async_trait]
pub trait SettingsAuthority: Send + Sync {
    /// May the caller administer `org` (its owner, the privilege on the
    /// roles model, or a platform administrator)?
    async fn administers(&self, ctx: &SecurityContext, org: Uuid) -> bool;
    /// Is the caller a platform administrator?
    async fn is_platform_admin(&self, ctx: &SecurityContext) -> bool;
}

/// May the caller change the settings of a service of `scope` for `org`?
pub async fn may_change(
    authority: &dyn SettingsAuthority,
    ctx: &SecurityContext,
    org: Uuid,
    scope: ServiceScope,
) -> bool {
    match scope {
        ServiceScope::Organization => authority.administers(ctx, org).await,
        ServiceScope::Deployment => authority.is_platform_admin(ctx).await,
    }
}

/// [`SettingsAuthority`] over studio-user, as the rest of the backend asks it.
pub struct HubAuthority(pub Arc<ClientHub>);

#[async_trait]
impl SettingsAuthority for HubAuthority {
    async fn administers(&self, ctx: &SecurityContext, org: Uuid) -> bool {
        match self
            .0
            .get_scoped::<dyn crate::user_profile::OrgAuthority>(&ClientScope::gts_id(
                crate::user_profile::IDENTITY_INSTANCE_ID,
            )) {
            Ok(authority) => authority.may_administer(ctx, org, DEFAULT_PRIVILEGE).await,
            Err(_) => false,
        }
    }

    async fn is_platform_admin(&self, ctx: &SecurityContext) -> bool {
        match self
            .0
            .get_scoped::<dyn crate::user_profile::OrganizationReader>(&ClientScope::gts_id(
                crate::user_profile::IDENTITY_INSTANCE_ID,
            )) {
            Ok(reader) => reader
                .is_platform_admin(&ctx.subject_id().to_string())
                .await
                .unwrap_or(false),
            Err(_) => false,
        }
    }
}

/// Why the settings were not read or changed.
#[derive(Debug, PartialEq, Eq)]
pub enum SettingsRefusal {
    /// No service, or it did not answer: 503.
    Unavailable(String),
    /// The caller may not change them: 403 [`ADMIN_REQUIRED`].
    Forbidden,
    /// They changed since they were read: 409 [`CONFLICT`].
    Conflict(String),
    /// The service refused the change: 400 with `code`
    /// ([`PROVIDER_UNAVAILABLE`], [`BAD_SETTINGS`]).
    Invalid { code: &'static str, why: String },
    /// Anything else the service answered: 500.
    Internal(String),
}

impl From<MatcherError> for SettingsRefusal {
    fn from(e: MatcherError) -> Self {
        match &e {
            MatcherError::Upstream { status: 409, .. } => Self::Conflict(e.to_string()),
            MatcherError::Upstream {
                status: 400 | 422,
                code,
                detail,
            } => Self::Invalid {
                code: if code.as_deref() == Some("provider_unavailable") {
                    PROVIDER_UNAVAILABLE
                } else {
                    BAD_SETTINGS
                },
                why: detail.clone(),
            },
            // A wrong secret is the deployment's to fix, as an absent one is.
            MatcherError::Upstream { status: 401, .. } => Self::Unavailable(e.to_string()),
            _ if e.is_transient() => Self::Unavailable(e.to_string()),
            MatcherError::NotConfigured(_) => Self::Unavailable(e.to_string()),
            MatcherError::Upstream { .. } | MatcherError::Transport(_) => {
                Self::Internal(e.to_string())
            }
        }
    }
}

/// The service's settings, whose service it is, and whether the caller may
/// change them.
#[derive(Debug)]
pub struct SettingsRead {
    /// The service's own answer (`Settings` of the contract).
    pub settings: Value,
    pub scope: ServiceScope,
    pub may_change: bool,
}

impl GearMatches {
    async fn settings_service(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        strategy: &str,
    ) -> Result<(Arc<dyn super::client::Matcher>, ServiceScope), SettingsRefusal> {
        self.service_for(ctx, org, strategy)
            .await
            .map_err(|r| match r {
                Refusal::Internal(e) => SettingsRefusal::Internal(format!("{e:#}")),
                other => SettingsRefusal::Unavailable(other.to_string()),
            })
    }

    /// `strategy`'s service's settings in `org`, as the caller reads them.
    pub async fn read_settings(
        &self,
        authority: &dyn SettingsAuthority,
        ctx: &SecurityContext,
        org: Uuid,
        strategy: &str,
    ) -> Result<SettingsRead, SettingsRefusal> {
        let (matcher, scope) = self.settings_service(ctx, org, strategy).await?;
        let (settings, may) =
            tokio::join!(matcher.settings(), may_change(authority, ctx, org, scope));
        Ok(SettingsRead {
            settings: settings?,
            scope,
            may_change: may,
        })
    }

    /// Replace the override of `strategy`'s service's settings in `org`:
    /// `overrides` as a whole, if `version` is still the service's. Recorded
    /// as the caller's change.
    pub async fn change_settings(
        &self,
        authority: &dyn SettingsAuthority,
        ctx: &SecurityContext,
        org: Uuid,
        strategy: &str,
        version: u64,
        overrides: Value,
    ) -> Result<SettingsRead, SettingsRefusal> {
        let (matcher, scope) = self.settings_service(ctx, org, strategy).await?;
        if !may_change(authority, ctx, org, scope).await {
            return Err(SettingsRefusal::Forbidden);
        }
        let body = json!({
            "version": version,
            "overrides": overrides,
            "updated_by": ctx.subject_id().to_string(),
        });
        let settings = matcher.put_settings(&body).await?;
        // The organization page's live check shows the new models at once.
        self.forget_info(org, strategy, scope).await;
        tracing::info!(
            organization_id = %org,
            strategy,
            scope = scope.as_str(),
            "studio-product: a gears-matcher service's run settings were changed"
        );
        Ok(SettingsRead {
            settings,
            scope,
            may_change: true,
        })
    }
}

#[cfg(test)]
#[path = "settings_tests.rs"]
mod settings_tests;
